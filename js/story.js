// ============================================================
// 故事生成 + 完形填空挑战模块
// 项目：词境 LexiLoop（雅思语境抗遗忘背词）
//
// 架构说明（2026-10 变更）：
//   原方案是 前端 → Supabase Edge Function → DeepSeek，DeepSeek Key 藏在服务端。
//   但 Supabase 项目被平台回收（DNS NXDOMAIN），整条链路失效。
//   现改为 前端 → DeepSeek 官方 API 直连，Key 由使用者在「AI 设置」里自行填入，
//   仅保存在本机 localStorage，不上传、不进代码仓库。
//
//   ⚠️ 直连意味着 Key 存在于浏览器内存/本地存储中：
//      - 适合个人使用、录屏演示、内网演示
//      - 不适合公开给他人访问（等同把自己的 API 额度公开）
//      若日后要公开发布，请恢复 Edge Function 方案，把 Key 放回服务端。
// ============================================================

// DeepSeek 官方接口
const DEEPSEEK_ENDPOINT = "https://api.deepseek.com/chat/completions";
const DEEPSEEK_MODEL = "deepseek-chat";

// Key 存储：只在浏览器本地，键名与代码分离，便于一键清除
const DEEPSEEK_KEY_STORAGE = "lexiloop_deepseek_key";

const AIKey = {
    get() {
        try {
            const k = (localStorage.getItem(DEEPSEEK_KEY_STORAGE) || "").trim();
            return k.startsWith("sk-") ? k : "";
        } catch { return ""; }
    },
    set(key) {
        const k = String(key || "").trim();
        try {
            if (k) localStorage.setItem(DEEPSEEK_KEY_STORAGE, k);
            else localStorage.removeItem(DEEPSEEK_KEY_STORAGE);
        } catch {}
        return this.get();
    },
    has() { return !!this.get(); },
    masked() {
        const k = this.get();
        if (!k) return "";
        return k.slice(0, 7) + "••••••" + k.slice(-4);
    },
};

// 生成来源标记：ai = 真实大模型生成；local = 本地兜底
const StorySource = {
    value: "ai",
    set(source) { this.value = source; },
    isLocal() { return this.value === "local"; },
};

// 单次请求超时（毫秒）。DeepSeek 生成 8 词短文通常 5-15 秒，给足 45 秒；
// 但必须有上限，否则断网时会无限等待，用户以为程序挂了。
const STORY_TIMEOUT_MS = 45000;
// 网络类错误重试 1 次
const STORY_RETRY = 1;

// 错误归类：把底层异常翻译成用户能看懂、且能据此采取行动的话
function _classifyStoryError(err) {
    const msg = String(err?.name === "AbortError" ? "timeout" : (err?.message || err));
    if (err?.name === "AbortError" || /timeout/i.test(msg)) {
        return { kind: "timeout", retryable: true, text: "请求超时（DeepSeek 响应太慢）" };
    }
    if (/Failed to fetch|NetworkError|Load failed|ERR_|NS_ERROR/i.test(msg)) {
        return { kind: "network", retryable: true, text: "网络无法连到 api.deepseek.com" };
    }
    const m = msg.match(/HTTP (\d{3})/);
    if (m) {
        const status = Number(m[1]);
        if (status === 401) {
            return { kind: "auth", retryable: false, text: "API Key 无效或已被禁用（401）" };
        }
        if (status === 402 || status === 403) {
            return { kind: "billing", retryable: false, text: "账户余额不足或无权限（" + status + "）" };
        }
        if (status === 429) {
            return { kind: "rate", retryable: true, text: "请求过于频繁，已被限流（429）" };
        }
        const retryable = status === 408 || status >= 500;
        return { kind: "http", retryable, text: `DeepSeek 服务端异常（${status}）` };
    }
    if (/JSON|格式|结构/.test(msg)) return { kind: "bad_payload", retryable: true, text: "模型返回内容不是合法 JSON" };
    return { kind: "unknown", retryable: false, text: "未知错误：" + msg };
}

// ── Prompt 构造：与服务端原实现保持一致的产品约束 ──
const DIFFICULTY_PROMPT = {
    beginner: "词汇：只许用 CEFR A2 级别日常词，禁止使用雅思长词、抽象名词、专业术语。",
    intermediate: "词汇：标准雅思高频词，句式简单直接，允许少量常见从句。",
    advanced: "词汇：学术/正式语体，可适度使用书面表达，但句子长度仍受下面硬性约束限制。",
};

function _buildStoryMessages(words, difficulty, budget) {
    const boundaryLines = [
        "【硬性长度边界】必须遵守，不可突破：",
        `- 全文约 ${budget.max_sentences} 句（可在 ±1 句内浮动），必须足够容纳所有目标词自然出场。`,
        `- 每句话最多 ${budget.max_words_per_sentence} 个英文单词。`,
        "- 只能使用 1 个简单段落；禁止分段；禁止换行。",
        "- 禁止出现任何引号或对话。",
        `- 目标词 HTML 高亮格式：<span class="target-word" data-word="WORD">WORD</span>。`,
    ].join("\n");

    const sys = `你是一位专为雅思考生写「情景记忆短文」的导师。你要写的不是例句清单，而是一个真实、连贯、极易读懂的生活小场景。

1) 一篇连贯的英文迷你故事（必须遵守下方【硬性长度边界】）：
   - 全文必须围绕【唯一一个场景】展开（例如：一个下雨的早晨赶公交、一次超市采购、一次课堂展示、一次朋友聚餐），从头到尾不换场景。
   - 句与句之间用时间或因果衔接（First... / Then... / Because... / So... / After...），读起来是一个完整的小故事。
   - 所有目标词都必须在情节中自然出现；允许多个目标词出现在同一句；读者能通过上下文猜出每个目标词的意思。
   - 严禁「一句一词、句句无关」的词典式拼凑——每个句子孤立成立、句间没有故事联系，就是失败的作品。

2) 短文的标准简体中文翻译：通顺、自然、符合中文表达习惯，读起来像人话，禁止逐词直译的翻译腔。翻译必须是完整的整篇译文，不能省略。

3) 每个目标词一道「句子挖空」题：一句自然的英文例句，在目标词该出现的位置用 _____ 占位；给出 3 个干扰项（拼写/词义易混淆的雅思词汇，不能是正确答案），以及每个选项的简体中文释义。

${DIFFICULTY_PROMPT[difficulty] || DIFFICULTY_PROMPT.intermediate}

${boundaryLines}

严格要求：只返回如下结构的 JSON 对象，不要任何 markdown 代码块、不要多余文字：
{
  "title": "短文标题（4词以内）",
  "story": "HTML 字符串，目标词用 <span class=\\"target-word\\" data-word=\\"WORD\\">WORD</span> 高亮",
  "translation": "整篇中文翻译（必须有内容，不能为空）",
  "questions": [
    {
      "target_word": "Word",
      "cloze_sentence": "一句自然的英文，目标词位置用 _____ 占位",
      "options": ["Word", "distractor1", "distractor2", "distractor3"],
      "options_translation": ["正确词中文", "干扰项1中文", "干扰项2中文", "干扰项3中文"],
      "correct_answer": "Word"
    }
  ]
}`;

    const user = `目标词（共 ${words.length} 个，${difficulty} 难度，约束：${budget.max_sentences}句/每句≤${budget.max_words_per_sentence}词）：
${words.map((w, i) => `${i + 1}. ${w}`).join("\n")}

请生成严格遵守上述长度边界的 JSON。`;

    return [
        { role: "system", content: sys },
        { role: "user", content: user },
    ];
}

const StoryEngine = {
    generatedStory: null,
    challengeQuestions: [],
    currentQuestionIndex: 0,
    challengeResults: { mastered: [], restudy: [] },
    isReviewMode: false,
    lastError: null,

    async generateStory(words, difficulty = "intermediate") {
        const apiKey = AIKey.get();
        if (!apiKey) {
            const e = new Error("MISSING_KEY");
            this.lastError = { kind: "auth", text: "尚未填写 DeepSeek API Key" };
            throw e;
        }

        // 按难度给「句数/句长」预算：目标词越多，越需要足够的句子来构建连贯情景
        const budget = {
            beginner:     { max_sentences: 5,  max_words_per_sentence: 12 },
            intermediate: { max_sentences: 8,  max_words_per_sentence: 16 },
            advanced:     { max_sentences: 10, max_words_per_sentence: 18 },
        }[difficulty] || { max_sentences: 8, max_words_per_sentence: 16 };

        const body = JSON.stringify({
            model: DEEPSEEK_MODEL,
            messages: _buildStoryMessages(words.map(w => w.word), difficulty, budget),
            response_format: { type: "json_object" },
            temperature: 0.7,
            stream: false,
        });

        let lastErr = null;
        for (let attempt = 0; attempt <= STORY_RETRY; attempt++) {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), STORY_TIMEOUT_MS);
            try {
                const response = await fetch(DEEPSEEK_ENDPOINT, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "Authorization": `Bearer ${apiKey}`,
                    },
                    body,
                    signal: controller.signal,
                });
                clearTimeout(timer);

                if (!response.ok) {
                    const errText = await response.text().catch(() => "");
                    console.error("[deepseek] HTTP", response.status, errText.slice(0, 300));
                    const e = new Error("HTTP " + response.status);
                    e.status = response.status;
                    throw e;
                }

                const json = await response.json();
                const content = json?.choices?.[0]?.message?.content;
                if (!content) throw new Error("模型返回内容为空");

                // 容错解析：去掉可能存在的 ``` 包裹
                const cleaned = content.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
                let data;
                try {
                    data = JSON.parse(cleaned);
                } catch {
                    throw new Error("返回内容不是合法 JSON");
                }

                if (!data?.story || !Array.isArray(data.questions) || data.questions.length === 0) {
                    throw new Error("返回结构不完整");
                }
                // 译文兜底：模型偶尔漏字段，缺了就等于用户「看不到中文翻译」
                if (!data.translation || !String(data.translation).trim()) {
                    data.translation = "（本篇模型未返回中文翻译，可重新生成本次短文）";
                    data._translationMissing = true;
                }

                this.generatedStory = data;
                this.lastError = null;
                StorySource.set("ai");
                return this.generatedStory;
            } catch (err) {
                clearTimeout(timer);
                lastErr = err;
                const info = _classifyStoryError(err);
                console.warn(`[deepseek] 第 ${attempt + 1} 次失败：${info.kind} / ${info.text}`, err);
                this.lastError = { kind: info.kind, text: info.text, raw: String(err?.message || err) };

                // 鉴权/余额/未填 Key 属于确定性失败，重试没有意义
                if (info.kind === "auth" || info.kind === "billing") break;
                if (info.kind === "network") break;
                if (!info.retryable || attempt === STORY_RETRY) break;

                if (typeof App !== "undefined" && typeof App.setLoadingHint === "function") {
                    App.setLoadingHint(`${info.text}，正在重试（第 ${attempt + 2} 次）…`);
                }
                await new Promise(r => setTimeout(r, 900));
            }
        }
        throw lastErr || new Error("AI 服务不可用");
    },

    // ── 以下为挑战/复习/统计逻辑 ──

    startChallenge() {
        this.isReviewMode = false;
        this.challengeQuestions = this.generatedStory?.questions || [];
        this.currentQuestionIndex = 0;
        this.challengeResults = { mastered: [], restudy: [] };
        return this.challengeQuestions.length > 0;
    },

    async startReviewChallenge() {
        this.isReviewMode = true;
        const words = await Vocabulary.getDueReviewWords();
        if (words.length === 0) return false;
        const reviewTargets = words.map(w => ({
            word: w.word, phonetic: w.phonetic, definition: w.definition, translation: w.translation,
        }));
        this.challengeQuestions = reviewTargets.map(item => {
            const fullWord = Vocabulary.database.find(w => w.word.toLowerCase() === item.word.toLowerCase()) || item;
            const distractorN = (typeof App !== "undefined" && App.distractorCount) ? App.distractorCount() : 3;
            const simWords = Vocabulary.getSimilarWords(item.word, distractorN);
            const options = [item.word, ...simWords.map(w => w.word)];
            const transMap = {};
            transMap[item.word] = fullWord.translation || item.translation;
            simWords.forEach(w => { transMap[w.word] = w.translation; });
            shuffleArray(options);
            const optionsTrans = options.map(opt => transMap[opt] || "???");

            let sentence = fullWord.example;
            if (!sentence || !sentence.includes("_____")) {
                sentence = `Choose the word that means "${fullWord.definition}" to fill the blank: The correct answer is _____.`;
            }

            return {
                target_word: item.word,
                cloze_sentence: sentence,
                options: options,
                options_translation: optionsTrans,
                correct_answer: item.word,
            };
        });
        this.currentQuestionIndex = 0;
        this.challengeResults = { mastered: [], restudy: [] };
        return true;
    },

    getCurrentQuestion() {
        if (this.currentQuestionIndex >= this.challengeQuestions.length) return null;
        return this.challengeQuestions[this.currentQuestionIndex];
    },

    submitAnswer(selectedOpt) {
        const q = this.getCurrentQuestion();
        if (!q) return null;
        const isCorrect = selectedOpt === q.correct_answer;
        const wordObj = Vocabulary.database.find(w => w.word.toLowerCase() === q.target_word.toLowerCase());
        if (isCorrect) {
            if (!this.challengeResults.mastered.find(w => w.word === q.target_word)) {
                this.challengeResults.mastered.push(wordObj || { word: q.target_word });
            }
        } else {
            if (!this.challengeResults.restudy.find(w => w.word === q.target_word)) {
                this.challengeResults.restudy.push(wordObj || { word: q.target_word });
            }
        }
        return { isCorrect, correctAnswer: q.correct_answer, wordObj };
    },

    nextQuestion() {
        this.currentQuestionIndex++;
        return this.currentQuestionIndex < this.challengeQuestions.length;
    },

    async processResults() {
        // 完形填空结束后：选对的词标 mastered（永久移除），
        // 选错的词标回 unknown（回到生词池），清空本轮队列。
        if (!this.isReviewMode && typeof App !== "undefined") {
            App.currentQueue = [];
            App.unknownWordsCount = 0;
        }

        const allResults = [
            ...this.challengeResults.mastered.map(w => ({ word: w, status: "mastered", isCorrect: true })),
            ...this.challengeResults.restudy.map(w => ({ word: w, status: "unknown", isCorrect: false })),
        ];

        for (const entry of allResults) {
            const word = Vocabulary.database.find(w => w.word.toLowerCase() === entry.word.word.toLowerCase());
            if (!word) continue;

            const correctCount = entry.isCorrect ? (word._correctCount || 0) + 1 : (word._correctCount || 0);
            const wrongCount = entry.isCorrect ? (word._wrongCount || 0) : (word._wrongCount || 0) + 1;
            const nextReview = Vocabulary.calculateNextReview(word, entry.isCorrect);

            word._status = entry.status;
            word._correctCount = correctCount;
            word._wrongCount = wrongCount;
            word._lastReviewed = new Date().toISOString();
            if (entry.status === "mastered") word._masteredAt = new Date().toISOString();
            word._nextReview = nextReview;
        }

        // 进度统一存本机（无云端后，登录态与游客态一致）
        Vocabulary.saveGuestProgress();
    },
};

function shuffleArray(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
}
