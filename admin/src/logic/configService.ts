// API 接口配置（endpoint / key / 模型参数）的持久化层。
//
// 这是 CLAUDE.md 铁律2 的落地：ASR/LLM/TTS 等节点的 endpoint 与 key 全部走配置、
// 可在线切换（「先走 apiyi、卡了切直连」靠改这里，不动对话逻辑）。后台「接口配置」
// 页是这份配置的编辑界面，后端实时管线是它的消费者。
//
// 两种后端：
//   • 配置了 VITE_API_BASE：走后端 REST（GET/PUT /admin/api-config）。**生产用这条**
//     ——密钥存服务端、读取时由后端打码，浏览器永不持久化明文密钥。
//   • 未配置：落 localStorage，方便无后端时本地把配置功能跑通（dev/演示）。
//
// ⚠️ 安全：localStorage 持久化仅供本地联调。生产务必配置 VITE_API_BASE，让密钥留在
//    服务端；不要把真实 key 长期存在浏览器里。

import { authToken } from "./auth";

export type ApiConfig = Record<string, Record<string, string>>;

const LS_KEY = "micall_admin_api_cfg";

function base(): string {
  // optional chaining keeps this safe outside Vite (tests / SSR)
  return (import.meta.env?.VITE_API_BASE || "").trim();
}

/** 是否走真实后端（决定密钥落地位置）。 */
export function usingBackend(): boolean {
  return !!base();
}

/** 带上登录 token 的请求头（接后端后由 /admin/login 发放）。 */
function authHeaders(json = false): Record<string, string> {
  const h: Record<string, string> = {};
  if (json) h["Content-Type"] = "application/json";
  const t = authToken();
  if (t && t !== "dev") h["Authorization"] = "Bearer " + t;
  return h;
}

/** 读取已保存的配置；无则返回 null（调用方回退到内置默认）。 */
export async function loadApiConfig(): Promise<ApiConfig | null> {
  const b = base();
  if (b) {
    try {
      const r = await fetch(`${b}/admin/api-config`, { credentials: "include", headers: authHeaders() });
      if (r.ok) return (await r.json()) as ApiConfig;
    } catch {
      /* 网络/后端不可用：保持默认，不阻塞页面 */
    }
    return null;
  }
  try {
    const raw = localStorage.getItem(LS_KEY);
    return raw ? (JSON.parse(raw) as ApiConfig) : null;
  } catch {
    return null;
  }
}

/** 保存整份配置；返回是否成功。 */
export async function saveApiConfig(cfg: ApiConfig): Promise<boolean> {
  const b = base();
  if (b) {
    try {
      const r = await fetch(`${b}/admin/api-config`, {
        method: "PUT",
        headers: authHeaders(true),
        credentials: "include",
        body: JSON.stringify(cfg),
      });
      return r.ok;
    } catch {
      return false;
    }
  }
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(cfg));
    return true;
  } catch {
    return false;
  }
}

// ── 后台「角色管理」：出厂角色 spec 的可编辑字段（人设/说话风格/喜好/音色）持久化 ──
export type CharEdit = Record<string, string>;

/** 读取出厂角色（含后台覆盖）的可编辑字段；无后端 → null（页面用内置 mock）。 */
export async function loadCharacters(): Promise<CharEdit[] | null> {
  const b = base();
  if (!b) return null;
  try {
    const r = await fetch(`${b}/admin/characters`, { credentials: "include", headers: authHeaders() });
    if (r.ok) {
      const data = (await r.json()) as { characters?: CharEdit[] };
      return data.characters || [];
    }
  } catch {
    /* 网络/后端不可用：用内置 mock，不阻塞 */
  }
  return null;
}

/** 保存某角色改动（白名单字段，需带 id）；无后端时乐观返回 true（演示用）。 */
export async function saveCharacter(payload: CharEdit): Promise<boolean> {
  const b = base();
  if (!b) return true;
  try {
    const r = await fetch(`${b}/admin/characters`, {
      method: "PUT",
      headers: authHeaders(true),
      credentials: "include",
      body: JSON.stringify(payload),
    });
    return r.ok;
  } catch {
    return false;
  }
}

// ── 后台看板真实数据（P4）：有后端则拉 DB 聚合，无后端/失败 → null（页面用内置演示数据）──
async function getList(path: string, key: string): Promise<any[] | null> {
  const b = base();
  if (!b) return null;
  try {
    const r = await fetch(`${b}${path}`, { credentials: "include", headers: authHeaders() });
    if (r.ok) {
      const d = (await r.json()) as Record<string, any>;
      if (d && d.ok) return (d[key] as any[]) || [];
    }
  } catch {
    /* 网络/后端不可用：退回演示数据 */
  }
  return null;
}

/** 首页 KPI + 热门角色 + 趋势 + 每角色通话数。无后端/失败 → null。 */
export async function loadDashboard(): Promise<{ stats: any; top_characters: any[]; trends: any; char_calls: any } | null> {
  const b = base();
  if (!b) return null;
  try {
    const r = await fetch(`${b}/admin/stats`, { credentials: "include", headers: authHeaders() });
    if (r.ok) {
      const d = (await r.json()) as Record<string, any>;
      if (d && d.ok) return { stats: d.stats || {}, top_characters: d.top_characters || [],
                              trends: d.trends || null, char_calls: d.char_calls || null };
    }
  } catch {
    /* 退回演示 */
  }
  return null;
}

export const loadUsers = () => getList("/admin/users", "users");
export const loadCalls = () => getList("/admin/calls", "calls");
export const loadOrders = () => getList("/admin/orders", "orders");
export const loadTickets = () => getList("/admin/tickets", "tickets");
export const loadInvites = () => getList("/admin/invites", "invites");
export const loadRedeemCodes = () => getList("/admin/redeem-codes", "codes");

/** 批量生成兑换码，返回码数组（无后端返回 null）。 */
export async function genRedeemCodes(count: number, minutes: number): Promise<string[] | null> {
  const b = base();
  if (!b) return null;
  try {
    const r = await fetch(`${b}/admin/redeem-codes`, {
      method: "POST", headers: authHeaders(true), credentials: "include",
      body: JSON.stringify({ count, minutes }),
    });
    if (r.ok) { const d = await r.json(); if (d && d.ok) return d.codes || []; }
  } catch {
    /* noop */
  }
  return null;
}

/** 回复工单（后台）。返回是否成功。 */
export async function replyTicket(id: any, reply: string): Promise<boolean> {
  const b = base();
  if (!b) return false;
  try {
    const r = await fetch(`${b}/admin/tickets/reply`, {
      method: "POST", headers: authHeaders(true), credentials: "include",
      body: JSON.stringify({ id, reply }),
    });
    if (r.ok) { const d = await r.json(); return !!(d && d.ok); }
  } catch {
    /* noop */
  }
  return false;
}

/** 连通性测试结果：ok=null 表示无后端（未知）；失败时 error 带出后端真因（1004/2049 等）。 */
export type TestResult = { ok: boolean | null; error?: string; ms?: number; note?: string };

/** 连通性测试。有后端则让后端实测该节点；无后端时本地无法跨域直连，返回 ok=null（未知）。 */
export async function testApiSection(sectionKey: string, cfg: Record<string, string>): Promise<TestResult> {
  const b = base();
  if (!b) return { ok: null };
  try {
    const r = await fetch(`${b}/admin/api-config/test`, {
      method: "POST",
      headers: authHeaders(true),
      credentials: "include",
      body: JSON.stringify({ section: sectionKey, config: cfg }),
    });
    if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
    const data = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string; ms?: number; note?: string };
    return { ok: typeof data.ok === "boolean" ? data.ok : true, error: data.error, ms: data.ms, note: data.note };
  } catch {
    return { ok: false, error: "无法连接服务器" };
  }
}
