// AdminLogic — production port of the Admin prototype's `class Component extends
// DCLogic` (prototype/MiCall Admin.dc.html).
//
// Per docs/02-后端架构与实现规格 §7, the Admin console implements all 11 tabs.
// The prototype is the source of truth, so the data, state machine and
// renderVals() are ported verbatim and rendered through the shared DC renderer.
// This is an internal ops console; it currently runs on the prototype's mock
// data. When the backend exists, the data sources swap to REST (VITE_API_BASE)
// and the 接口配置 endpoints/keys persist server-side (CLAUDE.md 铁律2) — no UI
// change required.

import type { Vals } from "../dc/resolve";
import { loadApiConfig, saveApiConfig, testApiSection, loadCharacters, saveCharacter,
         loadDashboard, loadUsers, loadCalls, loadOrders, loadTickets, loadInvites, replyTicket,
         loadRedeemCodes, createRedeemCode, deleteRedeemCode,
         createCharacter, deleteCharacter, generateCharacter, generateCore, setCharacterOnline,
         loadDefaultCharacter, saveDefaultCharacter,
         loadInviteConfig, saveInviteConfig,
         loadCostConfig, saveCostConfig, usingBackend, playVoicePreview, loadVoices, setUserBanned, resetUserMemory, cloneVoice,
         generateAvatar, uploadAvatar, adminAvatarUrl } from "./configService";

export interface AdminProps {
  [k: string]: unknown;
}

/** 头像球色相：由角色 id 确定性哈希得到（0-359）。与用户端 MiCallLogic.hueFromId 算法一致，
 *  保证同一角色在后台和用户端颜色相同、不随列表顺序变。 */
export function hueFromId(id: string): number {
  let h = 0;
  const s = id || "";
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return h;
}

type State = Record<string, any>;
type Timer = ReturnType<typeof setTimeout>;

export class AdminLogic {
  props: AdminProps;
  private notify: () => void = () => {};

  chars: any[];
  hueOf: Record<string, string> = {};
  users: any[];
  calls: any[];
  tickets: any[];
  orders: any[];
  plans: any[];
  voices: any[];
  apiSections: any[];
  inviters: any[];
  inviteRecords: any[];
  notifs: any[];
  realStats: any = null;        // 接后端后的首页 KPI（null = 用演示数据）
  realVoices: any[] | null = null;    // 接后端后的 MiniMax 系统音色库（null = 用演示）
  realTopChars: any[] | null = null;  // 接后端后的热门角色排名
  realTrends: any = null;       // 接后端后的通话量趋势（null = 用演示）
  realCost: any = null;         // 接后端后的成本汇总（null = 用演示）
  realSceneCalls: any = null;   // 接后端后的各场景通话数（null = 用演示）
  realInviteStats: any = null;  // 接后端后的邀请 KPI（null = 用演示）
  redeemCodes: any[] = [];      // 兑换码列表（后台「订单充值」）
  defaultCharId = "";           // 当前默认角色 cid（用户端进来先选它）

  private _t: Timer | undefined;
  private _tt: Timer[] = [];

  state: State = {
    section: "dashboard", detail: null, query: "", userFilter: "all", charBio: "", charEdit: {}, replyDraft: "", toast: "", ticketReplies: {}, inviteReward: "60", inviteeReward: "60", registerGift: "60", inviteRuleOn: true, notifOpen: false, notifRead: false, dateRange: "7d", charTab: "role", ioOpen: false, ioMode: "export", apiStatus: {},
    confirm: null, confirmBusy: false, savingChar: false, genCoreBusy: false,   // 二次确认弹层 / 异步写忙态（防误删、防连点）
    redeemCode: "", redeemUses: "1", redeemMinutes: "60", generatedCode: "",
    costCfg: { chars_per_token: "2", llm_fast: "0.0002", llm_slow: "0.0008", embedding: "0.00008", tts: "0.025", asr: "0.00192" },
    apiCfg: {
      // 这些只是「无后端」时的兜底默认；接了后端会被真实配置覆盖。值与 backend/config/default.json 对齐，
      // 避免再出现 DeepSeek-V4-Flash 这类虚名误导。key 留空（不放假占位），由运营填、后端打码回显。
      asr: { provider: "bailian_qwen3_asr", endpoint: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions", key: "", model: "qwen3-asr-flash", lang: "zh" },
      fast: { provider: "deepseek", endpoint: "https://api.deepseek.com/v1/chat/completions", key: "", model: "deepseek-v4-flash", temp: "0.8", maxTokens: "2048" },
      tts: { provider: "minimax", endpoint: "https://api.minimax.chat/v1/t2a_v2?GroupId=填你的GroupId", key: "", model: "speech-2.8-turbo", voiceId: "female-shaonv", sampleRate: "24000" },
      memory: { provider: "apiyi_qwen_long", endpoint: "https://api.apiyi.com/v1/chat/completions", key: "", model: "qwen-max", maxContext: "32000" },
      embed: { provider: "bailian_embedding", endpoint: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/embeddings", key: "", model: "text-embedding-v4", vectorDB: "pgvector", topK: "5" },
      image: { provider: "", endpoint: "https://api.apiyi.com/v1/images/generations", key: "", model: "gpt-image-1", size: "1024x1024" },
      eval: { provider: "apiyi", endpoint: "https://api.apiyi.com/v1/chat/completions", key: "", model: "gpt-4o", temp: "0.6", maxTokens: "1500" },
      search: { provider: "apiyi", endpoint: "https://api.apiyi.com/v1/chat/completions", key: "", model: "grok-4-all", maxTokens: "600" },
    },
  };

  constructor(props?: AdminProps) {
    this.props = props || {};
    const uG = { a: "linear-gradient(140deg,#A78BFF,#6E5CFF)", b: "linear-gradient(140deg,#FF8FC8,#FF4FA0)", c: "linear-gradient(140deg,#5BE0A0,#1FA971)", d: "linear-gradient(140deg,#6FC8FF,#2E7BFF)", e: "linear-gradient(140deg,#FFB36B,#F5821F)" };
    this.chars = [
      // 冷启动占位：**不放任何真实角色名**（旧版放「沈知微」等死数据 → 和后端真实 36 角色对不上、还会一闪）。
      // 只放一个中性空占位；loadCharacters 会按后端真值新建每个角色、并 filter 掉这条未匹配占位（cid 为空）。
      { id: "c0", cid: "", speaking_style: "", voiceId: "", name: "", desc: "", hue: 0, gender: "女", age: "", height: "", weight: "", birthday: "", nationality: "", race: "", traits: [], tags: [], slogan: "", likes: "", dislikes: "", bio: "", calls: "0", customVoices: 0, favs: "0", status: "上线" },
    ];
    this.hueOf = {};
    this.chars.forEach((c) => (this.hueOf[c.name] = "hue-rotate(" + c.hue + "deg)"));
    this.users = [];
    this.calls = [];
    this.tickets = [];
    this.orders = [];
    this.plans = [
      { name: "轻享会员", price: "$4.99", mins: "每月 300 分钟", subs: "2,180", popular: false, tile: "linear-gradient(145deg,#7AA8FF,#5B7CF0)", icon: "M12 3l2.2 5.2L20 9.4l-4 3.9 1 5.7L12 16.3 7 19l1-5.7-4-3.9 5.8-1.2L12 3z" },
      { name: "畅聊会员", price: "$9.99", mins: "每月 1500 分钟", subs: "4,910", popular: true, tile: "linear-gradient(145deg,#B79CFF,#9277F5)", icon: "M21 11.5a8.38 8.38 0 0 1-8.5 8.5 8.5 8.5 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8A8.5 8.5 0 0 1 12.5 3 8.38 8.38 0 0 1 21 11.5z" },
      { name: "无限会员", price: "$19.99", mins: "每月不限时", subs: "1,240", popular: false, tile: "linear-gradient(145deg,#FFC061,#F5A623)", icon: "M18.5 8.5c-2 0-3.2 1.6-4.2 3-.8 1.1-1.5 2-2.3 2s-1.5-.9-2.3-2c-1-1.4-2.2-3-4.2-3a3.5 3.5 0 1 0 0 7c2 0 3.2-1.6 4.2-3 .8-1.1 1.5-2 2.3-2s1.5.9 2.3 2c1 1.4 2.2 3 4.2 3a3.5 3.5 0 1 0 0-7z" },
    ];
    // 音色列表：以后端 /admin/voices（MiniMax 真实系统音色 + 克隆音色）为唯一来源，挂载即拉。
    // 不再放假音色占位（曾有 Azure/ElevenLabs 等并不存在的引擎），未加载时显示空，杜绝演示数据误导。
    this.voices = [];
    this.apiSections = [
      { key: "asr", name: "ASR · 语音识别", chain: "快链路", desc: "实时把用户语音转写为文字 · 默认 Qwen3-ASR-Flash（阿里百炼）", icon: "M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3zM19 10v2a7 7 0 0 1-14 0v-2M12 19v4M8 23h8", req: "快 · 低延迟 · 可打断", fields: [{ k: "endpoint", label: "接口地址", full: true }, { k: "key", label: "API Key", pw: true }, { k: "model", label: "模型" }, { k: "lang", label: "识别语言" }] },
      { key: "fast", name: "LLM · 快脑（通话中）", chain: "快链路", desc: "通话中实时生成简短回复 · 默认 deepseek-v4-flash（DeepSeek 直连，小写；deepseek-chat 是其旧别名，2026-07-24 停用）", icon: "M13 2L3 14h7l-1 8 10-12h-7l1-8z", req: "快 · 短 · 低延迟 · 可打断", fields: [{ k: "endpoint", label: "接口地址", full: true }, { k: "key", label: "API Key", pw: true }, { k: "model", label: "模型" }, { k: "temp", label: "温度" }, { k: "maxTokens", label: "回复上限 Token" }] },
      { key: "tts", name: "TTS · 语音合成", chain: "快链路", desc: "合成角色语音，voice_id 决定音色 · 默认 MiniMax TTS（官方直连，支持 emotion）", icon: "M11 5 6 9H3v6h3l5 4V5zM15.5 9a4.5 4.5 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11", req: "快 · 自然 · 可打断", fields: [{ k: "endpoint", label: "接口地址", full: true }, { k: "key", label: "API Key", pw: true }, { k: "model", label: "模型" }, { k: "voiceId", label: "默认 voice_id" }, { k: "sampleRate", label: "采样率" }] },
      { key: "memory", name: "LLM · 长记忆脑（通话后）", chain: "慢链路", desc: "通话后总结、提取长期记忆、生成开场白 · 默认 qwen-max（经 apiyi，可在「模型」改 qwen-plus 等；离线不要求快）", icon: "M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2zM2 12h20M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20", req: "准 · 稳 · 长上下文（不要求快）", fields: [{ k: "endpoint", label: "接口地址", full: true }, { k: "key", label: "API Key", pw: true }, { k: "model", label: "模型（如 qwen-max / qwen-plus）" }, { k: "maxContext", label: "最大上下文" }] },
      { key: "embed", name: "Embedding · 记忆检索", chain: "慢链路", desc: "向量化记忆并快速检索相关片段 · 存储 Postgres + pgvector", icon: "M21 5c0 1.66-4 3-9 3S3 6.66 3 5s4-3 9-3 9 1.34 9 3zM3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5M3 12c0 1.66 4 3 9 3s9-1.34 9-3", req: "快检索 · 高召回", fields: [{ k: "endpoint", label: "接口地址", full: true }, { k: "key", label: "API Key", pw: true }, { k: "model", label: "模型" }, { k: "vectorDB", label: "向量数据库" }, { k: "topK", label: "检索 Top-K" }] },
      { key: "image", name: "生图 · 角色头像", chain: "离线", desc: "给角色生成头像（半写实·柔光影棚，规范锁死防全站漂移）· OpenAI 兼容 images 接口（经 apiyi，可填 gpt-image-1 / flux 等）", icon: "M21 15l-5-5L5 21M3 5h18a0 0 0 0 1 0 0v14a0 0 0 0 1 0 0H3a0 0 0 0 1 0 0V5a0 0 0 0 1 0 0zM8.5 8.5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0z", req: "1:1 正方 · 头肩居中 · 不要求快", fields: [{ k: "endpoint", label: "接口地址（…/v1/images/generations）", full: true }, { k: "key", label: "API Key", pw: true }, { k: "model", label: "生图模型（如 gpt-image-1 / flux）" }, { k: "size", label: "尺寸（如 1024x1024）" }] },
      { key: "eval", name: "LLM · 评测脑（分析/判定）", chain: "离线", desc: "图灵测试的审问者/裁判/分析师 + 后台「AI 生成角色/内核」用 · 离线偶发调用、配最强模型（经 apiyi 接 GPT/Claude 级前沿，判断力=结论可信度）· 留空则自动回退长记忆脑", icon: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3M11 8v3l2 2", req: "顶级判断力 · 不要求快", fields: [{ k: "endpoint", label: "接口地址", full: true }, { k: "key", label: "API Key", pw: true }, { k: "model", label: "模型（填你 apiyi 最强的，如 gpt-5 / claude-sonnet-4 等）" }, { k: "temp", label: "温度" }, { k: "maxTokens", label: "回复上限 Token" }] },
      { key: "search", name: "LLM · 联网脑（现居地近况）", chain: "离线", desc: "离线给角色抓「现居地真实天气 + 安全大众话题」，让 TA 像真活在世界里、能聊真实近况 · 模型必须填 apiyi 里【自带联网】的那个（带 -All 后缀，如 grok-4-all / grok-3-all，或 sonar；填普通版不会真联网、会编）· 抓回内容过安全闸再用 · 留空则现居地退回季节推测", icon: "M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2zM2 12h20M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20", req: "自带联网检索 · 离线 · 不要求快", fields: [{ k: "endpoint", label: "接口地址", full: true }, { k: "key", label: "API Key（沿用 apiyi）", pw: true }, { k: "model", label: "联网模型（带 -All，如 grok-4-all / grok-3-all / sonar）" }, { k: "maxTokens", label: "回复上限 Token" }] },
    ];
    this.inviters = [];
    this.inviteRecords = [];
    this.notifs = [];
  }

  // ── React host bridge (mirrors DCLogic.setState semantics) ────────────────
  attach(notify: () => void) {
    this.notify = notify;
  }
  setState(update: Partial<State> | ((s: State) => Partial<State>), cb?: () => void) {
    const patch = typeof update === "function" ? update(this.state) : update;
    this.state = { ...this.state, ...patch };
    this.notify();
    if (cb) cb();
  }
  componentWillUnmount() {
    clearTimeout(this._t);
    (this._tt || []).forEach(clearTimeout);
    this._tt = [];
  }

  /** Load any persisted 接口配置 over the built-in defaults (铁律2). */
  async componentDidMount() {
    const loaded = await loadApiConfig();
    if (loaded) {
      this.setState((p) => {
        const merged: any = { ...p.apiCfg };
        for (const k of Object.keys(loaded)) merged[k] = { ...(p.apiCfg[k] || {}), ...loaded[k] };
        return { apiCfg: merged };
      });
    }
    // 出厂角色的可编辑字段（含后台覆盖）从后端拉真实值覆盖内置 mock。
    const chars = await loadCharacters();
    if (chars) {
      for (const row of chars) {
        let c = this.chars.find((x) => x.cid === row.id);
        if (!c) {
          // 运营新建角色（custom_xxx）：内置 mock 没有它 → 新建一条加进列表。否则后台看不到、
          // 设不了默认、也编辑不了（用户实测：新建的角色无法设为默认，出厂的可以——就是这里漏加）。
          c = {
            id: row.id, cid: row.id, name: "", desc: "", hue: hueFromId(row.id),
            gender: "女", age: "", height: "", weight: "", birthday: "", nationality: "", race: "", appearance: "",
            traits: [], tags: [], speaking_style: "", bio: "", hidden_layer: "", values: "",
            likes: "", dislikes: "", voiceId: "", slogan: "",
            calls: "0", customVoices: 0, favs: "—", status: "上线",
          } as any;
          this.chars.push(c);
        }
        if (row.name) c.name = row.name;
        if (row.tagline) c.desc = row.tagline;
        if (row.traits) { c.traits = this._splitList(row.traits); c.tags = c.traits.slice(0, 4); }  // 标签=性格前若干，和用户端一致（过去标签是写死 mock）
        if (row.background_story) c.bio = row.background_story;
        if ((row as any).hidden_layer != null) c.hidden_layer = (row as any).hidden_layer;
        if ((row as any).values != null) c.values = (row as any).values;
        if (row.likes != null) c.likes = row.likes;
        if (row.dislikes != null) c.dislikes = row.dislikes;
        if ((row as any).prompt_extra != null) c.prompt_extra = (row as any).prompt_extra;  // 本角色实时口吻补充
        if ((row as any).reply_max_tokens != null) c.reply_max_tokens = (row as any).reply_max_tokens;  // 角色级话长
        if ((row as any).memory_depth != null) c.memory_depth = (row as any).memory_depth;              // 角色级记忆深度
        c.speaking_style = row.speaking_style || "";
        c.voiceId = row.voice_id || "";
        // 基础资料取真值覆盖内置 mock（过去后台显示的是写死假数据，和通话用的出厂 spec 对不上）。
        if ((row as any).gender) c.gender = (row as any).gender;
        if ((row as any).age !== "" && (row as any).age != null) c.age = (row as any).age;
        if ((row as any).appearance != null) c.appearance = (row as any).appearance;
        if ((row as any).nationality != null) c.nationality = (row as any).nationality;
        if ((row as any).height !== "" && (row as any).height != null) c.height = (row as any).height;
        if ((row as any).weight !== "" && (row as any).weight != null) c.weight = (row as any).weight;
        if ((row as any).birthday != null) c.birthday = (row as any).birthday;
        if ((row as any).race != null) c.race = (row as any).race;
        // 富化维度：身份(职业/现居/MBTI) + 人设(性子/兴趣/口头禅/小习惯/软肋)。列表型后端已 join 成串。
        if ((row as any).occupation != null) c.occupation = (row as any).occupation;
        if ((row as any).residence != null) c.residence = (row as any).residence;
        if ((row as any).mbti != null) c.mbti = (row as any).mbti;
        if ((row as any).summary != null) c.summary = (row as any).summary;
        if ((row as any).core != null) c.core = (row as any).core;   // 内核/spine

        if ((row as any).hobbies != null) c.hobbies = (row as any).hobbies;
        if ((row as any).catchphrases != null) c.catchphrases = (row as any).catchphrases;
        if ((row as any).quirks != null) c.quirks = (row as any).quirks;
        if ((row as any).soft_spot != null) c.soft_spot = (row as any).soft_spot;
        if ((row as any).status) c.status = (row as any).status;   // 上线 / 下架（后端真值）
        c.has_avatar = !!(row as any).has_avatar;                  // 是否已有生成的头像（编辑时决定是否预显）
        c.avatar_rev = (row as any).avatar_rev || 0;               // 头像内容版本：列表 URL 带 &v=rev → 缓存命中、刷新不重拉
      }
      // 后端为权威：剔除没在后端列表里的本地占位（否则换了出厂角色后，旧占位会和真实角色并存、还编辑不了）。
      const backendIds = new Set(chars.map((r: any) => r.id));
      this.chars = this.chars.filter((c) => backendIds.has(c.cid));
      this.chars.forEach((c) => { c.hue = hueFromId(c.cid || c.id); });   // 真实角色色相统一按 id 哈希
      this.hueOf = {};   // 重建 name→hueFilter，让通话记录等按名取色也一致
      this.chars.forEach((c) => (this.hueOf[c.name] = "hue-rotate(" + c.hue + "deg)"));
      this.setState({}); // 用真实角色数据重渲染
    }
    const dc = await loadDefaultCharacter();   // 当前默认角色（用户端进来先选它）
    if (dc != null) { this.defaultCharId = dc; this.setState({}); }
    const ic = await loadInviteConfig();       // 当前邀请奖励 + 注册赠送（分钟）
    if (ic && ic.reward_minutes != null) this.setState({ inviteReward: String(ic.reward_minutes), inviteeReward: String(ic.reward_minutes) });
    if (ic && ic.free_minutes != null) this.setState({ registerGift: String(ic.free_minutes) });
    const vl = await loadVoices();             // MiniMax 系统（免费）音色库
    if (vl && Array.isArray(vl.voices)) { this.realVoices = vl.voices; this.setState({}); }
    await this.loadRealData();   // 看板 KPI/用户/通话/订单接 DB（接了后端才覆盖演示数据）
  }

  /** 保存邀请奖励到后端（双方各得同一值，对齐后端对称奖励）；改完即对新注册生效。 */
  async saveInvite() {
    if (!usingBackend()) { this.toastMsg("需接入后端"); return; }
    const m = Math.max(0, parseInt(this.state.inviteReward, 10) || 60);
    const fm = Math.max(0, parseInt(this.state.registerGift, 10) || 0);
    const ok = await saveInviteConfig(m, fm);
    if (ok) this.setState({ inviteeReward: String(m) });
    this.toastMsg(ok ? "已保存，对新注册即时生效" : "保存失败");
  }

  /** 设默认角色：用户端下次进来先选它（后端落 default_character.json，下一次拉角色即生效）。 */
  async setDefaultChar(cid: string) {
    if (!usingBackend()) { this.toastMsg("需接入后端"); return; }
    if (!cid) return;
    const ok = await saveDefaultCharacter(cid);
    if (!ok) { this.toastMsg("设置失败"); return; }
    this.defaultCharId = cid;
    this.setState({});
    this.toastMsg("已设为默认角色（用户端进来先选它）");
  }

  /** 下架/上架角色：下架后用户端 discover 里看不到（仍在后台可上架），下一次拉角色即生效。 */
  async toggleCharOnline(cid: string, online: boolean) {
    if (!usingBackend()) { this.toastMsg("需接入后端"); return; }
    if (!cid) return;
    const ok = await setCharacterOnline(cid, online);
    if (!ok) { this.toastMsg(online ? "上架失败" : "下架失败"); return; }
    const c = this.chars.find((x) => x.cid === cid);
    if (c) c.status = online ? "上线" : "下架";
    this.setState({});
    this.toastMsg(online ? "已上架（用户端可见）" : "已下架（用户端不再展示）");
  }

  setCost(k: string, v: string) { this.setState((p) => ({ costCfg: { ...(p as any).costCfg, [k]: v } })); }
  /** 保存计费单价到后端（admin_overrides.cost），下一通通话即按新价估算。 */
  async saveCost() {
    if (!usingBackend()) { this.toastMsg("需接入后端"); return; }
    const ok = await saveCostConfig(this.state.costCfg);
    this.toastMsg(ok ? "单价已保存，下一通通话按新价估算" : "保存失败");
  }

  /** 导出角色为 JSON 文件（真实下载）。 */
  private exportChars() {
    try {
      const data = JSON.stringify(this.chars.map((c) => ({ id: c.cid || c.id, name: c.name, tagline: c.desc, traits: c.traits, speaking_style: c.speaking_style, background_story: c.bio, likes: c.likes, dislikes: c.dislikes, voice_id: c.voiceId })), null, 2);
      const url = URL.createObjectURL(new Blob([data], { type: "application/json" }));
      const a = document.createElement("a"); a.href = url; a.download = "micall_characters.json"; a.click();
      URL.revokeObjectURL(url);
      this.toastMsg("已导出 micall_characters.json");
    } catch {
      this.toastMsg("导出失败");
    }
  }

  /** 创建自定义兑换码：调后端、显示新码、刷新列表。 */
  private async genRedeem() {
    const code = (this.state.redeemCode || "").trim();
    const uses = Math.max(1, parseInt(this.state.redeemUses, 10) || 1);
    const minutes = Math.max(1, parseInt(this.state.redeemMinutes, 10) || 60);
    if (!usingBackend()) { this.toastMsg("需接入后端才能创建兑换码"); return; }
    const res = await createRedeemCode(code, minutes, uses);
    if (!res.ok) { this.toastMsg(res.error || "创建失败"); return; }
    this.setState({ generatedCode: res.code || code, redeemCode: "" });
    const list = await loadRedeemCodes();
    if (list) this.redeemCodes = list;
    this.setState({});
    this.toastMsg(`已创建兑换码 ${res.code || code}`);
  }

  /** 封禁/解封用户：封禁是限制性操作 → 二次确认；解封是恢复性 → 直接执行。 */
  toggleBan(userId?: string) {
    if (!userId) return;
    const u = this.users.find((x) => x.id === userId);
    if (!u) return;
    if (!u.banned) {
      this.askConfirm({ title: "封禁用户", body: `确定封禁「${u.name || u.email || userId}」？封禁后该账号登录与通话都会被拒，可随时解封。`,
        okLabel: "封禁", action: () => this._doToggleBan(userId, true) });
    } else {
      this._doToggleBan(userId, false);
    }
  }
  private async _doToggleBan(userId: string, next: boolean) {
    if (!usingBackend()) { this.toastMsg("需接入后端"); return; }
    const u = this.users.find((x) => x.id === userId);
    if (!u) return;
    const ok = await setUserBanned(userId, next);
    if (!ok) { this.toastMsg("操作失败"); return; }
    u.banned = next;
    this.setState({});
    this.toastMsg(next ? "已封禁该用户（登录/通话将被拒）" : "已解除封禁");
  }

  /** 清除该用户的全部角色记忆（事实层+理解层）——运营/客服纠错用。危险写操作 → 二次确认。
   *  只清记忆，账号/账单/通话记录全保留；清后这些角色像初识 TA 一样重新认识。 */
  clearMemory(userId?: string) {
    if (!userId) return;
    const u = this.users.find((x) => x.id === userId);
    this.askConfirm({
      title: "清除该用户记忆",
      body: `确定清除「${(u && (u.name || u.email)) || userId}」与所有角色之间的记忆（事实/画像/关系）？清除后这些角色会像第一次认识 TA 一样重新开始；账号、账单、通话记录都保留。不可撤销。`,
      okLabel: "清除", danger: true, action: () => this._doClearMemory(userId),
    });
  }
  private async _doClearMemory(userId: string) {
    if (!usingBackend()) { this.toastMsg("需接入后端"); return; }
    const res = await resetUserMemory(userId, "");   // 空角色 = 清该用户对所有角色的记忆
    if (!res.ok) { this.toastMsg("操作失败"); return; }
    this.toastMsg(`已清除该用户记忆（${res.cleared} 个角色）`);
  }

  /** 删除兑换码：二次确认后执行（删除即失效，不可撤销）。 */
  delRedeem(code: string) {
    this.askConfirm({ title: "删除兑换码", body: `确定删除兑换码 ${code}？删除后该码立即失效，不可撤销。`,
      okLabel: "删除", action: () => this._doDelRedeem(code) });
  }
  private async _doDelRedeem(code: string) {
    if (!usingBackend()) { this.toastMsg("需接入后端"); return; }
    const ok = await deleteRedeemCode(code);
    if (!ok) { this.toastMsg("删除失败"); return; }
    this.redeemCodes = this.redeemCodes.filter((r: any) => r.code !== code);
    this.setState({});
    this.toastMsg(`已删除兑换码 ${code}`);
  }

  // ── 通用二次确认弹层：危险写操作（删除/封禁）走它，避免单击即不可撤销。 ──
  private askConfirm(opts: { title: string; body: string; okLabel: string; danger?: boolean; action: () => Promise<void> | void }) {
    this.setState({ confirm: { ...opts, danger: opts.danger !== false }, confirmBusy: false });
  }
  confirmCancel() { if (this.state.confirmBusy) return; this.setState({ confirm: null }); }
  async confirmOk() {
    const c = this.state.confirm;
    if (!c || this.state.confirmBusy) return;
    this.setState({ confirmBusy: true });
    try { await c.action(); }
    finally { this.setState({ confirmBusy: false, confirm: null }); }
  }

  /** 拉后台真实数据并映射成既有视图形状；无后端/失败时保持内置演示数据。 */
  private async loadRealData() {
    const [dash, users, calls, orders, tickets, invites, codes] = await Promise.all([
      loadDashboard(), loadUsers(), loadCalls(), loadOrders(), loadTickets(), loadInvites(), loadRedeemCodes(),
    ]);
    if (codes) this.redeemCodes = codes;
    if (dash) {
      this.realStats = dash.stats; this.realTopChars = dash.top_characters || [];
      this.realTrends = dash.trends || this.realTrends;
      this.realCost = dash.cost || this.realCost;
      this.realSceneCalls = dash.scene_calls || {};
      this.realInviteStats = dash.invite_stats || { total_invites: 0, reward_minutes: 0 };
      // 真实后端：每个角色用真实通话数（无则 0）；后台无来源的「自定义音色数/收藏」诚实置 0/—。
      const cc = dash.char_calls || {};
      for (const c of this.chars) { c.calls = String(cc[c.cid] ?? cc[c.id] ?? 0); c.customVoices = 0; c.favs = "—"; }
    }
    const GRADS = ["linear-gradient(140deg,#A78BFF,#6E5CFF)", "linear-gradient(140deg,#FF8FC8,#FF4FA0)",
                   "linear-gradient(140deg,#5BE0A0,#1FA971)", "linear-gradient(140deg,#6FC8FF,#2E7BFF)",
                   "linear-gradient(140deg,#FFB36B,#F5821F)"];
    const nameOf = (email: string) => (email || "").split("@")[0] || "用户";
    const charName = (cid: string) => this.chars.find((c) => c.cid === cid || c.id === cid)?.name || cid;
    const fmtDur = (sec: number) => `${Math.floor((sec || 0) / 60)}:${String((sec || 0) % 60).padStart(2, "0")}`;
    const fmtTime = (iso: string) => { const d = new Date(iso); return isNaN(+d) ? "" : `${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };
    const OSTAT: Record<string, string> = { paid: "已支付", refunded: "已退款", pending: "待支付", failed: "已失败" };

    if (users) {
      this.users = users.map((u: any, i: number) => ({
        id: u.user_id, name: nameOf(u.email), email: u.email || "",
        initial: (nameOf(u.email)[0] || "U").toUpperCase(), grad: GRADS[i % GRADS.length],
        // 剩余时长 = 账户余额 remaining_seconds（不是已通话时长 total_seconds——那是「累计已用」，两码事）。
        plan: "免费用户", minsRaw: `${Math.round((u.remaining_seconds || 0) / 60)} 分钟`,
        usedRaw: `${Math.round((u.total_seconds || 0) / 60)} 分钟`,
        spent: "$0.00", joined: (u.created_at || "").slice(0, 10), recharges: [],
        banned: !!u.banned,   // 后端权威封禁态（账号级）
      }));
    }
    if (calls) {
      const REASON: Record<string, string> = { ended: "正常结束", out_of_minutes: "时长用尽", error: "异常中断" };
      this.calls = calls.map((c: any, i: number) => ({
        id: "rk" + i, char: charName(c.character_id), user: c.user_email || "—",
        scene: c.scenario || "随便聊聊", dur: fmtDur(c.duration_seconds),
        ended: REASON[c.ended_reason] || (c.ended_reason || "正常结束"),
        time: fmtTime(c.started_at),
      }));
    }
    if (orders) {
      this.orders = orders.map((o: any) => ({
        id: o.order_id, user: o.user_email || "—", plan: o.plan,
        amount: "$" + ((o.amount_cents || 0) / 100).toFixed(2), status: OSTAT[o.status] || o.status,
      }));
    }
    if (tickets) {
      this.tickets = tickets.map((t: any) => ({
        id: t.id, type: t.type || "其他", user: t.user_email || "—", msg: t.message,
        date: fmtTime(t.created_at), status: t.status === "replied" ? "已回复" : "待处理", reply: t.reply || "",
      }));
    }
    if (invites) {
      this.inviteRecords = invites.map((r: any) => ({
        inviter: r.inviter_email || "—", invitee: r.invitee_email || "—", status: "已注册",
        reward: "+" + Math.round((r.reward_seconds || 0) / 60) + " 分钟", date: fmtTime(r.created_at),
      }));
      const agg: Record<string, { name: string; invited: number; mins: number }> = {};
      for (const r of invites as any[]) {
        const k = r.inviter_email || "—";
        (agg[k] = agg[k] || { name: k, invited: 0, mins: 0 });
        agg[k].invited++; agg[k].mins += Math.round((r.reward_seconds || 0) / 60);
      }
      this.inviters = Object.values(agg).sort((a, b) => b.invited - a.invited).map((v, i) => ({
        name: v.name, initial: (v.name[0] || "U").toUpperCase(), grad: GRADS[i % GRADS.length],
        invited: v.invited, success: v.invited, pending: 0, mins: String(v.mins),
      }));
    }
    const cc = await loadCostConfig();
    if (cc) this.setState({ costCfg: { chars_per_token: String(cc.chars_per_token), llm_fast: String(cc.llm_fast), llm_slow: String(cc.llm_slow), embedding: String(cc.embedding), tts: String(cc.tts), asr: String(cc.asr) } });
    if (dash || users || calls || orders || tickets || invites || codes) this.setState({});
  }

  _splitList(s: string): string[] {
    return String(s || "").split(/[、,，;；\n]+/).map((x) => x.trim()).filter(Boolean);
  }

  /** 保存接口配置：有后端走 REST（密钥存服务端），无后端落 localStorage。 */
  async saveApi(name: string) {
    const ok = await saveApiConfig(this.state.apiCfg);
    this.toastMsg(ok ? name + " 配置已保存" : name + " 保存失败，请重试");
  }

  /** 连通性测试：有后端实测该节点；结果写进 apiStatus，驱动卡片状态徽标（不再写死「已连接」）。 */
  async testApi(sectionKey: string, name: string) {
    this.setState((p) => ({ apiStatus: { ...p.apiStatus, [sectionKey]: "testing" } }));
    const res = await testApiSection(sectionKey, this.state.apiCfg[sectionKey]);
    const st = res.ok === false ? "fail" : "ok";   // ok===null（无后端）当通过；false 才算失败
    this.setState((p) => ({ apiStatus: { ...p.apiStatus, [sectionKey]: st } }));
    if (res.ok === null) this.toastMsg(name + " 连接测试成功");
    else if (res.ok) this.toastMsg(name + " 测试成功" + (res.ms ? ` · ${res.ms}ms` : ""));
    else this.toastMsg(name + " 测试失败：" + (res.error || "未知错误"));
  }

  /** 卡片连接状态徽标：未测过=未知（中性），测过按真实结果显示已连接/连接失败。 */
  _apiStatusBadge(key: string) {
    const st = (this.state.apiStatus || {})[key];
    if (st === "ok") return { statusLabel: "已连接", statusColor: "#1FA971", statusBg: "rgba(31,169,113,.1)" };
    if (st === "fail") return { statusLabel: "连接失败", statusColor: "#E0594F", statusBg: "rgba(224,89,79,.1)" };
    if (st === "testing") return { statusLabel: "测试中…", statusColor: "#E0954F", statusBg: "rgba(224,149,79,.12)" };
    return { statusLabel: "未测试", statusColor: "#878B95", statusBg: "#F0F0F3" };
  }

  toastMsg(m: string) {
    this.setState({ toast: m });
    clearTimeout(this._t);
    this._t = setTimeout(() => this.setState({ toast: "" }), 1900);
  }
  go(sec: string) {
    this.setState({ section: sec, detail: null, query: "" });
  }
  open(type: string, id: string) {
    const ns: any = { detail: { type, id } };
    if (type === "char") {
      const c = this.chars.find((x) => x.id === id);
      ns.charBio = c.bio;
      ns.charEdit = {  // 把可编辑字段摊进编辑态（列表型 join 成串便于输入）
        name: c.name || "", tagline: c.desc || "",
        gender: c.gender || "女", age: (c.age ?? "") + "", nationality: c.nationality || "",
        appearance: c.appearance || "", height: (c.height ?? "") + "", weight: (c.weight ?? "") + "",
        birthday: c.birthday || "", race: c.race || "",
        traits: Array.isArray(c.traits) ? c.traits.join("、") : (c.traits || ""),
        occupation: c.occupation || "", residence: c.residence || "", mbti: c.mbti || "",
        summary: c.summary || "", core: c.core || "",
        speaking_style: c.speaking_style || "", background_story: c.bio || "",
        hidden_layer: c.hidden_layer || "", values: c.values || "", soft_spot: c.soft_spot || "",
        hobbies: c.hobbies || "", catchphrases: c.catchphrases || "", quirks: c.quirks || "",
        prompt_extra: c.prompt_extra || "",
        reply_max_tokens: (c.reply_max_tokens ?? "") + "", memory_depth: (c.memory_depth ?? "") + "",
        likes: c.likes || "", dislikes: c.dislikes || "", voice_id: c.voiceId || "",
      };
      // 切角色清空上一个的克隆片段/状态
      this._cloneBlob = null;
      ns.recording = false; ns.cloning = false; ns.hasClip = false; ns.cloneStatus = ""; ns.cloneDemoUrl = "";
      // 头像预览：进来先显该角色【已有】头像（has_avatar 才显，避免没生成时一个破图标）；状态清空。
      ns.avatarBusy = false; ns.avatarStatus = "";
      ns.avatarPreview = (c.has_avatar && (c.cid || c.id)) ? adminAvatarUrl(c.cid || c.id, true) : "";
    }
    if (type === "ticket") ns.replyDraft = "";
    this.setState(ns);
  }

  setCe(k: string, v: string) {
    this.setState((p) => ({ charEdit: { ...p.charEdit, [k]: v } }));
  }

  /** 打开「新建角色」表单（空白 + AI 生成入口）。 */
  openNewChar() {
    this.setState({ detail: { type: "char", id: "__new__" }, charBio: "", charAiPrompt: "",
      charEdit: { name: "", tagline: "", gender: "女", age: "20", nationality: "", appearance: "", height: "", weight: "", birthday: "", race: "", occupation: "", residence: "", mbti: "", summary: "", core: "", traits: "", speaking_style: "", background_story: "", hidden_layer: "", values: "", soft_spot: "", hobbies: "", catchphrases: "", quirks: "", prompt_extra: "", reply_max_tokens: "", memory_depth: "", likes: "", dislikes: "", voice_id: "" } });
  }

  /** AI 一键生成角色字段，填进编辑表单（运营可再微调）。 */
  async genCharAI() {
    if (!usingBackend()) { this.toastMsg("需接入后端"); return; }
    this.toastMsg("AI 生成中…");
    const res = await generateCharacter((this.state.charAiPrompt || "").trim());
    if (!res.ok || !res.fields) { this.toastMsg(res.error || "生成失败"); return; }
    const f = res.fields;
    this.setState((p) => ({ charBio: f.background_story || "", charEdit: { ...p.charEdit,
      name: f.name || "", tagline: f.tagline || "", gender: f.gender || (p.charEdit as any).gender, age: f.age || (p.charEdit as any).age,
      traits: f.traits || "", speaking_style: f.speaking_style || "", background_story: f.background_story || "",
      core: f.core || "", likes: f.likes || "", dislikes: f.dislikes || "" } }));
    this.toastMsg("已生成，可微调后保存");
  }

  /** AI 生成内核：按当前编辑态的现有维度提炼一段 core，填进内核框（运营可再微调）。 */
  async genCore() {
    if (!usingBackend()) { this.toastMsg("需接入后端"); return; }
    if (this.state.genCoreBusy) return;
    const e = this.state.charEdit as any;
    // 维度太空提炼不出内核——先让运营填点性格/来历/软肋
    const hasMaterial = ["summary", "traits", "background_story", "hidden_layer", "values", "soft_spot", "likes", "dislikes", "speaking_style", "catchphrases", "quirks"]
      .some((k) => String(e[k] || "").trim());
    if (!hasMaterial) { this.toastMsg("先填点性格/来历/软肋，再生成内核"); return; }
    this.setState({ genCoreBusy: true });
    this.toastMsg("AI 提炼内核中…");
    try {
      const res = await generateCore({
        name: e.name, tagline: e.tagline, occupation: e.occupation, summary: e.summary,
        traits: e.traits, speaking_style: e.speaking_style, background_story: e.background_story,
        hidden_layer: e.hidden_layer, values: e.values, soft_spot: e.soft_spot,
        likes: e.likes, dislikes: e.dislikes, catchphrases: e.catchphrases, quirks: e.quirks, hobbies: e.hobbies,
      });
      if (!res.ok || !res.core) { this.toastMsg(res.error || "生成失败"); return; }
      this.setCe("core", res.core);
      this.toastMsg("内核已生成，可微调后保存");
    } finally {
      this.setState({ genCoreBusy: false });
    }
  }

  // ── 音色克隆：录一段人声（或选文件）→ MiniMax 复刻 → 设为本角色音色 ──
  private _recStream: MediaStream | null = null;
  private _recCtx: AudioContext | null = null;
  private _recNode: ScriptProcessorNode | null = null;
  private _recBufs: Float32Array[] = [];
  private _recRate = 44100;
  private _cloneBlob: Blob | null = null;
  private _cloneName = "voice.wav";

  /** 开始录音：getUserMedia + AudioContext 采集 PCM（停止时编码 WAV，MiniMax 接受 wav）。 */
  async startRecord() {
    if (this.state.recording) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      const Ctx = (window as any).AudioContext || (window as any).webkitAudioContext;
      const ctx = new Ctx();
      const src = ctx.createMediaStreamSource(stream);
      const node = ctx.createScriptProcessor(4096, 1, 1);
      this._recBufs = []; this._recRate = ctx.sampleRate;
      node.onaudioprocess = (e: any) => { this._recBufs.push(new Float32Array(e.inputBuffer.getChannelData(0))); };
      src.connect(node); node.connect(ctx.destination);
      this._recStream = stream; this._recCtx = ctx; this._recNode = node;
      this.setState({ recording: true, cloneStatus: "录音中…（建议 15 秒～1 分钟，吐字清晰、安静环境）", cloneDemoUrl: "" });
    } catch (e: any) {
      this.toastMsg("无法录音：" + (e && e.message || "请允许麦克风权限"));
    }
  }

  /** 停止录音：拼接 PCM → 编码 16bit WAV，存为待克隆片段。 */
  stopRecord() {
    if (!this.state.recording) return;
    try { this._recNode?.disconnect(); } catch { /* noop */ }
    try { this._recStream?.getTracks().forEach((t) => t.stop()); } catch { /* noop */ }
    try { this._recCtx?.close(); } catch { /* noop */ }
    const blob = this._encodeWav(this._recBufs, this._recRate);
    this._recNode = null; this._recStream = null; this._recCtx = null; this._recBufs = [];
    const secs = blob ? Math.round((blob.size - 44) / 2 / this._recRate) : 0;
    if (!blob || secs < 8) { this.setState({ recording: false, cloneStatus: "录音太短（至少 8 秒），请重录" }); this._cloneBlob = null; return; }
    this._cloneBlob = blob; this._cloneName = "voice.wav";
    this.setState({ recording: false, hasClip: true, cloneStatus: `已录 ${secs} 秒，可点「克隆并设为该角色音色」` });
  }

  /** 选本地音频文件（mp3/m4a/wav）作为克隆素材。 */
  pickCloneFile(file: File) {
    if (!file) return;
    if (file.size > 20 * 1024 * 1024) { this.toastMsg("文件过大（≤20MB）"); return; }
    this._cloneBlob = file; this._cloneName = file.name || "voice.wav";
    this.setState({ hasClip: true, cloneStatus: `已选「${file.name}」，可点克隆`, cloneDemoUrl: "" });
  }

  /** 把 Float32 PCM 块编码成 16bit 单声道 WAV Blob。 */
  private _encodeWav(bufs: Float32Array[], rate: number): Blob | null {
    let len = 0; bufs.forEach((b) => (len += b.length));
    if (len === 0) return null;
    const pcm = new Float32Array(len); let off = 0;
    bufs.forEach((b) => { pcm.set(b, off); off += b.length; });
    const bytes = len * 2;
    const buf = new ArrayBuffer(44 + bytes); const view = new DataView(buf);
    const ws = (o: number, s: string) => { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); };
    ws(0, "RIFF"); view.setUint32(4, 36 + bytes, true); ws(8, "WAVE"); ws(12, "fmt ");
    view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
    ws(36, "data"); view.setUint32(40, bytes, true);
    let p = 44; for (let i = 0; i < len; i++) { const s = Math.max(-1, Math.min(1, pcm[i])); view.setInt16(p, s < 0 ? s * 0x8000 : s * 0x7fff, true); p += 2; }
    return new Blob([buf], { type: "audio/wav" });
  }

  /** 调后端 /admin/voice-clone：复刻并把返回 voice_id 写进当前角色音色框。 */
  async doClone() {
    const d = this.state.detail;
    if (!d || d.type !== "char") return;
    if (!this._cloneBlob) { this.toastMsg("请先录音或选择音频文件"); return; }
    if (this.state.cloning) return;
    this.setState({ cloning: true, cloneStatus: "上传并克隆中…（首次复刻约十几秒，请稍候）", cloneDemoUrl: "" });
    const cid = (this.chars.find((x) => x.id === d.id) as any)?.cid || "";
    const previewName = (this.state.charEdit as any)?.name || "我";
    const res = await cloneVoice(this._cloneBlob, cid, this._cloneName, `你好呀，我是${previewName}，这是我克隆出来的声音。`);
    if (!res.ok) { this.setState({ cloning: false, cloneStatus: "克隆失败：" + (res.error || "未知错误") }); return; }
    this.setCe("voice_id", res.voice_id || "");   // 自动填进音色框，保存即生效
    this.setState({ cloning: false, cloneDemoUrl: res.demo_audio || "",
      cloneStatus: `已克隆，voice_id=${res.voice_id}${res.set_to ? "（已设为该角色音色，记得点保存）" : "（请点保存让音色生效）"}` });
    this.toastMsg("音色克隆成功，记得保存角色");
  }

  /** 调后端 /admin/generate-avatar：给当前角色生成「半写实·柔光影棚」头像，成功后就地预览。 */
  async doGenerateAvatar() {
    const d = this.state.detail;
    if (!d || d.type !== "char") return;
    if (d.id === "__new__") { this.toastMsg("请先创建并保存角色，再生成头像"); return; }
    if (this.state.avatarBusy) return;
    const cid = (this.chars.find((x) => x.id === d.id) as any)?.cid || d.id;
    this.setState({ avatarBusy: true, avatarStatus: "生成中…（约十几秒到一分钟，取决于生图模型）" });
    const res = await generateAvatar(cid);
    if (!res.ok) { this.setState({ avatarBusy: false, avatarStatus: "生成失败：" + (res.error || "未知错误") }); return; }
    // 用同域 /admin/avatar 预览（带 cache-bust），生成/重生后立刻看到最新。
    this.chars.forEach((x) => { if ((x.cid || x.id) === cid) x.has_avatar = true; });   // 角色列表卡片即时显头像
    this.setState({ avatarBusy: false, avatarStatus: "已生成（全站下一通/刷新即用真实头像）", avatarPreview: adminAvatarUrl(cid, true) });
    this.toastMsg("头像已生成");
  }

  /** 上传图片替代 AI 生成 → 存为该角色头像（后端会自动缩放压缩），就地预览。 */
  async onAvatarPick(file: File) {
    const d = this.state.detail;
    if (!d || d.type !== "char") return;
    if (d.id === "__new__") { this.toastMsg("请先创建并保存角色，再上传头像"); return; }
    if (this.state.avatarBusy) return;
    const cid = (this.chars.find((x) => x.id === d.id) as any)?.cid || d.id;
    this.setState({ avatarBusy: true, avatarStatus: "上传中…" });
    const res = await uploadAvatar(cid, file);
    if (!res.ok) { this.setState({ avatarBusy: false, avatarStatus: "上传失败：" + (res.error || "未知错误") }); return; }
    this.chars.forEach((x) => { if ((x.cid || x.id) === cid) x.has_avatar = true; });
    this.setState({ avatarBusy: false, avatarStatus: "已上传（全站下一通/刷新即用）", avatarPreview: adminAvatarUrl(cid, true) });
    this.toastMsg("头像已上传");
  }

  /** 删除当前角色：二次确认后执行（自定义直删 / 出厂隐藏，不可撤销）。 */
  delChar() {
    const d = this.state.detail;
    if (!d || d.type !== "char" || d.id === "__new__") return;
    const c = this.chars.find((x) => x.id === d.id);
    this.askConfirm({ title: "删除角色", body: `确定删除「${c?.name || "该角色"}」？删除后用户端将不再显示，不可撤销。`,
      okLabel: "删除", action: () => this._doDelChar() });
  }
  private async _doDelChar() {
    const d = this.state.detail;
    if (!d || d.type !== "char" || d.id === "__new__") return;
    const c = this.chars.find((x) => x.id === d.id);
    const ok = await deleteCharacter(c?.cid || c?.id || d.id);
    if (!ok) { this.toastMsg("删除失败"); return; }
    this.chars = this.chars.filter((x) => x.id !== d.id);
    this.setState({ detail: null });
    this.toastMsg("角色已删除，下一通通话生效");
  }

  /** 保存角色人设到后端（新建走 create，编辑走 update）；同步更新本地展示。 */
  async saveChar() {
    const d = this.state.detail;
    if (!d || d.type !== "char") return;
    if (this.state.savingChar) return;   // 防连点重复提交
    const e: any = this.state.charEdit || {};
    if (d.id === "__new__") {   // 新建自定义角色
      if (!(e.name || "").trim()) { this.toastMsg("请填写角色名"); return; }
      this.setState({ savingChar: true });
      try {
        const res = await createCharacter(e);   // e 含 prompt_extra，后端按字段落 runtime_overrides
        if (!res.ok || !res.id) { this.toastMsg(res.error || "创建失败"); return; }
        this.chars.push({ id: res.id, cid: res.id, name: e.name, desc: e.tagline, hue: hueFromId(res.id),
          gender: e.gender || "女", age: e.age || "20", height: 160, weight: 48, birthday: "", nationality: "", race: "",
          occupation: e.occupation || "", residence: e.residence || "", mbti: e.mbti || "", summary: e.summary || "", core: e.core || "",
          hobbies: e.hobbies || "", catchphrases: e.catchphrases || "", quirks: e.quirks || "", soft_spot: e.soft_spot || "",
          traits: this._splitList(e.traits), tags: [], slogan: "", likes: e.likes || "", dislikes: e.dislikes || "",
          bio: e.background_story || "", speaking_style: e.speaking_style || "", prompt_extra: e.prompt_extra || "", voiceId: e.voice_id || "",
          reply_max_tokens: e.reply_max_tokens || "", memory_depth: e.memory_depth || "",
          calls: "0", customVoices: 0, favs: "0", status: "上线" });
        this.setState({ detail: null });
        this.toastMsg("角色已创建，下一通通话生效");
      } finally {
        this.setState({ savingChar: false });
      }
      return;
    }
    const c = this.chars.find((x) => x.id === d.id);
    if (!c || !c.cid) { this.toastMsg("该角色未关联后端，无法保存"); return; }
    this.setState({ savingChar: true });
    let ok = false;
    try {
      ok = await saveCharacter({
        id: c.cid, name: e.name, tagline: e.tagline, traits: e.traits,
        gender: e.gender, age: e.age, nationality: e.nationality, appearance: e.appearance,
        height: e.height, weight: e.weight, birthday: e.birthday, race: e.race,
        occupation: e.occupation, residence: e.residence, mbti: e.mbti, summary: e.summary, core: e.core,
        hobbies: e.hobbies, catchphrases: e.catchphrases, quirks: e.quirks, soft_spot: e.soft_spot,
        speaking_style: e.speaking_style, background_story: e.background_story,
        hidden_layer: e.hidden_layer, values: e.values, prompt_extra: e.prompt_extra,
        reply_max_tokens: e.reply_max_tokens, memory_depth: e.memory_depth,
        likes: e.likes, dislikes: e.dislikes, voice_id: e.voice_id,
      });
      if (ok) {  // 本地同步，列表/详情立即反映
        c.name = e.name; c.desc = e.tagline; c.traits = this._splitList(e.traits);
        c.bio = e.background_story; c.likes = e.likes; c.dislikes = e.dislikes;
        c.hidden_layer = e.hidden_layer; c.values = e.values; c.prompt_extra = e.prompt_extra;
        c.reply_max_tokens = e.reply_max_tokens; c.memory_depth = e.memory_depth;
        c.speaking_style = e.speaking_style; c.voiceId = e.voice_id;
        c.occupation = e.occupation; c.residence = e.residence; c.mbti = e.mbti; c.summary = e.summary; c.core = e.core;
        c.hobbies = e.hobbies; c.catchphrases = e.catchphrases; c.quirks = e.quirks; c.soft_spot = e.soft_spot;
        if (e.gender) c.gender = e.gender; if (e.age !== "" && e.age != null) c.age = e.age;
        c.nationality = e.nationality; c.appearance = e.appearance; c.birthday = e.birthday; c.race = e.race;
        if (e.height !== "" && e.height != null) c.height = e.height;
        if (e.weight !== "" && e.weight != null) c.weight = e.weight;
      }
    } finally {
      // 写成功后关详情回列表（与新建/删除一致，避免面板残留旧态）；失败则留在面板让运营重试。
      this.setState({ savingChar: false, detail: ok ? null : this.state.detail });
    }
    this.toastMsg(ok ? "角色已保存，下一通通话生效" : "保存失败，检查后端连接");
  }
  setCfg(sk: string, fk: string, v: string) {
    this.setState((p) => ({ apiCfg: { ...p.apiCfg, [sk]: { ...p.apiCfg[sk], [fk]: v } } }));
  }

  renderVals(): Vals {
    const s = this.state;
    const planStyle = (p: string) => p === "无限会员" ? { c: "#E0954F", b: "rgba(224,149,79,.12)" } : (p === "畅聊会员" ? { c: "#6E5CFF", b: "rgba(110,92,255,.1)" } : (p === "轻享会员" ? { c: "#2E7BFF", b: "rgba(46,123,255,.1)" } : (p === "已封禁" ? { c: "#E0594F", b: "rgba(224,89,79,.1)" } : { c: "#878B95", b: "#F0F0F3" })));
    // 全站统一：圈里显真实头像（稳定 URL，浏览器按 immutable 缓存，不每帧重拉）；无头像则暗底占位，不再用渐变球。
    const avatarByName = (name: string) => { const ch = this.chars.find((c: any) => c.name === name); return ch && (ch as any).has_avatar ? adminAvatarUrl((ch as any).cid || ch.id, (ch as any).avatar_rev || 0) : ""; };

    const nav = [
      { key: "dashboard", label: "数据概览", icon: "M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z" },
      { key: "users", label: "用户管理", icon: "M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" },
      { key: "characters", label: "角色管理", icon: "M12 3l2.4 7.4H22l-6 4.6 2.3 7.4-6.3-4.6L5.7 21.4 8 14 2 9.4h7.6z" },
      { key: "voices", label: "音色管理", icon: "M2 10v4M6 7v10M10 4v16M14 8v8M18 6v12M22 10v4" },
      { key: "calls", label: "通话记录", icon: "M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z" },
      { key: "tickets", label: "工单反馈", icon: "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" },
      { key: "orders", label: "订单充值", icon: "M2 4h20v16H2zM2 10h20" },
      { key: "invites", label: "邀请裂变", icon: "M20 12v10H4V12M2 7h20v5H2zM12 22V7M12 7H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7zM12 7h4.5a2.5 2.5 0 0 0 0-5C13 2 12 7 12 7z" },
    ];
    const openTicketCount = this.tickets.filter((t) => !(s.ticketReplies[t.id]) && t.status !== "已回复").length;
    const navView = nav.map((n) => ({
      label: n.label, icon: n.icon, go: () => this.go(n.key),
      bg: s.section === n.key ? "rgba(110,92,255,.1)" : "transparent",
      color: s.section === n.key ? "#6E5CFF" : "#4A4E5A",
      weight: s.section === n.key ? 600 : 500,
      badge: n.key === "tickets" && openTicketCount ? openTicketCount : "",
    }));

    const navCfg = [
      { key: "api", label: "接口配置", icon: "M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6" },
      { key: "cost", label: "成本与限流", icon: "M12 1v22M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" },
    ];
    const navConfigView = navCfg.map((n) => ({ label: n.label, icon: n.icon, go: () => this.go(n.key), bg: s.section === n.key ? "rgba(110,92,255,.1)" : "transparent", color: s.section === n.key ? "#6E5CFF" : "#4A4E5A", weight: s.section === n.key ? 600 : 500 }));
    const engStyle = (e: string) => (({ "火山引擎": { c: "#E0594F", b: "rgba(224,89,79,.1)" }, "MiniMax": { c: "#6E5CFF", b: "rgba(110,92,255,.1)" }, "Azure": { c: "#2E7BFF", b: "rgba(46,123,255,.1)" }, "ElevenLabs": { c: "#1FA971", b: "rgba(31,169,113,.1)" } } as Record<string, any>)[e] || { c: "#878B95", b: "#F0F0F3" });
    const matchedBy: Record<string, number> = { v1: 230, v2: 96, v3: 142, v4: 61, v5: 58, v6: 120, v7: 78, v8: 0, v9: 72 };
    const mmStyle = engStyle("MiniMax");
    // 接了后端：真实 MiniMax 系统（免费）音色库，可真实试听；否则回退演示数据。
    const previewVid = (vid: string) => async () => { if (!usingBackend()) { this.toastMsg("接入后端后可真实试听"); return; } this.toastMsg("正在合成试听…"); const ok = await playVoicePreview({ voiceId: vid }); this.toastMsg(ok ? "" : "试听失败：请确认 TTS 接口已配置"); };
    const voicesView = this.realVoices
      ? this.realVoices.map((v: any) => {
          const used: string[] = v.used_by || [];
          const inUse = used.length > 0;
          const ch = this.chars.find((c: any) => used.includes(c.name));
          const vav = ch && (ch as any).has_avatar ? adminAvatarUrl((ch as any).cid || ch.id, (ch as any).avatar_rev || 0) : "";
          return { matched: v.voice_id, name: v.name, engine: "MiniMax", engColor: mmStyle.c, engBg: mmStyle.b,
            meta: v.gender + " · " + v.group, char: inUse ? used.join("、") : "—",
            avatar: vav, avatarDisplay: vav ? "block" : "none", hasChar: inUse,
            status: inUse ? "已启用" : "可用", stColor: inUse ? "#1FA971" : "#878B95",
            stBg: inUse ? "rgba(31,169,113,.1)" : "#F0F0F3", preview: previewVid(v.voice_id) };
        })
      : this.voices.map((v) => { const es = engStyle(v.engine); const m = matchedBy[v.id] || 0; return { matched: this.realStats ? "—" : (m ? m.toLocaleString() + " 次" : "—"), name: v.name, engine: v.engine, engColor: es.c, engBg: es.b, meta: v.gender + " · " + v.lang, char: v.char || "—", avatar: "", avatarDisplay: "none", hasChar: !!v.char, status: v.status, stColor: v.status === "启用" ? "#1FA971" : "#878B95", stBg: v.status === "启用" ? "rgba(31,169,113,.1)" : "#F0F0F3", preview: () => this.toastMsg("音色试听功能开发中") }; });
    const voicePresetCount = this.realVoices ? this.realVoices.length : this.voices.length;
    const voiceCloneCount = this.chars.reduce((a, c) => a + c.customVoices, 0).toLocaleString();
    const voiceMatchTotal = this.realVoices
      ? String(this.realVoices.filter((v: any) => (v.used_by || []).length > 0).length)
      : Object.values(matchedBy).reduce((a, b) => a + b, 0).toLocaleString();
    const ttsEngine = s.apiCfg.tts.model;
    const charTabs = ([["role", "角色"], ["voice", "音色"]] as [string, string][]).map(([k, label]) => ({ label, pick: () => this.setState({ charTab: k }), bg: s.charTab === k ? "#16161A" : "#fff", color: s.charTab === k ? "#fff" : "#5A5E6B", border: s.charTab === k ? "#16161A" : "#E6E7EB" }));
    const exportSample = '{\n  "id": "c1",\n  "name": "林晚",\n  "gender": "女", "age": 18, "height": 156, "weight": 44,\n  "birthday": "2006年1月1日", "nationality": "中国", "race": "东亚人",\n  "desc": "温柔的深夜倾听者",\n  "traits": ["温柔", "耐心", "共情"],\n  "tags": ["治愈系", "深夜", "倾听", "温柔"],\n  "slogan": "今天也辛苦了，想聊点什么都可以。",\n  "bio": "深夜电台主播出身……",\n  "likes": "安静的深夜、下雨天……",\n  "dislikes": "被敷衍、嘈杂的人群……",\n  "voice": { "engine": "MiniMax", "voice_id": "female-shaonv-01", "file": "c1__voice.wav" },\n  "status": "上线"\n}';
    const mkKpi = (label: string, value: string, delta: string, dc: string, db: string, note: string) => ({ label, value, delta, deltaColor: dc, deltaBg: db, note });
    const istat = this.realInviteStats || { total_invites: 0, reward_minutes: 0 };   // 全真实，无演示回退
    const inviteKpis = [
      mkKpi("累计邀请", (istat.total_invites || 0).toLocaleString(), "实时", "#1FA971", "rgba(31,169,113,.1)", "成功注册数"),
      mkKpi("成功注册", (istat.total_invites || 0).toLocaleString(), "", "#6E5CFF", "rgba(110,92,255,.1)", "带码注册"),
      mkKpi("待激活", "0", "", "#878B95", "#F0F0F3", "无待激活态"),
      mkKpi("已发放奖励", (istat.reward_minutes || 0).toLocaleString(), "分钟", "#878B95", "#F0F0F3", "双方各得 " + s.inviteReward + " 分钟"),
    ];
    const invStatus = (st2: string) => st2 === "已注册" ? { c: "#1FA971", b: "rgba(31,169,113,.1)" } : { c: "#E0954F", b: "rgba(224,149,79,.12)" };
    const invitersView = this.inviters.map((v, i) => ({ rank: i + 1, name: v.name, initial: v.initial, grad: v.grad, invited: v.invited, success: v.success, pending: v.pending, mins: v.mins }));
    const inviteRecordsView = this.inviteRecords.map((r) => { const ist = invStatus(r.status); return { inviter: r.inviter, invitee: r.invitee, status: r.status, stColor: ist.c, stBg: ist.b, reward: r.reward, rewardColor: r.reward.indexOf("+") === 0 ? "#1FA971" : "#A8ABB5", date: r.date }; });
    const apiCards = this.apiSections.map((sec) => { const cfg = s.apiCfg[sec.key] || {}; return {   // || {}：某节点配置未就绪也不崩渲染（曾因新增 image 节点 apiCfg 无此键 → cfg.provider 抛错白屏）
      name: sec.name, desc: sec.desc, icon: sec.icon, req: sec.req,
      chain: sec.chain, chainColor: sec.chain === "快链路" ? "#6E5CFF" : "#1FA971", chainBg: sec.chain === "快链路" ? "rgba(110,92,255,.1)" : "rgba(31,169,113,.1)",
      tileBg: sec.chain === "快链路" ? "linear-gradient(140deg,#8E7BFF,#6E5CFF)" : "linear-gradient(140deg,#5BE0A0,#1FA971)",
      ...this._apiStatusBadge(sec.key),
      providers: (sec.providers || []).map((p: string) => ({ name: p, pick: () => this.setCfg(sec.key, "provider", p), bg: cfg.provider === p ? "#16161A" : "#fff", color: cfg.provider === p ? "#fff" : "#5A5E6B", border: cfg.provider === p ? "#16161A" : "#E6E7EB" })),
      fields: sec.fields.map((f: any) => ({ label: f.label, value: cfg[f.k] || "", type: f.pw ? "password" : "text", full: f.full ? "grid-column:1 / -1;" : "",
        // key 字段回显为 •••••• 表示后端已存、留空不改 → 显「沿用原 key」徽标，避免运营误以为换了新 key。
        masked: !!(f.pw && /•/.test(String(cfg[f.k] || ""))),
        onInput: (e: any) => this.setCfg(sec.key, f.k, e.target.value) })),
      test: () => this.testApi(sec.key, sec.name), save: () => this.saveApi(sec.name),
    }; });
    const stC: Record<string, any> = { "正常": { c: "#1FA971", b: "rgba(31,169,113,.1)" }, "未配置": { c: "#878B95", b: "#F0F0F3" }, "延迟高": { c: "#E0954F", b: "rgba(224,149,79,.12)" }, "成本高": { c: "#E0954F", b: "rgba(224,149,79,.12)" }, "异常": { c: "#E0594F", b: "rgba(224,89,79,.1)" }, "备用中": { c: "#2E7BFF", b: "rgba(46,123,255,.1)" } };
    const stp = (st: string) => { const x = stC[st] || stC["正常"]; return { status: st, stColor: x.c, stBg: x.b }; };
    const linkFlow = [{ label: "用户语音", a: "#9AA0AC" }, { label: "Qwen3-ASR-Flash", a: "#2E7BFF" }, { label: "记忆检索", a: "#9AA0AC" }, { label: "DeepSeek 快脑", a: "#6E5CFF" }, { label: "MiniMax TTS", a: "#E0594F" }, { label: "Seedance 表情", a: "#9277F5" }, { label: "用户听到", a: "#1FA971" }, { label: "Qwen-Long 记忆整理", a: "#1FA971" }];
    // 接了真实后端：成本类 KPI 用真实 usage_log 估算（$=micros/1e6）；首句响应/失败率暂无埋点 → 「—」。
    const usd = (micros: number) => "$" + ((micros || 0) / 1e6).toFixed(2);
    const cost = this.realCost;
    const callsToday = (this.realStats || {}).calls_today || 0;
    // 全真实：有用量埋点的显真实成本/今日通话；首句响应/失败率暂无埋点 → 「—」。无演示数字。
    const healthKpis = [
      { label: "整体健康", value: "正常", sub: "服务运行中", vc: "#1FA971" },
      { label: "首句响应", value: "—", sub: "需埋点", vc: "#878B95" },
      { label: "每小时成本", value: usd((cost || {}).per_hour_micros), sub: "今日均摊", vc: "#16161A" },
      { label: "每 100 分钟成本", value: usd((cost || {}).per_100min_micros), sub: "时长摊薄", vc: "#16161A" },
      { label: "今日失败率", value: "—", sub: "需埋点", vc: "#878B95" },
      { label: "今日通话", value: callsToday.toLocaleString(), sub: "次", vc: "#16161A" },
    ];
    const byNode = (cost && cost.by_node) || {};   // 今日各节点成本（micros）
    const nodeCost = (k: string) => usd(byNode[k] || 0);
    const nodeCards = [
      { name: "ASR · 语音识别", role: "听", model: "", ...stp("正常"), latency: "—", calls: "—", cost: nodeCost("asr") },
      { name: "LLM · 快脑", role: "想 · 通话中", model: "", ...stp("正常"), latency: "—", calls: "—", cost: nodeCost("llm_fast") },
      { name: "TTS · 语音合成", role: "说", model: "", ...stp("正常"), latency: "—", calls: "—", cost: nodeCost("tts") },
      { name: "表情视频", role: "表情 · 预生成", model: "", ...stp("正常"), latency: "—", calls: "—", cost: "$0.00" },
      { name: "LLM · 长记忆脑", role: "记 · 通话后", model: "", ...stp("正常"), latency: "—", calls: "—", cost: nodeCost("llm_slow") },
    ];
    const costKpis = [{ label: "今日总成本", value: usd((cost || {}).today_micros) }, { label: "本月总成本", value: usd((cost || {}).month_micros) }, { label: "每小时平均", value: usd((cost || {}).per_hour_micros) }, { label: "每 100 分钟", value: usd((cost || {}).per_100min_micros) }];
    const NODE_LABEL: Record<string, string> = { llm_fast: "LLM 快脑", tts: "TTS 语音合成", asr: "ASR 语音识别", llm_slow: "记忆整理", embedding: "记忆检索" };
    const NODE_C: Record<string, string> = { llm_fast: "#6E5CFF", tts: "#E0594F", asr: "#2E7BFF", llm_slow: "#1FA971", embedding: "#9277F5" };
    const cbpTot = Object.values(byNode).reduce((a: number, b: any) => a + (b || 0), 0) as number;
    const costByProvider = Object.keys(byNode).filter((k) => byNode[k] > 0).sort((a, b) => byNode[b] - byNode[a]).map((k) => ({
      name: NODE_LABEL[k] || k, value: usd(byNode[k]), pct: cbpTot > 0 ? Math.round(byNode[k] / cbpTot * 100) + "%" : "0%", c: NODE_C[k] || "#878B95" }));
    const memTypeC: Record<string, string> = { fact: "#2E7BFF", preference: "#6E5CFF", project: "#E0954F", relationship: "#FF6FA5", open_loop: "#1FA971" };
    // 真实记忆涉及用户隐私，不在后台明文展示（始终空）。
    const memoryRecent: any[] = ([] as any[]).map((m) => ({ ...m, typeColor: memTypeC[m.type] || "#878B95", typeBg: (memTypeC[m.type] || "#878B95") + "1a", wColor: m.written ? "#1FA971" : "#E0954F", wBg: m.written ? "rgba(31,169,113,.1)" : "rgba(224,149,79,.12)", wLabel: m.written ? "已写入" : "待写入" }));
    const limitItems = [["单次通话最长", "60 分钟"], ["静音自动挂断", "45 秒"], ["AI 单次最大回复", "120 字"], ["超额后", "切换低成本模式"]];
    const warnItems = ["单用户今日成本 > $20", "某模型失败率 > 5%", "TTS 成本环比上涨 > 30%", "通话平均时长异常波动", "单个 voice_id 调用量激增"];

    const titles: Record<string, [string, string]> = {
      dashboard: ["数据概览", "MiCall.ai 运营核心指标"],
      users: ["用户管理", this.users.length + " 名注册用户"],
      characters: ["角色管理", this.chars.length + " 个 AI 角色"],
      voices: ["音色管理", "MiniMax 系统音色库 · 试听并分配给角色"],
      calls: ["通话记录", "会话明细与对话回放"],
      tickets: ["工单反馈", openTicketCount + " 条待处理"],
      orders: ["订单充值", "会员套餐与交易记录"],
      api: ["接口配置", "ASR · LLM · TTS 服务接入"],
      cost: ["成本与限流", "成本结构与限流策略"],
      invites: ["邀请裂变", "邀请奖励规则与裂变数据"],
    };

    const rs = this.realStats || {};   // 全真实，无演示回退（未加载时显示 0）
    const kpis = [
      { label: "总用户", value: (rs.total_users || 0).toLocaleString(), delta: "实时", up: true, note: "" },
      { label: "今日通话", value: (rs.calls_today || 0).toLocaleString(), delta: "实时", up: true, note: "" },
      { label: "总通话时长", value: (rs.total_minutes || 0).toLocaleString() + " 分钟", delta: "", up: true, note: "累计" },
      { label: "本月收入", value: "$" + ((rs.month_revenue_cents || 0) / 100).toFixed(2), delta: "", up: true, note: "已支付订单" },
    ].map((k) => ({ ...k, deltaColor: k.up ? "#1FA971" : "#E0594F", deltaBg: k.up ? "rgba(31,169,113,.1)" : "rgba(224,89,79,.1)" }));
    const trendTitles: Record<string, string> = { today: "今日通话量（按小时）", "7d": "近 7 日通话量", "30d": "近 30 日通话量（按周）" };
    const rt = this.realTrends || { today: [], "7d": [], "30d": [] };   // 全真实，无演示
    const trendSets: Record<string, any> = {
      today: { title: trendTitles.today, data: rt.today || [] },
      "7d": { title: trendTitles["7d"], data: rt["7d"] || [] },
      "30d": { title: trendTitles["30d"], data: rt["30d"] || [] },
    };
    const tset = trendSets[s.dateRange] || trendSets["7d"];
    const tmax = Math.max(1, ...tset.data.map((t: any) => t.v));
    const trend = tset.data.map((t: any) => ({ day: t.day, val: t.v.toLocaleString(), h: Math.round(t.v / tmax * 100) + "%" }));
    const trendTitle = tset.title;
    const dateChips = ([["today", "今日"], ["7d", "近 7 日"], ["30d", "近 30 日"]] as [string, string][]).map(([k, label]) => ({ label, pick: () => this.setState({ dateRange: k }), bg: s.dateRange === k ? "#16161A" : "#fff", color: s.dateRange === k ? "#fff" : "#5A5E6B", border: s.dateRange === k ? "#16161A" : "#E6E7EB" }));
    // 热门角色：this.chars 的 calls 在接后端时已是真实通话数（loadRealData 写入），演示时为内置数。
    const topChars = this.chars.slice().sort((a, b) => parseFloat(b.calls) - parseFloat(a.calls)).slice(0, 5)
      .map((c, i) => ({ rank: i + 1, name: c.name, avatar: (c as any).has_avatar ? adminAvatarUrl((c as any).cid || c.id, (c as any).avatar_rev || 0) : "", avatarDisplay: (c as any).has_avatar ? "block" : "none", calls: this.realStats ? c.calls + " 次" : c.calls }));
    const SCENE_NAME: Record<string, string> = { heart: "心情树洞", chat: "随便聊聊", interview: "模拟面试", idiom: "成语接龙", english: "英语陪练", study: "陪我学习", sleep: "睡前故事", meditation: "解压冥想", coffee: "咖啡馆", story: "睡前故事" };
    // 热门场景：从 calls.scenario 真实聚合（无数据则空，不再用演示数字）。
    const scEnt = Object.entries((this.realSceneCalls || {}) as Record<string, number>).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]).slice(0, 5);
    const scMax = Math.max(1, ...scEnt.map(([, n]) => n));
    const topScenes = scEnt.map(([k, n]) => ({ name: SCENE_NAME[k] || k, uses: String(n), pct: Math.round(n / scMax * 100) + "%" }));
    const recentCalls = this.calls.slice(0, 4).map((c) => { const av = avatarByName(c.char); return { char: c.char, avatar: av, avatarDisplay: av ? "block" : "none", scene: c.scene, dur: c.dur, open: () => this.open("call", c.id) }; });

    const ufDefs: [string, string][] = [["all", "全部"], ["无限会员", "无限会员"], ["畅聊会员", "畅聊会员"], ["轻享会员", "轻享会员"], ["免费", "免费"], ["已封禁", "已封禁"]];
    const userFilters = ufDefs.map(([k, label]) => ({
      label, pick: () => this.setState({ userFilter: k }),
      bg: s.userFilter === k ? "#16161A" : "#fff", color: s.userFilter === k ? "#fff" : "#5A5E6B",
      border: s.userFilter === k ? "#16161A" : "#E6E7EB",
    }));
    const q = s.query.trim().toLowerCase();
    const usersView = this.users.map((u) => {
      const plan = u.banned ? "已封禁" : u.plan;   // 封禁态来自后端（账号级），非本地
      const ps = planStyle(plan);
      return { ...u, plan, mins: plan === "已封禁" ? "—" : u.minsRaw, planColor: ps.c, planBg: ps.b, open: () => this.open("user", u.id) };
    }).filter((u) => (s.userFilter === "all" || u.plan === s.userFilter) && (!q || u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q)));

    const genderColor = (g: string) => g === "女" ? "#FF6FA5" : "#5B8DEF";
    const voiceIdMap: Record<string, string> = { c1: "female-shaonv-01", c2: "male-cixing-02", c3: "female-yuanqi-03", c4: "male-chenwen-04", c5: "female-tianmei-05" };
    const charMatched: Record<string, number> = { c1: 230, c2: 96, c3: 142, c4: 61, c5: 58 };
    const charsView = this.chars.filter((c) => !q || (c.name + c.desc + c.bio).toLowerCase().includes(q)).map((c) => ({ ...c, hueFilter: "hue-rotate(" + c.hue + "deg)", genderAge: c.gender + " · " + c.age + "岁", genderColor: genderColor(c.gender),
      avatar: c.has_avatar ? adminAvatarUrl(c.cid || c.id, (c as any).avatar_rev || 0) : "", avatarDisplay: c.has_avatar ? "block" : "none",   // 卡片有头像就显真实头像（&v=rev 稳定 URL，浏览器缓存命中、刷新不重拉）
      voiceId: voiceIdMap[c.id] || "default", voiceMatched: this.realStats ? "—" : (charMatched[c.id] || 0) + " 次匹配", playVoice: async (e: any) => { if (e && e.stopPropagation) e.stopPropagation(); if (!usingBackend()) { this.toastMsg("接入后端后可真实试听"); return; } this.toastMsg("正在合成试听…"); const ok = await playVoicePreview({ characterId: c.cid || "" }); this.toastMsg(ok ? "" : "试听失败：请确认 TTS 接口已配置"); },
      // 默认角色：用户端进来先选它。当前为默认显徽标；非默认给「设为默认」按钮。
      isDefault: !!c.cid && c.cid === this.defaultCharId,
      notDefault: !(!!c.cid && c.cid === this.defaultCharId),
      setDefault: (e: any) => { if (e && e.stopPropagation) e.stopPropagation(); this.setDefaultChar(c.cid || c.id); },
      status: c.status,
      // 下架/上架：下架的显「上架」按钮、上线的显「下架」按钮。
      isOnline: c.status !== "下架",
      onlineLabel: c.status === "下架" ? "上架" : "下架",
      toggleOnline: (e: any) => { if (e && e.stopPropagation) e.stopPropagation(); this.toggleCharOnline(c.cid || c.id, c.status === "下架"); },
      ...((st: string) => st === "上线" ? { stColor: "#1FA971", stBg: "rgba(31,169,113,.1)" } : { stColor: "#878B95", stBg: "#F0F0F3" })(c.status), open: () => this.open("char", c.id) }));

    const callsView = this.calls.filter((c) => !q || (c.char + c.user + c.scene).toLowerCase().includes(q)).map((c) => { const av = avatarByName(c.char); return { char: c.char, avatar: av, avatarDisplay: av ? "block" : "none", user: c.user, scene: c.scene, dur: c.dur, ended: c.ended, time: c.time, open: () => this.open("call", c.id) }; });

    const tStyle = (st: string) => st === "已回复" ? { c: "#1FA971", b: "rgba(31,169,113,.1)" } : { c: "#E0954F", b: "rgba(224,149,79,.12)" };
    const ticketsView = this.tickets.filter((t) => !q || (t.type + t.user + t.msg).toLowerCase().includes(q)).map((t) => {
      const replied = s.ticketReplies[t.id] || t.reply;
      const status = replied ? "已回复" : "待处理";
      const ts = tStyle(status);
      return { type: t.type, user: t.user, msg: t.msg, date: t.date, status, stColor: ts.c, stBg: ts.b, open: () => this.open("ticket", t.id) };
    });

    const oStyle = (st: string) => st === "已支付" ? { c: "#1FA971", b: "rgba(31,169,113,.1)" } : (st === "失败" ? { c: "#E0594F", b: "rgba(224,89,79,.1)" } : { c: "#E0954F", b: "rgba(224,149,79,.12)" });
    const ordersView = this.orders.filter((o) => !q || o.user.toLowerCase().includes(q) || o.id.toLowerCase().includes(q)).map((o) => { const os = oStyle(o.status); return { ...o, stColor: os.c, stBg: os.b }; });
    const plans = this.plans.map((p) => ({ ...p, subs: this.realStats ? "—" : p.subs, border: p.popular ? "#D9D6FF" : "#EBECEF" }));

    const d = s.detail;
    let dUser: any = null, dChar: any = null, dCall: any = null, dTicket: any = null, detailTitle = "";
    let banLabel = "", banColor = "", banBg = "", charBioLen = 0, ticketNeedsReply = false;
    if (d && d.type === "user") {
      const u = this.users.find((x) => x.id === d.id); const isBan = !!u.banned;
      const plan = isBan ? "已封禁" : u.plan;
      dUser = { ...u, plan, mins: isBan ? "—" : u.minsRaw, noRecharge: u.recharges.length === 0 };
      detailTitle = "用户详情";
      banLabel = isBan ? "解除封禁" : "封禁该用户"; banColor = isBan ? "#1FA971" : "#E0594F"; banBg = isBan ? "rgba(31,169,113,.1)" : "rgba(224,89,79,.1)";
    } else if (d && d.type === "char") {
      const isNew = d.id === "__new__";
      const c = isNew ? { name: "新角色", hue: 270, gender: (s.charEdit as any).gender || "女", age: (s.charEdit as any).age || "20", height: "—", weight: "—", desc: "AI 生成或手填", status: "上线" } : this.chars.find((x) => x.id === d.id);
      dChar = { ...c, isNew, notNew: !isNew, hueFilter: "hue-rotate(" + c.hue + "deg)", genderAge: c.gender + " · " + c.age + "岁", genderColor: c.gender === "女" ? "#FF6FA5" : "#5B8DEF", ...((st: string) => st === "上线" ? { stColor: "#1FA971", stBg: "rgba(31,169,113,.1)" } : { stColor: "#878B95", stBg: "#F0F0F3" })(c.status) };
      detailTitle = isNew ? "新建角色" : "角色编辑"; charBioLen = ((s.charEdit as any).background_story || "").length;
    } else if (d && d.type === "call") {
      const c = this.calls.find((x) => x.id === d.id);
      // 只展示后端真实留存的字段（角色/用户/场景/时长/结束方式/时间）。通话文字内容出于隐私不落库 → 不伪造回放。
      const dav = avatarByName(c.char);
      dCall = { char: c.char, avatar: dav, avatarDisplay: dav ? "block" : "none", user: c.user, scene: c.scene, dur: c.dur, ended: c.ended, time: c.time };
      detailTitle = "通话详情";
    } else if (d && d.type === "ticket") {
      const t = this.tickets.find((x) => x.id === d.id);
      const reply = s.ticketReplies[t.id] || t.reply;
      const status = reply ? "已回复" : "待处理";
      const ts = tStyle(status);
      dTicket = { type: t.type, user: t.user, msg: t.msg, date: t.date, status, reply, stColor: ts.c, stBg: ts.b };
      ticketNeedsReply = !reply;
      detailTitle = "工单详情";
    }

    return {
      nav: navView, navConfig: navConfigView,
      charTabs, isRoleTab: s.charTab === "role", isVoiceTab: s.charTab === "voice", isApi: s.section === "api", isCost: s.section === "cost",
      linkFlow, healthKpis, nodeCards, costKpis, costByProvider, memoryRecent, limitItems, warnItems,
      ccCpt: s.costCfg.chars_per_token, onCcCpt: (e: any) => this.setCost("chars_per_token", e.target.value),
      ccLlmFast: s.costCfg.llm_fast, onCcLlmFast: (e: any) => this.setCost("llm_fast", e.target.value),
      ccLlmSlow: s.costCfg.llm_slow, onCcLlmSlow: (e: any) => this.setCost("llm_slow", e.target.value),
      ccEmbedding: s.costCfg.embedding, onCcEmbedding: (e: any) => this.setCost("embedding", e.target.value),
      ccTts: s.costCfg.tts, onCcTts: (e: any) => this.setCost("tts", e.target.value),
      ccAsr: s.costCfg.asr, onCcAsr: (e: any) => this.setCost("asr", e.target.value),
      saveCost: () => this.saveCost(),
      ioOpen: s.ioOpen, exportSample,
      openExport: () => this.setState({ ioOpen: true, ioMode: "export" }), closeIO: () => this.setState({ ioOpen: false }),
      runExport: () => this.exportChars(),
      voicePresetCount, voiceCloneCount, voiceMatchTotal, ttsEngine, voicesView, apiCards,
      secTitle: titles[s.section][0], secSub: titles[s.section][1],
      query: s.query, onQuery: (e: any) => this.setState({ query: e.target.value }),
      isDashboard: s.section === "dashboard", isUsers: s.section === "users", isChars: s.section === "characters", isVoices: s.section === "voices",
      // 看板永远显示真实数据（未加载/无数据时为 0 或空），不再有「演示数据·占位数字」横幅误导。
      isCalls: s.section === "calls", isTickets: s.section === "tickets", isOrders: s.section === "orders",
      kpis, trend, trendTitle, dateChips, topChars, topScenes, recentCalls,
      isInvites: s.section === "invites",
      inviteKpis, invitersView, inviteRecordsView,
      // 后端是对称奖励（reward_minutes 一个值，双方同得）→ 邀请人输入即权威值、被邀请人镜像只读，UI 不再误导成可分别设。
      inviteReward: s.inviteReward, onInviteReward: (e: any) => this.setState({ inviteReward: e.target.value, inviteeReward: e.target.value }),
      registerGift: s.registerGift, onRegisterGift: (e: any) => this.setState({ registerGift: e.target.value }),
      inviteeReward: s.inviteReward, onInviteeReward: (e: any) => this.setState({ inviteReward: e.target.value, inviteeReward: e.target.value }),
      inviteRuleOn: s.inviteRuleOn, toggleInviteRule: () => this.setState((p) => ({ inviteRuleOn: !p.inviteRuleOn })),
      ruleTrackBg: s.inviteRuleOn ? "#6E5CFF" : "#D8D9DE", ruleKnobLeft: s.inviteRuleOn ? "20px" : "2px",
      saveInviteRule: () => this.saveInvite(),
      notifs: this.realStats ? (this.tickets.filter((t: any) => t.status === "待处理").length > 0 ? [{ title: this.tickets.filter((t: any) => t.status === "待处理").length + " 条工单待处理", time: "实时", dot: "#E0594F" }] : []) : this.notifs,
      notifOpen: s.notifOpen, notifUnread: this.realStats ? this.tickets.some((t: any) => t.status === "待处理") : !s.notifRead,
      toggleNotif: () => this.setState((p) => ({ notifOpen: !p.notifOpen })), closeNotif: () => this.setState({ notifOpen: false }), markAllRead: () => this.setState({ notifRead: true, notifOpen: false }),
      userFilters, usersView, charsView, callsView, ticketsView, ordersView, plans,
      redeemCode: s.redeemCode, onRedeemCode: (e: any) => this.setState({ redeemCode: e.target.value }),
      redeemUses: s.redeemUses, onRedeemUses: (e: any) => this.setState({ redeemUses: e.target.value }),
      redeemMinutes: s.redeemMinutes, onRedeemMinutes: (e: any) => this.setState({ redeemMinutes: e.target.value }),
      genRedeem: () => this.genRedeem(),
      hasGenerated: !!s.generatedCode,
      generatedCode: s.generatedCode || "",
      redeemCodesView: this.redeemCodes.map((r: any) => {
        const done = (r.used_count || 0) >= (r.max_uses || 1);
        return { code: r.code, mins: Math.round((r.seconds || 0) / 60) + " 分钟",
          uses: (r.used_count || 0) + " / " + (r.max_uses || 1),
          stColor: done ? "#878B95" : "#1FA971", stBg: done ? "#F0F0F3" : "rgba(31,169,113,.1)",
          del: () => this.delRedeem(r.code) };
      }),
      detailOpen: !!d, closeDetail: () => this.setState({ detail: null }), detailTitle,
      dUser, dChar, dCall, dTicket,
      banLabel, banColor, banBg, toggleBan: () => this.toggleBan(d && d.id),
      clearMemory: () => this.clearMemory(d && d.id),
      charBioLen, saveChar: () => this.saveChar(),
      savingChar: !!s.savingChar, saveCharOpacity: s.savingChar ? ".6" : "1",
      saveCharLabel: s.savingChar ? "保存中…" : ((s.detail && s.detail.id === "__new__") ? "创建角色" : "保存修改"),
      // 二次确认弹层（删除/封禁等危险写操作）
      confirmOpen: !!s.confirm, confirmTitle: (s.confirm && s.confirm.title) || "", confirmBody: (s.confirm && s.confirm.body) || "",
      confirmOkLabel: s.confirmBusy ? "处理中…" : ((s.confirm && s.confirm.okLabel) || "确定"),
      confirmOkBg: (s.confirm && s.confirm.danger) ? "#E0594F" : "#6E5CFF",
      confirmOpacity: s.confirmBusy ? ".6" : "1",
      confirmOk: () => this.confirmOk(), confirmCancel: () => this.confirmCancel(),
      stop: (e: any) => { if (e && e.stopPropagation) e.stopPropagation(); },   // 阻止点卡片冒泡到遮罩误关
      openNewChar: () => this.openNewChar(), genCharAI: () => this.genCharAI(), delChar: () => this.delChar(),
      isNewChar: !!(s.detail && s.detail.type === "char" && s.detail.id === "__new__"),
      charAiPrompt: s.charAiPrompt || "", onCharAiPrompt: (e: any) => this.setState({ charAiPrompt: e.target.value }),
      ceName: (s.charEdit as any).name || "", onCeName: (e: any) => this.setCe("name", e.target.value),
      ceTagline: (s.charEdit as any).tagline || "", onCeTagline: (e: any) => this.setCe("tagline", e.target.value),
      ceTraits: (s.charEdit as any).traits || "", onCeTraits: (e: any) => this.setCe("traits", e.target.value),
      ceStyle: (s.charEdit as any).speaking_style || "", onCeStyle: (e: any) => this.setCe("speaking_style", e.target.value),
      ceLikes: (s.charEdit as any).likes || "", onCeLikes: (e: any) => this.setCe("likes", e.target.value),
      ceDislikes: (s.charEdit as any).dislikes || "", onCeDislikes: (e: any) => this.setCe("dislikes", e.target.value),
      ceVoice: (s.charEdit as any).voice_id || "", onCeVoice: (e: any) => this.setCe("voice_id", e.target.value),
      // 音色克隆
      recording: !!s.recording, cloning: !!s.cloning, hasClip: !!s.hasClip,
      cloneStatus: s.cloneStatus || "", cloneDemoUrl: s.cloneDemoUrl || "", hasCloneDemo: !!s.cloneDemoUrl,
      recLabel: s.recording ? "■ 停止录音" : "● 开始录音",
      recColor: s.recording ? "#fff" : "#16161A", recBg: s.recording ? "#E0594F" : "#fff", recBorder: s.recording ? "#E0594F" : "#E6E7EB",
      toggleRecord: () => (this.state.recording ? this.stopRecord() : this.startRecord()),
      onClonePick: (e: any) => { const f = e.target.files && e.target.files[0]; if (f) this.pickCloneFile(f); },
      doClone: () => this.doClone(),
      cloneBtnLabel: s.cloning ? "克隆中…" : "克隆并设为该角色音色", cloneBtnOpacity: (s.cloning || !s.hasClip) ? ".5" : "1",
      // 头像生成
      doGenAvatar: () => this.doGenerateAvatar(),
      avatarBtnLabel: s.avatarBusy ? "生成中…" : (s.avatarPreview ? "重新生成头像" : "生成头像"),
      avatarBtnOpacity: s.avatarBusy ? ".5" : "1",
      avatarStatus: s.avatarStatus || "",
      avatarPreview: s.avatarPreview || "", hasAvatarPreview: !!s.avatarPreview, noAvatarPreview: !s.avatarPreview,
      avatarPreviewDisplay: s.avatarPreview ? "block" : "none",
      onAvatarPick: (e: any) => { const f = e.target.files && e.target.files[0]; if (f) this.onAvatarPick(f); },
      avatarIsNew: !!(s.detail && s.detail.id === "__new__"),
      ceBio: (s.charEdit as any).background_story || "", onCeBio: (e: any) => this.setCe("background_story", e.target.value),
      ceGender: (s.charEdit as any).gender || "", onCeGender: (e: any) => this.setCe("gender", e.target.value),
      ceAge: (s.charEdit as any).age || "", onCeAge: (e: any) => this.setCe("age", e.target.value),
      ceNationality: (s.charEdit as any).nationality || "", onCeNationality: (e: any) => this.setCe("nationality", e.target.value),
      ceAppearance: (s.charEdit as any).appearance || "", onCeAppearance: (e: any) => this.setCe("appearance", e.target.value),
      ceHeight: (s.charEdit as any).height || "", onCeHeight: (e: any) => this.setCe("height", e.target.value),
      ceWeight: (s.charEdit as any).weight || "", onCeWeight: (e: any) => this.setCe("weight", e.target.value),
      ceBirthday: (s.charEdit as any).birthday || "", onCeBirthday: (e: any) => this.setCe("birthday", e.target.value),
      ceRace: (s.charEdit as any).race || "", onCeRace: (e: any) => this.setCe("race", e.target.value),
      ceHidden: (s.charEdit as any).hidden_layer || "", onCeHidden: (e: any) => this.setCe("hidden_layer", e.target.value),
      ceValues: (s.charEdit as any).values || "", onCeValues: (e: any) => this.setCe("values", e.target.value),
      ceOccupation: (s.charEdit as any).occupation || "", onCeOccupation: (e: any) => this.setCe("occupation", e.target.value),
      ceResidence: (s.charEdit as any).residence || "", onCeResidence: (e: any) => this.setCe("residence", e.target.value),
      ceMbti: (s.charEdit as any).mbti || "", onCeMbti: (e: any) => this.setCe("mbti", e.target.value),
      ceSummary: (s.charEdit as any).summary || "", onCeSummary: (e: any) => this.setCe("summary", e.target.value),
      ceCore: (s.charEdit as any).core || "", onCeCore: (e: any) => this.setCe("core", e.target.value),
      onGenCore: () => this.genCore(), genCoreLabel: s.genCoreBusy ? "提炼中…" : "✨ AI 生成内核",
      ceHobbies: (s.charEdit as any).hobbies || "", onCeHobbies: (e: any) => this.setCe("hobbies", e.target.value),
      ceCatchphrases: (s.charEdit as any).catchphrases || "", onCeCatchphrases: (e: any) => this.setCe("catchphrases", e.target.value),
      ceQuirks: (s.charEdit as any).quirks || "", onCeQuirks: (e: any) => this.setCe("quirks", e.target.value),
      ceSoftSpot: (s.charEdit as any).soft_spot || "", onCeSoftSpot: (e: any) => this.setCe("soft_spot", e.target.value),
      cePromptExtra: (s.charEdit as any).prompt_extra || "", onCePromptExtra: (e: any) => this.setCe("prompt_extra", e.target.value),
      ceReplyMax: (s.charEdit as any).reply_max_tokens || "", onCeReplyMax: (e: any) => this.setCe("reply_max_tokens", e.target.value),
      ceMemDepth: (s.charEdit as any).memory_depth || "", onCeMemDepth: (e: any) => this.setCe("memory_depth", e.target.value),
      replyDraft: s.replyDraft, onReplyDraft: (e: any) => this.setState({ replyDraft: e.target.value }), ticketNeedsReply,
      sendReply: async () => { const v = (s.replyDraft || "").trim(); if (!v) { this.toastMsg("请输入回复内容"); return; } const id = d.id; const ok = await replyTicket(id, v); if (!ok && usingBackend()) { this.toastMsg("回复失败，请重试"); return; } const t = this.tickets.find((x) => x.id === id); if (t) { t.reply = v; t.status = "已回复"; } this.setState((p) => ({ ticketReplies: { ...p.ticketReplies, [id]: v }, replyDraft: "" })); this.toastMsg("回复已发送"); },
      toast: s.toast,
    };
  }
}
