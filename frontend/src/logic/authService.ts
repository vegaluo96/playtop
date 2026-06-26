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

export function register(email: string, password: string, inviteCode = ""): Promise<AuthResult> {
  return postJSON("/api/auth/register", { email, password, invite_code: inviteCode });
}

/** 修改密码（需登录）。 */
export async function changePassword(newPassword: string): Promise<{ ok: boolean; error?: string }> {
  const tok = getToken();
  if (!tok) return { ok: false, error: "请先登录" };
  try {
    const r = await fetch(BASE + "/api/auth/change-password", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + tok },
      body: JSON.stringify({ new_password: newPassword }),
    });
    return (await r.json()) as { ok: boolean; error?: string };
  } catch {
    return { ok: false, error: "网络错误，请稍后再试" };
  }
}

/** 公开角色列表（含运营新建、剔除已删除）。失败 → null（前端用内置 5 个）。 */
export async function getCharacters(): Promise<any[] | null> {
  try {
    const r = await fetch(BASE + "/api/characters");
    if (!r.ok) return null;
    const j = await r.json();
    return j.ok && Array.isArray(j.characters) ? j.characters : null;
  } catch {
    return null;
  }
}

/** 本 IP 剩余游客试用秒（刷新不重置）。失败 → null。 */
export async function getGuestTrial(): Promise<number | null> {
  try {
    const r = await fetch(BASE + "/api/guest-trial");
    if (!r.ok) return null;
    const j = await r.json();
    return j.ok ? (j.remaining_seconds as number) : null;
  } catch {
    return null;
  }
}

/** 我的邀请概况：{code, invited, reward_seconds, reward_minutes}。未登录/失败 → null。 */
export async function getInvite(): Promise<{ code: string; invited: number; reward_seconds: number; reward_minutes?: number } | null> {
  const j = await getJSON("/api/invite");
  return j && j.ok ? j.invite : null;
}

/** 角色音色试听 WAV 地址（真实 TTS 合成，非占位动画）。带 voiceId 则试听该指定音色，否则角色默认。 */
export function voicePreviewUrl(characterId: string, voiceId = ""): string {
  let u = BASE + "/api/voice-preview?c=" + encodeURIComponent(characterId || "");
  if (voiceId) u += "&v=" + encodeURIComponent(voiceId);
  return u;
}

export interface Voice { voice_id: string; name: string; gender: string; group: string; lang?: string; engine?: string; }

/** 真实可选音色库（MiniMax 系统音色）+ 我每个角色已选音色（登录才有 mine，跨设备一致）。失败 → null。 */
export async function getVoices(): Promise<{ voices: Voice[]; mine: Record<string, string> } | null> {
  try {
    const tok = getToken();
    const r = await fetch(BASE + "/api/voices", tok ? { headers: { Authorization: "Bearer " + tok } } : undefined);
    if (!r.ok) return null;
    const j = await r.json();
    if (!j || !j.ok || !Array.isArray(j.voices)) return null;
    return { voices: j.voices as Voice[], mine: (j.mine && typeof j.mine === "object") ? j.mine : {} };
  } catch { return null; }
}

/** 设定本账号某角色的音色（账号级、跨设备一致，下一通即生效）。需登录。返回是否成功。 */
export async function setUserVoice(characterId: string, voiceId: string): Promise<boolean> {
  const tok = getToken();
  if (!tok || !characterId || !voiceId) return false;
  try {
    const r = await fetch(BASE + "/api/voice", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + tok },
      body: JSON.stringify({ character_id: characterId, voice_id: voiceId }),
    });
    if (r.ok) { const d = await r.json(); return !!(d && d.ok); }
  } catch { /* noop */ }
  return false;
}

/** 自定义音色：一句话描述 → 后端 LLM 在免费音色库里匹配一个真实 voice_id（含名称/性别）。 */
export async function matchVoice(desc: string): Promise<Voice | null> {
  const tok = getToken();
  if (!tok || !desc.trim()) return null;
  try {
    const r = await fetch(BASE + "/api/voice-match", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + tok },
      body: JSON.stringify({ desc: desc.trim() }),
    });
    if (r.ok) { const d = await r.json(); if (d && d.ok && d.voice) return d.voice as Voice; }
  } catch { /* noop */ }
  return null;
}

/** 后台配置的邀请奖励（分钟）—— 公开接口，登录与否都返回真实值。失败 → null。 */
export async function getInviteReward(): Promise<number | null> {
  try {
    const r = await fetch(BASE + "/api/invite-reward");
    if (!r.ok) return null;
    const j = await r.json();
    return j && j.ok && typeof j.reward_minutes === "number" ? j.reward_minutes : null;
  } catch { return null; }
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
/** 用户端删除（隐藏）通话记录：账号级、跨设备一致（后台统计不受影响）。返回是否成功。 */
export async function deleteCalls(ids: number[]): Promise<boolean> {
  const tok = getToken();
  if (!tok || !ids || !ids.length) return false;
  try {
    const r = await fetch(BASE + "/api/calls/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + tok },
      body: JSON.stringify({ ids }),
    });
    if (r.ok) { const d = await r.json(); return !!(d && d.ok); }
  } catch { /* noop */ }
  return false;
}
/** 账单流水。未登录/失败 → null。 */
export async function getBills(): Promise<any[] | null> {
  const j = await getJSON("/api/bills");
  return j && j.ok ? j.bills : null;
}

/** 我的工单（后端原始形状，UI 映射）。未登录/失败 → null（退回演示）。 */
export async function getTickets(): Promise<any[] | null> {
  const j = await getJSON("/api/tickets");
  return j && j.ok ? j.tickets : null;
}
/** 提交工单。需登录。 */
export async function submitTicket(type: string, message: string): Promise<{ ok: boolean; error?: string }> {
  const tok = getToken();
  if (!tok) return { ok: false, error: "请先登录" };
  try {
    const r = await fetch(BASE + "/api/tickets", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + tok },
      body: JSON.stringify({ type, message }),
    });
    return (await r.json()) as { ok: boolean; error?: string };
  } catch {
    return { ok: false, error: "网络错误，请稍后再试" };
  }
}

export interface RedeemResult { ok: boolean; error?: string; message?: string; remaining_seconds?: number; }

/** 核销兑换码 → 后端入账，返回新余额。需登录。 */
export async function redeem(code: string): Promise<RedeemResult> {
  const tok = getToken();
  if (!tok) return { ok: false, error: "请先登录" };
  try {
    const r = await fetch(BASE + "/api/redeem", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + tok },
      body: JSON.stringify({ code }),
    });
    return (await r.json()) as RedeemResult;
  } catch {
    return { ok: false, error: "网络错误，请稍后再试" };
  }
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
