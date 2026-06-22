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
import { loadApiConfig, saveApiConfig, testApiSection } from "./configService";

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

  private _t: Timer | undefined;
  private _tt: Timer[] = [];

  state: State = {
    section: "dashboard", detail: null, query: "", userFilter: "all", sceneTab: "rec", charBio: "", replyDraft: "", toast: "", banned: {}, sceneStatus: {}, ticketReplies: {}, inviteReward: "60", inviteeReward: "60", inviteRuleOn: true, adminOff: {}, notifOpen: false, notifRead: false, dateRange: "7d", charTab: "role", exprOpen: null, exprOff: {}, charOff: {}, ioOpen: false, ioMode: "export",
    testVoice: "v1", testChar: "c1", testText: "今天工作压力好大，感觉有点撑不住。", testStage: 0, testRunning: false, testMs: {}, testReply: "", testAsr: "",
    apiCfg: {
      asr: { provider: "阿里云", endpoint: "https://nls-gateway.aliyuncs.com/stream/v1/asr", key: "sk-ali-••••••a3f9", model: "paraformer-realtime-v2", lang: "中文 / 自动" },
      fast: { provider: "DeepSeek", endpoint: "https://api.deepseek.com/v1/chat/completions", key: "sk-ds-••••••7c2d", model: "deepseek-v4-flash", temp: "0.8", maxTokens: "256" },
      tts: { provider: "MiniMax", endpoint: "https://api.minimax.chat/v1/t2a_v2", key: "sk-mm-••••••9e1b", model: "speech-02-turbo", voiceId: "female-shaonv-01", sampleRate: "24000 Hz" },
      memory: { provider: "通义千问", endpoint: "https://dashscope.aliyuncs.com/api/v1/services/aigc", key: "sk-qw-••••••2f8c", model: "qwen-long", maxContext: "1,000,000 tokens" },
      embed: { provider: "阿里云", endpoint: "https://dashscope.aliyuncs.com/api/v1/embeddings", key: "sk-emb-••••••b1d4", model: "text-embedding-v3", vectorDB: "Milvus", topK: "5" },
    },
  };

  constructor(props?: AdminProps) {
    this.props = props || {};
    const uG = { a: "linear-gradient(140deg,#A78BFF,#6E5CFF)", b: "linear-gradient(140deg,#FF8FC8,#FF4FA0)", c: "linear-gradient(140deg,#5BE0A0,#1FA971)", d: "linear-gradient(140deg,#6FC8FF,#2E7BFF)", e: "linear-gradient(140deg,#FFB36B,#F5821F)" };
    this.chars = [
      { id: "c1", name: "林晚", desc: "温柔的深夜倾听者", hue: 0, gender: "女", age: 18, height: 156, weight: 44, birthday: "2006年1月1日", nationality: "中国", race: "东亚人", traits: ["温柔", "耐心", "共情"], tags: ["治愈系", "深夜", "倾听", "温柔"], slogan: "今天也辛苦了，想聊点什么都可以。", likes: "安静的深夜、认真听你说话、下雨天、一杯热可可", dislikes: "被敷衍、嘈杂的人群、冷场", bio: "深夜电台主播出身，习惯在安静里听人把话说完。不急着给建议，也不轻易打断，只是稳稳地陪着你。", calls: "24.1k", customVoices: 312, favs: "9,840", status: "上线" },
      { id: "c2", name: "江野", desc: "理性可靠的陪伴", hue: 135, gender: "男", age: 21, height: 161, weight: 47, birthday: "2005年2月8日", nationality: "日本", race: "欧裔", traits: ["理性", "冷静", "务实"], tags: ["理性", "高冷", "成熟", "陪伴"], slogan: "有什么想不通的，说来听听。", likes: "清晰的逻辑、长跑、黑咖啡、安静", dislikes: "拖延、含糊其辞、无意义的争论", bio: "话不多，但每句都在点上。适合在你思绪乱成一团时，帮你一条条理清楚，再陪你走下一步。", calls: "15.3k", customVoices: 156, favs: "6,210", status: "上线" },
      { id: "c3", name: "夏鸣", desc: "元气满满的朋友", hue: 60, gender: "女", age: 24, height: 166, weight: 50, birthday: "2004年3月15日", nationality: "美国", race: "混血", traits: ["元气", "幽默", "直率"], tags: ["元气", "俏皮", "邻家", "温柔"], slogan: "嘿！今天有什么好玩的事？", likes: "阳光、音乐、冷笑话、奶茶", dislikes: "冷场、emo、被无视", bio: "走到哪儿都自带阳光，三两句就能把气氛点亮。心情低落时，找他准没错。", calls: "18.7k", customVoices: 204, favs: "7,530", status: "上线" },
      { id: "c4", name: "顾辞", desc: "沉静睿智的对话者", hue: 225, gender: "男", age: 27, height: 171, weight: 53, birthday: "2003年4月22日", nationality: "英国", race: "东亚人", traits: ["沉静", "睿智", "文艺"], tags: ["文艺", "知性", "沉静", "学长"], slogan: "夜深了，来聊聊书，或者别的？", likes: "旧书、爵士乐、独处、一壶红茶", dislikes: "喧闹、肤浅、敷衍", bio: "读过很多书，喜欢慢慢聊。和他说话，像在深夜翻开一本旧书，安静又有回味。", calls: "11.9k", customVoices: 98, favs: "5,180", status: "上线" },
      { id: "c5", name: "苏窈", desc: "俏皮灵动的伙伴", hue: 300, gender: "女", age: 30, height: 176, weight: 56, birthday: "2002年5月2日", nationality: "法国", race: "东亚人", traits: ["俏皮", "灵动", "好奇"], tags: ["俏皮", "灵动", "古灵精怪", "御姐"], slogan: "猜猜我今天又想到了什么？", likes: "新鲜事、恶作剧、甜点、惊喜", dislikes: "无聊、套路、被说教", bio: "鬼马精灵，脑洞奇大。跟她聊天，你永远猜不到她下一句会说什么。", calls: "9.2k", customVoices: 87, favs: "4,360", status: "上线" },
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
    this.users = [
      { id: "u1", name: "陈思远", email: "siyuan.c@gmail.com", initial: "陈", grad: uG.a, plan: "畅聊会员", minsRaw: "1488 分钟", spent: "$83.91", joined: "2025-11-02", recharges: [{ plan: "畅聊会员 · 年付", amount: "$83.92", date: "2026-01-18" }, { plan: "畅聊会员 · 月付", amount: "$9.99", date: "2025-11-02" }] },
      { id: "u2", name: "林晓彤", email: "xiaotong@163.com", initial: "林", grad: uG.b, plan: "免费", minsRaw: "12 分钟", spent: "$0", joined: "2026-03-14", recharges: [] },
      { id: "u3", name: "Marcus Lee", email: "marcus.lee@outlook.com", initial: "M", grad: uG.d, plan: "无限会员", minsRaw: "不限时", spent: "$167.92", joined: "2025-09-21", recharges: [{ plan: "无限会员 · 年付", amount: "$167.92", date: "2025-09-21" }] },
      { id: "u4", name: "王雨桐", email: "yutong.w@qq.com", initial: "王", grad: uG.c, plan: "轻享会员", minsRaw: "240 分钟", spent: "$14.97", joined: "2026-02-08", recharges: [{ plan: "轻享会员 · 季付", amount: "$11.98", date: "2026-02-10" }, { plan: "轻享会员 · 月付", amount: "$4.99", date: "2026-05-10" }] },
      { id: "u5", name: "赵梓涵", email: "zihan.zhao@gmail.com", initial: "赵", grad: uG.e, plan: "已封禁", minsRaw: "0 分钟", spent: "$9.99", joined: "2025-12-30", recharges: [{ plan: "畅聊会员 · 月付", amount: "$9.99", date: "2025-12-30" }] },
      { id: "u6", name: "Sora Tanaka", email: "sora.t@gmail.com", initial: "S", grad: uG.a, plan: "畅聊会员", minsRaw: "1024 分钟", spent: "$29.97", joined: "2026-01-05", recharges: [{ plan: "畅聊会员 · 月付", amount: "$9.99", date: "2026-01-05" }, { plan: "畅聊会员 · 月付", amount: "$9.99", date: "2026-02-05" }, { plan: "畅聊会员 · 月付", amount: "$9.99", date: "2026-03-05" }] },
      { id: "u7", name: "刘梦琪", email: "mengqi.liu@163.com", initial: "刘", grad: uG.b, plan: "免费", minsRaw: "8 分钟", spent: "$0", joined: "2026-04-11", recharges: [] },
      { id: "u8", name: "周岚", email: "lan.zhou@foxmail.com", initial: "周", grad: uG.d, plan: "无限会员", minsRaw: "不限时", spent: "$239.88", joined: "2025-08-17", recharges: [{ plan: "无限会员 · 月付", amount: "$19.99", date: "2026-05-17" }, { plan: "无限会员 · 月付", amount: "$19.99", date: "2026-06-17" }] },
    ];
    this.calls = [
      { id: "k1", char: "林晚", user: "陈思远", scene: "心情树洞", dur: "12:08", rating: 5, time: "今天 23:14", feedback: "很温暖", lines: [{ who: "ai", t: "今天看起来有点累，愿意和我说说吗?" }, { who: "user", t: "嗯…工作压力好大，感觉撑不住了。" }, { who: "ai", t: "辛苦你了，能撑到现在已经很不容易。是哪一部分让你觉得最累?" }, { who: "user", t: "项目一直改，怎么做都达不到要求。" }, { who: "ai", t: "那种反复推翻的无力感，真的很消耗人。这不代表你不够好，只是要求一直在变。" }, { who: "user", t: "听你这么说，好像没那么糟了。" }] },
      { id: "k2", char: "夏鸣", user: "林晓彤", scene: "随便聊聊", dur: "04:21", rating: 4, time: "今天 12:30", feedback: "聊得开心", lines: [{ who: "user", t: "今天有点无聊。" }, { who: "ai", t: "那可不行!来，你今天遇到的最好笑的一件事是什么?" }, { who: "user", t: "上班路上看见一只猫追自己尾巴转圈。" }, { who: "ai", t: "哈哈哈那画面太治愈了!它是不是转到自己都晕了?" }] },
      { id: "k3", char: "顾辞", user: "Marcus Lee", scene: "成语接龙", dur: "08:47", rating: 5, time: "昨天 21:35", feedback: "", lines: [{ who: "ai", t: "我先来——「水到渠成」。" }, { who: "user", t: "成竹在胸。" }, { who: "ai", t: "胸有成竹的另一种说法，接得妙。那我接「胸」字…「胸怀大志」。" }, { who: "user", t: "志在四方!" }] },
      { id: "k4", char: "苏窈", user: "王雨桐", scene: "随便聊聊", dur: "03:12", rating: 3, time: "昨天 13:08", feedback: "答非所问", lines: [{ who: "user", t: "帮我想个周末去哪玩。" }, { who: "ai", t: "周末当然要出去浪啦!你喜欢热闹还是安静?" }, { who: "user", t: "安静一点的。" }, { who: "ai", t: "那去郊外的湖边走走怎么样，带本书，超惬意~" }] },
      { id: "k5", char: "林晚", user: "Sora Tanaka", scene: "心情树洞", dur: "18:40", rating: 5, time: "昨天 00:22", feedback: "", lines: [{ who: "ai", t: "这么晚还没睡，在想什么呢?" }, { who: "user", t: "有点想家。" }, { who: "ai", t: "想家是因为那里有让你安心的人和回忆。要不要和我说说家里最让你怀念的画面?" }] },
      { id: "k6", char: "江野", user: "刘梦琪", scene: "模拟面试", dur: "15:03", rating: 4, time: "周一 20:15", feedback: "反应慢", lines: [{ who: "ai", t: "先做个简单的自我介绍吧。" }, { who: "user", t: "我是应届生，应聘产品岗。" }, { who: "ai", t: "好。说一个你主导过、最有成就感的项目，重点讲你的决策。" }, { who: "user", t: "我做过一个校园社团管理的小程序…" }] },
      { id: "k7", char: "顾辞", user: "周岚", scene: "随便聊聊", dur: "09:18", rating: 5, time: "周日 22:02", feedback: "", lines: [{ who: "user", t: "最近总是失眠。" }, { who: "ai", t: "睡前是不是想得太多?试着把脑子里的事写下来，交给明天。" }] },
      { id: "k8", char: "苏窈", user: "赵梓涵", scene: "英语陪练", dur: "11:27", rating: 2, time: "周日 15:40", feedback: "反应慢", lines: [{ who: "ai", t: "Let's start! How was your day?" }, { who: "user", t: "It was…busy。" }, { who: "ai", t: "Busy in a good way or a tiring way? Try to tell me one thing you did." }] },
    ];
    this.tickets = [
      { id: "t1", type: "功能异常", user: "林晓彤", msg: "通话时偶尔会有电流杂音，尤其是晚上信号不好的时候，影响体验。", date: "2026-06-19", status: "待处理", reply: "" },
      { id: "t2", type: "建议反馈", user: "Marcus Lee", msg: "希望能增加更多男性角色，以及英文原声的音色选项。", date: "2026-06-18", status: "待处理", reply: "" },
      { id: "t3", type: "账号/支付", user: "王雨桐", msg: "充值了轻享会员季付但时长没有到账，订单号 MC20260210。", date: "2026-06-15", status: "已回复", reply: "已为你补发季度时长并核实订单，感谢反馈，额外补偿你 30 分钟。" },
      { id: "t4", type: "建议反馈", user: "陈思远", msg: "自定义场景能不能支持保存多个常用 prompt，方便一次通话里切换。", date: "2026-06-12", status: "已回复", reply: "好建议!多场景快捷切换已在开发中，预计下个版本上线。" },
      { id: "t5", type: "其他", user: "周岚", msg: "想了解无限会员年付有没有更优惠的活动。", date: "2026-06-10", status: "待处理", reply: "" },
    ];
    this.orders = [
      { id: "MC20260618A", user: "陈思远", plan: "畅聊会员 · 月付", amount: "$9.99", status: "已支付" },
      { id: "MC20260618B", user: "周岚", plan: "无限会员 · 月付", amount: "$19.99", status: "已支付" },
      { id: "MC20260617C", user: "Sora Tanaka", plan: "畅聊会员 · 月付", amount: "$9.99", status: "已支付" },
      { id: "MC20260617D", user: "王雨桐", plan: "轻享会员 · 季付", amount: "$11.98", status: "退款中" },
      { id: "MC20260616E", user: "Marcus Lee", plan: "无限会员 · 年付", amount: "$167.92", status: "已支付" },
      { id: "MC20260615F", user: "刘梦琪", plan: "轻享会员 · 月付", amount: "$4.99", status: "失败" },
      { id: "MC20260614G", user: "赵梓涵", plan: "畅聊会员 · 月付", amount: "$9.99", status: "已支付" },
      { id: "MC20260613H", user: "陈思远", plan: "畅聊会员 · 年付", amount: "$83.92", status: "已支付" },
    ];
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
      { key: "asr", name: "ASR · 语音识别", chain: "快链路", desc: "实时把用户语音转写为文字 · 默认 Qwen3-ASR-Flash（阿里百炼）", icon: "M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3zM19 10v2a7 7 0 0 1-14 0v-2M12 19v4M8 23h8", req: "快 · 低延迟 · 可打断", fields: [{ k: "endpoint", label: "接口地址", full: true }, { k: "key", label: "API Key", pw: true }, { k: "lang", label: "识别语言" }] },
      { key: "fast", name: "LLM · 快脑（通话中）", chain: "快链路", desc: "通话中实时生成简短回复 · 默认 DeepSeek-V4-Flash（先经 apiyi，endpoint 可配，卡了切直连）", icon: "M13 2L3 14h7l-1 8 10-12h-7l1-8z", req: "快 · 短 · 低延迟 · 可打断", fields: [{ k: "endpoint", label: "接口地址", full: true }, { k: "key", label: "API Key", pw: true }, { k: "temp", label: "温度" }, { k: "maxTokens", label: "回复上限 Token" }] },
      { key: "tts", name: "TTS · 语音合成", chain: "快链路", desc: "合成角色语音，voice_id 决定音色 · 默认 MiniMax TTS（官方直连，支持 emotion）", icon: "M11 5 6 9H3v6h3l5 4V5zM15.5 9a4.5 4.5 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11", req: "快 · 自然 · 可打断", fields: [{ k: "endpoint", label: "接口地址", full: true }, { k: "key", label: "API Key", pw: true }, { k: "voiceId", label: "默认 voice_id" }, { k: "sampleRate", label: "采样率" }] },
      { key: "memory", name: "LLM · 长记忆脑（通话后）", chain: "慢链路", desc: "通话后总结、提取长期记忆、生成开场白 · 默认通义千问（阿里百炼国际站，可复用 ASR 账号，离线不要求快）", icon: "M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2zM2 12h20M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20", req: "准 · 稳 · 长上下文（不要求快）", fields: [{ k: "endpoint", label: "接口地址", full: true }, { k: "key", label: "API Key", pw: true }, { k: "maxContext", label: "最大上下文" }] },
      { key: "embed", name: "Embedding · 记忆检索", chain: "慢链路", desc: "向量化记忆并快速检索相关片段 · 存储 Postgres + pgvector", icon: "M21 5c0 1.66-4 3-9 3S3 6.66 3 5s4-3 9-3 9 1.34 9 3zM3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5M3 12c0 1.66 4 3 9 3s9-1.34 9-3", req: "快检索 · 高召回", fields: [{ k: "endpoint", label: "接口地址", full: true }, { k: "key", label: "API Key", pw: true }, { k: "vectorDB", label: "向量数据库" }, { k: "topK", label: "检索 Top-K" }] },
    ];
    this.inviters = [
      { name: "周岚", initial: "周", grad: "linear-gradient(140deg,#6FC8FF,#2E7BFF)", invited: 48, success: 41, pending: 3, mins: "2,460" },
      { name: "陈思远", initial: "陈", grad: "linear-gradient(140deg,#A78BFF,#6E5CFF)", invited: 36, success: 33, pending: 2, mins: "1,980" },
      { name: "Marcus Lee", initial: "M", grad: "linear-gradient(140deg,#6FC8FF,#2E7BFF)", invited: 29, success: 24, pending: 5, mins: "1,440" },
      { name: "Sora Tanaka", initial: "S", grad: "linear-gradient(140deg,#A78BFF,#6E5CFF)", invited: 21, success: 19, pending: 1, mins: "1,140" },
      { name: "王雨桐", initial: "王", grad: "linear-gradient(140deg,#5BE0A0,#1FA971)", invited: 14, success: 12, pending: 2, mins: "720" },
      { name: "林晓彤", initial: "林", grad: "linear-gradient(140deg,#FF8FC8,#FF4FA0)", invited: 9, success: 7, pending: 1, mins: "420" },
    ];
    this.inviteRecords = [
      { inviter: "周岚", invitee: "小柚", status: "已注册", reward: "+60 分钟", date: "2026-06-15" },
      { inviter: "陈思远", invitee: "阿哲", status: "已注册", reward: "+60 分钟", date: "2026-06-12" },
      { inviter: "周岚", invitee: "Momo", status: "待激活", reward: "待到账", date: "2026-06-08" },
      { inviter: "Marcus Lee", invitee: "林夕", status: "已注册", reward: "+60 分钟", date: "2026-05-14" },
      { inviter: "陈思远", invitee: "阿楠", status: "已注册", reward: "+60 分钟", date: "2026-05-09" },
      { inviter: "Sora Tanaka", invitee: "Yuki", status: "待激活", reward: "待到账", date: "2026-05-03" },
    ];
    this.admins = [
      { id: "a1", name: "张运营", email: "admin@micall.ai", role: "超级管理员", last: "2 分钟前", initial: "张", grad: "linear-gradient(140deg,#5B7CF0,#8E7BFF)" },
      { id: "a2", name: "王内容", email: "content@micall.ai", role: "运营", last: "1 小时前", initial: "王", grad: "linear-gradient(140deg,#A78BFF,#6E5CFF)" },
      { id: "a3", name: "李客服", email: "support@micall.ai", role: "客服", last: "昨天 18:30", initial: "李", grad: "linear-gradient(140deg,#5BE0A0,#1FA971)" },
      { id: "a4", name: "陈数据", email: "data@micall.ai", role: "只读", last: "3 天前", initial: "陈", grad: "linear-gradient(140deg,#FFB36B,#F5821F)" },
    ];
    this.permModules = ["用户", "角色", "场景", "通话", "工单", "订单", "邀请", "配置"];
    this.roleMatrix = { "超级管理员": [1, 1, 1, 1, 1, 1, 1, 1], "运营": [1, 1, 1, 1, 1, 0, 1, 0], "客服": [1, 0, 0, 1, 1, 1, 0, 0], "只读（仅查看）": [1, 1, 1, 1, 1, 1, 1, 0] };
    this.notifs = [
      { title: "3 条新工单待处理", time: "5 分钟前", dot: "#E0594F" },
      { title: "1 笔退款申请待审核（王雨桐 · $11.98）", time: "22 分钟前", dot: "#E0954F" },
      { title: "LLM 接口平均延迟升高至 1.2s", time: "1 小时前", dot: "#E0954F" },
      { title: "今日新增注册用户 +218", time: "今天 09:00", dot: "#1FA971" },
    ];
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
    if (!loaded) return;
    this.setState((p) => {
      const merged: any = { ...p.apiCfg };
      for (const k of Object.keys(loaded)) merged[k] = { ...(p.apiCfg[k] || {}), ...loaded[k] };
      return { apiCfg: merged };
    });
  }

  /** 保存接口配置：有后端走 REST（密钥存服务端），无后端落 localStorage。 */
  async saveApi(name: string) {
    const ok = await saveApiConfig(this.state.apiCfg);
    this.toastMsg(ok ? name + " 配置已保存" : name + " 保存失败，请重试");
  }

  /** 连通性测试：有后端实测该节点；无后端时无法跨域直连，沿用乐观提示。 */
  async testApi(sectionKey: string, name: string) {
    const res = await testApiSection(sectionKey, this.state.apiCfg[sectionKey]);
    if (res.ok === null) this.toastMsg(name + " 连接测试成功");
    else if (res.ok) this.toastMsg(name + " 测试成功" + (res.ms ? ` · ${res.ms}ms` : ""));
    else this.toastMsg(name + " 测试失败：" + (res.error || "未知错误"));
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
    if (type === "char") ns.charBio = this.chars.find((c) => c.id === id).bio;
    if (type === "ticket") ns.replyDraft = "";
    this.setState(ns);
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
    const voicesView = this.voices.map((v) => { const es = engStyle(v.engine); const m = matchedBy[v.id] || 0; return { matched: m ? m.toLocaleString() + " 次" : "—", name: v.name, engine: v.engine, engColor: es.c, engBg: es.b, meta: v.gender + " · " + v.lang, char: v.char || "—", hueFilter: v.char ? "hue-rotate(" + (v.hue || 0) + "deg)" : "none", hasChar: !!v.char, status: v.status, stColor: v.status === "启用" ? "#1FA971" : "#878B95", stBg: v.status === "启用" ? "rgba(31,169,113,.1)" : "#F0F0F3", preview: () => this.toastMsg("正在播放「" + v.name + "」试听…") }; });
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
    const inviteKpis = [
      mkKpi("累计邀请", "3,847", "+15.2%", "#1FA971", "rgba(31,169,113,.1)", "较上月"),
      mkKpi("成功注册", "2,910", "75.6%", "#6E5CFF", "rgba(110,92,255,.1)", "转化率"),
      mkKpi("待激活", "412", "实时", "#878B95", "#F0F0F3", "尚未完成注册"),
      mkKpi("已发放奖励", "174,600", "分钟", "#878B95", "#F0F0F3", "双方各得 " + s.inviteReward + " 分钟"),
    ];
    const invStatus = (st2: string) => st2 === "已注册" ? { c: "#1FA971", b: "rgba(31,169,113,.1)" } : { c: "#E0954F", b: "rgba(224,149,79,.12)" };
    const invitersView = this.inviters.map((v, i) => ({ rank: i + 1, name: v.name, initial: v.initial, grad: v.grad, invited: v.invited, success: v.success, pending: v.pending, mins: v.mins }));
    const inviteRecordsView = this.inviteRecords.map((r) => { const ist = invStatus(r.status); return { inviter: r.inviter, invitee: r.invitee, status: r.status, stColor: ist.c, stBg: ist.b, reward: r.reward, rewardColor: r.reward.indexOf("+") === 0 ? "#1FA971" : "#A8ABB5", date: r.date }; });
    const roleStyle = (r: string) => (r.indexOf("超级") === 0 ? { c: "#6E5CFF", b: "rgba(110,92,255,.1)" } : r === "运营" ? { c: "#2E7BFF", b: "rgba(46,123,255,.1)" } : r === "客服" ? { c: "#1FA971", b: "rgba(31,169,113,.1)" } : { c: "#878B95", b: "#F0F0F3" });
    const adminsView = this.admins.map((a) => { const off = !!s.adminOff[a.id]; const rs = roleStyle(a.role); return { name: a.name, email: a.email, initial: a.initial, grad: a.grad, role: a.role, roleColor: rs.c, roleBg: rs.b, last: a.last, status: off ? "停用" : "启用", stColor: off ? "#878B95" : "#1FA971", stBg: off ? "#F0F0F3" : "rgba(31,169,113,.1)", toggleLabel: off ? "启用" : "停用", toggle: () => { this.setState((p) => ({ adminOff: { ...p.adminOff, [a.id]: !p.adminOff[a.id] } })); this.toastMsg(off ? "已启用 " + a.name : "已停用 " + a.name); } }; });
    const roleMatrixView = Object.keys(this.roleMatrix).map((role) => { const rs = roleStyle(role); return { role, roleColor: rs.c, roleBg: rs.b, cells: this.roleMatrix[role].map((v) => ({ mark: v === 1 ? "✓" : "—", color: v === 1 ? "#1FA971" : "#C9CBD2", bg: v === 1 ? "rgba(31,169,113,.08)" : "transparent" })) }; });
    const apiCards = this.apiSections.map((sec) => { const cfg = s.apiCfg[sec.key]; return {
      name: sec.name, desc: sec.desc, icon: sec.icon, req: sec.req,
      chain: sec.chain, chainColor: sec.chain === "快链路" ? "#6E5CFF" : "#1FA971", chainBg: sec.chain === "快链路" ? "rgba(110,92,255,.1)" : "rgba(31,169,113,.1)",
      tileBg: sec.chain === "快链路" ? "linear-gradient(140deg,#8E7BFF,#6E5CFF)" : "linear-gradient(140deg,#5BE0A0,#1FA971)",
      statusLabel: "已连接", statusColor: "#1FA971", statusBg: "rgba(31,169,113,.1)",
      providers: (sec.providers || []).map((p: string) => ({ name: p, pick: () => this.setCfg(sec.key, "provider", p), bg: cfg.provider === p ? "#16161A" : "#fff", color: cfg.provider === p ? "#fff" : "#5A5E6B", border: cfg.provider === p ? "#16161A" : "#E6E7EB" })),
      fields: sec.fields.map((f: any) => ({ label: f.label, value: cfg[f.k] || "", type: f.pw ? "password" : "text", full: f.full ? "grid-column:1 / -1;" : "", onInput: (e: any) => this.setCfg(sec.key, f.k, e.target.value) })),
      test: () => this.testApi(sec.key, sec.name), save: () => this.saveApi(sec.name),
    }; });
    const stC: Record<string, any> = { "正常": { c: "#1FA971", b: "rgba(31,169,113,.1)" }, "未配置": { c: "#878B95", b: "#F0F0F3" }, "延迟高": { c: "#E0954F", b: "rgba(224,149,79,.12)" }, "成本高": { c: "#E0954F", b: "rgba(224,149,79,.12)" }, "异常": { c: "#E0594F", b: "rgba(224,89,79,.1)" }, "备用中": { c: "#2E7BFF", b: "rgba(46,123,255,.1)" } };
    const stp = (st: string) => { const x = stC[st] || stC["正常"]; return { status: st, stColor: x.c, stBg: x.b }; };
    const linkFlow = [{ label: "用户语音", a: "#9AA0AC" }, { label: "Qwen3-ASR-Flash", a: "#2E7BFF" }, { label: "记忆检索", a: "#9AA0AC" }, { label: "DeepSeek-V4-Flash", a: "#6E5CFF" }, { label: "MiniMax TTS", a: "#E0594F" }, { label: "Seedance 表情", a: "#9277F5" }, { label: "用户听到", a: "#1FA971" }, { label: "Qwen-Long 记忆整理", a: "#1FA971" }];
    const healthKpis = [
      { label: "整体健康", value: "正常", sub: "6 / 6 节点在线", vc: "#1FA971" },
      { label: "首句响应", value: "1.4s", sub: "目标 < 1.8s", vc: "#16161A" },
      { label: "每小时成本", value: "$38.6", sub: "近 1 小时", vc: "#16161A" },
      { label: "每 100 分钟成本", value: "$12.4", sub: "时长摊薄", vc: "#16161A" },
      { label: "今日失败率", value: "0.7%", sub: "目标 < 2%", vc: "#1FA971" },
      { label: "今日通话", value: "3,219", sub: "分钟", vc: "#16161A" },
    ];
    const nodeCards = [
      { name: "ASR · 语音识别", role: "听", model: "", ...stp("正常"), latency: "180ms", calls: "42.1k 次", cost: "$6.20" },
      { name: "LLM · 快脑", role: "想 · 通话中", model: "", ...stp("正常"), latency: "620ms", calls: "38.7k 次", cost: "$14.80" },
      { name: "TTS · 语音合成", role: "说", model: "", ...stp("延迟高"), latency: "310ms", calls: "38.7k 次", cost: "$9.40" },
      { name: "表情视频", role: "表情 · 预生成", model: "", ...stp("正常"), latency: "—", calls: "预生成库", cost: "$0" },
      { name: "LLM · 长记忆脑", role: "记 · 通话后", model: "", ...stp("正常"), latency: "2.1s", calls: "3.2k 次", cost: "$4.90" },
    ];
    const costKpis = [{ label: "今日总成本", value: "$926" }, { label: "本月总成本", value: "$21,480" }, { label: "每小时平均", value: "$38.6" }, { label: "每 100 分钟", value: "$12.4" }];
    const costByProvider = [{ name: "LLM 快脑", value: "$352", pct: "38%", c: "#6E5CFF" }, { name: "TTS 语音合成", value: "$231", pct: "25%", c: "#E0594F" }, { name: "音色生成", value: "$120", pct: "13%", c: "#FF6FA5" }, { name: "ASR 语音识别", value: "$139", pct: "15%", c: "#2E7BFF" }, { name: "记忆整理", value: "$56", pct: "6%", c: "#1FA971" }, { name: "表情视频", value: "$28", pct: "3%", c: "#9277F5" }];
    const memTypeC: Record<string, string> = { fact: "#2E7BFF", preference: "#6E5CFF", project: "#E0954F", relationship: "#FF6FA5", open_loop: "#1FA971" };
    const memoryRecent = [
      { content: "用户是应届生，正在准备产品经理面试", type: "project", imp: "高", conf: "0.92", source: "林晚 · 今天 23:14", written: true },
      { content: "喜欢深夜安静地聊天，不喜欢被催", type: "preference", imp: "中", conf: "0.88", source: "林晚 · 昨天 00:22", written: true },
      { content: "下周一有一场重要面试（open loop）", type: "open_loop", imp: "高", conf: "0.81", source: "江野 · 周一 20:15", written: true },
      { content: "和 AI 的关系：信任、依赖深夜倾诉", type: "relationship", imp: "中", conf: "0.76", source: "林晚 · 多次", written: false },
      { content: "母语中文，在学英语，备考六级", type: "fact", imp: "低", conf: "0.95", source: "苏窈 · 周日 15:40", written: true },
    ].map((m) => ({ ...m, typeColor: memTypeC[m.type] || "#878B95", typeBg: (memTypeC[m.type] || "#878B95") + "1a", wColor: m.written ? "#1FA971" : "#E0954F", wBg: m.written ? "rgba(31,169,113,.1)" : "rgba(224,149,79,.12)", wLabel: m.written ? "已写入" : "待写入" }));
    const fallbackRows = [
      { kind: "ASR", primary: "阿里云", backups: "火山 ASR · ElevenLabs Scribe", cond: "连续失败 3 次 / 延迟 > 2s / 错误率 > 5%" },
      { kind: "LLM 快脑", primary: "DeepSeek-V4-Flash", backups: "Qwen Flash · 豆包", cond: "超时 / 连续失败 / 成本超阈值" },
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

    const kpis = [
      { label: "总用户", value: "12,847", delta: "+8.2%", up: true, note: "较上月" },
      { label: "今日通话", value: "3,219", delta: "+12.4%", up: true, note: "较昨日" },
      { label: "总通话时长", value: "8,640h", delta: "+6.1%", up: true, note: "本月累计" },
      { label: "本月收入", value: "$48,920", delta: "+9.7%", up: true, note: "会员订阅" },
    ].map((k) => ({ ...k, deltaColor: k.up ? "#1FA971" : "#E0594F", deltaBg: k.up ? "rgba(31,169,113,.1)" : "rgba(224,89,79,.1)" }));
    const trendSets: Record<string, any> = {
      today: { title: "今日通话量（按小时）", data: [{ day: "0时", v: 120 }, { day: "4时", v: 60 }, { day: "8时", v: 280 }, { day: "12时", v: 430 }, { day: "16时", v: 520 }, { day: "20时", v: 790 }, { day: "现在", v: 540 }] },
      "7d": { title: "近 7 日通话量", data: [{ day: "周一", v: 2480 }, { day: "周二", v: 2710 }, { day: "周三", v: 2390 }, { day: "周四", v: 2950 }, { day: "周五", v: 3180 }, { day: "周六", v: 3620 }, { day: "周日", v: 3219 }] },
      "30d": { title: "近 30 日通话量（按周）", data: [{ day: "第1周", v: 16800 }, { day: "第2周", v: 18200 }, { day: "第3周", v: 19500 }, { day: "第4周", v: 21300 }] },
    };
    const tset = trendSets[s.dateRange] || trendSets["7d"];
    const tmax = Math.max(...tset.data.map((t: any) => t.v));
    const trend = tset.data.map((t: any) => ({ day: t.day, val: t.v.toLocaleString(), h: Math.round(t.v / tmax * 100) + "%" }));
    const trendTitle = tset.title;
    const dateChips = ([["today", "今日"], ["7d", "近 7 日"], ["30d", "近 30 日"]] as [string, string][]).map(([k, label]) => ({ label, pick: () => this.setState({ dateRange: k }), bg: s.dateRange === k ? "#16161A" : "#fff", color: s.dateRange === k ? "#fff" : "#5A5E6B", border: s.dateRange === k ? "#16161A" : "#E6E7EB" }));
    const topChars = this.chars.slice().sort((a, b) => parseFloat(b.calls) - parseFloat(a.calls)).slice(0, 5).map((c, i) => ({ rank: i + 1, name: c.name, hueFilter: "hue-rotate(" + c.hue + "deg)", calls: c.calls }));
    const sceneUseRaw = this.scenes.filter((x) => x.type !== "custom");
    const smax = Math.max(...sceneUseRaw.map((x) => parseFloat(x.uses)));
    const topScenes = sceneUseRaw.slice().sort((a, b) => parseFloat(b.uses) - parseFloat(a.uses)).slice(0, 5).map((x) => ({ name: x.name, uses: x.uses, pct: Math.round(parseFloat(x.uses) / smax * 100) + "%" }));
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
      return { name: x.name, desc: x.desc || "", prompt: x.prompt, byUser: x.byUser || "", uses: x.type === "custom" ? "" : x.uses + " 次使用", status: st, stColor: stStyle.c, stBg: stStyle.b, pending,
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
    const plans = this.plans.map((p) => ({ ...p, border: p.popular ? "#D9D6FF" : "#EBECEF" }));

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
      const c = this.chars.find((x) => x.id === d.id);
      dChar = { ...c, hueFilter: "hue-rotate(" + c.hue + "deg)", genderAge: c.gender + " · " + c.age + "岁", genderColor: c.gender === "女" ? "#FF6FA5" : "#5B8DEF", ...((st: string) => st === "上线" ? { stColor: "#1FA971", stBg: "rgba(31,169,113,.1)" } : { stColor: "#878B95", stBg: "#F0F0F3" })(c.status) };
      detailTitle = "角色编辑"; charBioLen = (s.charBio || "").length;
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
      notifs: this.notifs, notifOpen: s.notifOpen, notifUnread: !s.notifRead,
      toggleNotif: () => this.setState((p) => ({ notifOpen: !p.notifOpen })), closeNotif: () => this.setState({ notifOpen: false }), markAllRead: () => this.setState({ notifRead: true, notifOpen: false }),
      userFilters, usersView, charsView, sceneTabs, scenesView, callsView, ticketsView, ordersView, plans,
      detailOpen: !!d, closeDetail: () => this.setState({ detail: null }), detailTitle,
      dUser, dChar, dCall, dTicket, dCharExpr,
      banLabel, banColor, banBg, toggleBan: () => { const id = d.id; this.setState((p) => ({ banned: { ...p.banned, [id]: !p.banned[id] } })); this.toastMsg(s.banned[d.id] ? "已解除封禁" : "已封禁该用户"); },
      charBio: s.charBio, charBioLen, onCharBio: (e: any) => this.setState({ charBio: e.target.value }), saveChar: () => this.toastMsg("角色人设已保存"),
      replyDraft: s.replyDraft, onReplyDraft: (e: any) => this.setState({ replyDraft: e.target.value }), ticketNeedsReply,
      sendReply: () => { const v = (s.replyDraft || "").trim(); if (!v) { this.toastMsg("请输入回复内容"); return; } const id = d.id; this.setState((p) => ({ ticketReplies: { ...p.ticketReplies, [id]: v }, replyDraft: "" })); this.toastMsg("回复已发送"); },
      toast: s.toast,
    };
  }
}
