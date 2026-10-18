// ============================================================
// 故事生成 + 完形填空挑战模块
// 项目：词境 LexiLoop（雅思语境抗遗忘背词）
// 只通过 Supabase Edge Function 调用 AI（DeepSeek Key 仅存于服务端环境变量，
// 前端不保存、不暴露任何密钥，防止 API 额度被盗用）
// ============================================================

// 使用 supabase-client.js 中定义的 SUPABASE_URL，避免硬编码
const EDGE_URL = (typeof SUPABASE_URL !== "undefined" ? SUPABASE_URL : "") + "/functions/v1/generate-story";

// 从 localStorage 读取当前登录用户的 access token（用于 Edge Function 鉴权）
function _getAccessToken() {
    try {
        const raw = localStorage.getItem("sb-auth-token");
        if (!raw) return "";
        const parsed = JSON.parse(raw);
        const session = parsed?.currentSession || parsed?.session || null;
        return session?.access_token || "";
    } catch {
        return "";
    }
}

// 生成来源标记：ai = 大模型真实生成；local = 本地兜底
// 用于 UI 如实告知用户「这篇是 AI 写的还是本地拼的」，避免让人误以为断网时也走了模型
const StorySource = {
    value: "ai",
    set(source) { this.value = source; },
    isLocal() { return this.value === "local"; },
};

// 单次请求超时（毫秒）。断网时 fetch 可能长时间挂起，必须主动中断，
// 否则用户会一直卡在 loading 页（这是之前「AI 又不能用了」最糟的体验点）
const STORY_TIMEOUT_MS = 20000;
// 网络类错误重试 1 次：偶发丢包/代理抖动不值得让用户重来一遍
const STORY_RETRY = 1;

// 错误归类：区分「网络到不了后端」和「后端自己出错」，给用户的提示才有信息量
function _classifyStoryError(err) {
    const msg = String(err?.name === "AbortError" ? "timeout" : (err?.message || err));
    if (err?.name === "AbortError" || /timeout/i.test(msg)) {
        return { kind: "timeout", retryable: true, text: "请求超时" };
    }
    if (/Failed to fetch|NetworkError|Load failed|ERR_|NS_ERROR/i.test(msg)) {
        return { kind: "network", retryable: true, text: "网络未能连到 AI 服务" };
    }
    const m = msg.match(/HTTP (\d{3})/);
    if (m) {
        const status = Number(m[1]);
        // 4xx（除 408/429）属于请求本身问题，重试没有意义
        const retryable = status === 408 || status === 429 || status >= 500;
        const text = status === 429 ? "请求过于频繁"
            : status >= 500 ? `AI 服务端异常 (${status})`
            : `请求被拒绝 (${status})`;
        return { kind: "http", retryable, text };
    }
    if (/格式|结构|空/.test(msg)) return { kind: "bad_payload", retryable: false, text: msg };
    return { kind: "unknown", retryable: false, text: "未知错误" };
}

// DNS/连通性探测：用 no-cors 的 HEAD 打一次 Supabase 根路径。
// 能连但被 CORS 拦时 resolve 为 alive；域名根本无法解析/连接被拒时 reject → 判定为确定性故障。
function _probeHostUnreachable() {
    if (typeof SUPABASE_URL === "undefined" || !SUPABASE_URL) return Promise.resolve(false);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3000);
    return fetch(SUPABASE_URL + "/rest/v1/", { method: "HEAD", mode: "no-cors", signal: ctrl.signal })
        .then(() => { clearTimeout(timer); return false; })
        .catch(e => { clearTimeout(timer); return e?.name !== "AbortError"; });
}

const StoryEngine = {
    generatedStory: null,
    challengeQuestions: [],
    currentQuestionIndex: 0,
    challengeResults: { mastered: [], restudy: [] },
    isReviewMode: false,
    lastError: null,

    async generateStory(words, difficulty = "intermediate") {
        // 只走 Edge Function（服务端持有 DeepSeek Key，前端不暴露任何密钥）
        // 已登录用户携带 token；游客模式携带 mode: "guest"（需 Edge Function 侧放开匿名访问并做限流）
        const token = _getAccessToken();
        // 按难度给「句数/句长」预算：目标词越多，越需要足够的句子来构建连贯情景，
        // 否则 AI 只能写出「一句一词、句句无关」的词典式拼凑。
        const budget = {
            beginner:     { max_sentences: 5,  max_words_per_sentence: 12 },
            intermediate: { max_sentences: 8,  max_words_per_sentence: 16 },
            advanced:     { max_sentences: 10, max_words_per_sentence: 18 },
        }[difficulty] || { max_sentences: 8, max_words_per_sentence: 16 };

        const payload = {
            action: "generate_story",
            words: words.map(w => w.word),
            difficulty: difficulty, // beginner | intermediate | advanced
            mode: (typeof Auth !== "undefined" && Auth.isGuest) ? "guest" : "user",
            // 文章边界：服务端读取后写入 prompt，强制短、简单、易读
            constraints: {
                max_sentences: budget.max_sentences,
                max_words_per_sentence: budget.max_words_per_sentence,
                style: "simple",
                tone: "daily",
                no_dialogue: true,
            },
        };

        let lastErr = null;
        for (let attempt = 0; attempt <= STORY_RETRY; attempt++) {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), STORY_TIMEOUT_MS);
            try {
                const response = await fetch(EDGE_URL, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        // anon key（publishable，可公开）用于通过 Supabase 网关鉴权；
                        // 真实 DeepSeek Key 仅在 Edge Function 服务端环境变量中，前端永不可见
                        "apikey": typeof SUPABASE_ANON_KEY !== "undefined" ? SUPABASE_ANON_KEY : "",
                        ...(token ? { "Authorization": `Bearer ${token}` } : {}),
                    },
                    body: JSON.stringify(payload),
                    signal: controller.signal,
                });
                clearTimeout(timer);

                if (!response.ok) {
                    // 带上状态码，交给 _classifyStoryError 判断能否重试
                    const e = new Error("HTTP " + response.status);
                    e.status = response.status;
                    throw e;
                }

                const data = await response.json();
                if (!data || !data.story || !Array.isArray(data.questions) || data.questions.length === 0) {
                    throw new Error("AI 返回结构不完整");
                }
                this.generatedStory = data;
                this.lastError = null;
                StorySource.set("ai");
                return this.generatedStory;
            } catch (err) {
                clearTimeout(timer);
                lastErr = err;
                const info = _classifyStoryError(err);
                // 域名解析失败（离线/被墙/DNS 污染）会以 Failed to fetch 的形式出现，
                // 浏览器不暴露细节，这里用一次轻量探测判定是否属于「连域名都解析不了」
                if (info.kind === "network") {
                    const dnsDead = await _probeHostUnreachable();
                    if (dnsDead) {
                        err.dnsFailure = true;
                        info.text = "当前网络无法访问 AI 服务域名";
                    }
                }
                console.warn(
                    `[generate-story] 第 ${attempt + 1} 次失败：${info.kind} / ${info.text}`,
                    err
                );
                this.lastError = { kind: info.kind, text: info.text, raw: String(err?.message || err) };
                // DNS 解析失败属于「确定性故障」：同一网络下重试必然再次失败，
                // 重试只会让用户多等 20 秒。这类错误直接降级，别做无谓重试。
                if (info.kind === "network" && err?.dnsFailure) break;
                // 不可重试（如 401 鉴权失败、返回结构异常）→ 立即放弃，别让用户白等
                if (!info.retryable || attempt === STORY_RETRY) break;
                // 把「正在重试」显示在加载页，用户知道系统在努力，而不是卡死
                if (typeof App !== "undefined" && typeof App.setLoadingHint === "function") {
                    App.setLoadingHint(`${info.text}，正在重试（第 ${attempt + 2} 次）…`);
                }
                await new Promise(r => setTimeout(r, 700));
            }
        }
        throw lastErr || new Error("AI 服务不可用");
    },

    // ── 以下为挑战/复习/统计逻辑，未改动 ──

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

            // 优先使用词库中的 example 句子挖空，否则 fallback 到释义题（极少情况）
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
        // 这样错词会在下次「开始筛选」时与其他没学过的词一起被正常筛出，而不是单独拎出来重做。
        if (!this.isReviewMode && typeof App !== "undefined") {
            App.currentQueue = [];
            App.unknownWordsCount = 0;
        }

        // 1) 先更新内存中的词状态（登录用户 / 游客都执行）
        const allResults = [
            ...this.challengeResults.mastered.map(w => ({ word: w, status: "mastered", isCorrect: true })),
            ...this.challengeResults.restudy.map(w => ({ word: w, status: "unknown", isCorrect: false })),
        ];

        const rows = [];
        for (const entry of allResults) {
            const word = Vocabulary.database.find(w => w.word.toLowerCase() === entry.word.word.toLowerCase());
            if (!word) continue;

            const correctCount = entry.isCorrect ? (word._correctCount || 0) + 1 : (word._correctCount || 0);
            const wrongCount = entry.isCorrect ? (word._wrongCount || 0) : (word._wrongCount || 0) + 1;
            const nextReview = Vocabulary.calculateNextReview(word, entry.isCorrect);

            // 同步更新本地状态
            word._status = entry.status;
            word._correctCount = correctCount;
            word._wrongCount = wrongCount;
            word._lastReviewed = new Date().toISOString();
            if (entry.status === "mastered") word._masteredAt = new Date().toISOString();
            word._nextReview = nextReview;

            if (Auth.currentUser) {
                rows.push({
                    user_id: Auth.currentUser.id,
                    word: word.word,
                    phonetic: word.phonetic || "",
                    definition: word.definition || "",
                    translation: word.translation || "",
                    status: entry.status,
                    correct_count: correctCount,
                    wrong_count: wrongCount,
                    last_reviewed_at: word._lastReviewed,
                    mastered_at: entry.status === "mastered" ? word._masteredAt : null,
                    next_review_at: nextReview,
                });
            }
        }

        // 2) 持久化
        if (Auth.currentUser) {
            // 登录用户：云端保存进度 + 学习会话 + 统计
            if (rows.length > 0) {
                try {
                    await supabase.from("word_progress").upsert(rows, { onConflict: "user_id, word" });
                } catch (e) {
                    console.error("保存进度失败:", e);
                }
            }
            try {
                const total = this.challengeResults.mastered.length + this.challengeResults.restudy.length;
                const score = total > 0 ? this.challengeResults.mastered.length / total : 0;
                await supabase.from("learning_sessions").insert([{
                    user_id: Auth.currentUser.id,
                    session_type: this.isReviewMode ? "review" : "challenge",
                    words_tested: [...this.challengeResults.mastered, ...this.challengeResults.restudy].map(w => w.word),
                    score: score,
                    detail: { mastered: this.challengeResults.mastered.map(w => w.word), restudy: this.challengeResults.restudy.map(w => w.word) },
                }]);
            } catch (e) {
                console.error("保存学习会话失败:", e);
            }
            await this.updateUserStats();
        } else if (Auth.isGuest) {
            // 游客：进度仅存本机 localStorage
            Vocabulary.saveGuestProgress();
        }
    },

    async updateUserStats() {
        if (!Auth.currentUser) return;
        try {
            const today = new Date().toISOString().split("T")[0];
            const { data: stats } = await supabase.from("user_stats").select("*").eq("user_id", Auth.currentUser.id).single();
            let streakDays = stats?.streak_days || 0;
            const lastDate = stats?.last_study_date;
            if (lastDate) {
                const yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1);
                const yesterdayStr = yesterday.toISOString().split("T")[0];
                if (lastDate === yesterdayStr) streakDays += 1;
                else if (lastDate !== today) streakDays = 1;
            } else { streakDays = 1; }
            const masteredCount = Vocabulary.getMasteredWords().length;
            await supabase.from("user_stats").upsert([{
                user_id: Auth.currentUser.id, total_words_mastered: masteredCount,
                total_sessions: (stats?.total_sessions || 0) + 1, streak_days: streakDays, last_study_date: today,
            }]);
        } catch (e) {
            console.error("更新统计数据失败:", e);
        }
    },

    async getUserStats() {
        if (!Auth.currentUser) return null;
        try {
            const { data } = await supabase.from("user_stats").select("*").eq("user_id", Auth.currentUser.id).single();
            return data;
        } catch (e) {
            return null;
        }
    },
};

function shuffleArray(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
}