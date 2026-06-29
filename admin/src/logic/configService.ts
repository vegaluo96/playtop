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

/** MiniMax 系统（免费）音色库 + 各音色当前被哪些角色使用。无后端 → null（前端回退演示数据）。 */
export async function loadVoices(): Promise<{ voices: any[]; engine: string } | null> {
  const b = base();
  if (!b) return null;
  try {
    const r = await fetch(`${b}/admin/voices`, { credentials: "include", headers: authHeaders() });
    if (r.ok) return (await r.json()) as { voices: any[]; engine: string };
  } catch { /* noop */ }
  return null;
}

/** 音色试听：拉后端用该角色/voice_id 真实 TTS 合成的 WAV 并播放（非占位提示）。
 *  成功返回 true；无后端或合成失败返回 false（调用方据此提示）。 */
let _previewAudio: HTMLAudioElement | null = null;
export async function playVoicePreview(opts: { characterId?: string; voiceId?: string }): Promise<boolean> {
  const b = base();
  if (!b) return false;
  const q = opts.characterId ? "c=" + encodeURIComponent(opts.characterId)
    : "v=" + encodeURIComponent(opts.voiceId || "");
  try {
    const r = await fetch(`${b}/admin/voice-preview?${q}`, { credentials: "include", headers: authHeaders() });
    if (!r.ok) return false;
    const blob = await r.blob();
    if (!blob.size || blob.size <= 64) return false;   // 仅 WAV 头（TTS 未配置）→ 当作失败
    try { _previewAudio?.pause(); } catch { /* noop */ }
    const url = URL.createObjectURL(blob);
    const a = new Audio(url);
    _previewAudio = a;
    a.onended = () => URL.revokeObjectURL(url);
    await a.play();
    return true;
  } catch {
    return false;
  }
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

/** 首页 KPI + 热门角色 + 趋势 + 每角色通话数 + 成本汇总。无后端/失败 → null。 */
export async function loadDashboard(): Promise<{ stats: any; top_characters: any[]; trends: any; char_calls: any; char_favs: any; scene_calls: any; invite_stats: any; cost: any } | null> {
  const b = base();
  if (!b) return null;
  try {
    const r = await fetch(`${b}/admin/stats`, { credentials: "include", headers: authHeaders() });
    if (r.ok) {
      const d = (await r.json()) as Record<string, any>;
      if (d && d.ok) return { stats: d.stats || {}, top_characters: d.top_characters || [],
                              trends: d.trends || null, char_calls: d.char_calls || null,
                              char_favs: d.char_favs || null,
                              scene_calls: d.scene_calls || null, invite_stats: d.invite_stats || null,
                              cost: d.cost || null };
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

/** 计费单价（成本估算）。无后端 → null。 */
export async function loadCostConfig(): Promise<Record<string, number> | null> {
  const b = base();
  if (!b) return null;
  try {
    const r = await fetch(`${b}/admin/cost-config`, { credentials: "include", headers: authHeaders() });
    if (r.ok) return (await r.json()) as Record<string, number>;
  } catch { /* noop */ }
  return null;
}
/** 保存计费单价；返回是否成功。改完下一通通话即按新价估算。 */
export async function saveCostConfig(cfg: Record<string, any>): Promise<boolean> {
  const b = base();
  if (!b) return false;
  try {
    const r = await fetch(`${b}/admin/cost-config`, { method: "PUT", headers: authHeaders(true), credentials: "include", body: JSON.stringify(cfg) });
    if (r.ok) { const d = await r.json(); return !!(d && d.ok); }
  } catch { /* noop */ }
  return false;
}

/** 读取当前默认角色 id（用户端进来先选它）。无后端 → null。 */
export async function loadDefaultCharacter(): Promise<string | null> {
  const b = base();
  if (!b) return null;
  try {
    const r = await fetch(`${b}/admin/default-character`, { credentials: "include", headers: authHeaders() });
    if (r.ok) { const d = await r.json(); return (d && d.id) || ""; }
  } catch { /* noop */ }
  return null;
}
/** 设默认角色。返回是否成功。改完用户端下次进来即先选它。 */
export async function saveDefaultCharacter(id: string): Promise<boolean> {
  const b = base();
  if (!b) return false;
  try {
    const r = await fetch(`${b}/admin/default-character`, { method: "PUT", headers: authHeaders(true), credentials: "include", body: JSON.stringify({ id }) });
    if (r.ok) { const d = await r.json(); return !!(d && d.ok); }
  } catch { /* noop */ }
  return false;
}

/** 读取邀请奖励 + 注册赠送（均为分钟）。无后端 → null。 */
export async function loadInviteConfig(): Promise<{ reward_minutes: number; free_minutes?: number } | null> {
  const b = base();
  if (!b) return null;
  try {
    const r = await fetch(`${b}/admin/invite-config`, { credentials: "include", headers: authHeaders() });
    if (r.ok) return (await r.json()) as { reward_minutes: number; free_minutes?: number };
  } catch { /* noop */ }
  return null;
}
/** 保存邀请奖励 +（可选）注册赠送（均为分钟）。改完即对新注册生效。 */
export async function saveInviteConfig(rewardMinutes: number, freeMinutes?: number): Promise<boolean> {
  const b = base();
  if (!b) return false;
  try {
    const body: any = { reward_minutes: rewardMinutes };
    if (freeMinutes != null) body.free_minutes = freeMinutes;
    const r = await fetch(`${b}/admin/invite-config`, { method: "PUT", headers: authHeaders(true), credentials: "include", body: JSON.stringify(body) });
    if (r.ok) { const d = await r.json(); return !!(d && d.ok); }
  } catch { /* noop */ }
  return false;
}

/** 删除兑换码。返回是否成功。 */
export async function deleteRedeemCode(code: string): Promise<boolean> {
  const b = base();
  if (!b) return false;
  try {
    const r = await fetch(`${b}/admin/redeem-codes/delete`, {
      method: "POST", headers: authHeaders(true), credentials: "include",
      body: JSON.stringify({ code }),
    });
    if (r.ok) { const d = await r.json(); return !!(d && d.ok); }
  } catch {
    /* noop */
  }
  return false;
}
/** 封禁/解封用户：封后该用户登录被拒、通话被拒（账号级）。返回是否成功。 */
export async function setUserBanned(userId: string, banned: boolean): Promise<boolean> {
  const b = base();
  if (!b) return false;
  try {
    const r = await fetch(`${b}/admin/users/ban`, {
      method: "POST", headers: authHeaders(true), credentials: "include",
      body: JSON.stringify({ user_id: userId, banned }),
    });
    if (r.ok) { const d = await r.json(); return !!(d && d.ok); }
  } catch {
    /* noop */
  }
  return false;
}
/** 清某用户的记忆（事实层+理解层）。characterId 留空=清该用户对所有角色的记忆；指定=只清那一个。
 *  保留账号/账单/通话记录。返回 {ok, 清了几个角色}。 */
export async function resetUserMemory(userId: string, characterId = ""): Promise<{ ok: boolean; cleared: number }> {
  const b = base();
  if (!b) return { ok: false, cleared: 0 };
  try {
    const r = await fetch(`${b}/admin/reset-memory`, {
      method: "POST", headers: authHeaders(true), credentials: "include",
      body: JSON.stringify({ user_id: userId, character_id: characterId }),
    });
    if (r.ok) { const d = await r.json(); return { ok: !!(d && d.ok), cleared: Number(d && d.cleared) || 0 }; }
  } catch {
    /* noop */
  }
  return { ok: false, cleared: 0 };
}
export async function createRedeemCode(code: string, minutes: number, maxUses: number): Promise<{ ok: boolean; code?: string; error?: string }> {
  const b = base();
  if (!b) return { ok: false, error: "需接入后端" };
  try {
    const r = await fetch(`${b}/admin/redeem-codes`, {
      method: "POST", headers: authHeaders(true), credentials: "include",
      body: JSON.stringify({ code, minutes, max_uses: maxUses }),
    });
    if (r.ok) return (await r.json()) as { ok: boolean; code?: string; error?: string };
  } catch {
    /* noop */
  }
  return { ok: false, error: "请求失败" };
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

/** 新建自定义角色，返回 {ok, id}。 */
export async function createCharacter(fields: any): Promise<{ ok: boolean; id?: string; error?: string }> {
  const b = base();
  if (!b) return { ok: false, error: "需接入后端" };
  try {
    const r = await fetch(`${b}/admin/characters/create`, { method: "POST", headers: authHeaders(true), credentials: "include", body: JSON.stringify(fields) });
    if (r.ok) return await r.json();
  } catch { /* noop */ }
  return { ok: false, error: "请求失败" };
}
/** 音色克隆：上传一段人声（Blob）→ MiniMax 复刻 → 设为该角色音色。返回 {ok, voice_id, demo_audio, error}。 */
export async function cloneVoice(audio: Blob, characterId: string, filename = "voice.wav", previewText = ""):
  Promise<{ ok: boolean; voice_id?: string; demo_audio?: string; set_to?: string; error?: string }> {
  const b = base();
  if (!b) return { ok: false, error: "需接入后端" };
  const qs = new URLSearchParams({ c: characterId || "", name: filename, text: previewText || "" }).toString();
  try {
    const h = authHeaders();                 // 不设 Content-Type：发原始音频字节，后端按 Content-Length 读
    const r = await fetch(`${b}/admin/voice-clone?${qs}`, { method: "POST", headers: h, credentials: "include", body: audio });
    if (r.ok) return await r.json();
    return { ok: false, error: "HTTP " + r.status };
  } catch (e: any) {
    return { ok: false, error: String(e && e.message || e).slice(0, 200) };
  }
}

/** 给角色生成「半写实·柔光影棚」头像（走『生图』节点）。返回 {ok, avatar, error}。 */
export async function generateAvatar(id: string): Promise<{ ok: boolean; avatar?: string; error?: string }> {
  const b = base();
  if (!b) return { ok: false, error: "需接入后端" };
  try {
    const r = await fetch(`${b}/admin/generate-avatar`, { method: "POST", headers: authHeaders(true), credentials: "include", body: JSON.stringify({ id }) });
    const d = await r.json().catch(() => ({}));
    if (r.ok && d && d.ok) return d;
    return { ok: false, error: (d && d.error) || ("HTTP " + r.status) };
  } catch (e: any) {
    return { ok: false, error: String(e && e.message || e).slice(0, 200) };
  }
}

/** 上传图片替代 AI 生成，存为该角色头像。返回 {ok, avatar, error}。 */
export async function uploadAvatar(id: string, file: Blob): Promise<{ ok: boolean; avatar?: string; error?: string }> {
  const b = base();
  if (!b) return { ok: false, error: "需接入后端" };
  try {
    const h = authHeaders();   // 不设 Content-Type：发原始图片字节，后端按 Content-Length 读
    const r = await fetch(`${b}/admin/upload-avatar?c=${encodeURIComponent(id)}`, { method: "POST", headers: h, credentials: "include", body: file });
    const d = await r.json().catch(() => ({}));
    if (r.ok && d && d.ok) return d;
    return { ok: false, error: (d && d.error) || ("HTTP " + r.status) };
  } catch (e: any) {
    return { ok: false, error: String(e && e.message || e).slice(0, 200) };
  }
}

/** 后台头像的同域 URL（admin nginx 反代 /admin/ → adminapi 的 /admin/avatar）。
 *  第二参 true → 加时间戳 &t= 强制取最新（生成/重生后预览用，后端 no-store）；
 *  第二参数字 rev → 加内容版本 &v=rev（后端长缓存 immutable，内容不变走缓存、刷新不重拉，重生 rev 变才换 URL）；
 *  省略/0 → 裸 URL（后端 no-store 兜底）。 */
export function adminAvatarUrl(cid: string, bustOrRev: boolean | number = false): string {
  let suffix = "";
  if (bustOrRev === true) suffix = "&t=" + Date.now();
  else if (typeof bustOrRev === "number" && bustOrRev > 0) suffix = "&v=" + bustOrRev;
  return `${base()}/admin/avatar?c=${encodeURIComponent(cid)}${suffix}`;
}

/** 删除角色。 */
export async function deleteCharacter(id: string): Promise<boolean> {
  const b = base();
  if (!b) return false;
  try {
    const r = await fetch(`${b}/admin/characters/delete`, { method: "POST", headers: authHeaders(true), credentials: "include", body: JSON.stringify({ id }) });
    if (r.ok) { const d = await r.json(); return !!(d && d.ok); }
  } catch { /* noop */ }
  return false;
}
/** 下架/上架角色：online=false 下架（不对用户端展示），online=true 上架。 */
export async function setCharacterOnline(id: string, online: boolean): Promise<boolean> {
  const b = base();
  if (!b) return false;
  try {
    const r = await fetch(`${b}/admin/characters/online`, { method: "POST", headers: authHeaders(true), credentials: "include", body: JSON.stringify({ id, online }) });
    if (r.ok) { const d = await r.json(); return !!(d && d.ok); }
  } catch { /* noop */ }
  return false;
}
/** 重置角色自主状态：清掉 DB 里已生长的近况，回落到出厂『开局近况』（治角色改过定位后老提旧设定的事）。 */
export async function resetCharAutonomous(id: string): Promise<boolean> {
  const b = base();
  if (!b) return false;
  try {
    const r = await fetch(`${b}/admin/characters/reset-autonomous`, { method: "POST", headers: authHeaders(true), credentials: "include", body: JSON.stringify({ id }) });
    if (r.ok) { const d = await r.json(); return !!(d && d.ok); }
  } catch { /* noop */ }
  return false;
}
/** AI 一键生成角色字段。 */
export async function generateCharacter(prompt: string): Promise<{ ok: boolean; fields?: any; error?: string }> {
  const b = base();
  if (!b) return { ok: false, error: "需接入后端" };
  try {
    const r = await fetch(`${b}/admin/characters/generate`, { method: "POST", headers: authHeaders(true), credentials: "include", body: JSON.stringify({ prompt }) });
    if (r.ok) return await r.json();
  } catch { /* noop */ }
  return { ok: false, error: "生成失败" };
}

/** AI 生成内核：把当前编辑态的扁平维度发给后端，按现有维度提炼一段 core（不新增设定、保人格）。 */
export async function generateCore(fields: Record<string, any>): Promise<{ ok: boolean; core?: string; error?: string }> {
  const b = base();
  if (!b) return { ok: false, error: "需接入后端" };
  try {
    const r = await fetch(`${b}/admin/characters/generate-core`, { method: "POST", headers: authHeaders(true), credentials: "include", body: JSON.stringify(fields) });
    if (r.ok) return await r.json();
    return { ok: false, error: `HTTP ${r.status}` };
  } catch { /* noop */ }
  return { ok: false, error: "生成失败" };
}

/** 连通性测试结果：ok=null 表示无后端（未知）；失败时 error 带出后端真因（1004/2049 等）。
 *  联网脑额外带 answer（模型真实答案）+ live（像不像真联网的初判），让运营一眼看出「连上≠在搜网」。 */
export type TestResult = { ok: boolean | null; error?: string; ms?: number; note?: string; answer?: string; live?: boolean };

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
    const data = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string; ms?: number; note?: string; answer?: string; live?: boolean };
    return { ok: typeof data.ok === "boolean" ? data.ok : true, error: data.error, ms: data.ms, note: data.note, answer: data.answer, live: data.live };
  } catch {
    return { ok: false, error: "无法连接服务器" };
  }
}

/** 手动拉取联网脑（世界库）：后端真跑一遍 open-meteo 天气 + 联网脑话题，回带真实结果给运营看效果。
 *  无后端 → ok:null（本地无法跨域直连联网脑）。 */
export type WorldPull = { ok: boolean | null; error?: string; rewriter_configured?: boolean;
  cities_total?: number; weather_cities?: number; topics_count?: number;
  topics_src?: { text: string; url: string; cat?: string; date?: string }[]; weather?: Record<string, string> };
export async function worldRefresh(): Promise<WorldPull> {
  const b = base();
  if (!b) return { ok: null };
  try {
    const r = await fetch(`${b}/admin/world-refresh`, { method: "POST", headers: authHeaders(true), credentials: "include" });
    if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
    return (await r.json().catch(() => ({ ok: false, error: "解析失败" }))) as WorldPull;
  } catch {
    return { ok: false, error: "无法连接服务器" };
  }
}

/** 一键测试每个免费热点源是否可达 + 拿到几条 + 样例。无后端 → null。 */
export type SourceRow = { source: string; ok: boolean; count?: number; safe?: number; error?: string;
  sample?: { text: string; url: string; desc?: string }[] };

/** 源管理：读当前生效的热点源清单。无后端 → null。 */
export async function loadHotSources(): Promise<string[] | null> {
  const b = base();
  if (!b) return null;
  try {
    const r = await fetch(`${b}/admin/hot-sources`, { credentials: "include", headers: authHeaders() });
    if (r.ok) { const d = await r.json(); return (d && d.endpoints) || []; }
  } catch { /* noop */ }
  return null;
}
/** 源管理：保存热点源清单（后端只收 http(s)、去重、封顶 40）。返回保存后的清单或 null。 */
export async function saveHotSources(endpoints: string[]): Promise<string[] | null> {
  const b = base();
  if (!b) return null;
  try {
    const r = await fetch(`${b}/admin/hot-sources`, { method: "PUT", headers: authHeaders(true), credentials: "include", body: JSON.stringify({ endpoints }) });
    if (r.ok) { const d = await r.json(); return d && d.ok ? (d.endpoints || []) : null; }
  } catch { /* noop */ }
  return null;
}
/** 源管理：单测一个热点源 URL。返回 {ok, result}。 */
export async function testOneSource(endpoint: string): Promise<{ ok: boolean; result?: SourceRow; error?: string } | null> {
  const b = base();
  if (!b) return null;
  try {
    const r = await fetch(`${b}/admin/world-test-one`, { method: "POST", headers: authHeaders(true), credentials: "include", body: JSON.stringify({ endpoint }) });
    if (r.ok) return (await r.json()) as { ok: boolean; result?: SourceRow };
    return { ok: false, error: `HTTP ${r.status}` };
  } catch { return { ok: false, error: "无法连接服务器" }; }
}
/** 话题手动管控：删除一条（拉黑，再抓也不收）。 */
export async function removeTopic(text: string): Promise<boolean> {
  const b = base();
  if (!b) return false;
  try {
    const r = await fetch(`${b}/admin/world-topic-remove`, { method: "POST", headers: authHeaders(true), credentials: "include", body: JSON.stringify({ text }) });
    if (r.ok) { const d = await r.json(); return !!(d && d.ok); }
  } catch { /* noop */ }
  return false;
}
/** 话题手动管控：置顶/取消置顶一条（置顶豁免衰减、检索优先）。 */
export async function pinTopic(text: string, on: boolean): Promise<boolean> {
  const b = base();
  if (!b) return false;
  try {
    const r = await fetch(`${b}/admin/world-topic-pin`, { method: "POST", headers: authHeaders(true), credentials: "include", body: JSON.stringify({ text, on }) });
    if (r.ok) { const d = await r.json(); return !!(d && d.ok); }
  } catch { /* noop */ }
  return false;
}
export async function testHotSources(): Promise<{ ok: boolean; sources?: SourceRow[]; error?: string } | null> {
  const b = base();
  if (!b) return null;
  try {
    const r = await fetch(`${b}/admin/world-test-source`, { method: "POST", headers: authHeaders(true), credentials: "include" });
    if (r.ok) return (await r.json()) as { ok: boolean; sources?: SourceRow[] };
    return { ok: false, error: `HTTP ${r.status}` };
  } catch {
    return { ok: false, error: "无法连接服务器" };
  }
}

/** 读取【已保存】的世界库快照（持久化那份，重启/重拉都在）：日期/话题/各城天气/历史天数。无后端 → null。 */
export type WorldLib = { date?: string; fresh?: boolean; persisted?: boolean;
  topics?: string[]; topics_src?: { text: string; url: string; cat?: string; date?: string; pinned?: boolean }[];
  weather?: { city: string; line: string }[]; hist_days?: Record<string, number> };
export async function loadWorld(): Promise<WorldLib | null> {
  const b = base();
  if (!b) return null;
  try {
    const r = await fetch(`${b}/admin/world`, { credentials: "include", headers: authHeaders() });
    if (r.ok) return (await r.json()) as WorldLib;
  } catch { /* noop */ }
  return null;
}

/** 读取【真正生效】的运行限流（global_defaults 等）。无后端 → null。 */
export async function loadLimits(): Promise<Record<string, number> | null> {
  const b = base();
  if (!b) return null;
  try {
    const r = await fetch(`${b}/admin/limits-config`, { credentials: "include", headers: authHeaders() });
    if (r.ok) return (await r.json()) as Record<string, number>;
  } catch { /* noop */ }
  return null;
}
/** 保存运行限流（只传可调的几个键；后端钳到安全区间，下一通即生效）。返回是否成功。 */
export async function saveLimits(cfg: Record<string, any>): Promise<boolean> {
  const b = base();
  if (!b) return false;
  try {
    const r = await fetch(`${b}/admin/limits-config`, { method: "PUT", headers: authHeaders(true), credentials: "include", body: JSON.stringify(cfg) });
    if (r.ok) { const d = await r.json(); return !!(d && d.ok); }
  } catch { /* noop */ }
  return false;
}
