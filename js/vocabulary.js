// ============================================================
// 词库数据模块：词汇数据 + 本机进度持久化
//
// 2026-10 变更：云端账号体系随 Supabase 项目一起下线，
// 进度统一保存在浏览器 localStorage（键 lexiloop_guest_progress），
// 本文件不再发起任何网络请求。
// ============================================================

const Vocabulary = {
    // 本地词库
    database: [],

    // 初始化：直接装载内置词库
    async init() {
        this.database = [...IELTS_VOCABULARY_FULL];
    },

    // 获取已掌握的单词列表
    getMasteredWords() {
        return this.database.filter(w => w._status === "mastered");
    },

    // 间隔重复：SM-2 简化版，计算下次复习时间（天数）
    calculateNextReview(word, wasCorrect) {
        const correctCount = word._correctCount || 0;
        const wrongCount = word._wrongCount || 0;

        if (wasCorrect) {
            // 根据正确次数递增间隔：1天, 3天, 7天, 14天, 30天, 60天...
            const intervals = [0, 1, 3, 7, 14, 30, 60, 120];
            const idx = Math.min(correctCount + 1, intervals.length - 1);
            const days = intervals[idx];
            const nextDate = new Date();
            nextDate.setDate(nextDate.getDate() + days);
            return nextDate.toISOString();
        } else {
            // 答错：重置为 1 天后
            const nextDate = new Date();
            nextDate.setDate(nextDate.getDate() + 1);
            return nextDate.toISOString();
        }
    },

    // 获取需要复习的单词（温故知新）
    // 逻辑：复习词 = 已掌握（mastered）的词。优先取「已到复习时间」的，
    // 若到期词不足，则补入其他已掌握词，保证刚背完也能立刻「温故知新」，
    // 而不是死等间隔到期导致「暂无需要复习的单词」。
    async getDueReviewWords() {
        // 本机进度：取所有已掌握词，到期优先
        const now = new Date().toISOString();
        const mastered = this.database.filter(w => w._status === "mastered");
        const due = mastered.filter(w => !w._nextReview || w._nextReview <= now);
        const notDue = mastered.filter(w => w._nextReview && w._nextReview > now);
        return [...due, ...notDue]
            .map(w => ({ word: w.word, phonetic: w.phonetic, definition: w.definition, translation: w.translation }))
            .slice(0, 10);
    },

    // ── 本机进度持久化（localStorage）──
    saveGuestProgress() {
        try {
            const map = {};
            this.database.forEach(w => {
                map[w.word.toLowerCase()] = {
                    word: w.word,
                    status: w._status || "unknown",
                    correct_count: w._correctCount || 0,
                    wrong_count: w._wrongCount || 0,
                    last_reviewed_at: w._lastReviewed || null,
                    mastered_at: w._masteredAt || null,
                    next_review_at: w._nextReview || null,
                };
            });
            localStorage.setItem("lexiloop_guest_progress", JSON.stringify(map));
        } catch (e) {
            console.error("保存游客进度失败:", e);
        }
    },

    loadGuestProgress() {
        try {
            const raw = localStorage.getItem("lexiloop_guest_progress");
            if (!raw) return;
            const map = JSON.parse(raw);
            this.database.forEach(w => {
                const p = map[w.word.toLowerCase()];
                if (p) {
                    w._status = p.status || "unknown";
                    w._correctCount = p.correct_count || 0;
                    w._wrongCount = p.wrong_count || 0;
                    w._lastReviewed = p.last_reviewed_at || null;
                    w._masteredAt = p.mastered_at || null;
                    w._nextReview = p.next_review_at || null;
                } else {
                    w._status = "unknown";
                    w._correctCount = 0;
                    w._wrongCount = 0;
                    w._lastReviewed = null;
                    w._masteredAt = null;
                    w._nextReview = null;
                }
            });
        } catch (e) {
            console.error("读取游客进度失败:", e);
        }
    },

    // 筛选形似干扰词
    getSimilarWords(targetWord, count = 3) {
        let pool = this.database.filter(w => w.word.toLowerCase() !== targetWord.toLowerCase());

        pool.forEach(w => {
            let score = 0;
            if (w.word[0]?.toLowerCase() === targetWord[0]?.toLowerCase()) score += 15;
            if (w.word.slice(0, 2).toLowerCase() === targetWord.slice(0, 2).toLowerCase()) score += 20;
            if (w.word.slice(-2).toLowerCase() === targetWord.slice(-2).toLowerCase()) score += 8;
            score -= Math.abs(w.word.length - targetWord.length) * 2;
            w._tempScore = score;
        });

        pool.sort((a, b) => b._tempScore - a._tempScore);
        return pool.slice(0, count);
    },
};