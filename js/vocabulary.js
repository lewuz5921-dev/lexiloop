// ============================================================
// 词库数据模块：词汇数据 + 云端进度同步
// ============================================================

const Vocabulary = {
    // 本地词库（从云端加载后合并）
    database: [],

    // 初始化：本地词库立即可用，云端同步后台执行
    async init() {
        this.database = [...IELTS_VOCABULARY_FULL];
        // 云端同步不阻塞，后台静默执行
        this.syncProgress();
    },

    // 从云端加载用户对每个词的掌握状态（后台静默）
    async syncProgress() {
        if (!Auth.currentUser) return;

        try {
            const { data } = await supabase
                .from("word_progress")
                .select("*")
                .eq("user_id", Auth.currentUser.id);

            const progressMap = {};
            (data || []).forEach(p => { progressMap[p.word.toLowerCase()] = p; });

            this.database.forEach(word => {
                const cloud = progressMap[word.word.toLowerCase()];
                if (cloud) {
                    word._status = cloud.status;
                    word._correctCount = cloud.correct_count;
                    word._wrongCount = cloud.wrong_count;
                    word._lastReviewed = cloud.last_reviewed_at;
                    word._masteredAt = cloud.mastered_at;
                    word._nextReview = cloud.next_review_at;
                } else {
                    word._status = "unknown";
                    word._correctCount = 0;
                    word._wrongCount = 0;
                    word._lastReviewed = null;
                    word._masteredAt = null;
                    word._nextReview = null;
                }
            });
        } catch (e) {
            console.error("后台同步进度失败:", e);
        }
    },

    // 获取已掌握的单词列表
    getMasteredWords() {
        return this.database.filter(w => w._status === "mastered");
    },

    // 获取当前生词队列（从数据库中读取 learning 状态的词）
    async getLearningQueue() {
        if (!Auth.currentUser) return [];
        const { data } = await supabase
            .from("word_progress")
            .select("*")
            .eq("user_id", Auth.currentUser.id)
            .eq("status", "learning");
        return data || [];
    },

    // 更新单个词的掌握状态（同步到云端）
    async updateWordProgress(word, updates) {
        if (!Auth.currentUser) return;

        const { error } = await supabase
            .from("word_progress")
            .upsert({
                user_id: Auth.currentUser.id,
                word: word.word,
                phonetic: word.phonetic,
                definition: word.definition,
                translation: word.translation,
                status: updates.status || word._status || "unknown",
                correct_count: updates.correctCount ?? word._correctCount ?? 0,
                wrong_count: updates.wrongCount ?? word._wrongCount ?? 0,
                last_reviewed_at: updates.lastReviewed || new Date().toISOString(),
                mastered_at: updates.status === "mastered" ? new Date().toISOString() : word._masteredAt,
                next_review_at: updates.nextReview || null,
            }, { onConflict: "user_id, word" });

        if (error) {
            console.error("Failed to update word progress:", error);
            return;
        }

        // 同步更新本地
        word._status = updates.status || word._status;
        word._correctCount = updates.correctCount ?? word._correctCount;
        word._wrongCount = updates.wrongCount ?? word._wrongCount;
        word._lastReviewed = updates.lastReviewed || new Date().toISOString();
        if (updates.status === "mastered") word._masteredAt = new Date().toISOString();
        word._nextReview = updates.nextReview || null;
    },

    // 批量更新单词进度
    async batchUpdateProgress(words, status) {
        if (!Auth.currentUser || words.length === 0) return;

        const rows = words.map(w => ({
            user_id: Auth.currentUser.id,
            word: w.word,
            phonetic: w.phonetic || "",
            definition: w.definition || "",
            translation: w.translation || "",
            status: status,
            last_reviewed_at: new Date().toISOString(),
            mastered_at: status === "mastered" ? new Date().toISOString() : null,
        }));

        const { error } = await supabase
            .from("word_progress")
            .upsert(rows, { onConflict: "user_id, word" });

        if (error) {
            console.error("Failed to batch update:", error);
        }
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
        if (Auth.currentUser) {
            // 已登录：从云端拉取所有已掌握词
            try {
                const { data } = await supabase
                    .from("word_progress")
                    .select("*")
                    .eq("user_id", Auth.currentUser.id)
                    .eq("status", "mastered")
                    .order("next_review_at", { ascending: true, nullsFirst: true });
                const all = data || [];
                const now = new Date().toISOString();
                // 到期的排前面，未到期的排后面，一起作为复习词源
                const due = all.filter(p => !p.next_review_at || p.next_review_at <= now);
                const notDue = all.filter(p => p.next_review_at && p.next_review_at > now);
                return [...due, ...notDue].slice(0, 10);
            } catch (e) {
                console.error("获取复习词失败:", e);
                return [];
            }
        }
        if (Auth.isGuest) {
            // 游客：从本机进度取所有已掌握词，到期优先
            const now = new Date().toISOString();
            const mastered = this.database.filter(w => w._status === "mastered");
            const due = mastered.filter(w => !w._nextReview || w._nextReview <= now);
            const notDue = mastered.filter(w => w._nextReview && w._nextReview > now);
            return [...due, ...notDue]
                .map(w => ({ word: w.word, phonetic: w.phonetic, definition: w.definition, translation: w.translation }))
                .slice(0, 10);
        }
        return [];
    },

    // ── 游客模式：本机进度持久化（localStorage）──
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