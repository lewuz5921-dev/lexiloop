// ============================================================
// 认证模块
//
// 2026-10 变更：Supabase 项目已被平台回收（域名 NXDOMAIN），
// 云端账号体系不再可用。当前版本统一按「本机账号」运行：
//   - 进度保存在 localStorage，换设备不漫游
//   - 登录页保留品牌与形态，但不再请求远端
// 若日后后台恢复，再把 supabase 调用接回来即可。
// ============================================================

const Auth = {
    // 当前用户
    currentUser: null,
    // 游客模式标记（未登录但允许体验，进度仅存本机）
    isGuest: false,

    // 初始化：本地场景下始终可用，绝不因为网络问题卡住页面
    async init() {
        if (localStorage.getItem("lexiloop_guest") === "1") {
            this.isGuest = true;
            this.currentUser = null;
            return "guest";
        }
        // 无云端后端：未显式选择游客时，也直接以「本机模式」进入，
        // 避免用户被送到一个登录页却根本登不上
        this.isGuest = true;
        try { localStorage.setItem("lexiloop_guest", "1"); } catch {}
        return "guest";
    },

    // 进入游客模式（进度仅存本机 localStorage）
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

    // 云端认证已停用，保留空实现以免调用处报错
    onAuthStateChange() {},
    async signUp() { throw new Error("账号系统暂不可用，请直接使用本机模式"); },
    async signIn() { throw new Error("账号系统暂不可用，请直接使用本机模式"); },
    async signInWithGoogle() { throw new Error("账号系统暂不可用，请直接使用本机模式"); },
    async signOut() {
        this.currentUser = null;
        this.isGuest = false;
        localStorage.removeItem("lexiloop_guest");
    },
    async getSession() { return null; },
};