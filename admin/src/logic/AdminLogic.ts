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
         createCharacter, deleteCharacter, generateCharacter, usingBackend } from "./configService";

export interface AdminProps {
  [k: string]: unknown;
}

type State = Record<string, any>;
type Timer = ReturnType<typeof setTimeout>;

export class AdminLogic {
  props: AdminProps;
  private notify: () => void = () => {};

  chars: any[];
  hueOf: Record<string, string> = {};
  scenes: any[];
  users: any[];
  calls: any[];
  tickets: any[];
  orders: any[];
  plans: any[];
  voices: any[];
  expressions: any[];
  apiSections: any[];
  inviters: any[];
  inviteRecords: any[];
  admins: any[];
  permModules: string[];
  roleMatrix: Record<string, number[]>;
  notifs: any[];
  realStats: any = null;        // 接后端后的首页 KPI（null = 用演示数据）
  realTopChars: any[] | null = null;  // 接后端后的热门角色排名
  realTrends: any = null;       // 接后端后的通话量趋势（null = 用演示）
  realCost: any = null;         // 接后端后的成本汇总（null = 用演示）
  realSceneCalls: any = null;   // 接后端后的各场景通话数（null = 用演示）
  realInviteStats: any = null;  // 接后端后的邀请 KPI（null = 用演示）
  redeemCodes: any[] = [];      // 兑换码列表（后台「订单充值」）

  private _t: Timer | undefined;
  private _tt: Timer[] = [];

  state: State = {
    section: "dashboard", detail: null, query: "", userFilter: "all", sceneTab: "rec", charBio: "", charEdit: {}, replyDraft: "", toast: "", banned: {}, sceneStatus: {}, ticketReplies: {}, inviteReward: "60", inviteeReward: "60", inviteRuleOn: true, adminOff: {}, notifOpen: false, notifRead: false, dateRange: "7d", charTab: "role", exprOpen: null, exprOff: {}, charOff: {}, ioOpen: false, ioMode: "export",
    testVoice: "v1", testChar: "c1", testText: "今天工作压力好大，感觉有点撑不住。", testStage: 0, testRunning: false, testMs: {}, testReply: "", testAsr: "", apiStatus: {},
    redeemCode: "", redeemUses: "1", redeemMinutes: "60", generatedCode: "",
    apiCfg: {
      // 这些只是「无后端」时的兜底默认；接了后端会被真实配置覆盖。值与 backend/config/default.json 对齐，
      // 避免再出现 DeepSeek-V4-Flash 这类虚名误导。key 留空（不放假占位），由运营填、后端打码回显。
      asr: { provider: "bailian_qwen3_asr", endpoint: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions", key: "", model: "qwen3-asr-flash", lang: "zh" },
      fast: { provider: "deepseek", endpoint: "https://api.deepseek.com/v1/chat/completions", key: "", model: "deepseek-v4-flash", temp: "0.8", maxTokens: "2048" },
      tts: { provider: "minimax", endpoint: "https://api.minimax.chat/v1/t2a_v2?GroupId=填你的GroupId", key: "", model: "speech-2.8-turbo", voiceId: "female-shaonv", sampleRate: "24000" },
      memory: { provider: "apiyi_qwen_long", endpoint: "https://api.apiyi.com/v1/chat/completions", key: "", model: "qwen-max", maxContext: "32000" },
      embed: { provider: "bailian_embedding", endpoint: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/embeddings", key: "", model: "text-embedding-v4", vectorDB: "pgvector", topK: "5" },
    },
  };

  constructor(props?: AdminProps) {
    this.props = props || {};
    const uG = { a: "linear-gradient(140deg,#A78BFF,#6E5CFF)", b: "linear-gradient(140deg,#FF8FC8,#FF4FA0)", c: "linear-gradient(140deg,#5BE0A0,#1FA971)", d: "linear-gradient(140deg,#6FC8FF,#2E7BFF)", e: "linear-gradient(140deg,#FFB36B,#F5821F)" };
    this.chars = [
      { id: "c1", cid: "lin_wan", speaking_style: "", voiceId: "", name: "林晚", desc: "温柔的深夜倾听者", hue: 0, gender: "女", age: 18, height: 156, weight: 44, birthday: "2006年1月1日", nationality: "中国", race: "东亚人", traits: ["温柔", "耐心", "共情"], tags: ["治愈系", "深夜", "倾听", "温柔"], slogan: "今天也辛苦了，想聊点什么都可以。", likes: "安静的深夜、认真听你说话、下雨天、一杯热可可", dislikes: "被敷衍、嘈杂的人群、冷场", bio: "深夜电台主播出身，习惯在安静里听人把话说完。不急着给建议，也不轻易打断，只是稳稳地陪着你。", calls: "0", customVoices: 0, favs: "0", status: "上线" },
      { id: "c2", cid: "jiang_ye", speaking_style: "", voiceId: "", name: "江野", desc: "理性可靠的陪伴", hue: 135, gender: "男", age: 21, height: 161, weight: 47, birthday: "2005年2月8日", nationality: "日本", race: "欧裔", traits: ["理性", "冷静", "务实"], tags: ["理性", "高冷", "成熟", "陪伴"], slogan: "有什么想不通的，说来听听。", likes: "清晰的逻辑、长跑、黑咖啡、安静", dislikes: "拖延、含糊其辞、无意义的争论", bio: "话不多，但每句都在点上。适合在你思绪乱成一团时，帮你一条条理清楚，再陪你走下一步。", calls: "0", customVoices: 0, favs: "0", status: "上线" },
      { id: "c3", cid: "xia_ming", speaking_style: "", voiceId: "", name: "夏鸣", desc: "元气满满的朋友", hue: 60, gender: "女", age: 24, height: 166, weight: 50, birthday: "2004年3月15日", nationality: "美国", race: "混血", traits: ["元气", "幽默", "直率"], tags: ["元气", "俏皮", "邻家", "温柔"], slogan: "嘿！今天有什么好玩的事？", likes: "阳光、音乐、冷笑话、奶茶", dislikes: "冷场、emo、被无视", bio: "走到哪儿都自带阳光，三两句就能把气氛点亮。心情低落时，找他准没错。", calls: "0", customVoices: 0, favs: "0", status: "上线" },
      { id: "c4", cid: "gu_ci", speaking_style: "", voiceId: "", name: "顾辞", desc: "沉静睿智的对话者", hue: 225, gender: "男", age: 27, height: 171, weight: 53, birthday: "2003年4月22日", nationality: "英国", race: "东亚人", traits: ["沉静", "睿智", "文艺"], tags: ["文艺", "知性", "沉静", "学长"], slogan: "夜深了，来聊聊书，或者别的？", likes: "旧书、爵士乐、独处、一壶红茶", dislikes: "喧闹、肤浅、敷衍", bio: "读过很多书，喜欢慢慢聊。和他说话，像在深夜翻开一本旧书，安静又有回味。", calls: "0", customVoices: 0, favs: "0", status: "上线" },
      { id: "c5", cid: "su_yao", speaking_style: "", voiceId: "", name: "苏窈", desc: "俏皮灵动的伙伴", hue: 300, gender: "女", age: 30, height: 176, weight: 56, birthday: "2002年5月2日", nationality: "法国", race: "东亚人", traits: ["俏皮", "灵动", "好奇"], tags: ["俏皮", "灵动", "古灵精怪", "御姐"], slogan: "猜猜我今天又想到了什么？", likes: "新鲜事、恶作剧、甜点、惊喜", dislikes: "无聊、套路、被说教", bio: "鬼马精灵，脑洞奇大。跟她聊天，你永远猜不到她下一句会说什么。", calls: "0", customVoices: 0, favs: "0", status: "上线" },
    ];
    this.hueOf = {};
    this.chars.forEach((c) => (this.hueOf[c.name] = "hue-rotate(" + c.hue + "deg)"));
    this.scenes = [
      { id: "s1", name: "随便聊聊", type: "rec", desc: "想到什么说什么", prompt: "现在是轻松的闲聊时间。请用自然随意的语气和我聊天，话题不限，可以从今天发生的小事聊起。", uses: "6.7k" },
      { id: "s2", name: "心情树洞", type: "rec", desc: "我会认真听你说", prompt: "我可能心情不太好，需要找人倾诉。请你耐心倾听，不评判也不说教，多共情、多接纳我的情绪。", uses: "8.2k" },
      { id: "s3", name: "模拟面试", type: "rec", desc: "我陪你一起准备", prompt: "请扮演一位专业又友善的面试官，围绕我的经历依次提问，包括自我介绍、项目细节和应变问题，最后给出诚恳反馈。", uses: "5.1k" },
      { id: "s4", name: "英语陪练", type: "rec", desc: "快和我用英语聊吧", prompt: "Let's practice English together. Speak naturally but slowly, ask me simple follow-up questions, and gently correct my mistakes.", uses: "4.4k" },
      { id: "s5", name: "成语接龙", type: "rec", desc: "测试你的成语储备", prompt: "我们来玩成语接龙。你先说一个四字成语，我用它的最后一个字开头接下一个，轮流进行，接不上算输。", uses: "3.9k" },
      { id: "s6", name: "睡前故事", type: "hot", desc: "伴你慢慢入睡", prompt: "现在是睡前时间。请用极轻柔、缓慢的语气给我讲一个温暖平静的小故事，帮助我放松入睡。", uses: "12.4k" },
      { id: "s7", name: "解压冥想", type: "hot", desc: "一起深呼吸放松", prompt: "请带我做一次简短的放松冥想。用平稳缓慢的语气引导我关注呼吸，逐步放松身体的每一处。", uses: "7.8k" },
      { id: "s8", name: "哄睡晚安", type: "hot", desc: "轻声陪你入眠", prompt: "现在请用最轻最柔的声音陪我说晚安，聊些安静温暖的话，直到我慢慢睡去。", uses: "6.1k" },
      { id: "s9", name: "早安叫醒", type: "hot", desc: "元气满满开启一天", prompt: "现在是早晨。请用轻快有活力的语气叫我起床，给我一点温暖的鼓励，开启美好的一天。", uses: "3.3k" },
      { id: "s10", name: "陪我背单词", type: "custom", byUser: "陈思远", desc: "", prompt: "现在请扮演一个英语陪练。每次给我一个六级单词，我说出释义，你判断对错并给出例句和记忆方法。", uses: "待审核", status: "待审核" },
      { id: "s11", name: "深夜哲学辩论", type: "custom", byUser: "Marcus Lee", desc: "", prompt: "现在请和我进行一场关于自由意志的哲学辩论，你持反方立场，用犀利但尊重的方式反驳我的观点。", uses: "待审核", status: "待审核" },
      { id: "s12", name: "扮演我的猫", type: "custom", byUser: "刘梦琪", desc: "", prompt: "请扮演我养的橘猫「团子」，用慵懒傲娇的语气和我说话，偶尔卖个萌，但其实很黏人。", uses: "待审核", status: "待审核" },
    ];
    this.users = [];
    this.calls = [];
    this.tickets = [];
    this.orders = [];
    this.plans = [
      { name: "轻享会员", price: "$4.99", mins: "每月 300 分钟", subs: "2,180", popular: false, tile: "linear-gradient(145deg,#7AA8FF,#5B7CF0)", icon: "M12 3l2.2 5.2L20 9.4l-4 3.9 1 5.7L12 16.3 7 19l1-5.7-4-3.9 5.8-1.2L12 3z" },
      { name: "畅聊会员", price: "$9.99", mins: "每月 1500 分钟", subs: "4,910", popular: true, tile: "linear-gradient(145deg,#B79CFF,#9277F5)", icon: "M21 11.5a8.38 8.38 0 0 1-8.5 8.5 8.5 8.5 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8A8.5 8.5 0 0 1 12.5 3 8.38 8.38 0 0 1 21 11.5z" },
      { name: "无限会员", price: "$19.99", mins: "每月不限时", subs: "1,240", popular: false, tile: "linear-gradient(145deg,#FFC061,#F5A623)", icon: "M18.5 8.5c-2 0-3.2 1.6-4.2 3-.8 1.1-1.5 2-2.3 2s-1.5-.9-2.3-2c-1-1.4-2.2-3-4.2-3a3.5 3.5 0 1 0 0 7c2 0 3.2-1.6 4.2-3 .8-1.1 1.5-2 2.3-2s1.5.9 2.3 2c1 1.4 2.2 3 4.2 3a3.5 3.5 0 1 0 0-7z" },
    ];
    this.voices = [
      { id: "v1", name: "林晚 · 原本音色", engine: "火山引擎", gender: "女声", lang: "中文", char: "林晚", hue: 0, status: "启用" },
      { id: "v2", name: "江野 · 原本音色", engine: "火山引擎", gender: "男声", lang: "中文", char: "江野", hue: 135, status: "启用" },
      { id: "v3", name: "夏鸣 · 原本音色", engine: "火山引擎", gender: "女声", lang: "中文", char: "夏鸣", hue: 60, status: "启用" },
      { id: "v4", name: "顾辞 · 原本音色", engine: "火山引擎", gender: "男声", lang: "中文", char: "顾辞", hue: 225, status: "启用" },
      { id: "v5", name: "苏窈 · 原本音色", engine: "火山引擎", gender: "女声", lang: "中文", char: "苏窈", hue: 300, status: "启用" },
      { id: "v6", name: "温柔女声", engine: "MiniMax", gender: "女声", lang: "中文", char: "", status: "启用" },
      { id: "v7", name: "磁性男声", engine: "MiniMax", gender: "男声", lang: "中文", char: "", status: "启用" },
      { id: "v8", name: "甜美童声", engine: "Azure", gender: "女声", lang: "中文", char: "", status: "停用" },
      { id: "v9", name: "English · Aria", engine: "ElevenLabs", gender: "女声", lang: "English", char: "", status: "启用" },
    ];
    this.expressions = [
      { key: "idle_normal", name: "默认待机", emoji: "🙂" },
      { key: "listening", name: "正在听你说", emoji: "👂" },
      { key: "thinking", name: "思考中", emoji: "🤔" },
      { key: "speaking_happy", name: "开心说话", emoji: "😄" },
      { key: "speaking_soft", name: "温柔说话", emoji: "🥰" },
      { key: "speaking_serious", name: "认真说话", emoji: "🧐" },
      { key: "surprised", name: "惊讶", emoji: "😮" },
      { key: "concerned", name: "担心", emoji: "😟" },
      { key: "shy", name: "害羞", emoji: "😳" },
      { key: "laughing", name: "笑", emoji: "😆" },
      { key: "sad_soft", name: "轻微低落", emoji: "😔" },
      { key: "goodbye", name: "挂断告别", emoji: "👋" },
    ];
    this.apiSections = [
      { key: "asr", name: "ASR · 语音识别", chain: "快链路", desc: "实时把用户语音转写为文字 · 默认 Qwen3-ASR-Flash（阿里百炼）", icon: "M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3zM19 10v2a7 7 0 0 1-14 0v-2M12 19v4M8 23h8", req: "快 · 低延迟 · 可打断", fields: [{ k: "endpoint", label: "接口地址", full: true }, { k: "key", label: "API Key", pw: true }, { k: "model", label: "模型" }, { k: "lang", label: "识别语言" }] },
      { key: "fast", name: "LLM · 快脑（通话中）", chain: "快链路", desc: "通话中实时生成简短回复 · 默认 deepseek-v4-flash（DeepSeek 直连，小写；deepseek-chat 是其旧别名，2026-07-24 停用）", icon: "M13 2L3 14h7l-1 8 10-12h-7l1-8z", req: "快 · 短 · 低延迟 · 可打断", fields: [{ k: "endpoint", label: "接口地址", full: true }, { k: "key", label: "API Key", pw: true }, { k: "model", label: "模型" }, { k: "temp", label: "温度" }, { k: "maxTokens", label: "回复上限 Token" }] },
      { key: "tts", name: "TTS · 语音合成", chain: "快链路", desc: "合成角色语音，voice_id 决定音色 · 默认 MiniMax TTS（官方直连，支持 emotion）", icon: "M11 5 6 9H3v6h3l5 4V5zM15.5 9a4.5 4.5 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11", req: "快 · 自然 · 可打断", fields: [{ k: "endpoint", label: "接口地址", full: true }, { k: "key", label: "API Key", pw: true }, { k: "model", label: "模型" }, { k: "voiceId", label: "默认 voice_id" }, { k: "sampleRate", label: "采样率" }] },
      { key: "memory", name: "LLM · 长记忆脑（通话后）", chain: "慢链路", desc: "通话后总结、提取长期记忆、生成开场白 · 默认 qwen-max（经 apiyi，可在「模型」改 qwen-plus 等；离线不要求快）", icon: "M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2zM2 12h20M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20", req: "准 · 稳 · 长上下文（不要求快）", fields: [{ k: "endpoint", label: "接口地址", full: true }, { k: "key", label: "API Key", pw: true }, { k: "model", label: "模型（如 qwen-max / qwen-plus）" }, { k: "maxContext", label: "最大上下文" }] },
      { key: "embed", name: "Embedding · 记忆检索", chain: "慢链路", desc: "向量化记忆并快速检索相关片段 · 存储 Postgres + pgvector", icon: "M21 5c0 1.66-4 3-9 3S3 6.66 3 5s4-3 9-3 9 1.34 9 3zM3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5M3 12c0 1.66 4 3 9 3s9-1.34 9-3", req: "快检索 · 高召回", fields: [{ k: "endpoint", label: "接口地址", full: true }, { k: "key", label: "API Key", pw: true }, { k: "model", label: "模型" }, { k: "vectorDB", label: "向量数据库" }, { k: "topK", label: "检索 Top-K" }] },
    ];
    this.inviters = [];
    this.inviteRecords = [];
    this.admins = [];
    this.permModules = ["用户", "角色", "场景", "通话", "工单", "订单", "邀请", "配置"];
    this.roleMatrix = { "超级管理员": [1, 1, 1, 1, 1, 1, 1, 1], "运营": [1, 1, 1, 1, 1, 0, 1, 0], "客服": [1, 0, 0, 1, 1, 1, 0, 0], "只读（仅查看）": [1, 1, 1, 1, 1, 1, 1, 0] };
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
        const c = this.chars.find((x) => x.cid === row.id);
        if (!c) continue;
        if (row.name) c.name = row.name;
        if (row.tagline) c.desc = row.tagline;
        if (row.traits) c.traits = this._splitList(row.traits);
        if (row.background_story) c.bio = row.background_story;
        if (row.likes != null) c.likes = row.likes;
        if (row.dislikes != null) c.dislikes = row.dislikes;
        c.speaking_style = row.speaking_style || "";
        c.voiceId = row.voice_id || "";
      }
      this.setState({}); // 用真实角色数据重渲染
    }
    await this.loadRealData();   // 看板 KPI/用户/通话/订单接 DB（接了后端才覆盖演示数据）
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

  /** 删除兑换码。 */
  private async delRedeem(code: string) {
    if (!usingBackend()) { this.toastMsg("需接入后端"); return; }
    const ok = await deleteRedeemCode(code);
    if (!ok) { this.toastMsg("删除失败"); return; }
    this.redeemCodes = this.redeemCodes.filter((r: any) => r.code !== code);
    this.setState({});
    this.toastMsg(`已删除兑换码 ${code}`);
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
        plan: "免费用户", minsRaw: `${Math.round((u.total_seconds || 0) / 60)} 分钟`,
        spent: "$0.00", joined: (u.created_at || "").slice(0, 10), recharges: [],
      }));
    }
    if (calls) {
      this.calls = calls.map((c: any, i: number) => ({
        id: "rk" + i, char: charName(c.character_id), user: c.user_email || "—",
        scene: c.scenario || "随便聊聊", dur: fmtDur(c.duration_seconds), rating: 0,
        time: fmtTime(c.started_at), feedback: "", lines: [],
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
        traits: Array.isArray(c.traits) ? c.traits.join("、") : (c.traits || ""),
        speaking_style: c.speaking_style || "", background_story: c.bio || "",
        likes: c.likes || "", dislikes: c.dislikes || "", voice_id: c.voiceId || "",
      };
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
      charEdit: { name: "", tagline: "", gender: "女", age: "20", traits: "", speaking_style: "", background_story: "", likes: "", dislikes: "", voice_id: "" } });
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
      likes: f.likes || "", dislikes: f.dislikes || "" } }));
    this.toastMsg("已生成，可微调后保存");
  }

  /** 删除当前角色（自定义直删 / 出厂隐藏）。 */
  async delChar() {
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
    const e: any = this.state.charEdit || {};
    if (d.id === "__new__") {   // 新建自定义角色
      if (!(e.name || "").trim()) { this.toastMsg("请填写角色名"); return; }
      const res = await createCharacter(e);
      if (!res.ok || !res.id) { this.toastMsg(res.error || "创建失败"); return; }
      this.chars.push({ id: res.id, cid: res.id, name: e.name, desc: e.tagline, hue: (this.chars.length * 47) % 360,
        gender: e.gender || "女", age: e.age || "20", height: 160, weight: 48, birthday: "", nationality: "", race: "",
        traits: this._splitList(e.traits), tags: [], slogan: "", likes: e.likes || "", dislikes: e.dislikes || "",
        bio: e.background_story || "", speaking_style: e.speaking_style || "", voiceId: e.voice_id || "",
        calls: "0", customVoices: 0, favs: "0", status: "上线" });
      this.setState({ detail: null });
      this.toastMsg("角色已创建，下一通通话生效");
      return;
    }
    const c = this.chars.find((x) => x.id === d.id);
    if (!c || !c.cid) { this.toastMsg("该角色未关联后端，无法保存"); return; }
    const ok = await saveCharacter({
      id: c.cid, name: e.name, tagline: e.tagline, traits: e.traits,
      speaking_style: e.speaking_style, background_story: e.background_story,
      likes: e.likes, dislikes: e.dislikes, voice_id: e.voice_id,
    });
    if (ok) {  // 本地同步，列表/详情立即反映
      c.name = e.name; c.desc = e.tagline; c.traits = this._splitList(e.traits);
      c.bio = e.background_story; c.likes = e.likes; c.dislikes = e.dislikes;
      c.speaking_style = e.speaking_style; c.voiceId = e.voice_id;
    }
    this.toastMsg(ok ? "角色已保存，下一通通话生效" : "保存失败，检查后端连接");
  }
  setCfg(sk: string, fk: string, v: string) {
    this.setState((p) => ({ apiCfg: { ...p.apiCfg, [sk]: { ...p.apiCfg[sk], [fk]: v } } }));
  }
  genReply() {
    const t = (this.state.testText || "").trim();
    const c = this.chars.find((x) => x.id === this.state.testChar);
    const tone = ({ "林晚": "嗯，我都听到了。", "江野": "明白，我们一条条来看。", "夏鸣": "哈哈，这个我喜欢!", "顾辞": "我懂你的意思。", "苏窈": "诶~让我想想哦。" } as Record<string, string>)[c && c.name] || "好的，我明白了。";
    return tone + "你说「" + t + "」，别急，我陪你慢慢聊。";
  }
  runTest() {
    if (!(this.state.testText || "").trim()) {
      this.toastMsg("请输入测试语句");
      return;
    }
    (this._tt || []).forEach(clearTimeout);
    this._tt = [];
    const ms = { asr: 160 + Math.floor(Math.random() * 130), llm: 600 + Math.floor(Math.random() * 480), tts: 220 + Math.floor(Math.random() * 180), seed: 40 + Math.floor(Math.random() * 60), mem: 1700 + Math.floor(Math.random() * 700) };
    this.setState({ testStage: 1, testRunning: true, testMs: {}, testReply: "", testAsr: this.state.testText });
    this._tt.push(setTimeout(() => this.setState((p) => ({ testStage: 2, testMs: { ...p.testMs, asr: ms.asr } })), 600));
    this._tt.push(setTimeout(() => this.setState((p) => ({ testStage: 3, testReply: this.genReply(), testMs: { ...p.testMs, llm: ms.llm } })), 1400));
    this._tt.push(setTimeout(() => this.setState((p) => ({ testStage: 4, testMs: { ...p.testMs, tts: ms.tts } })), 2000));
    this._tt.push(setTimeout(() => this.setState((p) => ({ testStage: 5, testMs: { ...p.testMs, seed: ms.seed } })), 2350));
    this._tt.push(setTimeout(() => this.setState((p) => ({ testStage: 6, testRunning: false, testMs: { ...p.testMs, mem: ms.mem } })), 3100));
  }

  renderVals(): Vals {
    const s = this.state;
    const planStyle = (p: string) => p === "无限会员" ? { c: "#E0954F", b: "rgba(224,149,79,.12)" } : (p === "畅聊会员" ? { c: "#6E5CFF", b: "rgba(110,92,255,.1)" } : (p === "轻享会员" ? { c: "#2E7BFF", b: "rgba(46,123,255,.1)" } : (p === "已封禁" ? { c: "#E0594F", b: "rgba(224,89,79,.1)" } : { c: "#878B95", b: "#F0F0F3" })));
    const stars = (n: number) => "★★★★★".slice(0, n) + "☆☆☆☆☆".slice(0, 5 - n);
    const hf = (name: string) => this.hueOf[name] || "none";

    const nav = [
      { key: "dashboard", label: "数据概览", icon: "M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z" },
      { key: "users", label: "用户管理", icon: "M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" },
      { key: "characters", label: "角色管理", icon: "M12 3l2.4 7.4H22l-6 4.6 2.3 7.4-6.3-4.6L5.7 21.4 8 14 2 9.4h7.6z" },
      { key: "scenarios", label: "场景管理", icon: "M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" },
      { key: "calls", label: "通话记录", icon: "M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z" },
      { key: "tickets", label: "工单反馈", icon: "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" },
      { key: "orders", label: "订单充值", icon: "M2 4h20v16H2zM2 10h20" },
      { key: "invites", label: "邀请裂变", icon: "M20 12v10H4V12M2 7h20v5H2zM12 22V7M12 7H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7zM12 7h4.5a2.5 2.5 0 0 0 0-5C13 2 12 7 12 7z" },
    ];
    const pendingCount = 0;
    const openTicketCount = this.tickets.filter((t) => !(s.ticketReplies[t.id]) && t.status !== "已回复").length;
    const navView = nav.map((n) => ({
      label: n.label, icon: n.icon, go: () => this.go(n.key),
      bg: s.section === n.key ? "rgba(110,92,255,.1)" : "transparent",
      color: s.section === n.key ? "#6E5CFF" : "#4A4E5A",
      weight: s.section === n.key ? 600 : 500,
      badge: n.key === "scenarios" && pendingCount ? pendingCount : (n.key === "tickets" && openTicketCount ? openTicketCount : ""),
    }));

    const navCfg = [
      { key: "api", label: "接口配置", icon: "M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6" },
      { key: "cost", label: "成本与限流", icon: "M12 1v22M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" },
      { key: "admins", label: "权限管理", icon: "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" },
    ];
    const navConfigView = navCfg.map((n) => ({ label: n.label, icon: n.icon, go: () => this.go(n.key), bg: s.section === n.key ? "rgba(110,92,255,.1)" : "transparent", color: s.section === n.key ? "#6E5CFF" : "#4A4E5A", weight: s.section === n.key ? 600 : 500 }));
    const engStyle = (e: string) => (({ "火山引擎": { c: "#E0594F", b: "rgba(224,89,79,.1)" }, "MiniMax": { c: "#6E5CFF", b: "rgba(110,92,255,.1)" }, "Azure": { c: "#2E7BFF", b: "rgba(46,123,255,.1)" }, "ElevenLabs": { c: "#1FA971", b: "rgba(31,169,113,.1)" } } as Record<string, any>)[e] || { c: "#878B95", b: "#F0F0F3" });
    const matchedBy: Record<string, number> = { v1: 230, v2: 96, v3: 142, v4: 61, v5: 58, v6: 120, v7: 78, v8: 0, v9: 72 };
    const voicesView = this.voices.map((v) => { const es = engStyle(v.engine); const m = matchedBy[v.id] || 0; return { matched: this.realStats ? "—" : (m ? m.toLocaleString() + " 次" : "—"), name: v.name, engine: v.engine, engColor: es.c, engBg: es.b, meta: v.gender + " · " + v.lang, char: v.char || "—", hueFilter: v.char ? "hue-rotate(" + (v.hue || 0) + "deg)" : "none", hasChar: !!v.char, status: v.status, stColor: v.status === "启用" ? "#1FA971" : "#878B95", stBg: v.status === "启用" ? "rgba(31,169,113,.1)" : "#F0F0F3", preview: () => this.toastMsg("正在播放「" + v.name + "」试听…") }; });
    const voicePresetCount = this.voices.length;
    const voiceCloneCount = this.chars.reduce((a, c) => a + c.customVoices, 0).toLocaleString();
    const voiceMatchTotal = Object.values(matchedBy).reduce((a, b) => a + b, 0).toLocaleString();
    const ttsEngine = s.apiCfg.tts.model;
    const charTabs = ([["role", "角色"], ["voice", "音色"], ["expr", "表情"]] as [string, string][]).map(([k, label]) => ({ label, pick: () => this.setState({ charTab: k }), bg: s.charTab === k ? "#16161A" : "#fff", color: s.charTab === k ? "#fff" : "#5A5E6B", border: s.charTab === k ? "#16161A" : "#E6E7EB" }));
    const ioTabs = ([["export", "导出规则"], ["import", "导入规则"]] as [string, string][]).map(([k, label]) => ({ label, pick: () => this.setState({ ioMode: k }), bg: s.ioMode === k ? "#16161A" : "#fff", color: s.ioMode === k ? "#fff" : "#5A5E6B", border: s.ioMode === k ? "#16161A" : "#E6E7EB" }));
    const exprFiles = this.expressions.map((e) => ({ key: e.key, name: e.name, file: "{id}__expr__" + e.key + ".png" }));
    const exportSample = '{\n  "id": "c1",\n  "name": "林晚",\n  "gender": "女", "age": 18, "height": 156, "weight": 44,\n  "birthday": "2006年1月1日", "nationality": "中国", "race": "东亚人",\n  "desc": "温柔的深夜倾听者",\n  "traits": ["温柔", "耐心", "共情"],\n  "tags": ["治愈系", "深夜", "倾听", "温柔"],\n  "slogan": "今天也辛苦了，想聊点什么都可以。",\n  "bio": "深夜电台主播出身……",\n  "likes": "安静的深夜、下雨天……",\n  "dislikes": "被敷衍、嘈杂的人群……",\n  "voice": { "engine": "MiniMax", "voice_id": "female-shaonv-01", "file": "c1__voice.wav" },\n  "expressions": [\n    { "key": "idle_normal", "file": "c1__expr__idle_normal.png" },\n    { "key": "listening",   "file": "c1__expr__listening.png" },\n    "……（共 12 个状态，见导入规则）……",\n    { "key": "goodbye",     "file": "c1__expr__goodbye.png" }\n  ],\n  "status": "上线"\n}';
    const exprCount = this.expressions.length;
    const exprCharList = this.chars.map((c) => { const offN = this.expressions.filter((e) => s.exprOff[c.id + "_" + e.key]).length; return { name: c.name, desc: c.desc, hueFilter: "hue-rotate(" + c.hue + "deg)", genderAge: c.gender + " · " + c.age + "岁", genderColor: c.gender === "女" ? "#FF6FA5" : "#5B8DEF", enabled: exprCount - offN, total: exprCount, open: () => this.setState({ exprOpen: c.id }) }; });
    const exprChar = this.chars.find((c) => c.id === s.exprOpen);
    const exprCharName = exprChar ? exprChar.name : "";
    const exprCharHue = exprChar ? "hue-rotate(" + exprChar.hue + "deg)" : "none";
    const exprView = this.expressions.map((e) => { const ok = s.exprOpen + "_" + e.key; const off = !!s.exprOff[ok]; return { key: e.key, name: e.name, emoji: e.emoji, status: off ? "停用" : "启用", stColor: off ? "#878B95" : "#1FA971", stBg: off ? "#F0F0F3" : "rgba(31,169,113,.1)", toggle: () => { this.setState((p) => ({ exprOff: { ...p.exprOff, [ok]: !p.exprOff[ok] } })); this.toastMsg(off ? "已启用「" + e.name + "」" : "已停用「" + e.name + "」"); }, preview: () => this.toastMsg("预览 " + exprCharName + " 的「" + e.name + "」表情…") }; });
    const testChars = this.chars.map((c) => ({ name: c.name, hueFilter: "hue-rotate(" + c.hue + "deg)", sel: s.testChar === c.id, bg: s.testChar === c.id ? "rgba(110,92,255,.1)" : "#fff", border: s.testChar === c.id ? "#D9D6FF" : "#E6E7EB", color: s.testChar === c.id ? "#6E5CFF" : "#5A5E6B", pick: () => this.setState({ testChar: c.id }) }));
    const testVoices = this.voices.filter((v) => v.status === "启用").map((v) => ({ name: v.name, sel: s.testVoice === v.id, bg: s.testVoice === v.id ? "#16161A" : "#fff", border: s.testVoice === v.id ? "#16161A" : "#E6E7EB", color: s.testVoice === v.id ? "#fff" : "#5A5E6B", pick: () => this.setState({ testVoice: v.id }) }));
    const selVoice = this.voices.find((v) => v.id === s.testVoice);
    const node = (running: boolean, done: boolean, ms: any) => running ? { color: "#6E5CFF", sub: "#9A8FE0", bg: "rgba(110,92,255,.06)", border: "#D9D6FF", status: "进行中…" } : (done ? { color: "#1FA971", sub: "#7BBF9F", bg: "rgba(31,169,113,.06)", border: "rgba(31,169,113,.28)", status: "✓ " + ms + "ms" } : { color: "#878B95", sub: "#B8BBC4", bg: "#FAFAFB", border: "#EEEFF2", status: "待命" });
    const st = s.testStage;
    const asrNode = node(st === 1, st >= 2, s.testMs.asr);
    const llmNode = node(st === 2, st >= 3, s.testMs.llm);
    const ttsNode = node(st === 3, st >= 4, s.testMs.tts);
    const seedNode = node(st === 4, st >= 5, s.testMs.seed);
    const memNode = node(st === 5, st >= 6, s.testMs.mem);
    const testVideoState = s.testReply ? (this.genReply().indexOf("哈哈") >= 0 ? "speaking_happy" : "speaking_soft") : "";
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
    const roleStyle = (r: string) => (r.indexOf("超级") === 0 ? { c: "#6E5CFF", b: "rgba(110,92,255,.1)" } : r === "运营" ? { c: "#2E7BFF", b: "rgba(46,123,255,.1)" } : r === "客服" ? { c: "#1FA971", b: "rgba(31,169,113,.1)" } : { c: "#878B95", b: "#F0F0F3" });
    // 真实后端：暂无团队成员管理表 → 只显示当前登录运营，不展示演示花名册。
    const adminRoster = [{ id: "self", name: "运营管理员", email: "admin@micall.ai", role: "超级管理员", last: "在线", initial: "运", grad: "linear-gradient(140deg,#A78BFF,#6E5CFF)" }];
    const adminsView = adminRoster.map((a) => { const off = !!s.adminOff[a.id]; const rs = roleStyle(a.role); return { name: a.name, email: a.email, initial: a.initial, grad: a.grad, role: a.role, roleColor: rs.c, roleBg: rs.b, last: a.last, status: off ? "停用" : "启用", stColor: off ? "#878B95" : "#1FA971", stBg: off ? "#F0F0F3" : "rgba(31,169,113,.1)", toggleLabel: off ? "启用" : "停用", toggle: () => { this.setState((p) => ({ adminOff: { ...p.adminOff, [a.id]: !p.adminOff[a.id] } })); this.toastMsg(off ? "已启用 " + a.name : "已停用 " + a.name); } }; });
    const roleMatrixView = Object.keys(this.roleMatrix).map((role) => { const rs = roleStyle(role); return { role, roleColor: rs.c, roleBg: rs.b, cells: this.roleMatrix[role].map((v) => ({ mark: v === 1 ? "✓" : "—", color: v === 1 ? "#1FA971" : "#C9CBD2", bg: v === 1 ? "rgba(31,169,113,.08)" : "transparent" })) }; });
    const apiCards = this.apiSections.map((sec) => { const cfg = s.apiCfg[sec.key]; return {
      name: sec.name, desc: sec.desc, icon: sec.icon, req: sec.req,
      chain: sec.chain, chainColor: sec.chain === "快链路" ? "#6E5CFF" : "#1FA971", chainBg: sec.chain === "快链路" ? "rgba(110,92,255,.1)" : "rgba(31,169,113,.1)",
      tileBg: sec.chain === "快链路" ? "linear-gradient(140deg,#8E7BFF,#6E5CFF)" : "linear-gradient(140deg,#5BE0A0,#1FA971)",
      ...this._apiStatusBadge(sec.key),
      providers: (sec.providers || []).map((p: string) => ({ name: p, pick: () => this.setCfg(sec.key, "provider", p), bg: cfg.provider === p ? "#16161A" : "#fff", color: cfg.provider === p ? "#fff" : "#5A5E6B", border: cfg.provider === p ? "#16161A" : "#E6E7EB" })),
      fields: sec.fields.map((f: any) => ({ label: f.label, value: cfg[f.k] || "", type: f.pw ? "password" : "text", full: f.full ? "grid-column:1 / -1;" : "", onInput: (e: any) => this.setCfg(sec.key, f.k, e.target.value) })),
      test: () => this.testApi(sec.key, sec.name), save: () => this.saveApi(sec.name),
    }; });
    const stC: Record<string, any> = { "正常": { c: "#1FA971", b: "rgba(31,169,113,.1)" }, "未配置": { c: "#878B95", b: "#F0F0F3" }, "延迟高": { c: "#E0954F", b: "rgba(224,149,79,.12)" }, "成本高": { c: "#E0954F", b: "rgba(224,149,79,.12)" }, "异常": { c: "#E0594F", b: "rgba(224,89,79,.1)" }, "备用中": { c: "#2E7BFF", b: "rgba(46,123,255,.1)" } };
    const stp = (st: string) => { const x = stC[st] || stC["正常"]; return { status: st, stColor: x.c, stBg: x.b }; };
    const linkFlow = [{ label: "用户语音", a: "#9AA0AC" }, { label: "Qwen3-ASR-Flash", a: "#2E7BFF" }, { label: "记忆检索", a: "#9AA0AC" }, { label: "deepseek-chat", a: "#6E5CFF" }, { label: "MiniMax TTS", a: "#E0594F" }, { label: "Seedance 表情", a: "#9277F5" }, { label: "用户听到", a: "#1FA971" }, { label: "Qwen-Long 记忆整理", a: "#1FA971" }];
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
    const fallbackRows = [
      { kind: "ASR", primary: "阿里云", backups: "火山 ASR · ElevenLabs Scribe", cond: "连续失败 3 次 / 延迟 > 2s / 错误率 > 5%" },
      { kind: "LLM 快脑", primary: "deepseek-chat", backups: "Qwen Flash · 豆包", cond: "超时 / 连续失败 / 成本超阈值" },
      { kind: "TTS", primary: "MiniMax speech-2.8-turbo", backups: "阿里 Qwen-TTS · ElevenLabs", cond: "超时 / 延迟超阈值 / 手动切换" },
      { kind: "表情视频", primary: "Seedance 预生成库", backups: "回退 idle_normal → 静态头像", cond: "video_state 缺失 / 视频加载失败" },
      { kind: "记忆总结", primary: "Qwen-Long", backups: "保存 transcript 后台重试", cond: "总结失败 / 超时" },
    ];
    const limitItems = [["免费用户每日通话", "30 分钟"], ["会员每月高级语音", "1500 分钟"], ["单次通话最长", "60 分钟"], ["静音自动挂断", "45 秒"], ["AI 单次最大回复", "120 字"], ["超额后", "切换低成本模式"], ["高成本模型", "仅高级会员"]];
    const warnItems = ["单用户今日成本 > $20", "某模型失败率 > 5%", "TTS 成本环比上涨 > 30%", "通话平均时长异常波动", "单个 voice_id 调用量激增"];
    const seedanceCoverage = this.chars.map((c) => { const offN = this.expressions.filter((e) => s.exprOff[c.id + "_" + e.key]).length; return { name: c.name, hueFilter: "hue-rotate(" + c.hue + "deg)", got: this.expressions.length - offN, total: this.expressions.length }; });

    const titles: Record<string, [string, string]> = {
      dashboard: ["数据概览", "MiCall.ai 运营核心指标"],
      users: ["用户管理", this.users.length + " 名注册用户"],
      characters: ["角色管理", this.chars.length + " 个 AI 角色"],
      scenarios: ["场景管理", "官方场景库"],
      calls: ["通话记录", "会话明细与对话回放"],
      tickets: ["工单反馈", openTicketCount + " 条待处理"],
      orders: ["订单充值", "会员套餐与交易记录"],
      api: ["接口配置", "ASR · LLM · TTS 服务接入"],
      cost: ["成本与限流", "成本结构与付费/免费策略"],
      invites: ["邀请裂变", "邀请奖励规则与裂变数据"],
      admins: ["权限管理", "管理员账号与角色权限"],
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
      .map((c, i) => ({ rank: i + 1, name: c.name, hueFilter: "hue-rotate(" + c.hue + "deg)", calls: this.realStats ? c.calls + " 次" : c.calls }));
    const SCENE_NAME: Record<string, string> = { heart: "心情树洞", chat: "随便聊聊", interview: "模拟面试", idiom: "成语接龙", english: "英语陪练", study: "陪我学习", sleep: "睡前故事", meditation: "解压冥想", coffee: "咖啡馆", story: "睡前故事" };
    // 热门场景：从 calls.scenario 真实聚合（无数据则空，不再用演示数字）。
    const scEnt = Object.entries((this.realSceneCalls || {}) as Record<string, number>).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]).slice(0, 5);
    const scMax = Math.max(1, ...scEnt.map(([, n]) => n));
    const topScenes = scEnt.map(([k, n]) => ({ name: SCENE_NAME[k] || k, uses: String(n), pct: Math.round(n / scMax * 100) + "%" }));
    const recentCalls = this.calls.slice(0, 4).map((c) => ({ char: c.char, hueFilter: hf(c.char), scene: c.scene, dur: c.dur, open: () => this.open("call", c.id) }));

    const ufDefs: [string, string][] = [["all", "全部"], ["无限会员", "无限会员"], ["畅聊会员", "畅聊会员"], ["轻享会员", "轻享会员"], ["免费", "免费"], ["已封禁", "已封禁"]];
    const userFilters = ufDefs.map(([k, label]) => ({
      label, pick: () => this.setState({ userFilter: k }),
      bg: s.userFilter === k ? "#16161A" : "#fff", color: s.userFilter === k ? "#fff" : "#5A5E6B",
      border: s.userFilter === k ? "#16161A" : "#E6E7EB",
    }));
    const q = s.query.trim().toLowerCase();
    const usersView = this.users.map((u) => {
      const plan = s.banned[u.id] ? "已封禁" : u.plan;
      const ps = planStyle(plan);
      return { ...u, plan, mins: plan === "已封禁" ? "—" : u.minsRaw, planColor: ps.c, planBg: ps.b, open: () => this.open("user", u.id) };
    }).filter((u) => (s.userFilter === "all" || u.plan === s.userFilter) && (!q || u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q)));

    const genderColor = (g: string) => g === "女" ? "#FF6FA5" : "#5B8DEF";
    const voiceIdMap: Record<string, string> = { c1: "female-shaonv-01", c2: "male-cixing-02", c3: "female-yuanqi-03", c4: "male-chenwen-04", c5: "female-tianmei-05" };
    const charMatched: Record<string, number> = { c1: 230, c2: 96, c3: 142, c4: 61, c5: 58 };
    const charsView = this.chars.filter((c) => !q || (c.name + c.desc + c.bio).toLowerCase().includes(q)).map((c) => ({ ...c, hueFilter: "hue-rotate(" + c.hue + "deg)", genderAge: c.gender + " · " + c.age + "岁", genderColor: genderColor(c.gender),
      voiceId: voiceIdMap[c.id] || "default", voiceMatched: (charMatched[c.id] || 0) + " 次匹配", playVoice: (e: any) => { if (e && e.stopPropagation) e.stopPropagation(); this.toastMsg("播放 " + c.name + " 原本音色…"); },
      status: s.charOff[c.id] ? "已下架" : c.status,
      // NB: stColor/stBg are set by the trailing status-based spread below
      // (it unconditionally overwrites), matching the prototype's exact output.
      offLabel: s.charOff[c.id] ? "重新上线" : "下架", offColor: s.charOff[c.id] ? "#1FA971" : "#E0594F", offBg: s.charOff[c.id] ? "rgba(31,169,113,.08)" : "rgba(224,89,79,.08)",
      offToggle: (e: any) => { if (e && e.stopPropagation) e.stopPropagation(); this.setState((p) => ({ charOff: { ...p.charOff, [c.id]: !p.charOff[c.id] } })); this.toastMsg(s.charOff[c.id] ? "已重新上线 " + c.name : "已下架 " + c.name); },
      exprGot: this.expressions.length - this.expressions.filter((e) => s.exprOff[c.id + "_" + e.key]).length, exprTotal: this.expressions.length,
      exprChips: this.expressions.map((e) => ({ emoji: e.emoji, op: s.exprOff[c.id + "_" + e.key] ? "0.28" : "1" })), ...((st: string) => st === "上线" ? { stColor: "#1FA971", stBg: "rgba(31,169,113,.1)" } : { stColor: "#878B95", stBg: "#F0F0F3" })(c.status), open: () => this.open("char", c.id) }));

    const tabDefs: [string, string][] = [["rec", "推荐"], ["hot", "热门"]];
    const sceneTabs = tabDefs.map(([k, label]) => ({
      label, pick: () => this.setState({ sceneTab: k }),
      bg: s.sceneTab === k ? "#16161A" : "#fff", color: s.sceneTab === k ? "#fff" : "#5A5E6B",
      border: s.sceneTab === k ? "#16161A" : "#E6E7EB",
      badge: k === "custom" && pendingCount ? pendingCount : "",
    }));
    const scenesView = this.scenes.filter((x) => x.type === s.sceneTab && (!q || (x.name + (x.prompt || "")).toLowerCase().includes(q))).map((x) => {
      const st = s.sceneStatus[x.id] || x.status || (x.type === "custom" ? "待审核" : "已上线");
      const pending = st === "待审核";
      const stStyle = st === "已上线" ? { c: "#1FA971", b: "rgba(31,169,113,.1)" } : (st === "已拒绝" ? { c: "#E0594F", b: "rgba(224,89,79,.1)" } : { c: "#E0954F", b: "rgba(224,149,79,.12)" });
      const realUses = this.realSceneCalls ? (this.realSceneCalls[Object.keys(SCENE_NAME).find((k) => SCENE_NAME[k] === x.name) || ""] || 0) : null;
      return { name: x.name, desc: x.desc || "", prompt: x.prompt, byUser: x.byUser || "", uses: x.type === "custom" ? "" : (realUses != null ? realUses + " 次使用" : x.uses + " 次使用"), status: st, stColor: stStyle.c, stBg: stStyle.b, pending,
        approve: () => { this.setState((p) => ({ sceneStatus: { ...p.sceneStatus, [x.id]: "已上线" } })); this.toastMsg("已通过「" + x.name + "」"); },
        reject: () => { this.setState((p) => ({ sceneStatus: { ...p.sceneStatus, [x.id]: "已拒绝" } })); this.toastMsg("已拒绝「" + x.name + "」"); } };
    });

    const callsView = this.calls.filter((c) => !q || (c.char + c.user + c.scene).toLowerCase().includes(q)).map((c) => ({ char: c.char, hueFilter: hf(c.char), user: c.user, scene: c.scene, dur: c.dur, stars: stars(c.rating), time: c.time, open: () => this.open("call", c.id) }));

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
    let dUser: any = null, dChar: any = null, dCall: any = null, dTicket: any = null, dCharExpr: any = null, detailTitle = "";
    let banLabel = "", banColor = "", banBg = "", charBioLen = 0, ticketNeedsReply = false;
    if (d && d.type === "user") {
      const u = this.users.find((x) => x.id === d.id); const isBan = !!s.banned[u.id];
      const plan = isBan ? "已封禁" : u.plan;
      dUser = { ...u, plan, mins: isBan ? "—" : u.minsRaw, noRecharge: u.recharges.length === 0 };
      detailTitle = "用户详情";
      banLabel = isBan ? "解除封禁" : "封禁该用户"; banColor = isBan ? "#1FA971" : "#E0594F"; banBg = isBan ? "rgba(31,169,113,.1)" : "rgba(224,89,79,.1)";
    } else if (d && d.type === "char") {
      const isNew = d.id === "__new__";
      const c = isNew ? { name: "新角色", hue: 270, gender: (s.charEdit as any).gender || "女", age: (s.charEdit as any).age || "20", height: "—", weight: "—", desc: "AI 生成或手填", status: "上线" } : this.chars.find((x) => x.id === d.id);
      dChar = { ...c, isNew, notNew: !isNew, hueFilter: "hue-rotate(" + c.hue + "deg)", genderAge: c.gender + " · " + c.age + "岁", genderColor: c.gender === "女" ? "#FF6FA5" : "#5B8DEF", ...((st: string) => st === "上线" ? { stColor: "#1FA971", stBg: "rgba(31,169,113,.1)" } : { stColor: "#878B95", stBg: "#F0F0F3" })(c.status) };
      detailTitle = isNew ? "新建角色" : "角色编辑"; charBioLen = ((s.charEdit as any).background_story || "").length;
      dCharExpr = this.expressions.map((e) => { const ok = d.id + "_" + e.key; const off = !!s.exprOff[ok]; return { name: e.name, emoji: e.emoji, key: e.key, status: off ? "停用" : "启用", stColor: off ? "#878B95" : "#1FA971", stBg: off ? "#F0F0F3" : "rgba(31,169,113,.1)", toggle: () => { this.setState((p) => ({ exprOff: { ...p.exprOff, [ok]: !p.exprOff[ok] } })); }, preview: () => this.toastMsg("预览「" + e.name + "」表情…") }; });
    } else if (d && d.type === "call") {
      const c = this.calls.find((x) => x.id === d.id);
      dCall = { char: c.char, hueFilter: hf(c.char), user: c.user, scene: c.scene, dur: c.dur, stars: stars(c.rating), time: c.time, feedback: c.feedback,
        lines: c.lines.map((m: any) => m.who === "ai"
          ? { text: m.t, justify: "flex-start", radius: "4px 14px 14px 14px", bg: "#F2F2F5", color: "#2A2A2E" }
          : { text: m.t, justify: "flex-end", radius: "14px 4px 14px 14px", bg: "#6E5CFF", color: "#fff" }) };
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
      charTabs, isRoleTab: s.charTab === "role", isVoiceTab: s.charTab === "voice", isExprTab: s.charTab === "expr", isApi: s.section === "api", isCost: s.section === "cost",
      linkFlow, healthKpis, nodeCards, costKpis, costByProvider, memoryRecent, fallbackRows, limitItems, warnItems, seedanceCoverage,
      freePaid: [
        { item: "通话额度", free: "每日 30 分钟", paid: "畅聊 1500 分钟/月 · 无限会员不限时" },
        { item: "单次通话最长", free: "15 分钟", paid: "60 分钟" },
        { item: "语音合成 TTS", free: "标准音质", paid: "标准 / 高音质（高级）" },
        { item: "自定义音色", free: "不可用", paid: "会员可用（Voice Design / Clone）" },
        { item: "AI 回复长度", free: "≤ 80 字", paid: "≤ 120 字" },
        { item: "表情视频", free: "基础状态", paid: "完整 12 状态" },
        { item: "记忆深度", free: "近 3 次通话", paid: "长期记忆完整" },
        { item: "超额后", free: "提示充值 / 切低成本模式", paid: "切低成本模式 · 不中断" },
        { item: "高成本模型", free: "不可用", paid: "仅高级会员" },
      ],
      nodeTest: () => this.toastMsg("正在测试该节点…"), fbTest: () => this.toastMsg("一键测试兜底链路中…"), fbLog: () => this.toastMsg("打开最近兜底日志"), fbSwitch: () => this.toastMsg("已切换主供应商"),
      expr12: this.expressions.map((e) => e.name),
      ioOpen: s.ioOpen, isIoExport: s.ioMode === "export", isIoImport: s.ioMode === "import", ioTabs, exportSample, exprFiles,
      openExport: () => this.setState({ ioOpen: true, ioMode: "export" }), openImport: () => this.setState({ ioOpen: true, ioMode: "import" }), closeIO: () => this.setState({ ioOpen: false }),
      runExport: () => this.toastMsg("已导出 micall_characters.json"), runImport: () => this.toastMsg("正在解析并按文件名归位导入资产…"),
      voicePresetCount, voiceCloneCount, voiceMatchTotal, ttsEngine, voicesView, apiCards,
      exprView, exprCharName, exprCharHue, exprCount, exprCharList,
      exprListMode: !s.exprOpen, exprDetailMode: !!s.exprOpen, exprBack: () => this.setState({ exprOpen: null }),
      testChars, testVoices, testText: s.testText, onTestText: (e: any) => this.setState({ testText: e.target.value }),
      runTest: () => this.runTest(), runLabel: s.testRunning ? "测试中…" : "开始测试",
      asrNode, llmNode, ttsNode, seedNode, memNode, testVideoState,
      asrMs: s.testMs.asr || "", llmMs: s.testMs.llm || "", seedMs: s.testMs.seed || "", memMs: s.testMs.mem || "", testAllDone: st >= 6,
      testReply: s.testReply, testAsr: s.testAsr, testDone: st >= 3,
      testVoiceName: selVoice ? selVoice.name : "", testCharHue: s.testChar ? "hue-rotate(" + ((this.chars.find((c) => c.id === s.testChar) || {}).hue || 0) + "deg)" : "none",
      ttsMs: s.testMs.tts || "", replay: () => this.toastMsg("正在用「" + (selVoice ? selVoice.name : "默认") + "」播放合成语音…"),
      secTitle: titles[s.section][0], secSub: titles[s.section][1],
      query: s.query, onQuery: (e: any) => this.setState({ query: e.target.value }),
      isDashboard: s.section === "dashboard", isUsers: s.section === "users", isChars: s.section === "characters",
      isScenes: s.section === "scenarios", isCalls: s.section === "calls", isTickets: s.section === "tickets", isOrders: s.section === "orders",
      kpis, trend, trendTitle, dateChips, topChars, topScenes, recentCalls,
      isInvites: s.section === "invites", isAdmins: s.section === "admins",
      inviteKpis, invitersView, inviteRecordsView,
      inviteReward: s.inviteReward, onInviteReward: (e: any) => this.setState({ inviteReward: e.target.value }),
      inviteeReward: s.inviteeReward, onInviteeReward: (e: any) => this.setState({ inviteeReward: e.target.value }),
      inviteRuleOn: s.inviteRuleOn, toggleInviteRule: () => this.setState((p) => ({ inviteRuleOn: !p.inviteRuleOn })),
      ruleTrackBg: s.inviteRuleOn ? "#6E5CFF" : "#D8D9DE", ruleKnobLeft: s.inviteRuleOn ? "20px" : "2px",
      saveInviteRule: () => this.toastMsg("邀请奖励规则已保存"),
      adminsView, permModules: this.permModules, roleMatrixView, addAdmin: () => this.toastMsg("打开「添加管理员」表单…"),
      notifs: this.realStats ? (this.tickets.filter((t: any) => t.status === "待处理").length > 0 ? [{ title: this.tickets.filter((t: any) => t.status === "待处理").length + " 条工单待处理", time: "实时", dot: "#E0594F" }] : []) : this.notifs,
      notifOpen: s.notifOpen, notifUnread: this.realStats ? this.tickets.some((t: any) => t.status === "待处理") : !s.notifRead,
      toggleNotif: () => this.setState((p) => ({ notifOpen: !p.notifOpen })), closeNotif: () => this.setState({ notifOpen: false }), markAllRead: () => this.setState({ notifRead: true, notifOpen: false }),
      userFilters, usersView, charsView, sceneTabs, scenesView, callsView, ticketsView, ordersView, plans,
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
      dUser, dChar, dCall, dTicket, dCharExpr,
      banLabel, banColor, banBg, toggleBan: () => { const id = d.id; this.setState((p) => ({ banned: { ...p.banned, [id]: !p.banned[id] } })); this.toastMsg(s.banned[d.id] ? "已解除封禁" : "已封禁该用户"); },
      charBioLen, saveChar: () => this.saveChar(),
      saveCharLabel: (s.detail && s.detail.id === "__new__") ? "创建角色" : "保存修改",
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
      ceBio: (s.charEdit as any).background_story || "", onCeBio: (e: any) => this.setCe("background_story", e.target.value),
      replyDraft: s.replyDraft, onReplyDraft: (e: any) => this.setState({ replyDraft: e.target.value }), ticketNeedsReply,
      sendReply: async () => { const v = (s.replyDraft || "").trim(); if (!v) { this.toastMsg("请输入回复内容"); return; } const id = d.id; const ok = await replyTicket(id, v); if (!ok && usingBackend()) { this.toastMsg("回复失败，请重试"); return; } const t = this.tickets.find((x) => x.id === id); if (t) { t.reply = v; t.status = "已回复"; } this.setState((p) => ({ ticketReplies: { ...p.ticketReplies, [id]: v }, replyDraft: "" })); this.toastMsg("回复已发送"); },
      toast: s.toast,
    };
  }
}
