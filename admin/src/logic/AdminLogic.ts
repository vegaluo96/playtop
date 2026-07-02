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
         createCharacter, deleteCharacter, generateCharacter, generateCore, setCharacterOnline, resetCharAutonomous, syncRealtimeToFactory,
         loadDefaultCharacter, saveDefaultCharacter, saveCharacterOrder,
         loadInviteConfig, saveInviteConfig,
         loadCostConfig, saveCostConfig, usingBackend, playVoicePreview, loadVoices, setUserBanned, resetUserMemory, grantUserMinutes, cloneVoice,
         worldRefresh, loadWorld, testHotSources, loadLimits, saveLimits,
         loadHotSources, saveHotSources, testOneSource, removeTopic, pinTopic,
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

// 「导入角色」给 AI 的提示词模板：发给任意 AI、改最后一行描述 → 它输出 JSON → 粘回下框自动解析新建。
// 字段名与后台「新建角色」一致（列表用顿号分隔；解析时数组也兼容）。
const IMPORT_TEMPLATE = `你是顶尖虚拟角色设定师，为中文「语音陪伴」电话 App 写一个能打电话聊天的【真人】。

先想清两步，再输出：① 先定 core——这个人的魂（最在乎/最怕失去的那一件事 + 守着的软处）；② 让其余每个字段都从 core 长出来、能回溯到它。判据只有一条：用户在电话里【听得见/感觉得到】的才写实；听不见的（精确身高体重、生日到日、MBTI 标签）可留白，宁缺毋编。

只输出一个 JSON 对象，不要解释、不要 markdown 代码框，字段（全部中文，MBTI 除外；列表用顿号、分隔）。字段已按因果排序（魂→性格→怎么说话→裂缝→世界→表层），请照这个次序想：
{
  "name": "中文名 2-3 字",
  "tagline": "一句话简介（给人的『感觉』，不是职业说明）",
  "core": "魂 2-4 句，第二人称『你…』：最在乎/最怕失去的一件事 + 守着的软处；写出『表面一面 vs 底下真相』那道裂缝；show-not-tell，别贴标签、别报星座/MBTI、别写成完美/万能",
  "traits": "核心性格 3-4 个，顿号分隔（从 core 长出来）",
  "summary": "性子速写一句话（用户卡片展示）",
  "speaking_style": "说话风格：语速/尾音/用词习惯——这是 core『听起来』的样子",
  "catchphrases": "口头禅 2-3 个，顿号分隔（别多，多了像复读机）",
  "quirks": "小动作/小习惯 2-3 个，顿号分隔",
  "prompt_extra": "一句实时口吻提醒，要四样：①腔调（如 用短句、少铺垫）②一条本角色【专属反口癖护栏】——点名别把上面某个招牌口头禅/句式句句刷屏 ③别端着、别鸡汤 ④对用户真好奇、别只顾自己",
  "hidden_layer": "未必明说、但会流露的内里（表里那道缝的『里』）",
  "soft_spot": "软肋：一戳就破的那处 + 最想听到的一句话",
  "values": "价值观与边界一句话",
  "hobbies": "兴趣爱好 3-4 个，顿号分隔",
  "likes": "喜欢 3-5 个，顿号分隔",
  "dislikes": "不喜欢 3-5 个，顿号分隔",
  "background_story": "来历 2-3 句（魂落在哪儿）",
  "appearance": "外貌一句话，写成声音/气场的画面，不是卷尺数据",
  "gender": "男 或 女",
  "age": 数字,
  "occupation": "具体职业",
  "residence": "现居城市",
  "nationality": "国籍，如 中国",
  "race": "种族，如 东亚人",
  "mbti": "四字母 MBTI（仅卡片展示；别在对话/core 里自报；拿不准就留空）",
  "height": "身高cm数字（电话里听不见，可留白）",
  "weight": "体重kg数字（可留白）",
  "birthday": "YYYY-MM-DD，与年龄一致（可留白）"
}
硬性规则：core 是灵魂、要写出软处；其余字段都从 core 长出来；不要写成完美/万能；口头禅别刷屏；不要出现『作为AI/语言模型』之类元设定。
角色描述（改这一行）：温柔的深夜电台主播，话不多但很会听`;

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
  _limU = 200; _limC = 200; _limO = 200;   // 列表分页：用户/通话/订单当前拉取条数（「加载更多」逐次 +200）
  _moreU = false; _moreC = false; _moreO = false;   // 是否还有下一页：多取 1 条判定（避免恰好满页时 >= 误显「加载更多」）
  defaultCharId = "";           // 当前默认角色 cid（用户端进来先选它）

  private _t: Timer | undefined;
  private _tt: Timer[] = [];

  state: State = {
    section: "dashboard", detail: null, query: "", userFilter: "all", charBio: "", charEdit: {}, replyDraft: "", toast: "", ticketReplies: {}, inviteReward: "60", inviteeReward: "60", registerGift: "60", inviteRuleOn: true, grantMin: "", notifOpen: false, notifRead: false, dateRange: "7d", charTab: "role", ioOpen: false, importText: "", apiStatus: {}, apiTestDetail: {}, worldPull: null, worldPulling: false, worldLib: null, srcTest: null, srcTesting: false, limitsCfg: null, worldEndpoints: [], newSource: "", srcOne: {}, catFilter: "",
    confirm: null, confirmBusy: false, savingChar: false, genCoreBusy: false, genCharBusy: false,   // 二次确认弹层 / 异步写忙态（防误删、防连点）
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
      search: { provider: "apiyi", endpoint: "https://api.apiyi.com/v1/chat/completions", key: "", model: "qwen-long", maxTokens: "1600" },
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
      { key: "fast", name: "LLM · 快脑（通话中）", chain: "快链路", desc: "通话中实时生成简短回复 · 默认 deepseek-v4-flash（DeepSeek 直连，小写；deepseek-chat 是其旧别名，2026-07-24 停用）", icon: "M13 2L3 14h7l-1 8 10-12h-7l1-8z", req: "快 · 短 · 低延迟 · 可打断", fields: [{ k: "endpoint", label: "接口地址", full: true }, { k: "key", label: "API Key", pw: true }, { k: "model", label: "模型" }, { k: "temp", label: "温度" }] },
      { key: "tts", name: "TTS · 语音合成", chain: "快链路", desc: "合成角色语音，voice_id 决定音色 · 默认 MiniMax TTS（官方直连，支持 emotion）", icon: "M11 5 6 9H3v6h3l5 4V5zM15.5 9a4.5 4.5 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11", req: "快 · 自然 · 可打断", fields: [{ k: "endpoint", label: "接口地址", full: true }, { k: "key", label: "API Key", pw: true }, { k: "model", label: "模型" }, { k: "voiceId", label: "默认 voice_id" }, { k: "sampleRate", label: "采样率" }] },
      { key: "memory", name: "LLM · 长记忆脑（通话后）", chain: "慢链路", desc: "通话后总结、提取长期记忆、生成开场白 · 默认 qwen-max（经 apiyi，可在「模型」改 qwen-plus 等；离线不要求快）", icon: "M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2zM2 12h20M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20", req: "准 · 稳 · 长上下文（不要求快）", fields: [{ k: "endpoint", label: "接口地址", full: true }, { k: "key", label: "API Key", pw: true }, { k: "model", label: "模型（如 qwen-max / qwen-plus）" }, { k: "maxContext", label: "最大上下文" }] },
      { key: "embed", name: "Embedding · 记忆检索", chain: "慢链路", desc: "向量化记忆并快速检索相关片段 · 存储 Postgres + pgvector", icon: "M21 5c0 1.66-4 3-9 3S3 6.66 3 5s4-3 9-3 9 1.34 9 3zM3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5M3 12c0 1.66 4 3 9 3s9-1.34 9-3", req: "快检索 · 高召回", fields: [{ k: "endpoint", label: "接口地址", full: true }, { k: "key", label: "API Key", pw: true }, { k: "model", label: "模型" }, { k: "vectorDB", label: "向量数据库" }, { k: "topK", label: "检索 Top-K" }] },
      { key: "image", name: "生图 · 角色头像", chain: "离线", desc: "给角色生成头像（半写实·柔光影棚，规范锁死防全站漂移）· OpenAI 兼容 images 接口（经 apiyi，可填 gpt-image-1 / flux 等）", icon: "M21 15l-5-5L5 21M3 5h18a0 0 0 0 1 0 0v14a0 0 0 0 1 0 0H3a0 0 0 0 1 0 0V5a0 0 0 0 1 0 0zM8.5 8.5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0z", req: "1:1 正方 · 头肩居中 · 不要求快", fields: [{ k: "endpoint", label: "接口地址（…/v1/images/generations）", full: true }, { k: "key", label: "API Key", pw: true }, { k: "model", label: "生图模型（如 gpt-image-1 / flux）" }, { k: "size", label: "尺寸（如 1024x1024）" }] },
      { key: "eval", name: "LLM · 评测脑（分析/判定）", chain: "离线", desc: "图灵测试的审问者/裁判/分析师 + 后台「AI 生成角色/内核」用 · 离线偶发调用、配最强模型（经 apiyi 接 GPT/Claude 级前沿，判断力=结论可信度）· 留空则自动回退长记忆脑", icon: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3M11 8v3l2 2", req: "顶级判断力 · 不要求快", fields: [{ k: "endpoint", label: "接口地址", full: true }, { k: "key", label: "API Key", pw: true }, { k: "model", label: "模型（填你 apiyi 最强的，如 gpt-5 / claude-sonnet-4 等）" }, { k: "temp", label: "温度" }, { k: "maxTokens", label: "回复上限 Token" }] },
      { key: "search", name: "LLM · 热点改写脑（时事话题）", chain: "离线", desc: "时事话题的【真实性来自免费热榜 API】(抓真实热搜标题+原文链接、过安全闸)，这个模型只把真实标题【改写成口语闲聊】、不联网/不找热点/不编造 · grok-4.3/qwen-long 都没有真·网络检索，让模型「联网找热点」只会编(实测出现《夏日星河》等虚构番名)，故改用真实数据源 + 此脑改写 · model 填便宜够用的即可(qwen-long/qwen-plus，经 apiyi) · 留空则话题用真实标题原样(仍真实，只是没改成口语)", icon: "M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2zM2 12h20M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20", req: "改写真实热点 · 离线 · 不要求快", fields: [{ k: "endpoint", label: "接口地址", full: true }, { k: "key", label: "API Key（沿用 apiyi）", pw: true }, { k: "model", label: "改写模型（qwen-long / qwen-plus 等，经 apiyi）" }, { k: "maxTokens", label: "回复上限 Token" }] },
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

  /** 上移/下移角色：调整本地顺序后落库（保存整张顺序表）。用户端「发现」列表与后台列表都按此排，下次拉角色即生效。 */
  async moveChar(cid: string, dir: number) {
    if (!usingBackend()) { this.toastMsg("需接入后端"); return; }
    const i = this.chars.findIndex((x) => (x.cid || x.id) === cid);
    if (i < 0) return;
    const j = i + dir;
    if (j < 0 || j >= this.chars.length) return;
    const prev = this.chars;                    // 落库失败要回滚，别把错误顺序留在屏幕上到刷新
    const arr = this.chars.slice();
    [arr[i], arr[j]] = [arr[j], arr[i]];
    this.chars = arr;
    this.setState({});                          // 先即时反映新顺序，再异步落库
    const ids = arr.map((x) => x.cid || x.id).filter(Boolean);
    const ok = await saveCharacterOrder(ids);
    if (!ok) { this.chars = prev; this.setState({}); this.toastMsg("顺序保存失败"); return; }
    this.toastMsg("顺序已保存（用户端发现列表同步）");
  }

  setCost(k: string, v: string) { this.setState((p) => ({ costCfg: { ...(p as any).costCfg, [k]: v } })); }
  /** 保存计费单价到后端（admin_overrides.cost），下一通通话即按新价估算。 */
  async saveCost() {
    if (!usingBackend()) { this.toastMsg("需接入后端"); return; }
    const ok = await saveCostConfig(this.state.costCfg);
    this.toastMsg(ok ? "单价已保存，下一通通话按新价估算" : "保存失败");
  }

  /** 导入角色：解析粘贴的 AI JSON（字段同「新建角色」；列表数组也兼容）→ 直接新建一个角色。 */
  private async importChar() {
    if (!usingBackend()) { this.toastMsg("需接入后端"); return; }
    const raw = (this.state.importText || "").trim();
    if (!raw) { this.toastMsg("请先粘贴 AI 返回的 JSON"); return; }
    let data: any;
    try {
      const m = raw.match(/\{[\s\S]*\}/);   // 容错：从可能带前后文的内容里抠出第一个 {…}
      data = JSON.parse(m ? m[0] : raw);
    } catch { this.toastMsg("解析失败：不是有效 JSON"); return; }
    if (!data || typeof data !== "object") { this.toastMsg("解析失败：格式不对"); return; }
    const name = String(data.name || "").trim();
    if (!name) { this.toastMsg("缺少角色名（name）"); return; }
    const lst = (v: any) => Array.isArray(v) ? v.join("、") : String(v ?? "");   // 列表字段：数组→顿号串
    const str = (v: any) => String(v ?? "");
    const p: any = {
      name, tagline: str(data.tagline), gender: str(data.gender), age: str(data.age),
      nationality: str(data.nationality), race: str(data.race), appearance: str(data.appearance),
      occupation: str(data.occupation), residence: str(data.residence), mbti: str(data.mbti),
      height: str(data.height), weight: str(data.weight), birthday: str(data.birthday),
      traits: lst(data.traits), summary: str(data.summary), speaking_style: str(data.speaking_style),
      background_story: str(data.background_story), hidden_layer: str(data.hidden_layer),
      values: str(data.values), soft_spot: str(data.soft_spot), hobbies: lst(data.hobbies),
      catchphrases: lst(data.catchphrases), quirks: lst(data.quirks), likes: lst(data.likes),
      dislikes: lst(data.dislikes), core: str(data.core), prompt_extra: str(data.prompt_extra), voice_id: "",
    };
    if (this.state.savingChar) return;
    this.setState({ savingChar: true });
    this.toastMsg("解析成功，正在新建…");
    try {
      const res = await createCharacter(p);
      if (!res.ok || !res.id) { this.toastMsg(res.error || "创建失败"); return; }
      this.chars.push({ id: res.id, cid: res.id, name, desc: p.tagline, hue: hueFromId(res.id),
        gender: p.gender || "女", age: p.age || "20", height: 160, weight: 48, birthday: "", nationality: "", race: "",
        occupation: p.occupation, residence: p.residence, mbti: p.mbti, summary: p.summary, core: p.core,
        hobbies: p.hobbies, catchphrases: p.catchphrases, quirks: p.quirks, soft_spot: p.soft_spot,
        traits: this._splitList(p.traits), tags: [], slogan: "", likes: p.likes, dislikes: p.dislikes,
        bio: p.background_story, speaking_style: p.speaking_style, prompt_extra: p.prompt_extra, voiceId: "",
        reply_max_tokens: "", memory_depth: "", calls: "0", customVoices: 0, favs: "0", status: "上线" });
      this.setState({ ioOpen: false, importText: "" });
      this.toastMsg("已导入并新建「" + name + "」，记得去设置音色");
    } finally {
      this.setState({ savingChar: false });
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

  /** 手动给用户加/减时长（分钟）。sign=+1 增加 / -1 扣减；读输入框 grantMin 的绝对值。 */
  async grantMinutes(userId?: string, sign = 1) {
    if (!userId) return;
    if (!usingBackend()) { this.toastMsg("需接入后端"); return; }
    const n = Math.abs(parseInt(this.state.grantMin, 10) || 0);
    if (!n) { this.toastMsg("请输入分钟数"); return; }
    const delta = sign < 0 ? -n : n;
    const res = await grantUserMinutes(userId, delta);
    if (!res.ok) { this.toastMsg(res.error || "操作失败"); return; }
    const u = this.users.find((x) => x.id === userId);   // 同步刷新列表/详情里的剩余时长
    if (u) { u.minsRaw = Math.round((res.remaining_seconds || 0) / 60) + " 分钟"; }
    this.setState({ grantMin: "" });
    this.toastMsg(`已${delta > 0 ? "增加" : "扣减"} ${Math.abs(delta)} 分钟（剩余约 ${Math.round((res.remaining_seconds || 0) / 60)} 分钟）`);
  }

  /** 列表「加载更多」：把对应列表的拉取条数 +200，重拉真实数据（突破默认 200 上限）。 */
  async loadMore(kind: "users" | "calls" | "orders") {
    if (!usingBackend()) { this.toastMsg("需接入后端"); return; }
    if (kind === "users") this._limU += 200;
    else if (kind === "calls") this._limC += 200;
    else this._limO += 200;
    await this.loadRealData();
    this.setState({});
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
      loadDashboard(), loadUsers(this._limU + 1), loadCalls(this._limC + 1), loadOrders(this._limO + 1), loadTickets(), loadInvites(), loadRedeemCodes(),
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
      const cf = dash.char_favs || {};
      for (const c of this.chars) { c.calls = String(cc[c.cid] ?? cc[c.id] ?? 0); c.customVoices = 0; c.favs = String(cf[c.cid] ?? cf[c.id] ?? 0); }
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
      this._moreU = users.length > this._limU;   // 多取的那 1 条存在 → 还有下一页；只展示 _limU 条
      this.users = users.slice(0, this._limU).map((u: any, i: number) => ({
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
      this._moreC = calls.length > this._limC;
      const REASON: Record<string, string> = { ended: "正常结束", out_of_minutes: "时长用尽", error: "异常中断" };
      this.calls = calls.slice(0, this._limC).map((c: any, i: number) => {
        const cn = charName(c.character_id);
        const tx = Array.isArray(c.transcript) ? c.transcript : [];
        // 把逐句对话转成可直接渲染的气泡：用户右侧紫泡、角色左侧灰泡（测试期看真实对话内容用）。
        const messages = tx
          .filter((m: any) => m && String(m.content || "").trim())
          .map((m: any) => {
            const mine = m.role === "user";
            return {
              who: mine ? "用户" : cn, text: String(m.content || ""),
              rowJustify: mine ? "flex-end" : "flex-start", whoAlign: mine ? "right" : "left",
              bubbleBg: mine ? "#6E5CFF" : "#F2F2F5", bubbleColor: mine ? "#fff" : "#3A3D47",
            };
          });
        const guestLabel = c.guest_ip
          ? "游客" + (c.guest_region ? " · " + c.guest_region : "") + " · " + c.guest_ip
          : "游客";
        return {
          id: "rk" + i, char: cn, user: c.user_email || guestLabel,
          scene: c.scenario || "随便聊聊", dur: fmtDur(c.duration_seconds),
          ended: REASON[c.ended_reason] || (c.ended_reason || "正常结束"),
          time: fmtTime(c.started_at),
          messages, hasTranscript: messages.length > 0, noTranscript: messages.length === 0,
        };
      });
    }
    if (orders) {
      this._moreO = orders.length > this._limO;
      this.orders = orders.slice(0, this._limO).map((o: any) => ({
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
    const lim = await loadLimits();
    if (lim) this.setState({ limitsCfg: lim });
    const wl = await loadWorld();
    if (wl) this.setState({ worldLib: wl });
    const eps = await loadHotSources();
    if (eps) this.setState({ worldEndpoints: eps });
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
    this.setState((p) => ({ apiStatus: { ...p.apiStatus, [sectionKey]: "testing" }, apiTestDetail: { ...p.apiTestDetail, [sectionKey]: null } }));
    const res = await testApiSection(sectionKey, this.state.apiCfg[sectionKey]);
    const st = res.ok === false ? "fail" : "ok";   // ok===null（无后端）当通过；false 才算失败
    // 把真实结果（后端 note/错误 + ms）留在卡下方，不再只闪一下 toast。
    const detail = res.ok === false
      ? { kind: "fail", text: res.error || "未知错误" }
      : (res.answer != null
          ? { kind: res.live ? "live" : "maybe", text: res.answer, ms: res.ms }
          : { kind: "ok", text: res.note || "", ms: res.ms });
    this.setState((p) => ({ apiStatus: { ...p.apiStatus, [sectionKey]: st }, apiTestDetail: { ...p.apiTestDetail, [sectionKey]: detail } }));
    if (res.ok === null) this.toastMsg(name + " 连接测试成功");
    else if (res.ok === false) this.toastMsg(name + " 测试失败：" + (res.error || "未知错误"));
    else if (res.answer != null) this.toastMsg(name + (res.live ? " 看着像真联网 ✅" : " 已连上、但答案不像真联网 ⚠️"));
    else this.toastMsg(name + " 测试成功" + (res.ms ? ` · ${res.ms}ms` : ""));
  }

  /** 手动拉取世界库：真跑一遍 open-meteo 天气 + 免费热榜/维基真实热点抓取，把真实结果亮在面板上「看效果」。 */
  async pullWorld() {
    if (!usingBackend()) { this.toastMsg("需接入后端"); return; }
    if (this.state.worldPulling) return;
    this.setState({ worldPulling: true });
    const res = await worldRefresh();
    // 拉完回读【已保存】的世界库快照刷新常驻面板（持久化那份，重启也在）。
    const wl = await loadWorld();
    this.setState({ worldPulling: false, worldPull: res, worldLib: wl || this.state.worldLib });
    if (res.ok === null) this.toastMsg("需接入后端");
    else if (res.ok === false) this.toastMsg("拉取失败：" + (res.error || "未知错误"));
    else this.toastMsg(`真实热点 ${res.topics_count || 0} 条 · 天气 ${res.weather_cities || 0} 城` + (res.rewriter_configured ? "" : "（改写脑未配·用真实标题原样）"));
  }

  /** 一键测试所有免费热点源：逐源探可达性 + 拿到几条 + 样例，亮在面板上，方便据此增删源。 */
  async testSources() {
    if (!usingBackend()) { this.toastMsg("需接入后端"); return; }
    if (this.state.srcTesting) return;
    this.setState({ srcTesting: true, srcTest: null });
    const res = await testHotSources();
    this.setState({ srcTesting: false, srcTest: res });
    if (!res || res.ok === false) this.toastMsg("测试失败：" + ((res && res.error) || "未知错误"));
    else { const rows = res.sources || []; const up = rows.filter((r: any) => r.ok).length; this.toastMsg(`热点源 ${up}/${rows.length} 可用`); }
  }

  /** 自定义自动拉取间隔（小时）：写进 global_defaults.world_refresh_hours，约 10 分钟内生效（不用重启）。 */
  async saveWorldInterval() {
    if (!usingBackend()) { this.toastMsg("需接入后端"); return; }
    const h = parseFloat((this.state.limitsCfg || {}).world_refresh_hours);
    if (!isFinite(h) || h < 1) { this.toastMsg("请填 ≥1 的小时数"); return; }
    const ok = await saveLimits({ world_refresh_hours: h });
    if (ok) { const lim = await loadLimits(); if (lim) this.setState({ limitsCfg: lim }); }
    this.toastMsg(ok ? `已设为每 ${h} 小时自动拉取（约 10 分钟内生效）` : "保存失败");
  }

  setNewSource(v: string) { this.setState({ newSource: v }); }
  setCatFilter(c: string) { this.setState((p) => ({ catFilter: p.catFilter === c ? "" : c })); }

  /** 源管理：添加一个热点源 URL（即时存后端，下次拉取生效）。 */
  async addSource() {
    if (!usingBackend()) { this.toastMsg("需接入后端"); return; }
    const u = String(this.state.newSource || "").trim();
    if (!/^https?:\/\//.test(u)) { this.toastMsg("请填 http(s) 开头的源地址"); return; }
    if ((this.state.worldEndpoints || []).includes(u)) { this.toastMsg("已存在该源"); return; }
    const saved = await saveHotSources([...(this.state.worldEndpoints || []), u]);
    if (saved) this.setState({ worldEndpoints: saved, newSource: "" });
    this.toastMsg(saved ? "已添加，下次拉取生效" : "保存失败");
  }

  /** 源管理：删除一个热点源。 */
  async removeSource(url: string) {
    if (!usingBackend()) { this.toastMsg("需接入后端"); return; }
    const saved = await saveHotSources((this.state.worldEndpoints || []).filter((e: string) => e !== url));
    if (saved) this.setState((p) => ({ worldEndpoints: saved, srcOne: { ...p.srcOne, [url]: undefined } }));
    this.toastMsg(saved ? "已删除该源" : "保存失败");
  }

  /** 源管理：单测一个源（可达性 + 样例 + 简介，证明真抓到原文）。 */
  async testOne(url: string) {
    if (!usingBackend()) { this.toastMsg("需接入后端"); return; }
    this.setState((p) => ({ srcOne: { ...p.srcOne, [url]: { testing: true } } }));
    const res = await testOneSource(url);
    const r = (res && res.ok && res.result) ? res.result : { ok: false, error: (res && res.error) || "测试失败" };
    this.setState((p) => ({ srcOne: { ...p.srcOne, [url]: r } }));
  }

  /** 话题手动管控：删除一条（拉黑，再抓也不收）。 */
  async deleteTopic(text: string) {
    if (!usingBackend()) { this.toastMsg("需接入后端"); return; }
    const ok = await removeTopic(text);
    if (ok) { const wl = await loadWorld(); this.setState({ worldLib: wl || this.state.worldLib }); }
    this.toastMsg(ok ? "已删除（再抓到也不收）" : "删除失败");
  }

  /** 话题手动管控：置顶/取消置顶。 */
  async togglePin(text: string, on: boolean) {
    if (!usingBackend()) { this.toastMsg("需接入后端"); return; }
    const ok = await pinTopic(text, on);
    if (ok) { const wl = await loadWorld(); this.setState({ worldLib: wl || this.state.worldLib }); }
    this.toastMsg(ok ? (on ? "已置顶（优先被聊到）" : "已取消置顶") : "操作失败");
  }

  setLimit(k: string, v: string) {
    const n = v.replace(/[^\d.]/g, "");
    this.setState((p) => ({ limitsCfg: { ...(p.limitsCfg || {}), [k]: n } }));
  }
  /** 保存运行限流（只发可调的几个键）到后端 global_defaults，下一通即生效。 */
  async saveRunLimits() {
    if (!usingBackend()) { this.toastMsg("需接入后端"); return; }
    const l = this.state.limitsCfg || {};
    const ok = await saveLimits({
      reply_max_tokens: parseInt(l.reply_max_tokens, 10),
      incall_max_turns: parseInt(l.incall_max_turns, 10),
      budget_chars: parseInt(l.budget_chars, 10),
      memory_facts_cap: parseInt(l.memory_facts_cap, 10),
      guest_trial_seconds: parseInt(l.guest_trial_seconds, 10),
      world_refresh_hours: parseFloat(l.world_refresh_hours),
    });
    if (ok) { const lim = await loadLimits(); if (lim) this.setState({ limitsCfg: lim }); }
    this.toastMsg(ok ? "运行限流已保存，下一通即生效" : "保存失败");
  }

  /** 卡片连接状态徽标：未测过=未知（中性），测过按真实结果显示已连接/连接失败。 */
  _apiStatusBadge(key: string) {
    const st = (this.state.apiStatus || {})[key];
    if (st === "ok") return { statusLabel: "已连接", statusColor: "#1FA971", statusBg: "rgba(31,169,113,.1)" };
    if (st === "fail") return { statusLabel: "连接失败", statusColor: "#E0594F", statusBg: "rgba(224,89,79,.1)" };
    if (st === "testing") return { statusLabel: "测试中…", statusColor: "#E0954F", statusBg: "rgba(224,149,79,.12)" };
    return { statusLabel: "未测试", statusColor: "#878B95", statusBg: "#F0F0F3" };
  }

  /** 把上次「测试连接」的真实结果折成卡下方一行：显 note/ms 或错误。 */
  _apiTestDetailView(key: string) {
    const d = (this.state.apiTestDetail || {})[key];
    if (!d || !d.text) return { hasTestDetail: false, testDetailText: "", testDetailTag: "", testDetailColor: "", testDetailBg: "" };
    const map: Record<string, any> = {
      live: { tag: "看着像真联网 ✅", c: "#1FA971", b: "rgba(31,169,113,.08)" },
      maybe: { tag: "已连上 · 但不像真联网 ⚠️", c: "#E0954F", b: "rgba(224,149,79,.1)" },
      ok: { tag: "返回正常", c: "#1FA971", b: "rgba(31,169,113,.08)" },
      fail: { tag: "失败", c: "#E0594F", b: "rgba(224,89,79,.08)" },
    };
    const m = map[d.kind] || map.ok;
    return { hasTestDetail: true, testDetailText: String(d.text).slice(0, 600),
      testDetailTag: m.tag + (d.ms ? ` · ${d.ms}ms` : ""), testDetailColor: m.c, testDetailBg: m.b };
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
    if (this.state.genCharBusy) return;   // 防连点：生成中再点会并发多请求 + 覆盖表单
    this.setState({ genCharBusy: true });
    this.toastMsg("AI 生成中…");
    try {
      const res = await generateCharacter((this.state.charAiPrompt || "").trim());
      if (!res.ok || !res.fields) { this.toastMsg(res.error || "生成失败"); return; }
      const f: any = res.fields;
      const pick = (v: any, cur: any) => (v != null && v !== "" ? v : cur);   // 生成没给的字段不清空既有值
      this.setState((p) => { const c: any = p.charEdit; return { charBio: f.background_story || c.background_story || "",
        // 两段式生成的【全部】字段都回填（此前只填了 10 个：occupation/appearance/summary/hobbies/catchphrases/
        // quirks/soft_spot/values/hidden_layer/nationality/residence/prompt_extra 全被丢弃，运营还得手抄）。
        charEdit: { ...c,
          name: pick(f.name, c.name), tagline: pick(f.tagline, c.tagline), gender: pick(f.gender, c.gender), age: pick(f.age, c.age),
          nationality: pick(f.nationality, c.nationality), occupation: pick(f.occupation, c.occupation), residence: pick(f.residence, c.residence),
          appearance: pick(f.appearance, c.appearance), summary: pick(f.summary, c.summary), traits: pick(f.traits, c.traits),
          speaking_style: pick(f.speaking_style, c.speaking_style), catchphrases: pick(f.catchphrases, c.catchphrases),
          quirks: pick(f.quirks, c.quirks), hobbies: pick(f.hobbies, c.hobbies), likes: pick(f.likes, c.likes), dislikes: pick(f.dislikes, c.dislikes),
          background_story: pick(f.background_story, c.background_story), hidden_layer: pick(f.hidden_layer, c.hidden_layer),
          soft_spot: pick(f.soft_spot, c.soft_spot), values: pick(f.values, c.values), prompt_extra: pick(f.prompt_extra, c.prompt_extra),
          core: pick(f.core, c.core) } }; });
      this.toastMsg("已生成，可微调后保存");
    } finally {
      this.setState({ genCharBusy: false });
    }
  }

  /** 一键同步出厂「口吻」：清掉被后台覆盖的 realtime_prompt_extra/hidden_layer，让仓库更新的出厂值流回（下一通生效）。
   * 破坏性（会丢弃你手动改过的「口吻」覆盖），故走二次确认。其它覆盖（音色/core/资料）一律保留。 */
  syncRealtime() {
    if (!usingBackend()) { this.toastMsg("需接入后端"); return; }
    this.askConfirm({
      title: "同步出厂口吻",
      body: "把所有角色被后台覆盖的「实时口吻」(realtime_prompt_extra) 和「内里」(hidden_layer) 清掉，采用仓库最新的出厂值，下一通生效。音色/内核/资料等其它后台改动全部保留。注意：你手动改过的「口吻」那一项会被这次同步覆盖掉。",
      okLabel: "同步", danger: true, action: () => this._doSyncRealtime(),
    });
  }
  private async _doSyncRealtime() {
    const res = await syncRealtimeToFactory();
    if (!res.ok) { this.toastMsg(res.error || "同步失败"); return; }
    const n = res.count || 0;
    // 同步已把后台覆盖的口吻/内里清掉、出厂值回流；但本地 this.chars 还是旧覆盖值——不刷新的话，
    // 打开抽屉看到的仍是旧口吻，运营再一保存又把清掉的覆盖写回、白同步。拉后端真值把这两项回填。
    if (n > 0) {
      const fresh = await loadCharacters();
      if (fresh) {
        for (const row of fresh) {
          const c = this.chars.find((x) => x.cid === row.id);
          if (!c) continue;
          c.prompt_extra = (row as any).prompt_extra ?? "";   // realtime_prompt_extra 出厂值
          c.hidden_layer = (row as any).hidden_layer ?? "";
        }
        this.setState({});
      }
    }
    this.toastMsg(n > 0 ? `已同步 ${n} 个角色到出厂口吻，下一通生效` : "没有被覆盖的口吻，已都是出厂值");
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

  /** 重置该角色的「自主状态/近况」：清掉 DB 里已生长的心情/近况（如改过定位后老提旧设定的事），
   *  下一通通话回落到出厂『开局近况』。二次确认（会丢掉 TA 攒下的近况）。 */
  resetAutonomy() {
    const d = this.state.detail;
    if (!d || d.type !== "char" || d.id === "__new__") return;
    if (!usingBackend()) { this.toastMsg("需接入后端"); return; }
    const c = this.chars.find((x) => x.id === d.id);
    this.askConfirm({ title: "重置自主状态", body: `把「${c?.name || "该角色"}」当前的心情/近况清空，回到出厂开局近况？（用于角色改过定位后老提起旧设定里的事）`,
      okLabel: "重置", action: () => this._doResetAutonomy() });
  }
  private async _doResetAutonomy() {
    const d = this.state.detail;
    if (!d || d.type !== "char" || d.id === "__new__") return;
    const c = this.chars.find((x) => x.id === d.id);
    const ok = await resetCharAutonomous(c?.cid || c?.id || d.id);
    this.toastMsg(ok ? "已重置，下一通通话回到出厂开局近况" : "重置失败");
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
      { key: "world", label: "世界库", icon: "M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2zM2 12h20M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20" },
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
    const mkKpi =(label: string, value: string, delta: string, dc: string, db: string, note: string) => ({ label, value, delta, deltaColor: dc, deltaBg: db, note });
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
      ...this._apiTestDetailView(sec.key),
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
      { label: "今日通话", value: callsToday.toLocaleString(), sub: "次", vc: "#16161A" },
      { label: "每小时成本", value: usd((cost || {}).per_hour_micros), sub: "今日均摊", vc: "#16161A" },
      { label: "每 100 分钟成本", value: usd((cost || {}).per_100min_micros), sub: "时长摊薄", vc: "#16161A" },
    ];
    const byNode = (cost && cost.by_node) || {};   // 今日各节点成本（micros）
    const nodeCost = (k: string) => usd(byNode[k] || 0);
    // 节点状态：按【后台是否配了 key】判活/未配（之前一律写死「正常」会误导）。评测脑/热点改写脑是可选节点，未配=未配。
    const nst = (sec: string) => stp(((s.apiCfg as any)[sec] && (s.apiCfg as any)[sec].key) ? "正常" : "未配置");
    const nodeCards = [
      { name: "ASR · 语音识别", role: "听 · 通话中", model: "", ...nst("asr"), latency: "—", calls: "—", cost: nodeCost("asr") },
      { name: "LLM · 快脑", role: "想 · 通话中", model: "", ...nst("fast"), latency: "—", calls: "—", cost: nodeCost("llm_fast") },
      { name: "TTS · 语音合成", role: "说 · 通话中", model: "", ...nst("tts"), latency: "—", calls: "—", cost: nodeCost("tts") },
      { name: "Embedding · 记忆检索", role: "记忆向量化/召回 · 通话后", model: "", ...nst("embed"), latency: "—", calls: "—", cost: nodeCost("embedding") },
      { name: "LLM · 长记忆脑（慢脑）", role: "记 · 通话后", model: "", ...nst("memory"), latency: "—", calls: "—", cost: nodeCost("llm_slow") },
      { name: "LLM · 评测脑", role: "分析/判定 · AI生成·图灵测试", model: "", ...nst("eval"), latency: "—", calls: "—", cost: nodeCost("llm_eval") },
      { name: "LLM · 热点改写脑", role: "真实热点改口语 · 每日离线", model: "", ...nst("search"), latency: "—", calls: "—", cost: nodeCost("llm_search") },
    ];
    const costKpis = [{ label: "今日总成本", value: usd((cost || {}).today_micros) }, { label: "本月总成本", value: usd((cost || {}).month_micros) }, { label: "每小时平均", value: usd((cost || {}).per_hour_micros) }, { label: "每 100 分钟", value: usd((cost || {}).per_100min_micros) }];
    const NODE_LABEL: Record<string, string> = { llm_fast: "LLM 快脑", tts: "TTS 语音合成", asr: "ASR 语音识别", llm_slow: "记忆整理", embedding: "记忆检索", llm_eval: "评测脑", llm_search: "热点改写脑" };
    const NODE_C: Record<string, string> = { llm_fast: "#6E5CFF", tts: "#E0594F", asr: "#2E7BFF", llm_slow: "#1FA971", embedding: "#9277F5", llm_eval: "#9277F5", llm_search: "#E0954F" };
    const cbpTot = Object.values(byNode).reduce((a: number, b: any) => a + (b || 0), 0) as number;
    const costByProvider = Object.keys(byNode).filter((k) => byNode[k] > 0).sort((a, b) => byNode[b] - byNode[a]).map((k) => ({
      name: NODE_LABEL[k] || k, value: usd(byNode[k]), pct: cbpTot > 0 ? Math.round(byNode[k] / cbpTot * 100) + "%" : "0%", c: NODE_C[k] || "#878B95" }));
    const memTypeC: Record<string, string> = { fact: "#2E7BFF", preference: "#6E5CFF", project: "#E0954F", relationship: "#FF6FA5", open_loop: "#1FA971" };
    // 真实记忆涉及用户隐私，不在后台明文展示（始终空）。
    const memoryRecent: any[] = ([] as any[]).map((m) => ({ ...m, typeColor: memTypeC[m.type] || "#878B95", typeBg: (memTypeC[m.type] || "#878B95") + "1a", wColor: m.written ? "#1FA971" : "#E0954F", wBg: m.written ? "rgba(31,169,113,.1)" : "rgba(224,149,79,.12)", wLabel: m.written ? "已写入" : "待写入" }));
    // 运行限流：显示【真正在管线里生效】的值（来自后端 global_defaults 等），不再写死误导。
    const L = s.limitsCfg || {};
    const limitsLoaded = !!(L && Object.keys(L).length);
    const limitItems = (limitsLoaded ? [
      ["AI 单次回复上限", `${L.reply_max_tokens} tokens · 约 ${Math.round((Number(L.reply_max_tokens) || 0) * 1.5)} 字`],
      ["通话内记忆轮数", `${L.incall_max_turns} 轮`],
      ["上下文预算", `${L.budget_chars} 字`],
      ["热点 / 天气刷新", `每 ${L.world_refresh_hours} 小时`],
      ["游客试用", `${L.guest_trial_seconds} 秒`],
      ["注册赠送", `${L.register_gift_minutes} 分钟`],
      ["通话时长上限", "按余额扣到 0 自动挂断（无固定时长上限）"],
      ["静音自动挂断", "用户端设置 · 默认 3 分钟"],
    ] : [["运行限流", "接入后端后显示真实生效值"]]).map(([k, v]) => ({ k, v }));

    // 世界库（持久化）常驻面板：主体读【已保存】的 worldLib（重启/重拉都在）；错误/未配提示沿用最近一次拉取结果。
    const wl = s.worldLib;
    const wp = s.worldPull;
    // 真实热点：每条带【原文链接】(核对真假) +【领域标签】(看多元度) +【置顶/删除】(手动管控)。
    const _allTopics = ((wl && wl.topics_src) || []);
    const _catFilter = s.catFilter || "";
    const _catCount: Record<string, number> = {};
    _allTopics.forEach((t: any) => { const c = String(t.cat || "其它"); _catCount[c] = (_catCount[c] || 0) + 1; });
    const _catKeys = Object.keys(_catCount).sort((a, b) => _catCount[b] - _catCount[a]);
    const catChips = _catKeys.map((c) => ({
      cat: c, n: _catCount[c], active: _catFilter === c,
      bg: _catFilter === c ? "rgba(122,90,240,.14)" : "#F2F3F5",
      color: _catFilter === c ? "#6E5CFF" : "#5A5E6B", go: () => this.setCatFilter(c) }));
    const worldTopics = _allTopics
      .filter((t: any) => !_catFilter || String(t.cat || "其它") === _catFilter)
      .map((t: any) => ({
        text: String(t.text || ""), url: String(t.url || ""), hasUrl: !!String(t.url || ""),
        cat: String(t.cat || ""), hasCat: !!String(t.cat || ""), date: String(t.date || ""),
        pinned: !!t.pinned, pinLabel: t.pinned ? "★置顶" : "☆置顶",
        pinColor: t.pinned ? "#E0954F" : "#A8ABB5",
        rowBg: t.pinned ? "rgba(224,149,79,.06)" : "#FAFAFB",
        pin: () => this.togglePin(String(t.text || ""), !t.pinned),
        del: () => this.deleteTopic(String(t.text || "")) }));
    const worldStats = {
      total: _allTopics.length, cats: _catKeys.length,
      byCat: _catKeys.map((c) => `${c} ${_catCount[c]}`).join(" · "),
      weatherCities: ((wl && wl.weather) || []).length };
    // 源管理：当前热点源清单 + 测试结果。结果两路合并：单测(srcOne[url]) 优先，否则用「测试热点源」批量体检里
    // 这一条的结果(_batch[url]) —— 这样点【任一个】测试按钮，状态都直接显示在对应源那一行。
    const _eps = (s.worldEndpoints || []);
    const _epsSet = new Set(_eps);
    const _batch: Record<string, any> = {};
    (((s.srcTest && s.srcTest.sources) || []) as any[]).forEach((r) => { if (r && r.source) _batch[r.source] = r; });
    const _rowFrom = (u: string, r: any) => {
      const testing = !!(r && r.testing);
      const tested = !!(r && !r.testing);
      const ok = !!(r && r.ok);
      const samp = (r && r.sample && r.sample[0]) || null;
      return {
        url: u, testing, hasResult: testing || tested,
        statusText: testing ? "测试中…" : (tested ? (ok ? `可用 · ${r.count || 0} 条（安全 ${r.safe || 0}）` : ("失败：" + (r.error || "未知"))) : ""),
        statusColor: ok ? "#1FA971" : (tested ? "#E0594F" : "#9A9DA7"),
        sampleText: samp ? (samp.text || "") : "", hasSample: !!(samp && samp.text),
        sampleDesc: samp ? (samp.desc || "") : "", hasDesc: !!(samp && samp.desc) };
    };
    const worldEndpointRows = _eps.map((u: string) => ({
      ..._rowFrom(u, (s.srcOne || {})[u] || _batch[u]),
      test: () => this.testOne(u), remove: () => this.removeSource(u) }));
    // 固定源（代码内置：Hacker News + 维基中英，不在可编辑清单里）——「测试热点源」体检它们的结果单独列出，不丢。
    const fixedSrcRows = Object.keys(_batch).filter((src) => !_epsSet.has(src)).map((src) => _rowFrom(src, _batch[src]));
    const hasFixedSrc = fixedSrcRows.length > 0;
    const worldWeather = (wl && wl.weather) || [];               // 后端已给 [{city,line}]
    const worldHasResult = !!(wl && (worldTopics.length || worldWeather.length));
    const worldErr = (wp && wp.ok === false) ? (wp.error || "拉取失败") : "";
    const worldDate = (wl && wl.date) || "";
    const worldFresh = !!(wl && wl.fresh);
    const worldPersisted = !!(wl && wl.persisted);
    // 持久化未开 / 当天还没刷新 / 改写脑未配 → 给一句诚实提示
    const worldNote = !wl ? ""
      : (!worldPersisted ? "⚠️ 未开持久化：重启后世界库会丢，建议在后端配 world_store_path"
        : (!worldFresh && worldDate ? `当前是 ${worldDate} 的库（今天还没刷新，点「立即拉取」更新）`
          : ((wp && wp.ok && !wp.rewriter_configured) ? "改写脑未配 → 话题用真实标题原样（仍真实，只是没改成口语）" : "")));
    const worldSummary = worldHasResult ? `话题 ${worldTopics.length} 条 · 天气 ${worldWeather.length} 城` : "";
    // 测试热点源结果
    const _st = s.srcTest;
    const hasSrcTest = !!(_st && _st.sources);
    const srcErr = (_st && _st.ok === false) ? (_st.error || "测试失败") : "";
    const srcRows = ((_st && _st.sources) || []).map((r: any) => ({
      source: String(r.source || ""), ok: !!r.ok,
      statusText: r.ok ? `可用 · ${r.count || 0} 条（安全 ${r.safe || 0}）` : ("失败：" + (r.error || "未知")),
      statusColor: r.ok ? "#1FA971" : "#E0594F", statusBg: r.ok ? "rgba(31,169,113,.1)" : "rgba(224,89,79,.1)",
      sampleText: ((r.sample || [])[0] || {}).text || "", hasSample: !!((r.sample || [])[0] || {}).text }));

    const titles: Record<string, [string, string]> = {
      dashboard: ["数据概览", "载思 运营核心指标"],
      users: ["用户管理", this.users.length + " 名注册用户"],
      characters: ["角色管理", this.chars.length + " 个 AI 角色"],
      voices: ["音色管理", "MiniMax 系统音色库 · 试听并分配给角色"],
      calls: ["通话记录", "会话明细与对话回放"],
      tickets: ["工单反馈", openTicketCount + " 条待处理"],
      orders: ["订单充值", "会员套餐与交易记录"],
      api: ["接口配置", "ASR · LLM · TTS 服务接入"],
      world: ["世界库", "角色「活在世界里」· 源管理 · 话题池 · 天气"],
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
    const charCount = this.chars.length;
    const charsView = this.chars.filter((c) => !q || (c.name + c.desc + c.bio).toLowerCase().includes(q)).map((c) => { const ci = this.chars.indexOf(c); return { ...c, hueFilter: "hue-rotate(" + c.hue + "deg)", genderAge: c.gender + " · " + c.age + "岁", genderColor: genderColor(c.gender),
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
      // 上移/下移调显示顺序（搜索中不显，避免按可见邻居误判）。canUp/canDown 决定箭头是否亮。
      canUp: !q && ci > 0,
      canDown: !q && ci >= 0 && ci < charCount - 1,
      moveUp: (e: any) => { if (e && e.stopPropagation) e.stopPropagation(); this.moveChar(c.cid || c.id, -1); },
      moveDown: (e: any) => { if (e && e.stopPropagation) e.stopPropagation(); this.moveChar(c.cid || c.id, 1); },
      ...((st: string) => st === "上线" ? { stColor: "#1FA971", stBg: "rgba(31,169,113,.1)" } : { stColor: "#878B95", stBg: "#F0F0F3" })(c.status), open: () => this.open("char", c.id) }; });

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
      // 展示通话元数据 + 逐句对话内容（后端 transcript 留存，测试期默认开；上线要隐私可在配置关闭）。
      const dav = avatarByName(c.char);
      dCall = { char: c.char, avatar: dav, avatarDisplay: dav ? "block" : "none", user: c.user, scene: c.scene, dur: c.dur, ended: c.ended, time: c.time,
        messages: (c as any).messages || [], hasTranscript: !!(c as any).hasTranscript, noTranscript: !!(c as any).noTranscript };
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
      charTabs, isRoleTab: s.charTab === "role", isVoiceTab: s.charTab === "voice", isApi: s.section === "api", isCost: s.section === "cost", isWorld: s.section === "world",
      // 世界库菜单：源管理 + 完整池子 + 统计 + 领域筛选 + 单条删/置顶
      worldEndpointRows, fixedSrcRows, hasFixedSrc, catChips, worldStats, hasCatFilter: !!s.catFilter, catFilterLabel: s.catFilter || "",
      clearCatFilter: () => this.setCatFilter(s.catFilter || ""),
      newSource: s.newSource || "", onNewSource: (e: any) => this.setNewSource(e.target.value), addSource: () => this.addSource(),
      linkFlow, healthKpis, nodeCards, costKpis, costByProvider, memoryRecent, limitItems,
      ccCpt: s.costCfg.chars_per_token, onCcCpt: (e: any) => this.setCost("chars_per_token", e.target.value),
      ccLlmFast: s.costCfg.llm_fast, onCcLlmFast: (e: any) => this.setCost("llm_fast", e.target.value),
      ccLlmSlow: s.costCfg.llm_slow, onCcLlmSlow: (e: any) => this.setCost("llm_slow", e.target.value),
      ccEmbedding: s.costCfg.embedding, onCcEmbedding: (e: any) => this.setCost("embedding", e.target.value),
      ccTts: s.costCfg.tts, onCcTts: (e: any) => this.setCost("tts", e.target.value),
      ccAsr: s.costCfg.asr, onCcAsr: (e: any) => this.setCost("asr", e.target.value),
      saveCost: () => this.saveCost(),
      // 运行限流（真实生效，可改 4 个旋钮）
      limitsLoaded,
      rlReply: String(L.reply_max_tokens ?? ""), onRlReply: (e: any) => this.setLimit("reply_max_tokens", e.target.value),
      rlTurns: String(L.incall_max_turns ?? ""), onRlTurns: (e: any) => this.setLimit("incall_max_turns", e.target.value),
      rlBudget: String(L.budget_chars ?? ""), onRlBudget: (e: any) => this.setLimit("budget_chars", e.target.value),
      rlFactsCap: String(L.memory_facts_cap ?? ""), onRlFactsCap: (e: any) => this.setLimit("memory_facts_cap", e.target.value),
      rlGuestTrial: String(L.guest_trial_seconds ?? ""), onRlGuestTrial: (e: any) => this.setLimit("guest_trial_seconds", e.target.value),
      rlWorldHours: String(L.world_refresh_hours ?? ""), onRlWorldHours: (e: any) => this.setLimit("world_refresh_hours", e.target.value),
      saveRunLimits: () => this.saveRunLimits(),
      // 世界库（持久化常驻面板）—— 模板引擎不支持三元，按钮文案/底色在这里算好
      worldPulling: !!s.worldPulling, worldPullLabel: s.worldPulling ? "拉取中…" : "立即拉取",
      worldPullBtnBg: s.worldPulling ? "#C9A86A" : "#E0954F",
      worldHasResult, worldErr, worldSummary, worldDate, worldFresh, worldPersisted, worldNote, hasWorldNote: !!worldNote,
      worldTopics, worldWeather, hasWorldTopics: _allTopics.length > 0, hasWorldWeather: worldWeather.length > 0,
      pullWorld: () => this.pullWorld(),
      saveWorldInterval: () => this.saveWorldInterval(),
      // 测试热点源（逐源体检，据此增删）
      testSources: () => this.testSources(), srcTesting: !!s.srcTesting,
      srcTestLabel: s.srcTesting ? "测试中…" : "测试热点源",
      hasSrcTest, srcErr, srcRows,
      ioOpen: s.ioOpen,
      openImport: () => this.setState({ ioOpen: true, importText: "" }), closeIO: () => this.setState({ ioOpen: false }),
      importTemplate: IMPORT_TEMPLATE,
      importText: s.importText || "", onImportText: (e: any) => this.setState({ importText: e.target.value }),
      copyImportTpl: () => { try { navigator.clipboard.writeText(IMPORT_TEMPLATE); this.toastMsg("模板已复制，去 AI（DeepSeek/Gemini）粘贴"); } catch { this.toastMsg("复制失败，请手动全选复制"); } },
      runImport: () => this.importChar(),
      syncRealtime: () => this.syncRealtime(),   // 一键同步出厂口吻（清被覆盖的 realtime_prompt_extra/hidden_layer）
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
      saveInviteRule: () => this.saveInvite(),
      notifs: this.realStats ? (this.tickets.filter((t: any) => t.status === "待处理").length > 0 ? [{ title: this.tickets.filter((t: any) => t.status === "待处理").length + " 条工单待处理", time: "实时", dot: "#E0594F" }] : []) : this.notifs,
      notifOpen: s.notifOpen, notifUnread: this.realStats ? this.tickets.some((t: any) => t.status === "待处理") : !s.notifRead,
      toggleNotif: () => this.setState((p) => ({ notifOpen: !p.notifOpen })), closeNotif: () => this.setState({ notifOpen: false }), markAllRead: () => this.setState({ notifRead: true, notifOpen: false }),
      userFilters, usersView, charsView, callsView, ticketsView, ordersView, plans,
      // 列表「加载更多」：拉满当前上限 → 可能还有更多，给个按钮翻页（突破默认 200）
      moreUsers: usingBackend() && this._moreU,
      moreCalls: usingBackend() && this._moreC,
      moreOrders: usingBackend() && this._moreO,
      loadMoreUsers: () => this.loadMore("users"), loadMoreCalls: () => this.loadMore("calls"), loadMoreOrders: () => this.loadMore("orders"),
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
      grantMin: s.grantMin, onGrantMin: (e: any) => this.setState({ grantMin: e.target.value }),
      grantPlus: () => this.grantMinutes(d && d.id, 1), grantMinus: () => this.grantMinutes(d && d.id, -1),
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
      resetAutonomy: () => this.resetAutonomy(),
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
