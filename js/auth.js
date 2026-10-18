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
        // 本地已有可用的登录会话时，先按已登录处理，不必等网络。
        // 断网时 getSession 可能长时间挂起，会把整个应用卡在「数据加载中」，
        // 这是弱网/异地网络环境下最容易踩的坑。
        const localSession = this._localSession();
        if (localSession?.user) {
            this.currentUser = localSession.user;
            return "user";
        }
        try {
            const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("session timeout")), 6000));
            const { data: { session } } = await Promise.race([supabase.auth.getSession(), timeout]);
            if (session?.user) {
                this.currentUser = session.user;
                return "user";
            }
        } catch (e) {
            // 拿不到会话（断网/超时）→ 退化为游客，让用户仍能进入主流程
            console.warn("获取云端会话失败，按游客模式继续：", e?.message || e);
            this.isGuest = true;
            this.currentUser = null;
            return "guest";
        }
        return "none";
    },

    // 从 localStorage 读取本地缓存的会话（不发起网络请求）
    _localSession() {
        try {
            const raw = localStorage.getItem("sb-auth-token");
            if (!raw) return null;
            const parsed = JSON.parse(raw);
            return parsed?.currentSession || parsed?.session || null;
        } catch { return null; }
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