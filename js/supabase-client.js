// ============================================================
// 轻量 Supabase 客户端（零外部依赖，纯 fetch 实现）
// 不依赖任何 CDN，在任何网络环境下都能正常工作
//
// ⚠️ 修复说明：
// 1. 添加了 token refresh 逻辑（原版缺失，导致 session 1小时后过期无法续期）
// 2. 需要替换下方 SUPABASE_URL 和 SUPABASE_ANON_KEY 为新项目的值
// ============================================================

// ========== 新项目配置 ==========
const SUPABASE_URL = "https://dzqcufhofhpyjuciakme.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_y5sOhcC4VHosGPRKtTN8lw_vpDKv4x0";
// ==========================================

// 轻量 Supabase 客户端
const supabase = {
    _refreshing: null, // 防止并发刷新

    _headers() {
        const h = {
            "apikey": SUPABASE_ANON_KEY,
            "Content-Type": "application/json",
        };
        const session = this._getSession();
        if (session?.access_token) {
            h["Authorization"] = `Bearer ${session.access_token}`;
        }
        return h;
    },

    _getSession() {
        try {
            const raw = localStorage.getItem("sb-auth-token");
            if (!raw) return null;
            const parsed = JSON.parse(raw);
            return parsed?.currentSession || parsed?.session || null;
        } catch { return null; }
    },

    _setSession(session) {
        if (session) {
            localStorage.setItem("sb-auth-token", JSON.stringify({
                currentSession: session,
                expiresAt: Date.now() + (session.expires_in || 3600) * 1000,
            }));
        } else {
            localStorage.removeItem("sb-auth-token");
        }
    },

    // Token refresh 逻辑（新增）
    async _refreshSession() {
        // 防止并发刷新
        if (this._refreshing) return this._refreshing;

        const session = this._getSession();
        if (!session?.refresh_token) {
            this._setSession(null);
            return null;
        }

        this._refreshing = (async () => {
            try {
                const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
                    method: "POST",
                    headers: {
                        "apikey": SUPABASE_ANON_KEY,
                        "Content-Type": "application/json",
                    },
                    body: JSON.stringify({ refresh_token: session.refresh_token }),
                });

                if (!res.ok) {
                    // 只有「明确无效」的 4xx（如 401/400 invalid refresh token）才清会话；
                    // 5xx 或网关错误属于服务端临时故障，清掉等于把用户踢下线
                    if (res.status >= 400 && res.status < 500) {
                        this._setSession(null);
                    }
                    return null;
                }

                const data = await res.json();
                this._setSession(data);
                return data;
            } catch (e) {
                // 网络异常 ≠ 凭证失效：保留本地会话，等下次网络恢复再刷新
                console.error("Token refresh failed (网络异常，保留本地会话):", e?.message || e);
                return null;
            } finally {
                this._refreshing = null;
            }
        })();

        return this._refreshing;
    },

    // 检查 token 是否即将过期，如果是则自动刷新
    async _ensureValidSession() {
        const session = this._getSession();
        if (!session?.access_token) return null;

        // 检查是否过期（提前 5 分钟刷新）
        const raw = localStorage.getItem("sb-auth-token");
        if (raw) {
            try {
                const parsed = JSON.parse(raw);
                const expiresAt = parsed?.expiresAt || 0;
                if (Date.now() >= expiresAt - 5 * 60 * 1000) {
                    // 即将过期，刷新 token
                    return await this._refreshSession();
                }
            } catch {}
        }

        return session;
    },

    auth: {
        async signUp({ email, password }) {
            const res = await fetch(`${SUPABASE_URL}/auth/v1/signup`, {
                method: "POST",
                headers: {
                    "apikey": SUPABASE_ANON_KEY,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({ email, password }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.msg || data.error_description || "注册失败");
            if (data.session) supabase._setSession(data.session);
            return { data, error: null };
        },

        async signInWithPassword({ email, password }) {
            const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
                method: "POST",
                headers: {
                    "apikey": SUPABASE_ANON_KEY,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({ email, password }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error_description || data.msg || "登录失败");
            supabase._setSession(data);
            return { data: { user: data.user, session: data }, error: null };
        },

        async signInWithOAuth({ provider, options }) {
            const redirectTo = options?.redirectTo || window.location.origin + "/index.html";
            const params = new URLSearchParams({
                provider,
                redirect_to: redirectTo,
            });
            window.location.href = `${SUPABASE_URL}/auth/v1/authorize?${params.toString()}`;
            return { data: {}, error: null };
        },

        async signOut() {
            const session = supabase._getSession();
            if (session?.access_token) {
                await fetch(`${SUPABASE_URL}/auth/v1/logout`, {
                    method: "POST",
                    headers: {
                        "apikey": SUPABASE_ANON_KEY,
                        "Authorization": `Bearer ${session.access_token}`,
                    },
                }).catch(() => {});
            }
            supabase._setSession(null);
            return { error: null };
        },

        async getSession() {
            const session = supabase._getSession();
            if (!session?.access_token) return { data: { session: null }, error: null };

            // 先尝试用现有 token 验证。
            // ⚠️ 关键修复：网络失败（DNS 不通/断网/代理抖动）时 fetch 会抛异常，
            // 原实现没有 try/catch，异常直接冒泡；即便被上层吞掉，下面也会走到
            // _setSession(null) 把本地登录态清空 —— 用户表现为「一开始还好，后来自动退出登录」。
            // 正确做法：分不清是「token 失效」还是「网络不通」时，保留本地会话。
            let res;
            try {
                res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
                    headers: {
                        "apikey": SUPABASE_ANON_KEY,
                        "Authorization": `Bearer ${session.access_token}`,
                    },
                });
            } catch (e) {
                // 网络层失败：保留会话，返回本地缓存的用户信息
                console.warn("会话校验请求失败（网络异常），沿用本地会话：", e?.message || e);
                return { data: { session }, error: null };
            }

            if (res.ok) {
                const user = await res.json();
                return { data: { session: { ...session, user } }, error: null };
            }

            // token 过期，尝试 refresh
            if (res.status === 401 && session.refresh_token) {
                const newSession = await supabase._refreshSession();
                if (newSession) {
                    try {
                        const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
                            headers: {
                                "apikey": SUPABASE_ANON_KEY,
                                "Authorization": `Bearer ${newSession.access_token}`,
                            },
                        });
                        if (userRes.ok) {
                            const user = await userRes.json();
                            return { data: { session: { ...newSession, user } }, error: null };
                        }
                    } catch (e) {
                        // 刷新成功但校验请求网络失败：仍然保留刷新后的会话
                        return { data: { session: newSession }, error: null };
                    }
                }
                // 401 已明确说明凭证无效 → 此时清空才是正确的
                supabase._setSession(null);
                return { data: { session: null }, error: null };
            }

            // 其他非 401 状态（5xx / 网关错误）：服务端问题，不代表用户登录失效 → 保留会话
            console.warn("会话校验返回异常状态", res.status, "，保留本地会话");
            return { data: { session }, error: null };
        },

        async getUser() {
            const { data } = await this.getSession();
            return { data: { user: data?.session?.user || null }, error: null };
        },

        onAuthStateChange(callback) {
            // 简化版：监听 storage 变化
            window.addEventListener("storage", async (e) => {
                if (e.key === "sb-auth-token") {
                    const { data } = await this.getSession();
                    callback(data?.session?.user || null);
                }
            });
        },
    },

    from(table) {
        const self = this;
        return {
            _url: `${SUPABASE_URL}/rest/v1/${table}`,
            _filters: "",
            _headers: {},

            select(columns = "*") {
                this._method = "GET";
                this._select = columns;
                return this;
            },
            insert(rows) {
                this._method = "POST";
                this._body = rows;
                this._headers["Prefer"] = "return=minimal";
                return this;
            },
            upsert(rows, opts = {}) {
                this._method = "POST";
                this._body = rows;
                this._headers["Prefer"] = "resolution=merge-duplicates";
                if (opts.onConflict) {
                    this._url += `?on_conflict=${opts.onConflict}`;
                }
                return this;
            },
            eq(column, value) {
                this._filters += (this._filters ? "&" : "?") + `${column}=eq.${encodeURIComponent(value)}`;
                return this;
            },
            lte(column, value) {
                this._filters += (this._filters ? "&" : "?") + `${column}=lte.${encodeURIComponent(value)}`;
                return this;
            },
            order(column, opts = {}) {
                const dir = opts.ascending === false ? "desc" : "asc";
                this._filters += (this._filters ? "&" : "?") + `order=${column}.${dir}`;
                if (opts.nullsFirst) this._filters += ".nullsfirst";
                return this;
            },
            limit(n) {
                this._filters += (this._filters ? "&" : "?") + `limit=${n}`;
                return this;
            },
            single() {
                this._headers["Accept"] = "application/vnd.pgrst.object+json";
                return this;
            },

            async _execute() {
                // 执行前确保 token 有效
                await supabase._ensureValidSession();

                let url = this._url;
                if (this._select) {
                    const sep = url.includes("?") ? "&" : "?";
                    url += `${sep}select=${encodeURIComponent(this._select)}`;
                }
                url += this._filters;

                const headers = { ...supabase._headers(), ...this._headers };
                const opts = { method: this._method || "GET", headers };
                if (this._body) opts.body = JSON.stringify(this._body);

                let res = await fetch(url, opts);

                // 如果 401，尝试 refresh 后重试一次
                if (res.status === 401) {
                    const newSession = await supabase._refreshSession();
                    if (newSession) {
                        const retryHeaders = { ...supabase._headers(), ...this._headers };
                        const retryOpts = { method: this._method || "GET", headers: retryHeaders };
                        if (this._body) retryOpts.body = JSON.stringify(this._body);
                        res = await fetch(url, retryOpts);
                    }
                }

                if (res.status === 204 || res.headers.get("content-length") === "0") {
                    return { data: null, error: null };
                }

                const text = await res.text();
                if (!text) return { data: null, error: null };

                try {
                    const data = JSON.parse(text);
                    if (!res.ok) throw new Error(data.message || "Database error");
                    return { data, error: null };
                } catch (e) {
                    if (!res.ok) throw new Error("Database error: " + res.status);
                    return { data: null, error: null };
                }
            },

            // 让最终调用自动触发执行
            then(resolve, reject) {
                return this._execute().then(({ data, error }) => {
                    if (error) reject(error);
                    else resolve(data);
                });
            },
        };
    },
};
