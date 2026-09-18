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

const StoryEngine = {
    generatedStory: null,
    challengeQuestions: [],
    currentQuestionIndex: 0,
    challengeResults: { mastered: [], restudy: [] },
    isReviewMode: false,

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
        const response = await fetch(EDGE_URL, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                // anon key（publishable，可公开）用于通过 Supabase 网关鉴权；
                // 真实 DeepSeek Key 仅在 Edge Function 服务端环境变量中，前端永不可见
                "apikey": typeof SUPABASE_ANON_KEY !== "undefined" ? SUPABASE_ANON_KEY : "",
                ...(token ? { "Authorization": `Bearer ${token}` } : {}),
            },
            body: JSON.stringify({
                action: "generate_story",
                words: words.map(w => w.word),
                difficulty: difficulty, // beginner | intermediate | advanced
                mode: Auth.isGuest ? "guest" : "user",
                // 文章边界：服务端读取后写入 prompt，强制短、简单、易读
                constraints: {
                    max_sentences: budget.max_sentences,
                    max_words_per_sentence: budget.max_words_per_sentence,
                    style: "simple",
                    tone: "daily",
                    no_dialogue: true,
                },
            }),
        });
        if (!response.ok) {
            throw new Error("AI 服务暂不可用，请稍后再试 (" + response.status + ")");
        }
        this.generatedStory = await response.json();
        return this.generatedStory;
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