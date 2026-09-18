// ============================================================
// 认证模块：处理注册、登录、登出、会话管理
// ============================================================

const Auth = {
    // 当前用户
    currentUser: null,
    // 游客模式标记（未登录但允许体验，进度仅存本机）
    isGuest: false,

    // 初始化：检查登录会话或游客模式
    // 返回值: "user" (已登录) | "guest" (游客) | "none" (未登录)
    async init() {
        // 游客模式优先：已显式选择过免费体验
        if (localStorage.getItem("lexiloop_guest") === "1") {
            this.isGuest = true;
            this.currentUser = null;
            return "guest";
        }
        const { data: { session } } = await supabase.auth.getSession();
        if (session?.user) {
            this.currentUser = session.user;
            return "user";
        }
        return "none";
    },

    // 进入游客模式（不连云端，进度仅存本机 localStorage）
    enterGuestMode() {
        localStorage.setItem("lexiloop_guest", "1");
        this.isGuest = true;
        this.currentUser = null;
    },

    // 退出游客模式
    exitGuestMode() {
        localStorage.removeItem("lexiloop_guest");
        this.isGuest = false;
    },

    // 监听认证状态变化（游客模式不监听，避免误跳转）
    onAuthStateChange(callback) {
        if (this.isGuest) return;
        supabase.auth.onAuthStateChange((_event, session) => {
            this.currentUser = session?.user || null;
            callback(this.currentUser);
        });
    },

    // 邮箱注册
    async signUp(email, password) {
        const { data, error } = await supabase.auth.signUp({ email, password });
        if (error) throw error;
        return data;
    },

    // 邮箱登录
    async signIn(email, password) {
        const { data, error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        this.currentUser = data.user;
        return data;
    },

    // Google OAuth 登录
    async signInWithGoogle() {
        const { data, error } = await supabase.auth.signInWithOAuth({
            provider: "google",
            options: {
                redirectTo: window.location.origin + "/index.html",
            },
        });
        if (error) throw error;
        return data;
    },

    // 登出
    async signOut() {
        const { error } = await supabase.auth.signOut();
        if (error) throw error;
        this.currentUser = null;
        this.isGuest = false;
        localStorage.removeItem("lexiloop_guest");
    },

    // 获取当前 session
    async getSession() {
        const { data: { session } } = await supabase.auth.getSession();
        return session;
    },
};