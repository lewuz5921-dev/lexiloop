// ============================================================
// 主应用逻辑：UI 控制、页面切换、事件绑定
// ============================================================

const App = {
    // 运行状态
    currentQueue: [],
    knownWordsCount: 0,
    unknownWordsCount: 0,
    wordPointer: 0,
    currentTestWord: null,
    difficulty: "intermediate", // beginner | intermediate | advanced
    batchSize: 8, // 每篇情景短文包含的目标词数（难度阶梯）
    _ready: false, // 初始化完成标志
    _initPromise: null, // 初始化 Promise，防止重复

    // 难度阶梯：决定每篇目标词量与干扰项数量，避免「给药过猛」
    setDifficulty(level) {
        this.difficulty = ["beginner", "intermediate", "advanced"].includes(level) ? level : "intermediate";
        const batchMap = { beginner: 5, intermediate: 8, advanced: 10 };
        this.batchSize = batchMap[this.difficulty] || 8;
        try { localStorage.setItem("lexiloop_difficulty", this.difficulty); } catch (e) {}
    },

    // 每道题的干扰项数量：初级更少、高级更多
    distractorCount() {
        const map = { beginner: 2, intermediate: 3, advanced: 4 };
        return map[this.difficulty] || 3;
    },

    // 初始化
    async init() {
        if (this._initPromise) return this._initPromise;
        this._initPromise = this._doInit();
        return this._initPromise;
    },

    async _doInit() {
        // 本地词库立即可用
        Vocabulary.database = [...IELTS_VOCABULARY_FULL];
        this._ready = true;

        // 读取已保存的难度偏好
        let savedDifficulty = "intermediate";
        try { savedDifficulty = localStorage.getItem("lexiloop_difficulty") || "intermediate"; } catch (e) {}
        this.setDifficulty(savedDifficulty);
        const diffSelect = document.getElementById("difficulty-select");
        if (diffSelect) diffSelect.value = this.difficulty;
        this.updateWelcomeDesc();

        // 检查登录/游客状态（不阻塞本地词库使用）
        let authState = "none";
        try {
            authState = await Auth.init();
        } catch (e) {
            console.error("Auth init 失败:", e);
            authState = "none";
        }

        if (authState === "none") {
            window.location.href = "login.html";
            return;
        }

        // 本机模式：从 localStorage 读取进度（云端账号已停用）
        Vocabulary.loadGuestProgress();
        this.renderUserMenu("guest");

        this.updateStatsUI();
        this.updateWelcomeUI();
    },

    // === 背词流程 ===
    startSession() {
        if (!this._ready) {
            showStatusToast("数据加载中，请稍后再试...", "info");
            return;
        }
        const diffSelect = document.getElementById("difficulty-select");
        this.setDifficulty(diffSelect ? diffSelect.value : this.difficulty);
        this.updateWelcomeDesc();
        shuffleArray(Vocabulary.database);
        this.wordPointer = 0;
        this.currentQueue = [];
        this.unknownWordsCount = 0;
        StoryEngine.isReviewMode = false;

        showScreen("testing-screen");
        this.loadNextWord();
        this.updateStatsUI();
    },

    loadNextWord() {
        if (this.currentQueue.length >= this.batchSize) {
            this.triggerStoryGeneration();
            return;
        }

        if (this.wordPointer >= Vocabulary.database.length) {
            shuffleArray(Vocabulary.database);
            this.wordPointer = 0;
        }

        this.currentTestWord = Vocabulary.database[this.wordPointer];
        this.wordPointer++;

        // 跳过已在队列中的词
        if (this.currentQueue.some(w => w.word === this.currentTestWord.word)) {
            this.loadNextWord();
            return;
        }

        // 跳过已掌握的（非复习模式）
        if (this.currentTestWord._status === "mastered" && !StoryEngine.isReviewMode) {
            this.loadNextWord();
            return;
        }

        this.renderWordTestCard(this.currentTestWord);
    },

    renderWordTestCard(wordObj) {
        document.getElementById("target-word-display").innerText = wordObj.word;
        document.getElementById("word-phonetic").innerText = wordObj.phonetic;

        const distractors = Vocabulary.getSimilarWords(wordObj.word, this.distractorCount()).map(w => w.translation);
        const options = [wordObj.translation, ...distractors];
        shuffleArray(options);

        const container = document.getElementById("options-container");
        container.innerHTML = "";

        options.forEach((opt, index) => {
            const label = String.fromCharCode(65 + index);
            const button = document.createElement("button");
            button.className = "w-full text-left bg-slate-50 hover:bg-indigo-50 border border-slate-200 hover:border-indigo-300 rounded-xl px-5 py-3.5 transition flex items-center justify-between group";
            button.onclick = () => this.checkAnswer(opt, wordObj.translation, button);
            button.innerHTML = `
                <div class="flex items-center space-x-3">
                    <span class="w-7 h-7 rounded-lg bg-slate-200 group-hover:bg-indigo-200 text-slate-700 group-hover:text-indigo-800 flex items-center justify-center font-bold text-sm">${label}</span>
                    <span class="text-slate-700 font-medium">${opt}</span>
                </div>
                <i class="fa-solid fa-chevron-right text-slate-300 group-hover:text-indigo-400 text-sm"></i>
            `;
            container.appendChild(button);
        });
    },

    checkAnswer(selectedOpt, correctOpt, buttonEl) {
        const buttons = document.querySelectorAll("#options-container button");
        buttons.forEach(b => b.disabled = true);

        if (selectedOpt === correctOpt) {
            buttonEl.classList.remove("border-slate-200", "hover:bg-indigo-50");
            buttonEl.classList.add("bg-emerald-500", "border-emerald-500", "text-white");
            buttonEl.querySelector("span:first-child").className = "w-7 h-7 rounded-lg bg-emerald-600 text-white flex items-center justify-center font-bold text-sm";
            buttonEl.querySelector("span:nth-child(2)").className = "text-white font-semibold";
            buttonEl.querySelector("i").className = "fa-solid fa-circle-check text-white text-base";

            // 标记为临时掌握（云端在通关后统一更新）
            if (!Vocabulary.getMasteredWords().some(w => w.word === this.currentTestWord.word)) {
                this.currentTestWord._status = "mastered";
            }
            this.knownWordsCount = Vocabulary.getMasteredWords().length;

            setTimeout(() => {
                this.loadNextWord();
                this.updateStatsUI();
            }, 800);
        } else {
            buttonEl.classList.remove("border-slate-200", "hover:bg-indigo-50");
            buttonEl.classList.add("bg-rose-500", "border-rose-500", "text-white");
            buttonEl.querySelector("span:first-child").className = "w-7 h-7 rounded-lg bg-rose-600 text-white flex items-center justify-center font-bold text-sm";
            buttonEl.querySelector("span:nth-child(2)").className = "text-white font-semibold";
            buttonEl.querySelector("i").className = "fa-solid fa-circle-xmark text-white text-base";

            buttons.forEach(b => {
                if (b.innerText.includes(correctOpt)) {
                    b.classList.add("border-emerald-500", "bg-emerald-50");
                }
            });

            this.markAsUnknown();
        }
    },

    markAsUnknown() {
        if (!this.currentQueue.some(w => w.word === this.currentTestWord.word)) {
            this.currentQueue.push(this.currentTestWord);
            this.unknownWordsCount++;
        }
        this.updateStatsUI();

        setTimeout(() => {
            this.loadNextWord();
        }, 1000);
    },

    // === 故事生成 ===
    async triggerStoryGeneration() {
        const box = document.getElementById("story-error-box");
        if (box) box.classList.add("hidden");

        // 没填 Key 就别装了：直接引导去填，不发起无效请求
        if (typeof AIKey !== "undefined" && !AIKey.has()) {
            StoryEngine.lastError = { kind: "auth", text: "尚未填写 DeepSeek API Key" };
            this.showStoryError();
            showStatusToast("请先填写 DeepSeek API Key", "info");
            return;
        }

        showScreen("loading-screen");
        this.updateLoadingDesc();
        this.setLoadingHint("");

        const grid = document.getElementById("loading-words-grid");
        if (grid) {
            grid.innerHTML = "";
            this.currentQueue.forEach(item => {
                const el = document.createElement("span");
                el.className = "bg-indigo-50 border border-indigo-100 text-indigo-700 text-xs px-3 py-1.5 rounded-full font-semibold flex items-center space-x-1";
                el.innerHTML = `<i class="fa-solid fa-bookmark text-[10px]"></i> <span>${item.word}</span>`;
                grid.appendChild(el);
            });
        }

        try {
            await StoryEngine.generateStory(this.currentQueue, this.difficulty);
            // 校验 AI 故事是否真的包含本轮目标词：
            // 模型偶尔漏词，导致"读的故事"和"考的单词"对不上，必须拦下
            if (!this.storyContainsTargetWords()) {
                console.warn("AI 故事未覆盖足够目标词，判定为无效输出");
                StoryEngine.lastError = { kind: "bad_payload", text: "模型漏掉了本轮目标词" };
                this.showStoryError();
                return;
            }
            this.renderStory();
        } catch (err) {
            console.error("Story generation failed:", err);
            this.showStoryError();
        }
    },

    // 校验生成的故事是否覆盖了本轮所有目标词（大小写不敏感）
    storyContainsTargetWords() {
        const story = StoryEngine.generatedStory;
        if (!story || !story.story) return false;
        const storyLower = (story.story + " " + (story.title || "")).toLowerCase();
        const targetWords = this.currentQueue.map(w => w.word.toLowerCase());
        // 至少要有「过半数」目标词出现在故事里，才认为故事有效；
        // 全部缺失或严重缺失 → 判定失败降级
        const hitCount = targetWords.filter(w => storyLower.includes(w)).length;
        return hitCount >= Math.ceil(targetWords.length / 2);
    },

    // 加载页副提示：重试过程中如实展示「正在重试」，减少用户的等待焦虑
    setLoadingHint(text) {
        const el = document.getElementById("loading-hint");
        if (!el) return;
        if (!text) {
            el.classList.add("hidden");
            el.textContent = "";
        } else {
            el.classList.remove("hidden");
            el.textContent = text;
        }
    },

    // 根据当前难度动态刷新加载页文案（词量随难度阶梯变化）
    updateLoadingDesc() {
        const el = document.getElementById("loading-desc");
        if (el) {
            el.innerHTML = `AI 正在将你刚积累的 <span class="text-indigo-600 font-bold" id="loading-words-count">${this.batchSize}个单词</span> 组装进一段生活画面感极强、句意简单的短文中，助你秒懂其用法。`;
        }
    },

    // 根据当前难度动态刷新欢迎页文案
    updateWelcomeDesc() {
        const el = document.getElementById("welcome-desc");
        if (el) {
            el.innerHTML = `先快速筛掉你已会的词，剩下的攒成 <span class="font-bold text-indigo-600">${this.batchSize}</span> 个一组，读一篇短文记住它们，再用填空考一遍。全对就不用再背了。`;
        }
    },

    // AI 生成失败时的处理：不再伪装成一篇"备用课文"。
    // 你要的是 AI 一定能用，那么失败就应该明确告诉你「哪一步错了、怎么修」，
    // 而不是给你一段读着还行、但根因被藏起来的内容。
    showStoryError() {
        const err = StoryEngine.lastError || { kind: "unknown", text: "未知错误" };
        showScreen("welcome-screen");

        const guides = {
            auth: {
                title: "API Key 有问题",
                detail: "没有填写 Key，或 Key 无效/已过期。",
                action: "点击右上角「AI 设置」重新填写 Key（sk- 开头），保存时会自动验证。",
            },
            billing: {
                title: "DeepSeek 账户余额不足",
                detail: "接口返回余额或权限错误。",
                action: "去 platform.deepseek.com 充值后重试。",
            },
            network: {
                title: "网络连不上 api.deepseek.com",
                detail: "请求根本没发出去，通常是 DNS 解析失败或代理未开启。",
                action: "检查网络/代理，浏览器直接打开 https://api.deepseek.com 看是否可达。",
            },
            timeout: {
                title: "生成超时",
                detail: "45 秒内没有返回结果，可能是网络太慢或模型负载高。",
                action: "点「重试」再试一次；若持续超时，检查代理速度。",
            },
            rate: {
                title: "请求过于频繁",
                detail: "短时间内调用次数超限。",
                action: "等 30 秒再点重试。",
            },
            bad_payload: {
                title: "模型返回内容无法解析",
                detail: "模型没有按要求返回 JSON（偶发）。",
                action: "点「重试」，换一批词通常就好。",
            },
        };
        const g = guides[err.kind] || {
            title: "AI 生成失败",
            detail: err.text || "未知错误",
            action: "点「重试」；若反复失败，查看浏览器控制台的 [deepseek] 日志。",
        };

        const box = document.getElementById("story-error-box");
        if (!box) return;
        box.innerHTML = `
            <div class="max-w-lg mx-auto bg-white rounded-3xl border border-slate-200 shadow-sm p-8 space-y-5">
                <div class="flex items-start gap-4">
                    <div class="w-11 h-11 rounded-2xl bg-rose-50 text-rose-500 flex items-center justify-center flex-shrink-0">
                        <i class="fa-solid fa-triangle-exclamation text-lg"></i>
                    </div>
                    <div class="space-y-1">
                        <h3 class="text-lg font-bold text-slate-900">${g.title}</h3>
                        <p class="text-sm text-slate-600 leading-relaxed">${g.detail}</p>
                    </div>
                </div>
                <div class="bg-slate-50 rounded-2xl p-4 space-y-1.5">
                    <div class="text-xs font-semibold text-slate-500 uppercase tracking-wider">怎么修</div>
                    <p class="text-sm text-slate-700 leading-relaxed">${g.action}</p>
                </div>
                <div class="text-xs text-slate-400 font-mono break-all">${(err.raw || err.text || "").slice(0, 200)}</div>
                <div class="flex items-center gap-2">
                    <button onclick="App.retryStoryGeneration()" class="flex-1 bg-indigo-600 hover:bg-indigo-700 text-white font-semibold py-3 rounded-xl transition text-sm">
                        <i class="fa-solid fa-rotate-right mr-1"></i> 重试
                    </button>
                    <button onclick="openAIKeyModal()" class="px-5 py-3 rounded-xl border border-slate-200 text-slate-700 hover:bg-slate-50 transition text-sm font-medium">
                        检查 Key
                    </button>
                </div>
            </div>`;
        box.classList.remove("hidden");
    },

    // 重试：保留当前队列，直接再生成一次
    retryStoryGeneration() {
        const box = document.getElementById("story-error-box");
        if (box) box.classList.add("hidden");
        if (!this.currentQueue || this.currentQueue.length === 0) {
            showStatusToast("生词队列已清空，请重新开始背词", "info");
            return;
        }
        this.triggerStoryGeneration();
    },

    // 把中文译文里每个生词对应的片段标绿。
    //
    // 为什么不能只靠词典匹配：词典里 translation 是「承认；告知已收到；感谢」这种多义串，
    // 而 AI 译文会根据语境写成「无法确认」「含糊不清」——精确匹配几乎必然失败，
    // 结果就是整篇译文只有零星一两个词能标上。
    // 所以主路径是让模型在生成译文时就带好 <span class="target-word">，
    // 这里负责：① 保住这些标记 ② 给漏标的词做语境兜底 ③ 统一视觉样式。
    markTranslationWords(html) {
        const styleOpen = (word, text) =>
            `<strong class="text-emerald-700 bg-emerald-50 rounded px-0.5" data-word="${_escapeAttr(word)}">${text}</strong>`;

        let out = String(html || "");

        // ① 模型已按约定标好的片段：补上统一样式（模型给的是 <span class="target-word">）
        out = out.replace(
            /<span[^>]*class="[^"]*target-word[^"]*"[^>]*data-word="([^"]*)"[^>]*>([\s\S]*?)<\/span>/gi,
            (_m, word, inner) => styleOpen(word, inner)
        );
        // 兼容 data-word 写在 class 前面的情况
        out = out.replace(
            /<span[^>]*data-word="([^"]*)"[^>]*class="[^"]*target-word[^"]*"[^>]*>([\s\S]*?)<\/span>/gi,
            (_m, word, inner) => styleOpen(word, inner)
        );

        // 已标出的生词集合（小写）
        const marked = new Set();
        out.replace(/<strong[^>]*data-word="([^"]*)"/gi, (_m, w) => { marked.add(String(w).toLowerCase()); return _m; });

        // ② 兜底：模型漏标的词，按「词典释义分词 + 译文语境」找回
        this.currentQueue.forEach(item => {
            const key = item.word.toLowerCase();
            if (marked.has(key)) return;

            const zhText = out.replace(/<[^>]+>/g, ""); // 已标部分的纯文本
            const candidates = this._zhCandidates(item, zhText);
            for (const cand of candidates) {
                const escaped = cand.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
                // 只在未标记的纯文本区域替换，避免破坏已有标签
                const re = new RegExp(`(${escaped})(?![^<]*>)`);
                if (re.test(out)) {
                    out = out.replace(re, (_m, hit) => styleOpen(item.word, hit));
                    marked.add(key);
                    break;
                }
            }
        });

        return out;
    },

    // 为一个生词生成「可能出现在译文里的中文候选」，按可信度排序
    _zhCandidates(item, zhText) {
        const list = [];
        const push = (s) => {
            const v = String(s || "").trim();
            if (v && v.length >= 1 && !list.includes(v)) list.push(v);
        };

        // 1) 词典释义按分号/逗号拆开，取最短的核心词（「承认；告知已收到；感谢」→ 承认）
        const parts = String(item.translation || "")
            .split(/[；;，,、\/]/)
            .map(s => s.replace(/[（(].*?[）)]/g, "").trim())
            .filter(Boolean);
        // 去掉「的」「地」结尾，中文译文里常写成"含糊不清的邮件"
        const stems = new Set();
        parts.forEach(p => {
            push(p);
            const stem = p.replace(/[的地]$/, "");
            if (stem) stems.add(stem);
        });
        stems.forEach(push);
        // 2) 英文原词（译文偶尔保留英文）
        push(item.word);

        // 3) 按是否真的出现在译文里重新排序，出现过的优先
        return list.sort((a, b) => {
            const inA = zhText.includes(a) ? 0 : 1;
            const inB = zhText.includes(b) ? 0 : 1;
            if (inA !== inB) return inA - inB;
            return a.length - b.length; // 短的去匹配更准
        }).filter(s => zhText.includes(s));
    },

    // 阅读页来源标识：让「AI 生成」和「本地兜底」一眼可分辨。
    // 这是产品可信度的一部分——用户不该在不知情的情况下把兜底课文当成 AI 输出。
    renderStorySourceBadge() {
        const el = document.getElementById("story-source-badge");
        if (!el) return;
        if (StorySource.isLocal()) {
            el.className = "mt-2 inline-flex items-center gap-1.5 text-xs font-semibold text-amber-700 bg-amber-50 border border-amber-200 px-3 py-1 rounded-full";
            el.innerHTML = `<i class="fa-solid fa-circle-exclamation"></i><span>备用课文 · 词库例句拼合（未调用 AI）</span>`;
        } else {
            el.className = "mt-2 inline-flex items-center gap-1.5 text-xs font-semibold text-emerald-700 bg-emerald-50 border border-emerald-200 px-3 py-1 rounded-full";
            el.innerHTML = `<i class="fa-solid fa-wand-magic-sparkles"></i><span>由 DeepSeek 依据本轮生词即时生成</span>`;
        }
    },

    renderStory() {
        showScreen("reading-screen");
        const story = StoryEngine.generatedStory;
        document.getElementById("story-title").innerText = story.title;
        document.getElementById("story-body").innerHTML = story.story;
        this.renderStorySourceBadge();

        // 处理中文译文：把每个生词在译文里对应的中文片段标绿
        let translationHtml = story.translation || "";
        if (!translationHtml.trim() || story._translationMissing) {
            // 译文缺失时给出明确提示，而不是留一片空白
            translationHtml = `<span class="text-rose-600">本篇译文缺失（模型未返回中文翻译），请点「清空并重新背词」重新生成一次。</span>`;
        } else {
            translationHtml = this.markTranslationWords(translationHtml);
        }
        document.getElementById("story-translation").innerHTML = translationHtml;

        const wrapper = document.getElementById("translation-wrapper");
        wrapper.classList.add("hidden", "opacity-0");
        wrapper.classList.add("translate-y-4");

        const revealBtn = document.getElementById("reveal-translation-btn");
        revealBtn.className = "bg-slate-800 hover:bg-slate-900 text-white font-semibold py-3 px-6 rounded-xl transition text-sm inline-flex items-center space-x-2 shadow-md";
        revealBtn.innerHTML = `<i class="fa-solid fa-lock-open"></i> <span>解除中文译文锁定</span>`;
        revealBtn.disabled = false;

        // 绑定单词点击事件
        document.querySelectorAll(".target-word").forEach(element => {
            element.addEventListener("click", (e) => {
                e.stopPropagation();
                const rawWord = e.target.getAttribute("data-word");
                openDefinitionModal(rawWord);
            });
        });
    },

    // === 通关挑战 ===
    startChallenge() {
        // 没有题目说明生成环节出了问题，回到诊断面板而不是硬闯进去
        if (!StoryEngine.startChallenge()) {
            this.showStoryError();
            return;
        }
        showScreen("challenge-screen");
        document.getElementById("cloze-card-tag").innerText = "CONTEXT CLOZE CHALLENGE";
        this.renderChallengeQuestion();
    },

    async startReviewChallenge() {
        if (!this._ready) {
            showStatusToast("数据加载中，请稍后再试...", "info");
            return;
        }
        const hasWords = await StoryEngine.startReviewChallenge();
        if (!hasWords) {
            showStatusToast("暂无需要复习的单词，请先去积累生词！", "info");
            return;
        }
        showScreen("challenge-screen");
        document.getElementById("cloze-card-tag").innerText = "ANTI-LUCK MASTERED REVIEW";
        this.renderChallengeQuestion();
    },

    renderChallengeQuestion() {
        const q = StoryEngine.getCurrentQuestion();
        if (!q) {
            this.showChallengeResults();
            return;
        }

        const total = StoryEngine.challengeQuestions.length;
        const idx = StoryEngine.currentQuestionIndex;
        document.getElementById("challenge-progress").innerText = `第 ${idx + 1} / ${total} 题`;
        document.getElementById("challenge-progress-bar").style.width = `${((idx + 1) / total) * 100}%`;
        // 把句子中的 _____ 替换为视觉下划线空白
        const sentenceHtml = (q.cloze_sentence || "").replace(
            /_{3,}/g,
            `<span class="inline-block min-w-[4.5rem] md:min-w-[6rem] h-[1.1em] border-b-2 border-slate-400 mx-1 align-bottom"></span>`
        );
        document.getElementById("challenge-question-text").innerHTML = sentenceHtml;

        const container = document.getElementById("challenge-options-container");
        container.innerHTML = "";

        q.options.forEach((opt, index) => {
            const label = String.fromCharCode(65 + index);
            const trans = q.options_translation ? q.options_translation[index] : "暂无解释";
            const button = document.createElement("button");
            button.className = "w-full text-left bg-slate-50 hover:bg-indigo-50/70 border border-slate-200 hover:border-indigo-300 rounded-2xl px-5 py-4 transition duration-300 flex flex-col group text-sm md:text-base shadow-sm relative overflow-hidden";
            button.onclick = () => this.submitChallengeAnswer(opt, button);
            button.innerHTML = `
                <div class="flex items-center justify-between w-full">
                    <div class="flex items-center space-x-3 text-left">
                        <span class="w-7 h-7 rounded-lg bg-slate-200 group-hover:bg-indigo-200 text-slate-700 group-hover:text-indigo-800 flex items-center justify-center font-bold text-xs">${label}</span>
                        <div class="flex flex-col">
                            <span class="text-slate-800 font-semibold tracking-wide">${opt}</span>
                            <span class="challenge-opt-trans text-xs font-medium text-slate-500 mt-1 max-h-0 opacity-0 overflow-hidden transition-all duration-500 block">
                                <i class="fa-solid fa-arrow-right-long text-[10px] mr-1 text-indigo-400"></i> ${trans}
                            </span>
                        </div>
                    </div>
                    <i class="fa-solid fa-circle-question text-slate-300 group-hover:text-indigo-400 text-sm transition duration-300"></i>
                </div>
            `;
            container.appendChild(button);
        });

        document.getElementById("challenge-next-btn").classList.add("hidden");
    },

    submitChallengeAnswer(selectedOpt, buttonEl) {
        const buttons = document.querySelectorAll("#challenge-options-container button");
        buttons.forEach(b => b.disabled = true);

        const result = StoryEngine.submitAnswer(selectedOpt);

        buttons.forEach(btn => {
            const optText = btn.querySelector("span.text-slate-800").innerText.trim();
            const icon = btn.querySelector("i");
            const badge = btn.querySelector("span:first-child");

            if (optText === result.correctAnswer) {
                btn.classList.add("bg-emerald-500/10", "border-emerald-500", "ring-2", "ring-emerald-200");
                badge.className = "w-7 h-7 rounded-lg bg-emerald-500 text-white flex items-center justify-center font-bold text-xs";
                icon.className = "fa-solid fa-circle-check text-emerald-500 text-base";
            } else if (optText === selectedOpt && !result.isCorrect) {
                btn.classList.add("bg-rose-500/10", "border-rose-500");
                badge.className = "w-7 h-7 rounded-lg bg-rose-500 text-white flex items-center justify-center font-bold text-xs";
                icon.className = "fa-solid fa-circle-xmark text-rose-500 text-base";
            } else {
                btn.classList.add("opacity-70");
            }
        });

        // 显示所有选项中文释义
        document.querySelectorAll(".challenge-opt-trans").forEach(label => {
            label.classList.remove("max-h-0", "opacity-0");
            label.classList.add("max-h-12", "opacity-100");
            if (label.closest("button").classList.contains("border-emerald-500")) {
                label.classList.remove("text-slate-500");
                label.classList.add("text-emerald-700", "font-semibold");
            }
        });

        document.getElementById("challenge-next-btn").classList.remove("hidden");
    },

    nextChallengeQuestion() {
        if (!StoryEngine.nextQuestion()) {
            this.showChallengeResults();
            return;
        }
        this.renderChallengeQuestion();
    },

    async showChallengeResults() {
        showScreen("challenge-result-screen");

        // 先更新 UI（立即显示结果，不等待 API）
        const mastered = StoryEngine.challengeResults.mastered;
        const restudy = StoryEngine.challengeResults.restudy;

        document.getElementById("result-mastered-count").innerText = mastered.length;
        document.getElementById("result-restudy-count").innerText = restudy.length;

        const masteredList = document.getElementById("result-mastered-list");
        masteredList.innerHTML = "";
        if (mastered.length === 0) {
            masteredList.innerHTML = `<p class="text-xs text-slate-400 italic">本次测试未有单词通过检测，加油！</p>`;
        } else {
            mastered.forEach(item => {
                const badge = document.createElement("span");
                badge.className = "bg-emerald-50 border border-emerald-100 text-emerald-800 text-xs px-3 py-1.5 rounded-full font-semibold";
                badge.innerText = item.word;
                masteredList.appendChild(badge);
            });
        }

        const restudyList = document.getElementById("result-restudy-list");
        restudyList.innerHTML = "";
        if (restudy.length === 0) {
            restudyList.innerHTML = `<p class="text-xs text-slate-400 italic">全对通过！所有词汇检测都非常牢固！</p>`;
        } else {
            restudy.forEach(item => {
                const badge = document.createElement("span");
                badge.className = "bg-rose-50 border border-rose-100 text-rose-800 text-xs px-3 py-1.5 rounded-full font-semibold";
                badge.innerText = item.word;
                restudyList.appendChild(badge);
            });
        }

        if (StoryEngine.isReviewMode) {
            document.getElementById("results-headline").innerText = "已掌握词汇 · 复习重验报告";
            document.getElementById("results-subline").innerText = "复习完毕！以下是本次词汇重测的真实结果：";
            document.getElementById("mastered-label-txt").innerText = "仍旧掌握 (保留进度)";
            document.getElementById("restudy-label-txt").innerText = "复习露馅 (扣回生词池)";
            document.getElementById("mastered-list-header").innerText = "经受住检验的熟词 (继续保持)";
            document.getElementById("restudy-list-header").innerText = "已作废并归为生词的词汇";
            document.getElementById("results-action-btn").setAttribute("onclick", "App.backToWelcome()");
            document.getElementById("results-action-btn").innerHTML = `<span>返回主界面</span><i class="fa-solid fa-house"></i>`;
        } else {
            document.getElementById("results-headline").innerText = "通关测评报告";
            document.getElementById("results-subline").innerText = "通过实际例句语境检测，你的真实掌握情况如下：";
            document.getElementById("mastered-label-txt").innerText = "已掌握 (过关)";
            document.getElementById("restudy-label-txt").innerText = "需重修 (保留)";
            document.getElementById("mastered-list-header").innerText = "完美掌握的单词（从生词表移除）";
            document.getElementById("restudy-list-header").innerText = "选错的单词（已回到生词池，下次继续学）";
            document.getElementById("results-action-btn").setAttribute("onclick", "App.backToWelcomeOrTesting()");
            document.getElementById("results-action-btn").innerHTML = `<span>继续积累生词</span><i class="fa-solid fa-rotate-left"></i>`;
        }

        // 后台保存结果到云端（不阻塞 UI）
        try {
            await StoryEngine.processResults();
        } catch (e) {
            console.error("保存云端进度失败:", e);
            showStatusToast("网络不稳定，进度将在下次同步时保存", "info");
        }

        this.knownWordsCount = Vocabulary.getMasteredWords().length;
        this.updateStatsUI();
    },

    backToWelcome() {
        StoryEngine.isReviewMode = false;
        showScreen("welcome-screen");
        this.updateStatsUI();
    },

    backToWelcomeOrTesting() {
        // 完形填空选错的词已标回 unknown（回到生词池），清空队列后直接回欢迎页，
        // 下次「开始筛选」时错词会和其他没学过的词一起被正常筛出。
        showScreen("welcome-screen");
        this.updateStatsUI();
    },

    // === 工具方法 ===
    updateStatsUI() {
        this.knownWordsCount = Vocabulary.getMasteredWords().length;
        document.getElementById("stats-known-count").innerText = this.knownWordsCount;
        document.getElementById("stats-unknown-count").innerText = this.unknownWordsCount;
        document.getElementById("stats-unfamiliar-queue").innerText = this.currentQueue.length;

        const welcomeReviewCount = document.getElementById("welcome-review-count");
        if (welcomeReviewCount) welcomeReviewCount.innerText = this.knownWordsCount;

        const badge = document.getElementById("queue-counter-badge");
        if (badge) badge.innerText = `${this.currentQueue.length} / ${this.batchSize} 个生词`;

        const progressBar = document.getElementById("queue-progress-bar");
        if (progressBar) {
            progressBar.style.width = `${Math.min((this.currentQueue.length / this.batchSize) * 100, 100)}%`;
        }

        const totalEl = document.getElementById("stats-unfamiliar-total");
        if (totalEl) totalEl.innerText = `/${this.batchSize}`;
    },

    async updateWelcomeUI() {
        // 云端统计已停用，直接用本机已掌握词数
        const mastered = Vocabulary.getMasteredWords().length;
        const knownEl = document.getElementById("stats-known-count");
        if (knownEl) knownEl.innerText = mastered;
        const welcomeReviewCount = document.getElementById("welcome-review-count");
        if (welcomeReviewCount) welcomeReviewCount.innerText = mastered;
    },

    // 登出
    async logout() {
        Auth.exitGuestMode();
        await Auth.signOut();
        window.location.href = "login.html";
    },

    // 游客切换到登录页（清除游客标记，进入完整账号流程）
    switchToLogin() {
        Auth.exitGuestMode();
        window.location.href = "login.html";
    },

    // 渲染右上角用户菜单（登录 / 游客两种形态）
    renderUserMenu(mode) {
        const slot = document.getElementById("user-menu-slot");
        if (!slot) return;
        if (mode === "guest") {
            slot.innerHTML = `
                <span class="bg-emerald-50 text-emerald-700 px-3 py-1.5 rounded-full font-medium text-xs flex items-center space-x-1">
                    <i class="fa-solid fa-user-secret text-[10px]"></i><span>游客模式</span>
                </span>
                <button onclick="App.switchToLogin()" class="text-xs bg-indigo-600 hover:bg-indigo-700 text-white font-medium px-3 py-1.5 rounded-lg transition" title="登录以云端保存进度">登录保存进度</button>`;
        } else {
            const email = Auth.currentUser?.email || "";
            slot.innerHTML = `
                <span id="user-email-display" class="text-xs text-slate-500 hidden md:inline">${email}</span>
                <button onclick="App.logout()" class="text-slate-400 hover:text-rose-500 transition p-2 rounded-lg hover:bg-slate-50" title="退出登录">
                    <i class="fa-solid fa-right-from-bracket text-lg"></i>
                </button>`;
        }
    },
};

// === 全局快捷函数 ===
// HTML 属性/文本转义（兜底课文里要拼接词条字段，避免引号打断标签）
function _escapeAttr(str) {
    return String(str == null ? "" : str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function showScreen(screenId) {
    const screens = ["welcome-screen", "testing-screen", "loading-screen", "reading-screen", "challenge-screen", "challenge-result-screen"];
    screens.forEach(s => {
        const el = document.getElementById(s);
        if (el) el.classList.add("hidden");
    });
    const target = document.getElementById(screenId);
    if (target) target.classList.remove("hidden");
    window.scrollTo({ top: 0, behavior: "smooth" });
}

// 页面加载完成后初始化
window.addEventListener("DOMContentLoaded", () => App.init());