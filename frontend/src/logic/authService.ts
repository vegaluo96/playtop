// 用户账号 HTTP 客户端（注册/登录/me/登出）。token 存 localStorage，跨刷新保持登录态。
// 生产同源经 nginx 反代 /api/ → 后端 userapi；开发可设 VITE_API_BASE 指向后端（CLAUDE.md 铁律2）。
const BASE = ((import.meta.env?.VITE_API_BASE as string) || "").replace(/\/$/, "");
const TOKEN_KEY = "micall_token";

export interface AuthUser {
  user_id: string;
  email: string;
  display_name: string;
  remaining_seconds: number;
}
export interface AuthResult {
  ok: boolean;
  error?: string;
  token?: string;
  user?: AuthUser;
}

export function getToken(): string {
  try { return localStorage.getItem(TOKEN_KEY) || ""; } catch { return ""; }
}
export function setToken(t: string): void {
  try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); } catch { /* noop */ }
}

/** 接了真实后端才打真接口；纯演示（未配端点）退回前端假登录，保留 Mock 体验。 */
export function authConfigured(): boolean {
  const env = import.meta.env || {};
  return !!((env.VITE_API_BASE && String(env.VITE_API_BASE).trim()) ||
            (env.VITE_SIGNALING_URL && String(env.VITE_SIGNALING_URL).trim()));
}

async function postJSON(path: string, body: unknown): Promise<AuthResult> {
  try {
    const r = await fetch(BASE + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return (await r.json()) as AuthResult;
  } catch {
    return { ok: false, error: "网络错误，请稍后再试" };
  }
}

export function register(email: string, password: string): Promise<AuthResult> {
  return postJSON("/api/auth/register", { email, password });
}
export function login(email: string, password: string): Promise<AuthResult> {
  return postJSON("/api/auth/login", { email, password });
}

export async function logout(): Promise<void> {
  const tok = getToken();
  if (tok) {
    try {
      await fetch(BASE + "/api/auth/logout", {
        method: "POST",
        headers: { Authorization: "Bearer " + tok },
      });
    } catch { /* 即便后端不可达也清本地 */ }
  }
  setToken("");
}

async function getJSON(path: string): Promise<any | null> {
  const tok = getToken();
  if (!tok) return null;
  try {
    const r = await fetch(BASE + path, { headers: { Authorization: "Bearer " + tok } });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

/** 通话历史（后端原始形状，由 UI 层映射）。未登录/失败 → null（UI 退回演示数据）。 */
export async function getCalls(): Promise<any[] | null> {
  const j = await getJSON("/api/calls");
  return j && j.ok ? j.calls : null;
}
/** 账单流水。未登录/失败 → null。 */
export async function getBills(): Promise<any[] | null> {
  const j = await getJSON("/api/bills");
  return j && j.ok ? j.bills : null;
}

/** 刷新后用存的 token 恢复登录态；token 失效（401）则清掉。 */
export async function me(): Promise<AuthUser | null> {
  const tok = getToken();
  if (!tok) return null;
  try {
    const r = await fetch(BASE + "/api/auth/me", { headers: { Authorization: "Bearer " + tok } });
    if (!r.ok) { if (r.status === 401) setToken(""); return null; }
    const j = await r.json();
    return j.ok ? (j.user as AuthUser) : null;
  } catch {
    return null;
  }
}
