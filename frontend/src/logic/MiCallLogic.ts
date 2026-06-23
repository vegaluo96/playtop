// MiCallLogic — production port of the prototype's `class Component extends
// DCLogic` (prototype/AI Call.dc.html).
//
// Per docs/03-前端对接规格.md, the prototype is the single source of truth for
// the UI, so renderVals() and all non-realtime behaviour are ported verbatim.
// The ONLY substantive change is the call-flow: the prototype's setTimeout /
// setInterval mocks are replaced by server control-signaling (see signaling.ts).
//
// Mock-replacement checklist (spec §3):
//   • dial()'s 18% random failure …… deleted (call_failed only on real errors)
//   • setInterval front-end billing … deleted (server-authoritative billing)
//   • toListen/toThink/toSpeak fake台词 replay … deleted (subtitles from server)
//   • grantMic() … now performs a real getUserMedia({echoCancellation:true})
//   • scheduleOpen / incoming … already removed from the prototype
//
// scenarioDefs[].lines are kept ONLY as static design copy (they feed the
// character-detail "slogan"); they are never replayed as live dialogue.

import {
  createSignaling,
  type ClientMessage,
  type ServerEvent,
  type SignalingClient,
} from "./signaling";
import { AudioPlayer, MicCapture } from "./audio";
import * as authApi from "./authService";
import type { Vals } from "../dc/resolve";

export interface MiCallProps {
  theme?: "light" | "dark";
  orbColor?: string;
  aiName?: string;
}

type State = Record<string, any>;
type Timer = ReturnType<typeof setTimeout>;

interface Char {
  name: string;
  hue: number;
  desc: string;
  traits: string[];
  bio: string;
  id?: string; // 出厂角色对应后端 spec 的 character_id（asset-pipeline/characters/*.json）；省略则回退 "c"+idx
}
interface ScenarioDef {
  key: string;
  name: string;
  desc: string;
  prompt: string;
  tile: string;
  icon: string;
  lines: string[];
}

export class MiCallLogic {
  props: MiCallProps;
  /** Called by setState to ask the React host to re-render. */
  private notify: () => void = () => {};

  // ── instance data (ported verbatim) ──────────────────────────────────────
  chars: Char[] = [
    { name: "林晚", hue: 0, desc: "温柔的深夜倾听者", traits: ["温柔", "耐心", "共情"], bio: "深夜电台主播出身，习惯在安静里听人把话说完。不急着给建议，也不评判——只是陪着你。", id: "lin_wan" },
    { name: "江野", hue: 135, desc: "理性可靠的陪伴", traits: ["理性", "冷静", "务实"], bio: "话不多，但每句都在点上。适合在你思绪乱成一团时，帮你一条条理清楚。", id: "jiang_ye" },
    { name: "夏鸣", hue: 60, desc: "元气满满的朋友", traits: ["元气", "幽默", "直率"], bio: "走到哪儿都自带阳光，三两句就能把气氛点亮。心情低落时，找他准没错。", id: "xia_ming" },
    { name: "顾辞", hue: 225, desc: "沉静睿智的对话者", traits: ["沉静", "睿智", "文艺"], bio: "读过很多书，喜欢慢慢聊。和他说话，像在深夜翻开一本旧书。", id: "gu_ci" },
    { name: "苏窈", hue: 300, desc: "俏皮灵动的伙伴", traits: ["俏皮", "灵动", "好奇"], bio: "鬼马精灵，脑洞奇大。跟她聊天，你永远猜不到她下一句会说什么。", id: "su_yao" },
  ];
  private _charsBuilt = false;
  private _scenesBuilt = false;

  buildChars() {
    // 上线只保留 5 个真出厂角色（林晚/江野/夏鸣/顾辞/苏窈，spec 在 asset-pipeline/characters）。
    // 之前为撑满目录生成的占位角色已移除——不上线假角色。新角色做好 spec 后加进上面的 chars 即可。
  }

  state: State = { phase: "idle", seconds: 0, subtitle: "", theme: null, textMode: false, lines: [], scenario: null, scenarioOpen: false, mute: false, speaker: false, lang: "中文", langOpen: false, charIndex: 0, charOpen: false, charDetailOpen: false, rating: 0, feedback: [], menuOpen: false, favorites: [], favOpen: false, rechargeOpen: false, redeemCode: "", historyOpen: false, pendingSwitch: null, note: "", charTab: "rec", billing: "month", inviteOpen: false, billsOpen: false, sceneTab: "rec", customScene: null, customSceneText: "", expandedScene: null, customHistory: ["陪我练习模拟面试", "假装我们在咖啡馆", "用轻松的语气聊聊天"], settingsOpen: false, setSound: true, setVibrate: true, setSubtitle: false, toast: "", resetOpen: false, moreOpen: false, loggedIn: false, authOpen: false, authMode: "register", authEmail: "", authPw: "", regPromptShown: false, regPromptDismissed: false, pwResetOpen: false, newPw1: "", newPw2: "", genVoicesByChar: {}, pendingVoiceDel: null, cookieOpen: false, privacyOpen: false, termsOpen: false, logoutConfirmOpen: false, contactOpen: false, contactType: "建议反馈", contactMsg: "", fontScale: 0, tickets: [{ type: "功能异常", msg: "通话偶尔会有杂音", date: "2026-06-19", status: "已回复", reply: "已优化降噪,请更新到最新版试试,给你补了 30 分钟时长~" }], voiceByChar: {}, voiceCustomOpen: false, voiceCustomText: "", lowWarned: false, micGranted: false, permOpen: false, callFailed: false, remaining: 720, outOfMins: false, searchQ: "", previewing: null, showGuide: false, emotion: "idle" };

  t: Timer[] = [];
  i = 0;

  // realtime resources
  private sig: SignalingClient | null = null;
  private micStream: MediaStream | null = null;
  private micCapture: MicCapture | null = null;  // 麦克风 → 上行 PCM 帧
  private player = new AudioPlayer();             // 下行 TTS PCM → 播放

  bills = [
    { type: "sub", title: "畅聊会员 · 月付", date: "2026-06-18", amount: "-$9.99", mins: "+1500 分钟" },
    { type: "call", title: "通话消费 · 林晚", date: "2026-06-18 23:14", amount: "", mins: "-12 分钟" },
    { type: "call", title: "通话消费 · 夏鸣", date: "2026-06-17 19:02", amount: "", mins: "-4 分钟" },
    { type: "invite", title: "邀请奖励 · 好友注册", date: "2026-06-15", amount: "", mins: "+60 分钟" },
    { type: "call", title: "通话消费 · 顾辞", date: "2026-06-14 21:35", amount: "", mins: "-9 分钟" },
    { type: "call", title: "通话消费 · 苏窈", date: "2026-06-14 12:08", amount: "", mins: "-7 分钟" },
    { type: "call", title: "通话消费 · 林晚", date: "2026-06-13 23:40", amount: "", mins: "-18 分钟" },
    { type: "invite", title: "邀请奖励 · 好友注册", date: "2026-06-12", amount: "", mins: "+60 分钟" },
    { type: "call", title: "通话消费 · 江野", date: "2026-06-11 20:15", amount: "", mins: "-5 分钟" },
    { type: "call", title: "通话消费 · 夏鸣", date: "2026-06-10 18:30", amount: "", mins: "-11 分钟" },
    { type: "call", title: "通话消费 · 顾辞", date: "2026-06-09 22:02", amount: "", mins: "-6 分钟" },
    { type: "sub", title: "轻享会员 · 月付", date: "2026-05-18", amount: "-$4.99", mins: "+300 分钟" },
    { type: "call", title: "通话消费 · 林晚", date: "2026-05-17 23:55", amount: "", mins: "-22 分钟" },
    { type: "call", title: "通话消费 · 苏窈", date: "2026-05-16 13:20", amount: "", mins: "-8 分钟" },
    { type: "invite", title: "邀请奖励 · 好友注册", date: "2026-05-14", amount: "", mins: "+60 分钟" },
    { type: "call", title: "通话消费 · 江野", date: "2026-05-13 19:48", amount: "", mins: "-3 分钟" },
    { type: "call", title: "通话消费 · 夏鸣", date: "2026-05-12 21:10", amount: "", mins: "-14 分钟" },
    { type: "call", title: "通话消费 · 顾辞", date: "2026-05-11 22:33", amount: "", mins: "-9 分钟" },
    { type: "call", title: "通话消费 · 林晚", date: "2026-05-10 23:18", amount: "", mins: "-16 分钟" },
    { type: "invite", title: "邀请奖励 · 好友注册", date: "2026-05-08", amount: "", mins: "+60 分钟" },
  ];

  invites = [
    { name: "小柚", date: "2026-06-15", status: "已注册", reward: "+60 分钟" },
    { name: "阿哲", date: "2026-06-12", status: "已注册", reward: "+60 分钟" },
    { name: "Momo", date: "2026-06-08", status: "待激活", reward: "待到账" },
    { name: "林夕", date: "2026-05-14", status: "已注册", reward: "+60 分钟" },
  ];

  history = [
    { name: "林晚", hue: 0, idx: 0, sceneKey: "heart", scene: "心情树洞", dur: "12:08", when: "今天 23:14" },
    { name: "夏鸣", hue: 60, idx: 2, sceneKey: "chat", scene: "随便聊聊", dur: "04:21", when: "今天 12:30" },
    { name: "顾辞", hue: 225, idx: 3, sceneKey: "idiom", scene: "成语接龙", dur: "08:47", when: "昨天 21:35" },
    { name: "苏窈", hue: 300, idx: 4, sceneKey: "chat", scene: "随便聊聊", dur: "03:12", when: "昨天 13:08" },
    { name: "林晚", hue: 0, idx: 0, sceneKey: "heart", scene: "心情树洞", dur: "18:40", when: "昨天 00:22" },
    { name: "江野", hue: 135, idx: 1, sceneKey: "interview", scene: "模拟面试", dur: "15:03", when: "周一 20:15" },
    { name: "夏鸣", hue: 60, idx: 2, sceneKey: "sc0", scene: "睡前故事", dur: "06:55", when: "周一 23:50" },
    { name: "顾辞", hue: 225, idx: 3, sceneKey: "chat", scene: "随便聊聊", dur: "09:18", when: "周日 22:02" },
    { name: "苏窈", hue: 300, idx: 4, sceneKey: "english", scene: "英语陪练", dur: "11:27", when: "周日 15:40" },
    { name: "林晚", hue: 0, idx: 0, sceneKey: "heart", scene: "心情树洞", dur: "22:14", when: "周六 23:58" },
    { name: "江野", hue: 135, idx: 1, sceneKey: "chat", scene: "随便聊聊", dur: "05:46", when: "周五 19:30" },
    { name: "顾辞", hue: 225, idx: 3, sceneKey: "idiom", scene: "成语接龙", dur: "07:33", when: "周四 21:12" },
  ];

  // scenarioDefs[].lines: static design copy only (slogan source); NOT replayed.
  scenarioDefs: ScenarioDef[] = [
    { key: "chat", name: "随便聊聊", desc: "想到什么说什么", prompt: "现在是轻松的闲聊时间。请用自然随意的语气和我聊天，话题不限，可以从今天发生的小事聊起。多倾听、多回应，不用急着给建议，让对话像老朋友一样轻松地流动起来。", tile: "linear-gradient(145deg,#7AA8FF,#5B7CF0)", icon: "M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z", lines: ["嗯，我在听。", "今天过得怎么样？", "别急，慢慢说。", "我懂，那一定挺累的。"] },
    { key: "heart", name: "心情树洞", desc: "我会认真听你说", prompt: "我可能心情不太好，需要找人倾诉。请你耐心倾听，不评判也不说教，多共情、多接纳我的情绪，用温柔平静的语气陪着我，在合适的时候轻轻安慰，让我感到被理解。", tile: "linear-gradient(145deg,#FF8FA8,#F56A8C)", icon: "M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z", lines: ["我在听，慢慢说。", "没关系，我陪着你。", "今天真的辛苦了。", "把心里的话说出来吧。"] },
    { key: "interview", name: "模拟面试", desc: "我陪你一起准备", prompt: "请扮演一位专业又友善的面试官，围绕我的经历依次提问，包括自我介绍、项目细节和应对挑战的方式。每次只问一个问题，听完我的回答后给一句简短反馈，帮我从容准备。", tile: "linear-gradient(145deg,#B79CFF,#9277F5)", icon: "M20 7h-4V5l-2-2h-4L8 5v2H4c-1.1 0-2 .9-2 2v11c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V9c0-1.1-.9-2-2-2zm-6 0h-4V5h4v2z", lines: ["先做个自我介绍吧。", "可以具体讲讲那个项目吗？", "遇到困难时你会怎么处理？", "不错，逻辑很清晰。"] },
    { key: "english", name: "英语陪练", desc: "快和我用英语聊吧", prompt: "Let's practice English together. Speak naturally but slowly, ask me simple follow-up questions, gently correct only my bigger mistakes, and keep the tone warm so I feel relaxed speaking.", tile: "linear-gradient(145deg,#5FD6C6,#2FB8A8)", icon: "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm6.93 6h-2.95a15.65 15.65 0 0 0-1.38-3.56A8.03 8.03 0 0 1 18.92 8zM12 4.04c.83 1.2 1.48 2.53 1.91 3.96h-3.82c.43-1.43 1.08-2.76 1.91-3.96zM4.26 14a7.96 7.96 0 0 1 0-4h3.38a16.5 16.5 0 0 0 0 4H4.26zm.82 2h2.95c.32 1.25.78 2.45 1.38 3.56A7.99 7.99 0 0 1 5.08 16zm2.95-8H5.08a7.99 7.99 0 0 1 4.33-3.56A15.65 15.65 0 0 0 8.03 8zM12 19.96c-.83-1.2-1.48-2.53-1.91-3.96h3.82c-.43 1.43-1.08 2.76-1.91 3.96zM14.34 14H9.66a14.7 14.7 0 0 1 0-4h4.68a14.7 14.7 0 0 1 0 4zm.25 5.56c.6-1.11 1.06-2.31 1.38-3.56h2.95a7.99 7.99 0 0 1-4.33 3.56zM16.36 14a16.5 16.5 0 0 0 0-4h3.38a7.96 7.96 0 0 1 0 4h-3.38z", lines: ["Tell me about your day.", "Nice! How did that feel?", "Let's try that again, slowly.", "Great, that sounds natural."] },
    { key: "idiom", name: "成语接龙", desc: "测试你的成语储备", prompt: "我们来玩成语接龙。你先说一个四字成语，我用它的最后一个字开头接下一个，轮流进行。如果我卡住了给我一点提示，遇到生僻成语时简单解释一下意思，让整个游戏轻松又有趣。", tile: "linear-gradient(145deg,#FFC061,#F5A623)", icon: "M18 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zM6 4h5v8l-2.5-1.5L6 12V4z", lines: ["一心一意。", "意气风发。", "风和日丽，该你了。", "丽质天成，继续。"] },
  ];

  buildScenarios() {
    const tiles = ["linear-gradient(145deg,#7AA8FF,#5B7CF0)", "linear-gradient(145deg,#FF8FA8,#F56A8C)", "linear-gradient(145deg,#B79CFF,#9277F5)", "linear-gradient(145deg,#5FD6C6,#2FB8A8)", "linear-gradient(145deg,#FFC061,#F5A623)", "linear-gradient(145deg,#8FD3FF,#5BA8F0)"];
    const icons = ["M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z", "M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z", "M18 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zM6 4h5v8l-2.5-1.5L6 12V4z", "M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3zM19 11a7 7 0 0 1-14 0M12 18v3"];
    const items = [
      ["睡前故事", "伴你慢慢入睡"], ["解压冥想", "一起深呼吸放松"], ["哄睡晚安", "轻声陪你入眠"], ["早安叫醒", "元气满满开启一天"], ["情感倾诉", "说说你的心事"], ["学习监督", "陪你专注一小时"], ["旅行规划", "聊聊下一趟去哪"], ["美食推荐", "今天吃点什么好"], ["历史漫谈", "听段有趣的过往"], ["哲学夜谈", "深夜聊聊人生"], ["诗词鉴赏", "读一首给你听"], ["职场吐槽", "下班来吐吐槽"], ["恋爱模拟", "体验一段心动"], ["方言练习", "换个口音聊聊"], ["辩论练习", "来场观点交锋"], ["脱口秀", "听个段子乐一乐"], ["星座运势", "今天的你怎么样"], ["读书分享", "聊聊最近在读的"], ["育儿陪聊", "带娃路上不孤单"], ["减压陪伴", "卸下今天的疲惫"]];
    const lines = ["嗯，我在听。", "慢慢说，不着急。", "我懂你的意思。", "那我们继续聊聊吧。"];
    const out: ScenarioDef[] = items.map((it, i) => ({ key: "sc" + i, name: it[0], desc: it[1], tile: tiles[i % tiles.length], icon: icons[i % icons.length], lines, prompt: "请进入「" + it[0] + "」的情境和我聊天：" + it[1] + "。用贴合这个场景的语气自然地回应，多关注我的感受和节奏，让整段对话沉浸、舒服，像我们真的身处其中一样陪着我。" }));
    this.scenarioDefs = [...this.scenarioDefs, ...out];
  }

  constructor(props: MiCallProps) {
    this.props = props || {};
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

  componentDidMount() {
    let seen = false, cookie = false;
    try {
      seen = localStorage.getItem("micall_seen_guide") === "1";
      cookie = localStorage.getItem("micall_cookie_ok") === "1";
    } catch (e) { /* noop */ }
    this.setState({ showGuide: !seen, cookieOpen: !cookie });
    this.restoreSession();   // 用存的 token 恢复登录态 + 真实余额（接了后端才生效）
  }

  /** 刷新后凭 localStorage 的 token 向后端核验登录态，拉回邮箱与真实余额。 */
  private async restoreSession() {
    if (!authApi.authConfigured()) return;
    try {
      const u = await authApi.me();
      if (u) this.setState({ loggedIn: true, authEmail: u.email, remaining: u.remaining_seconds });
    } catch { /* 离线/后端不可达：维持游客态 */ }
  }

  /** 登录态变化后丢弃旧信令连接，下一通电话用新 token（或匿名）重连。仅在空闲时重置。 */
  private resetSignaling() {
    if (this.state.phase === "idle" && this.sig) {
      try { this.sig.close(); } catch { /* noop */ }
      this.sig = null;
    }
  }

  // ── 通话历史 / 账单：登录用户拉真实数据，未登录/未接后端退回演示数据 ──
  private realHistory: any[] | null = null;   // null = 用演示 this.history
  private realBills: any[] | null = null;     // null = 用演示 this.bills
  private realTickets: any[] | null = null;   // null = 用演示 state.tickets

  private async loadTickets() {
    if (!authApi.authConfigured() || !this.state.loggedIn) { this.realTickets = null; return; }
    const tk = await authApi.getTickets();
    if (!tk) { this.realTickets = []; this.notify(); return; }
    this.realTickets = tk.map((t) => ({
      type: t.type, msg: t.message, date: this.fmtWhen(t.created_at),
      status: t.status === "replied" ? "已回复" : "处理中", reply: t.reply || "",
    }));
    this.notify();
  }

  private idxForCharId(cid: string): number {
    const i = this.chars.findIndex((c) => c.id === cid);
    return i >= 0 ? i : 0;
  }
  private sceneNameOf(key: string): string {
    return this.scenarioDefs.find((d) => d.key === key)?.name || "随便聊聊";
  }
  private fmtDur(sec: number): string {
    const s = Math.max(0, Math.floor(sec));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  }
  private fmtWhen(iso: string): string {
    const d = new Date(iso);
    if (isNaN(+d)) return "";
    const hh = String(d.getHours()).padStart(2, "0"), mm = String(d.getMinutes()).padStart(2, "0");
    const day0 = (x: Date) => +new Date(x.getFullYear(), x.getMonth(), x.getDate());
    const diff = Math.round((day0(new Date()) - day0(d)) / 86400000);
    if (diff === 0) return `今天 ${hh}:${mm}`;
    if (diff === 1) return `昨天 ${hh}:${mm}`;
    return `${d.getMonth() + 1}月${d.getDate()}日 ${hh}:${mm}`;
  }

  private async loadHistory() {
    if (!authApi.authConfigured() || !this.state.loggedIn) { this.realHistory = null; return; }
    const calls = await authApi.getCalls();
    if (!calls) { this.realHistory = []; this.notify(); return; }
    this.realHistory = calls.map((c) => {
      const idx = this.idxForCharId(c.character_id), ch = this.chars[idx];
      return { name: ch?.name || "TA", hue: ch?.hue ?? 0, idx, sceneKey: c.scenario || "chat",
               scene: this.sceneNameOf(c.scenario), dur: this.fmtDur(c.duration_seconds || 0),
               when: this.fmtWhen(c.started_at) };
    });
    this.notify();
  }
  /** 核销兑换码 → 后端入账，更新余额。未登录先引导登录；未接后端给演示提示。 */
  private async doRedeem() {
    const code = (this.state.redeemCode || "").trim();
    if (!code) { this.toast("请输入兑换码"); return; }
    if (!authApi.authConfigured()) { this.toast("演示模式：接入后端后兑换码即可生效"); return; }
    if (!this.state.loggedIn) { this.setState({ rechargeOpen: false, authOpen: true, authMode: "login", toast: "请先登录再兑换" }); return; }
    this.setState({ toast: "兑换中…" });
    const res = await authApi.redeem(code);
    if (!res.ok) { this.toast(res.error || "兑换失败"); return; }
    this.setState({ redeemCode: "", rechargeOpen: false,
      remaining: res.remaining_seconds ?? this.state.remaining,
      outOfMins: (res.remaining_seconds ?? 1) <= 0 ? this.state.outOfMins : false,
      toast: res.message || "充值成功" });
    this.t.push(setTimeout(() => this.setState({ toast: "" }), 2200));
  }
  private toast(msg: string) { this.setState({ toast: msg }); this.t.push(setTimeout(() => this.setState({ toast: "" }), 2000)); }

  private async loadBills() {
    if (!authApi.authConfigured() || !this.state.loggedIn) { this.realBills = null; return; }
    const bills = await authApi.getBills();
    if (!bills) { this.realBills = []; this.notify(); return; }
    const TITLE: Record<string, string> = { call: "通话消费", recharge: "充值", invite_reward: "邀请奖励", register_gift: "注册赠送" };
    const TYPE = (r: string) => r === "invite_reward" ? "invite" : (r === "recharge" || r === "register_gift") ? "sub" : "call";
    this.realBills = bills.map((b) => {
      const sec = b.delta_seconds || 0, mins = Math.round(Math.abs(sec) / 60);
      return { type: TYPE(b.reason), title: TITLE[b.reason] || b.reason, date: this.fmtWhen(b.created_at),
               amount: "", mins: (sec >= 0 ? "+" : "-") + (mins >= 1 ? `${mins} 分钟` : `${Math.abs(sec)} 秒`) };
    });
    this.notify();
  }
  componentWillUnmount() {
    this.clearTimers();
    this.stopMic();
    if (this.sig) { this.sig.close(); this.sig = null; }
  }
  acceptCookie() {
    try { localStorage.setItem("micall_cookie_ok", "1"); } catch (e) { /* noop */ }
    this.setState({ cookieOpen: false });
  }
  dismissGuide() {
    try { localStorage.setItem("micall_seen_guide", "1"); } catch (e) { /* noop */ }
    this.setState({ showGuide: false });
  }

  profileOf(idx: number) {
    const c = this.chars[idx];
    const genders = ["女", "男", "女", "男", "女"];
    const gender = genders[idx % genders.length];
    const tagPool = ["治愈系", "深夜", "倾听", "陪伴", "温柔", "理性", "元气", "文艺", "俏皮", "知性", "邻家", "成熟", "腹黑", "高冷", "暖男", "御姐", "学长", "学妹", "病娇", "天然呆"];
    const likePool = ["安静的深夜", "认真听你说话", "下雨天", "一杯热可可", "你今天的好心情", "老电影", "散步", "手写信"];
    const dislikePool = ["被敷衍", "嘈杂的人群", "冷场", "被打断", "敷衍的回答", "深夜的孤独", "争吵"];
    const nats = ["中国", "日本", "美国", "英国", "法国", "韩国"];
    const races = ["东亚人", "欧裔", "混血", "东亚人"];
    const pick = (arr: string[], n: number, seed: number) => { const out: string[] = []; for (let k = 0; k < n; k++) out.push(arr[(seed * 7 + k * 13 + idx * 5) % arr.length]); return [...new Set(out)]; };
    return {
      gender,
      genderColor: gender === "女" ? "#FF6FA5" : "#5B8DEF",
      age: 18 + (idx * 3) % 13,
      height: 156 + (idx * 5) % 30,
      weight: 44 + (idx * 3) % 22,
      birthday: (2006 - (idx % 12)) + "年" + (1 + idx % 12) + "月" + (1 + (idx * 7) % 27) + "日",
      nationality: nats[idx % nats.length],
      race: races[idx % races.length],
      nickname: c.name,
      tags: pick(tagPool, 4, idx + 1),
      slogan: (this.scenarioDefs[idx % 5] && this.scenarioDefs[idx % 5].lines[0]) || "嗯……你好。",
      likes: pick(likePool, 5, idx + 2).join("、"),
      dislikes: pick(dislikePool, 4, idx + 3).join("、"),
      personality: (c.traits || []).join("、"),
    };
  }

  toggleFeedback(tag: string) {
    this.setState((s) => ({ feedback: s.feedback.includes(tag) ? s.feedback.filter((x: string) => x !== tag) : [...s.feedback, tag] }));
  }
  selectScenario(key: string) {
    this.setState({ scenario: key, scenarioOpen: false });
    if (this.isConnected()) this.send({ type: "set_scene", scene: key });
  }
  selectLang(l: string) { this.setState({ lang: l, langOpen: false }); }
  selectChar(i: number) { this.setState({ charIndex: i, charOpen: false }); }

  clearTimers() { (this.t || []).forEach(clearTimeout); this.t = []; }

  fmt(s: number) {
    const m = Math.floor(s / 60), r = s % 60;
    return String(m).padStart(2, "0") + ":" + String(r).padStart(2, "0");
  }
  hexA(hex: string, a: number) {
    const h = (hex || "#AAB8FF").replace("#", "");
    const n = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
    const r = parseInt(n.slice(0, 2), 16), g = parseInt(n.slice(2, 4), 16), b = parseInt(n.slice(4, 6), 16);
    return `rgba(${r},${g},${b},${a})`;
  }
  sheets() {
    return { favOpen: false, langOpen: false, settingsOpen: false, charDetailOpen: false, charOpen: false, scenarioOpen: false, billsOpen: false, inviteOpen: false, rechargeOpen: false, historyOpen: false, contactOpen: false, termsOpen: false, privacyOpen: false, moreOpen: false, authOpen: false, pwResetOpen: false };
  }

  // ── 手势驱动（侧栏滑入/滑出、底部弹窗下滑关闭）；纯 state 操作，零视觉/DOM 改动 ──
  // 供 useGestures 在 touchend 判定后调用，等价于点击对应的开/关，复用既有 setState 语义。
  gestureSnapshot() {
    const s = this.state;
    const sheetOpen =
      s.favOpen || s.langOpen || s.settingsOpen || s.charDetailOpen || s.charOpen ||
      s.scenarioOpen || s.billsOpen || s.inviteOpen || s.rechargeOpen || s.contactOpen ||
      s.termsOpen || s.privacyOpen || s.moreOpen || s.authOpen || s.pwResetOpen;
    // 中心模态/对话框（权限、呼叫失败、时长耗尽、切换确认、删除确认…）期间不接管手势。
    const modal =
      s.permOpen || s.callFailed || s.outOfMins || s.pendingSwitch || s.pendingVoiceDel ||
      s.logoutConfirmOpen || s.resetOpen;
    return { menuOpen: !!s.menuOpen, historyOpen: !!s.historyOpen, sheetOpen: !!sheetOpen, modal: !!modal };
  }
  openMenu() { if (!this.state.menuOpen) this.setState({ menuOpen: true, historyOpen: false }); }
  openHistory() { if (!this.state.historyOpen) { this.setState({ historyOpen: true, menuOpen: false }); this.loadHistory(); } }
  closeMenu() { if (this.state.menuOpen) this.setState({ menuOpen: false }); }
  closeHistory() { if (this.state.historyOpen) this.setState({ historyOpen: false }); }
  closeTopSheet() { this.setState(this.sheets()); }

  // ── realtime call flow (signaling-driven) ─────────────────────────────────
  private isConnected() {
    return ["listening", "thinking", "speaking"].includes(this.state.phase);
  }
  private characterId(idx: number) { return this.chars[idx]?.id ?? "c" + idx; }
  private currentScenarioKey() { return this.state.scenario || "chat"; }

  private ensureSignaling(): SignalingClient {
    if (!this.sig) {
      this.sig = createSignaling(
        (ev) => this.onServerEvent(ev),
        (frame) => this.player.play(frame), // 下行 TTS PCM → 播放
      );
    }
    return this.sig;
  }

  /** 通话接通后启动麦克风上行：每帧 PCM 经信令二进制帧发给后端 ASR。 */
  private startMicUplink() {
    if (this.micCapture || !this.micStream) return;
    const sig = this.ensureSignaling();
    this.micCapture = new MicCapture(this.micStream, (pcm) => {
      if (!this.state.mute) sig.sendAudio(pcm); // 静音时不上行（本地也已禁用音轨）
    });
    try { this.micCapture.start(); } catch { /* 不支持音频采集时静默降级 */ }
  }
  private stopMicUplink() {
    this.micCapture?.stop();
    this.micCapture = null;
  }
  private send(msg: ClientMessage) { this.ensureSignaling().send(msg); }

  private usingMockSignaling(): boolean {
    return !(import.meta.env?.VITE_SIGNALING_URL && import.meta.env.VITE_SIGNALING_URL.trim());
  }

  /** Acquire the microphone (AEC on — defends against echo-triggered false
   *  interrupts, 后端规格 §1.1). Idempotent: reuses an existing stream. */
  private async acquireMic(): Promise<boolean> {
    if (this.micStream) return true;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        // AEC 抑回声（防回声误打断）；NS 抑噪、AGC 归一化音量 → 上行 VAD 阈值更稳、AI 说话期麦克风近静音不上行省 ASR。
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      this.micStream = stream;
      this.applyMuteToTracks();
      return true;
    } catch {
      return false;
    }
  }

  startCall() {
    if (this.state.phase !== "idle") return;
    if (!this.state.micGranted) { this.setState({ permOpen: true }); return; }
    void this.beginCall();
  }

  async grantMic() {
    const ok = await this.acquireMic();
    if (ok) {
      this.setState({ micGranted: true, permOpen: false });
      void this.beginCall();
    } else if (this.usingMockSignaling()) {
      // Permission denied / no device — let the mock demo proceed anyway.
      this.setState({ micGranted: true, permOpen: false });
      void this.beginCall();
    } else {
      this.setState({ permOpen: false, toast: "需要麦克风权限才能通话" });
      this.t.push(setTimeout(() => this.setState({ toast: "" }), 2200));
    }
  }

  private async beginCall() {
    this.clearTimers();
    // (Re)acquire the mic for this call. Permission persists once granted, so
    // re-acquiring after a previous hang-up is silent (no prompt).
    if (this.state.micGranted && !this.micStream) await this.acquireMic();
    this.player.resume(); // 必须在点接听的手势链里，iOS 才允许出声
    this.setState({ phase: "calling", callFailed: false, lowWarned: false });
    const msg: ClientMessage = { type: "start_call", character_id: this.characterId(this.state.charIndex), scenario: this.currentScenarioKey() };
    this.send(msg);
    if (this.state.scenario === "__custom" && this.state.customScene) {
      this.send({ type: "set_scene", scene: this.state.customScene });
    }
  }

  retryDial() { this.setState({ callFailed: false }); void this.beginCall(); }

  endCall() {
    this.clearTimers();
    if (this.isConnected() || this.state.phase === "calling") this.send({ type: "end_call" });
    this.stopMic(); // release the microphone on hang-up (turns off the mic indicator)
    this.setState({ phase: "ended", textMode: false, rating: 0, feedback: [] });
  }

  switchTo(idx: number, sceneKey: string) {
    if (this.isConnected()) { this.setState({ pendingSwitch: { idx, sceneKey }, historyOpen: false }); return; }
    this.setState({ charIndex: idx, scenario: sceneKey, historyOpen: false });
  }
  confirmSwitch() {
    const ps = this.state.pendingSwitch;
    this.clearTimers();
    if (this.isConnected() || this.state.phase === "calling") this.send({ type: "end_call" });
    this.stopMic();
    this.setState({ phase: "idle", seconds: 0, subtitle: "", lines: [], mute: false, speaker: false, textMode: false, charIndex: ps.idx, scenario: ps.sceneKey, pendingSwitch: null });
  }
  resetIdle() {
    this.clearTimers();
    this.stopMic();
    this.setState({ phase: "idle", seconds: 0, subtitle: "", lines: [], mute: false, speaker: false, textMode: false, rating: 0, feedback: [], note: "" });
  }

  private applyMuteToTracks() {
    if (!this.micStream) return;
    const enabled = !this.state.mute;
    this.micStream.getAudioTracks().forEach((tr) => { tr.enabled = enabled; });
  }
  private stopMic() {
    this.stopMicUplink();
    this.player.flush(); // 挂断/失败：停掉残留下行音频
    if (this.micStream) { this.micStream.getTracks().forEach((tr) => tr.stop()); this.micStream = null; }
  }

  /** Map server control events → state (docs/03 §4). */
  private onServerEvent(ev: ServerEvent) {
    switch (ev.type) {
      case "connected":
        this.setState({ phase: "listening", seconds: 0, subtitle: "", lines: [], callFailed: false });
        this.startMicUplink(); // 接通即开始上行麦克风音频
        break;
      case "state":
        // 仅 AI 说话期启用上行门控（省 ASR、抑回声）；其余回合全量上行不切用户说话。
        this.micCapture?.setAiSpeaking(ev.phase === "speaking");
        this.setState({ phase: ev.phase });
        break;
      case "interrupted":
        // speaking → listening hard jump (skip thinking), keep transcript.
        this.micCapture?.setAiSpeaking(false); // 回到用户回合：恢复全量上行
        this.player.flush(); // barge-in：用户开口 → 立刻停掉 AI 正在播的音频
        this.setState({ phase: "listening", subtitle: "" });
        break;
      case "subtitle":
        if (ev.role === "ai") {
          this.setState((s) => ({ subtitle: ev.text, lines: [...s.lines, { role: "ai", text: ev.text }].slice(-8) }));
        } else if (ev.role === "user" && !ev.partial) {
          // 文字模式要看到自己说的话：用户最终识别结果也进转写（partial 不进，避免半句刷屏）。
          this.setState((s) => ({ lines: [...s.lines, { role: "user", text: ev.text }].slice(-8) }));
        }
        break;
      case "emotion":
        // Stored for the looping-video layer (影像 crossfade). The prototype's
        // placeholder orb has no emotion-driven visual, so no UI change here.
        this.setState({ emotion: ev.tag });
        break;
      case "billing":
        // Server-authoritative balance. seconds=elapsed drives the timer text.
        this.setState((s) => {
          const next: Partial<State> = { seconds: ev.elapsed, remaining: ev.remaining_seconds };
          if (ev.elapsed >= 60 && !s.loggedIn && !s.regPromptShown && !s.regPromptDismissed) {
            next.regPromptShown = true;
          }
          return next;
        });
        break;
      case "low_minutes":
        this.setState({ lowWarned: true, toast: "时长仅剩 1 分钟" });
        this.t.push(setTimeout(() => this.setState({ toast: "" }), 2400));
        break;
      case "out_of_minutes":
        this.clearTimers();
        this.stopMic();
        this.setState({ remaining: 0, outOfMins: true, phase: "idle", subtitle: "", lines: [] });
        break;
      case "call_failed":
        this.stopMic();
        this.setState({ phase: "idle", callFailed: true });
        break;
      case "ended":
        if (this.state.phase !== "ended") { this.stopMic(); this.setState({ phase: "ended", textMode: false }); }
        break;
    }
  }

  // ── flat render object (ported verbatim from the prototype) ───────────────
  renderVals(): Vals {
    const p = this.state.phase;
    const theme = this.state.theme ?? this.props.theme ?? "light";
    const tint = this.props.orbColor || "#AAB8FF";
    const connected = p === "listening" || p === "thinking" || p === "speaking";
    const edgeOpacity = ({ idle: 0, calling: 0.35, listening: 0.62, thinking: 0.45, speaking: 0.95, ended: 0 } as Record<string, number>)[p];

    const orbAnim = ({
      idle: "orbStill 7s ease-in-out infinite",
      calling: "orbBreathe 2.6s ease-in-out infinite",
      listening: "orbStill 5s ease-in-out infinite",
      thinking: "orbBreatheSlow 4.4s ease-in-out infinite",
      speaking: "orbDiffuse 1.9s ease-in-out infinite",
      ended: "orbStill 10s ease-in-out infinite",
    } as Record<string, string>)[p];
    const haloDur = ({ idle: 8, calling: 2.6, listening: 6, thinking: 4.4, speaking: 1.9, ended: 11 } as Record<string, number>)[p];
    const fieldDur = ({ idle: 26, calling: 15, listening: 19, thinking: 22, speaking: 9, ended: 34 } as Record<string, number>)[p];

    let subline = "";
    if (p === "idle") subline = "在线";
    else if (p === "calling") subline = "正在呼叫…";
    else subline = this.fmt(this.state.seconds);

    let underOrb = "";
    if (p === "listening") underOrb = "正在聆听";
    else if (p === "thinking") underOrb = "正在思考";
    else if (p === "speaking") underOrb = this.state.subtitle;
    else if (p === "ended") underOrb = "这次聊得怎么样？";

    let actionLabel = "轻点呼叫";
    if (p === "calling") actionLabel = "取消";
    else if (connected) actionLabel = "挂断";
    else if (p === "ended") actionLabel = "再次呼叫";
    const isCall = p === "idle" || p === "ended";
    const actionBg = isCall ? "#33C376" : "#F2554E";
    const actionGlow = isCall ? "rgba(51,195,118,.40)" : "rgba(242,85,78,.40)";

    let hint = "";
    if (p === "idle") hint = "剩余 12 分钟";
    else if (p === "ended") hint = "已保存";

    const textMode = this.state.textMode;
    const showOrb = !textMode;
    const showText = textMode;
    let textHint = "";
    if (p === "idle") textHint = "想聊就轻点呼叫";
    else if (p === "calling") textHint = "正在呼叫…";
    else if (p === "listening") textHint = "正在聆听";
    else if (p === "thinking") textHint = "正在思考";
    else if (p === "ended") textHint = "明天也别硬撑。";
    const showTextHint = textHint !== "";
    const displayLines = (this.state.lines || []).map((m: any, idx: number, arr: any[]) => {
      const isUser = m && m.role === "user";
      return {
        text: typeof m === "string" ? m : m.text,   // 兼容旧的纯字符串
        align: isUser ? "flex-end" : "flex-start",   // 我说的右对齐、TA 说的左对齐
        color: isUser ? "#6E5CFF" : (idx === arr.length - 1 ? "var(--fg)" : "var(--dim)"),
      };
    });

    if (!this._charsBuilt) { this.buildChars(); this._charsBuilt = true; }
    const char = this.chars[this.state.charIndex % this.chars.length];
    const charName = char.name;
    const orbHue = `hue-rotate(${char.hue}deg)`;
    const charTab = this.state.charTab;
    const charList = this.chars.map((c, i) => ({
      name: c.name,
      desc: c.desc,
      hueFilter: `hue-rotate(${c.hue}deg)`,
      bg: "var(--ctrl)",
      border: i === this.state.charIndex ? "2px solid #6E5CFF" : "2px solid transparent",
      check: i === this.state.charIndex ? 1 : 0,
      favOp: this.state.favorites.includes(i) ? 1 : 0,
      _i: i,
      pick: () => this.selectChar(i),
    })).filter((o) => charTab === "fav" ? this.state.favorites.includes(o._i) : (charTab === "hot" ? ((o._i * 31 + 7) % 100) < 52 : (o._i < 5 || o._i % 4 === 1)))
      .filter((o) => { const q = (this.state.searchQ || "").trim(); return !q || o.name.includes(q) || o.desc.includes(q); });
    const charListEmpty = charList.length === 0;
    const charDots = this.chars.map((_, i) => ({ op: i === this.state.charIndex ? 0.9 : 0.22 }));
    const curFav = this.state.favorites.includes(this.state.charIndex);
    const favCurFill = curFav ? "#FF4F7B" : "none";
    const favCurStroke = curFav ? "#FF4F7B" : "var(--fg)";
    const favList = this.chars.map((c, i) => ({ name: c.name, desc: c.desc, hueFilter: `hue-rotate(${c.hue}deg)`, _i: i, pick: () => this.setState({ charIndex: i, favOpen: false }) })).filter((o) => this.state.favorites.includes(o._i));
    const hasFavs = favList.length > 0;
    const noFavs = favList.length === 0;
    const phaseIdle = p === "idle";
    const phaseEnded = p === "ended";
    const showOrbStatus = p !== "idle";
    const stars = [1, 2, 3, 4, 5].map((n) => ({ fill: n <= this.state.rating ? "#FFB23E" : "var(--faint)", set: () => this.setState({ rating: n }) }));
    const feedbackChips = ["很温暖", "聊得开心", "答非所问", "反应慢"].map((t) => {
      const sel = this.state.feedback.includes(t);
      return { name: t, bg: sel ? "rgba(46,123,255,.14)" : "var(--ctrl)", color: sel ? "#2E7BFF" : "var(--dim)", pick: () => this.setState((s) => ({ feedback: s.feedback.includes(t) ? s.feedback.filter((x: string) => x !== t) : [...s.feedback, t] })) };
    });
    const phaseCalling = p === "calling";
    const inCall = p === "calling" || connected;
    const showHeaderChrome = p === "idle";
    const mute = this.state.mute, speaker = this.state.speaker;
    const muteBg = mute ? "#fff" : "var(--ctrl)";
    const muteIcon = mute ? "#1C1C1E" : "var(--fg)";
    const speakerBg = speaker ? "#fff" : "var(--ctrl)";
    const speakerIcon = speaker ? "#1C1C1E" : "var(--fg)";
    const textBtnBg = textMode ? "#fff" : "var(--ctrl)";
    const textBtnIcon = textMode ? "#1C1C1E" : "var(--fg)";

    const langs = [
      { name: "中文", sub: "简体中文", flag: "🇨🇳" },
      { name: "English", sub: "English (US)", flag: "🇺🇸" },
      { name: "日本語", sub: "Japanese", flag: "🇯🇵" },
      { name: "한국어", sub: "Korean", flag: "🇰🇷" },
      { name: "Español", sub: "Spanish", flag: "🇪🇸" },
      { name: "Français", sub: "French", flag: "🇫🇷" },
    ].map((o) => ({
      name: o.name,
      sub: o.sub,
      flag: o.flag,
      bg: "var(--ctrl)",
      border: this.state.lang === o.name ? "2px solid #6E5CFF" : "2px solid transparent",
      check: this.state.lang === o.name ? 1 : 0,
      pick: () => this.selectLang(o.name),
    }));

    if (!this._scenesBuilt) { this.buildScenarios(); this._scenesBuilt = true; }
    const curDef = this.scenarioDefs.find((d) => d.key === this.state.scenario);
    const pillLabel = this.state.scenario === "__custom" ? (this.state.customScene || "自定义") : (curDef ? curDef.name : "选择场景");
    const sceneTab = this.state.sceneTab;
    const scenarios = this.scenarioDefs.map((d, i) => ({
      name: d.name,
      desc: d.desc,
      iconPath: d.icon,
      tile: d.tile,
      bg: "var(--ctrl)",
      border: this.state.scenario === d.key ? "2px solid #6E5CFF" : "2px solid transparent",
      check: this.state.scenario === d.key ? 1 : 0,
      prompt: d.prompt || d.desc,
      expanded: this.state.expandedScene === d.key,
      clamp: this.state.expandedScene === d.key ? "none" : 2,
      toggleLabel: this.state.expandedScene === d.key ? "收起" : "展开",
      toggleExpand: (e: any) => { if (e) e.stopPropagation(); this.setState((s) => ({ expandedScene: s.expandedScene === d.key ? null : d.key })); },
      _i: i, _key: d.key,
      pick: () => this.selectScenario(d.key),
    })).filter((o) => sceneTab === "hot" ? ((o._i * 29 + 5) % 100) < 55 : (o._i < 5 || o._i % 3 === 0));
    const sceneListEmpty = scenarios.length === 0;
    const sceneCustomActive = sceneTab === "custom";
    const sceneListActive = sceneTab !== "custom";

    return {
      theme,
      edgeOpacity: theme === "dark" ? edgeOpacity : edgeOpacity * 0.7,
      edgeBlend: theme === "dark" ? "screen" : "normal",
      // 边缘光在 idle/ended（应用最常驻态）不可见——此时不渲染那层 blur(34px) 的旋转
      // 锥形渐变，省掉持续的 GPU 合成（仅通话各阶段才挂载）。
      edgeVisible: edgeOpacity > 0,
      title: p === "ended" ? "通话结束" : charName,
      orbHue, showOrbStatus, charDots,
      charTagline: char.desc,
      charDetail: {
        name: char.name, tagline: char.desc, bio: char.bio, traits: char.traits, hueFilter: orbHue,
        fav: this.state.favorites.includes(this.state.charIndex),
        favFill: this.state.favorites.includes(this.state.charIndex) ? "#FF4F7B" : "none",
        favStroke: this.state.favorites.includes(this.state.charIndex) ? "#FF4F7B" : "var(--dim)",
        favLabel: this.state.favorites.includes(this.state.charIndex) ? "已收藏" : "收藏",
        favLabelColor: this.state.favorites.includes(this.state.charIndex) ? "#FF4F7B" : "var(--dim)",
        favBtnBg: this.state.favorites.includes(this.state.charIndex) ? "rgba(255,79,123,.10)" : "var(--ctrl)",
        favToggle: () => this.setState((s) => ({ favorites: s.favorites.includes(s.charIndex) ? s.favorites.filter((x: number) => x !== s.charIndex) : [...s.favorites, s.charIndex] })),
        previewing: this.state.previewing === this.state.charIndex,
        notPreviewing: this.state.previewing !== this.state.charIndex,
        previewLabel: this.state.previewing === this.state.charIndex ? "正在试听…" : "试听声音",
        previewVoice: () => { const ci = this.state.charIndex; this.setState({ previewing: ci }); this.t.push(setTimeout(() => this.setState((s) => (s.previewing === ci ? { previewing: null } : {})), 2600)); },
        ...this.profileOf(this.state.charIndex),
        voiceChips: (() => {
          const ci = this.state.charIndex;
          const gen = this.state.genVoicesByChar[ci] || [];
          const sel = this.state.voiceByChar[ci] ?? "default";
          const mk = (nm: string, key: string, rm: boolean) => ({ name: nm, removable: !!rm, sel: sel === key, bg: sel === key ? "rgba(110,92,255,.12)" : "var(--ctrl)", color: sel === key ? "#6E5CFF" : "var(--fg)", pick: () => { this.setState((s) => ({ voiceByChar: { ...s.voiceByChar, [ci]: key }, previewing: ci })); this.t.push(setTimeout(() => this.setState((s) => (s.previewing === ci ? { previewing: null } : {})), 2600)); }, remove: (e: any) => { if (e) e.stopPropagation(); this.setState({ pendingVoiceDel: { ci, key } }); } });
          return [mk("原本音色", "default", false), ...gen.map((g: string) => mk(g, g, true))];
        })(),
        voiceCustomText: this.state.voiceCustomText,
        onVoiceCustom: (e: any) => this.setState({ voiceCustomText: e.target.value }),
        genVoice: () => { const v = (this.state.voiceCustomText || "").trim(); if (!v) return; const ci = this.state.charIndex; this.setState((s) => { const cur = s.genVoicesByChar[ci] || []; const next = cur.includes(v) ? cur : [...cur, v]; return { genVoicesByChar: { ...s.genVoicesByChar, [ci]: next }, voiceByChar: { ...s.voiceByChar, [ci]: v }, previewing: ci, voiceCustomText: "", toast: "音色生成成功" }; }); this.t.push(setTimeout(() => this.setState((s) => (s.previewing === ci ? { previewing: null } : {})), 2600)); this.t.push(setTimeout(() => this.setState({ toast: "" }), 2000)); },
      },
      charDetailOpen: this.state.charDetailOpen,
      charDetailToggle: () => this.setState((s) => ({ charDetailOpen: !s.charDetailOpen })),
      charDetailClose: () => this.setState({ charDetailOpen: false }),
      charList,
      charListEmpty,
      charTabRecBg: charTab === "rec" ? "var(--seg)" : "transparent",
      charTabRecColor: charTab === "rec" ? "var(--fg)" : "var(--dim)",
      charTabRecShadow: charTab === "rec" ? "0 2px 6px rgba(0,0,0,.10)" : "none",
      charTabHotBg: charTab === "hot" ? "var(--seg)" : "transparent",
      charTabHotColor: charTab === "hot" ? "var(--fg)" : "var(--dim)",
      charTabHotShadow: charTab === "hot" ? "0 2px 6px rgba(0,0,0,.10)" : "none",
      charTabFavBg: charTab === "fav" ? "var(--seg)" : "transparent",
      charTabFavColor: charTab === "fav" ? "var(--fg)" : "var(--dim)",
      charTabFavShadow: charTab === "fav" ? "0 2px 6px rgba(0,0,0,.10)" : "none",
      charTabRec: () => this.setState({ charTab: "rec" }),
      charTabHot: () => this.setState({ charTab: "hot" }),
      charTabFav: () => this.setState({ charTab: "fav" }),
      charListEmptyText: charTab === "fav" ? "还没有收藏的角色" : ((this.state.searchQ || "").trim() ? "没有找到相关角色" : "这里暂时还没有角色"),
      searchQ: this.state.searchQ,
      onSearch: (e: any) => this.setState({ searchQ: e.target.value }),
      showGuide: this.state.showGuide && p === "idle",
      dismissGuide: () => this.dismissGuide(),
      charCount: this.chars.length,
      charOpen: this.state.charOpen,
      charCursor: "pointer",
      charToggle: () => { if (p === "idle") this.setState((s) => ({ charOpen: !s.charOpen })); },
      charClose: () => this.setState({ charOpen: false }),
      prevChar: (e: any) => { if (e) e.stopPropagation(); this.setState((s) => ({ charIndex: (s.charIndex - 1 + this.chars.length) % this.chars.length })); },
      nextChar: (e: any) => { if (e) e.stopPropagation(); this.setState((s) => ({ charIndex: (s.charIndex + 1) % this.chars.length })); },
      subline,
      underOrb,
      underOpacity: underOrb ? 1 : 0,
      actionLabel,
      isCall,
      isEnd: !isCall,
      actionBg,
      actionGlow,
      hint,
      orbCursor: "pointer",
      orbTap: () => this.setState((s) => ({ charDetailOpen: !s.charDetailOpen })),
      onShuffle: (e: any) => {
        if (e) e.stopPropagation();
        if (p !== "idle") return;
        const ci = Math.floor(Math.random() * this.chars.length);
        const sd = this.scenarioDefs[Math.floor(Math.random() * this.scenarioDefs.length)];
        this.setState({ charIndex: ci, scenario: sd.key });
      },
      actionTap: () => {
        if (p === "idle") this.startCall();
        else if (p === "calling") this.resetIdle();
        else if (connected) this.endCall();
        else if (p === "ended") this.resetIdle();
      },
      textMode,
      showOrb,
      showText,
      showTextHint,
      textHint,
      lines: displayLines,
      textToggle: () => this.setState((s) => ({ textMode: !s.textMode })),
      textToggleColor: textMode ? "var(--fg)" : "var(--faint)",
      phaseIdle, phaseCalling, inCall, showHeaderChrome, phaseEnded,
      bottomH: "208px",
      note: this.state.note,
      onNote: (e: any) => this.setState({ note: e.target.value }),
      stars, feedbackChips,
      rated: this.state.rating > 0,
      notRated: this.state.rating === 0,
      finishRating: () => this.resetIdle(),
      chromeOpacity: phaseIdle ? 1 : 0,
      chromePE: phaseIdle ? "auto" : "none",
      muteBg, muteIcon, speakerBg, speakerIcon, textBtnBg, textBtnIcon,
      muteToggle: () => this.setState((s) => {
        const next = !s.mute;
        // local mic gate + notify server (docs/03 §5 mute)
        if (this.micStream) this.micStream.getAudioTracks().forEach((tr) => { tr.enabled = !next; });
        this.send({ type: "mute", on: next });
        return { mute: next };
      }),
      undoLast: () => { this.setState((s) => ({ lines: s.lines.slice(0, -1), toast: "已撤回上一句", moreOpen: false })); this.t.push(setTimeout(() => this.setState({ toast: "" }), 1600)); },
      resetMemory: () => {
        // 真清后端记忆（事实层+理解层），不只是清屏；接了真实信令才发，Mock 下静默。
        if (!this.usingMockSignaling()) {
          try { this.send({ type: "reset_memory", character_id: this.characterId(this.state.charIndex) }); } catch { /* 未连接则忽略 */ }
        }
        this.setState({ lines: [], toast: "记忆已重置", resetOpen: false });
        this.t.push(setTimeout(() => this.setState({ toast: "" }), 1600));
      },
      askReset: () => this.setState({ resetOpen: true, moreOpen: false }),
      moreOpen: this.state.moreOpen,
      moreToggle: () => this.setState((s) => ({ moreOpen: !s.moreOpen })),
      moreClose: () => this.setState({ moreOpen: false }),
      resetOpen: this.state.resetOpen,
      cancelReset: () => this.setState({ resetOpen: false }),
      toast: this.state.toast,
      showToast: !!this.state.toast,
      speakerToggle: () => this.setState((s) => ({ speaker: !s.speaker })),
      themeToggle: () => this.setState({ theme: theme === "dark" ? "light" : "dark" }),
      themeLabel: theme === "dark" ? "深色" : "浅色",
      menuOpen: this.state.menuOpen,
      menuToggle: () => this.setState((s) => ({ menuOpen: !s.menuOpen })),
      menuClose: () => this.setState({ menuOpen: false }),
      favCurFill, favCurStroke,
      favToggleCur: () => this.setState((s) => ({ favorites: s.favorites.includes(s.charIndex) ? s.favorites.filter((x: number) => x !== s.charIndex) : [...s.favorites, s.charIndex] })),
      favList, hasFavs, noFavs,
      favOpen: this.state.favOpen,
      favOpenToggle: () => this.setState((s) => ({ favOpen: !s.favOpen })),
      favClose: () => this.setState({ favOpen: false }),
      rechargeOpen: this.state.rechargeOpen,
      rechargeToggle: () => this.setState((s) => ({ rechargeOpen: !s.rechargeOpen })),
      rechargeClose: () => this.setState({ rechargeOpen: false }),
      redeemCode: this.state.redeemCode,
      onRedeemCode: (e: any) => this.setState({ redeemCode: e.target.value }),
      doRedeem: () => this.doRedeem(),
      billPeriod: this.state.billing,
      setBillMonth: () => this.setState({ billing: "month" }),
      setBillQuarter: () => this.setState({ billing: "quarter" }),
      setBillYear: () => this.setState({ billing: "year" }),
      billOptions: [
        { key: "month", label: "月付", off: "" },
        { key: "quarter", label: "季付", off: "省20%" },
        { key: "year", label: "年付", off: "省30%" },
      ].map((o) => ({
        label: o.label, off: o.off, hasOff: o.off !== "",
        border: this.state.billing === o.key ? "2px solid #6E5CFF" : "2px solid var(--line)",
        bg: this.state.billing === o.key ? "rgba(110,92,255,.08)" : "transparent",
        nameColor: this.state.billing === o.key ? "#6E5CFF" : "var(--fg)",
        pick: () => this.setState({ billing: o.key }),
      })),
      plans: (() => {
        const fmt = (n: number) => "$" + (Number.isInteger(n) ? n : (Math.round(n * 100) / 100));
        const cfg = ({ month: { mult: 1, off: 1, unit: "/月" }, quarter: { mult: 3, off: 0.8, unit: "/季" }, year: { mult: 12, off: 0.7, unit: "/年" } } as Record<string, { mult: number; off: number; unit: string }>)[this.state.billing];
        const tiers = [
          { tile: "linear-gradient(145deg,#7AA8FF,#5B7CF0)", iconPath: "M12 3l2.2 5.2L20 9.4l-4 3.9 1 5.7L12 16.3 7 19l1-5.7-4-3.9 5.8-1.2L12 3z", name: "轻享会员", mins: "每月 300 分钟", m: 4.99, tag: "" },
          { tile: "linear-gradient(145deg,#B79CFF,#9277F5)", iconPath: "M21 11.5a8.38 8.38 0 0 1-8.5 8.5 8.5 8.5 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8A8.5 8.5 0 0 1 12.5 3 8.38 8.38 0 0 1 21 11.5z", name: "畅聊会员", mins: "每月 1500 分钟", m: 9.99, tag: "最受欢迎" },
          { tile: "linear-gradient(145deg,#FFC061,#F5A623)", iconPath: "M18.5 8.5c-2 0-3.2 1.6-4.2 3-.8 1.1-1.5 2-2.3 2s-1.5-.9-2.3-2c-1-1.4-2.2-3-4.2-3a3.5 3.5 0 1 0 0 7c2 0 3.2-1.6 4.2-3 .8-1.1 1.5-2 2.3-2s1.5.9 2.3 2c1 1.4 2.2 3 4.2 3a3.5 3.5 0 1 0 0-7z", name: "无限会员", mins: "每月不限时", m: 19.99, tag: "" },
        ];
        return tiers.map((t) => {
          const total = t.m * cfg.mult * cfg.off;
          const perMonth = t.m * cfg.off;
          const note = this.state.billing === "month" ? t.tag : ("约 " + fmt(perMonth) + "/月");
          return { tile: t.tile, iconPath: t.iconPath, name: t.name, mins: t.mins, price: fmt(total), unit: cfg.unit, note, pick: () => { this.setState({ toast: "会员套餐即将上线，当前请用兑换码充值" }); this.t.push(setTimeout(() => this.setState({ toast: "" }), 2200)); } };
        });
      })(),
      historyOpen: this.state.historyOpen,
      historyToggle: () => this.setState((s) => ({ historyOpen: !s.historyOpen }), () => { if (this.state.historyOpen) this.loadHistory(); }),
      historyClose: () => this.setState({ historyOpen: false }),
      historyList: (this.realHistory ?? this.history).map((h) => ({ name: h.name, scene: h.scene, dur: h.dur, when: h.when, hueFilter: `hue-rotate(${h.hue}deg)`, pick: () => this.switchTo(h.idx, h.sceneKey) })),
      pendingSwitch: this.state.pendingSwitch,
      pendingName: this.state.pendingSwitch ? this.chars[this.state.pendingSwitch.idx].name : "",
      confirmSwitch: () => this.confirmSwitch(),
      cancelSwitch: () => this.setState({ pendingSwitch: null }),
      pillLabel,
      scenarios,
      sceneListEmpty,
      sceneListEmptyText: "这里暂时还没有场景",
      sceneCustomActive,
      sceneListActive,
      customSceneText: this.state.customSceneText,
      onCustomScene: (e: any) => this.setState({ customSceneText: e.target.value }),
      applyCustomScene: () => { const v = (this.state.customSceneText || "").trim(); if (!v) return; this.setState((s) => ({ customScene: v, scenario: "__custom", scenarioOpen: false, customSceneText: "", customHistory: [v, ...s.customHistory.filter((x: string) => x !== v)].slice(0, 8) })); if (this.isConnected()) this.send({ type: "set_scene", scene: v }); },
      customSuggestions: ["陪我准备演讲", "假装在海边散步", "哄我睡觉", "听我吐槽工作", "用英文聊天", "玩角色扮演"].map((txt) => ({ text: txt, pick: () => { this.setState((s) => ({ customScene: txt, scenario: "__custom", scenarioOpen: false, customHistory: [txt, ...s.customHistory.filter((x: string) => x !== txt)].slice(0, 8) })); if (this.isConnected()) this.send({ type: "set_scene", scene: txt }); } })),
      customHistory: this.state.customHistory.map((txt: string) => ({ text: txt, pick: () => { this.setState((s) => ({ customScene: txt, scenario: "__custom", scenarioOpen: false, customHistory: [txt, ...s.customHistory.filter((x: string) => x !== txt)].slice(0, 8) })); if (this.isConnected()) this.send({ type: "set_scene", scene: txt }); } })),
      hasCustomHistory: this.state.customHistory.length > 0,
      sceneTabRecBg: sceneTab === "rec" ? "var(--seg)" : "transparent",
      sceneTabRecColor: sceneTab === "rec" ? "var(--fg)" : "var(--dim)",
      sceneTabRecShadow: sceneTab === "rec" ? "0 2px 6px rgba(0,0,0,.10)" : "none",
      sceneTabHotBg: sceneTab === "hot" ? "var(--seg)" : "transparent",
      sceneTabHotColor: sceneTab === "hot" ? "var(--fg)" : "var(--dim)",
      sceneTabHotShadow: sceneTab === "hot" ? "0 2px 6px rgba(0,0,0,.10)" : "none",
      sceneTabFavBg: sceneTab === "custom" ? "var(--seg)" : "transparent",
      sceneTabFavColor: sceneTab === "custom" ? "var(--fg)" : "var(--dim)",
      sceneTabFavShadow: sceneTab === "custom" ? "0 2px 6px rgba(0,0,0,.10)" : "none",
      sceneTabRec: () => this.setState({ sceneTab: "rec" }),
      sceneTabHot: () => this.setState({ sceneTab: "hot" }),
      sceneTabFav: () => this.setState({ sceneTab: "custom" }),
      scenarioOpen: this.state.scenarioOpen,
      scenarioToggle: () => this.setState((s) => ({ scenarioOpen: !s.scenarioOpen })),
      scenarioClose: () => this.setState({ scenarioOpen: false }),
      langs,
      langOpen: this.state.langOpen,
      langToggle: () => this.setState((s) => ({ langOpen: !s.langOpen })),
      langFromMenu: () => this.setState({ ...this.sheets(), menuOpen: false, langOpen: true }),
      permOpen: this.state.permOpen,
      permDeny: () => this.setState({ permOpen: false }),
      grantMic: () => this.grantMic(),
      callFailed: this.state.callFailed,
      retryDial: () => this.retryDial(),
      dismissFail: () => this.setState({ callFailed: false }),
      outOfMins: this.state.outOfMins,
      outToRecharge: () => this.setState({ outOfMins: false, rechargeOpen: true }),
      dismissOut: () => this.setState({ outOfMins: false }),
      settingsFromMenu: () => this.setState({ ...this.sheets(), menuOpen: false, settingsOpen: true }),
      contactFromMenu: () => { this.setState({ ...this.sheets(), menuOpen: false, contactOpen: true }); this.loadTickets(); },
      fontLabel: ["标准", "大", "特大"][this.state.fontScale],
      rootZoom: [1, 1.06, 1.11][this.state.fontScale],
      orbCounterZoom: [1, 0.943, 0.901][this.state.fontScale],
      cycleFont: () => this.setState((s) => ({ fontScale: (s.fontScale + 1) % 3 })),
      fsTitle: [28, 33, 38][this.state.fontScale] + "px",
      fsSub: [15, 17, 19][this.state.fontScale] + "px",
      fsStatus: [18, 21, 24][this.state.fontScale] + "px",
      fsTagline: [14.5, 16.5, 18.5][this.state.fontScale] + "px",
      contactOpen: this.state.contactOpen,
      contactClose: () => this.setState({ contactOpen: false }),
      contactMsg: this.state.contactMsg,
      onContactMsg: (e: any) => this.setState({ contactMsg: e.target.value }),
      contactTypes: ["建议反馈", "功能异常", "账号/支付", "其他"].map((t) => ({ name: t, sel: this.state.contactType === t, bg: this.state.contactType === t ? "rgba(110,92,255,.12)" : "var(--ctrl)", color: this.state.contactType === t ? "#6E5CFF" : "var(--fg)", pick: () => this.setState({ contactType: t }) })),
      submitContact: async () => {
        const msg = (this.state.contactMsg || "").trim();
        if (!msg) { this.toast("请先描述你的问题"); return; }
        const type = this.state.contactType;
        // 演示模式（未接后端）：保留原本地行为。
        if (!authApi.authConfigured()) {
          this.setState((s) => ({ tickets: [{ type, msg, date: "刚刚", status: "处理中", reply: "" }, ...s.tickets], contactMsg: "", toast: "已提交，回复会显示在下方" }));
          this.t.push(setTimeout(() => this.setState({ toast: "" }), 2200));
          return;
        }
        if (!this.state.loggedIn) { this.setState({ contactOpen: false, authOpen: true, authMode: "login", toast: "请先登录再提交" }); return; }
        const res = await authApi.submitTicket(type, msg);
        if (!res.ok) { this.toast(res.error || "提交失败"); return; }
        this.setState({ contactMsg: "", toast: "已提交，回复会显示在下方" });
        this.t.push(setTimeout(() => this.setState({ toast: "" }), 2200));
        this.loadTickets();   // 拉回含这条新工单
      },
      ticketList: (this.realTickets ?? this.state.tickets).map((tk: any) => ({ type: tk.type, msg: tk.msg, date: tk.date, status: tk.status, reply: tk.reply, replied: tk.status === "已回复", statusColor: tk.status === "已回复" ? "#33A06B" : "#E0954F", statusBg: tk.status === "已回复" ? "rgba(51,160,107,.14)" : "rgba(224,149,79,.14)" })),
      hasTickets: (this.realTickets ?? this.state.tickets).length > 0,
      loggedIn: this.state.loggedIn,
      authOpen: this.state.authOpen,
      authIsRegister: this.state.authMode === "register",
      authTitle: this.state.authMode === "register" ? "注册账号" : "登录",
      authSubtitle: this.state.authMode === "register" ? "注册即送 60 分钟免费通话时长" : "欢迎回来,继续和 TA 聊聊",
      authSubmitLabel: this.state.authMode === "register" ? "注册并开始" : "登录",
      authSwitchLabel: this.state.authMode === "register" ? "已有账号？去登录" : "没有账号？去注册",
      authEmail: this.state.authEmail,
      authPw: this.state.authPw,
      onAuthEmail: (e: any) => this.setState({ authEmail: e.target.value }),
      onAuthPw: (e: any) => this.setState({ authPw: e.target.value }),
      switchAuthMode: () => this.setState((s) => ({ authMode: s.authMode === "register" ? "login" : "register" })),
      openRegister: () => this.setState({ ...this.sheets(), authOpen: true, authMode: "register", menuOpen: false, regPromptShown: false, regPromptDismissed: true }),
      openLogin: () => this.setState({ ...this.sheets(), authOpen: true, authMode: "login", menuOpen: false }),
      authClose: () => this.setState({ authOpen: false }),
      submitAuth: async () => {
        const email = (this.state.authEmail || "").trim();
        const pw = this.state.authPw || "";
        if (!(/.+@.+\..+/.test(email) && pw.length >= 6)) {
          this.setState({ toast: "请输入有效邮箱和至少 6 位密码" });
          this.t.push(setTimeout(() => this.setState({ toast: "" }), 2000));
          return;
        }
        const reg = this.state.authMode === "register";
        const okMsg = reg ? "注册成功，已送 60 分钟免费时长" : "登录成功";
        // 纯演示（未接后端）：保留原前端假登录。
        if (!authApi.authConfigured()) {
          this.setState((s) => ({ loggedIn: true, authOpen: false, authPw: "", regPromptShown: false, remaining: reg ? Math.max(s.remaining, 3600) : s.remaining, toast: okMsg }));
          this.t.push(setTimeout(() => this.setState({ toast: "" }), 2200));
          return;
        }
        // 真实后端：打 /api/auth/*，存 token，余额以服务端为准。
        this.setState({ toast: reg ? "注册中…" : "登录中…" });
        const res = reg ? await authApi.register(email, pw) : await authApi.login(email, pw);
        if (!res.ok || !res.token) {
          this.setState({ toast: res.error || "操作失败，请重试" });
          this.t.push(setTimeout(() => this.setState({ toast: "" }), 2200));
          return;
        }
        authApi.setToken(res.token);
        this.resetSignaling();   // 让下一通电话带上新 token 重连
        this.setState({ loggedIn: true, authOpen: false, authPw: "", regPromptShown: false, remaining: res.user?.remaining_seconds ?? this.state.remaining, toast: okMsg });
        this.t.push(setTimeout(() => this.setState({ toast: "" }), 2200));
      },
      logout: () => this.setState({ logoutConfirmOpen: true, menuOpen: false }),
      logoutConfirmOpen: this.state.logoutConfirmOpen,
      cancelLogout: () => this.setState({ logoutConfirmOpen: false }),
      confirmLogout: () => { authApi.logout().catch(() => {}); this.resetSignaling(); this.realHistory = null; this.realBills = null; this.realTickets = null; this.setState({ loggedIn: false, logoutConfirmOpen: false, authEmail: "", toast: "已退出登录" }); this.t.push(setTimeout(() => this.setState({ toast: "" }), 1600)); },
      pendingVoiceDel: this.state.pendingVoiceDel,
      pendingVoiceName: this.state.pendingVoiceDel ? this.state.pendingVoiceDel.key : "",
      cancelVoiceDel: () => this.setState({ pendingVoiceDel: null }),
      confirmVoiceDel: () => { const pv = this.state.pendingVoiceDel; if (!pv) return; this.setState((s) => { const next = (s.genVoicesByChar[pv.ci] || []).filter((x: string) => x !== pv.key); const vb = { ...s.voiceByChar }; if (vb[pv.ci] === pv.key) vb[pv.ci] = "default"; return { genVoicesByChar: { ...s.genVoicesByChar, [pv.ci]: next }, voiceByChar: vb, pendingVoiceDel: null, toast: "已删除音色" }; }); this.t.push(setTimeout(() => this.setState({ toast: "" }), 1500)); },
      loggedOut: !this.state.loggedIn,
      accountEmail: this.state.authEmail || "已登录用户",
      accountInitial: (this.state.authEmail || "M").trim().charAt(0).toUpperCase(),
      resetPassword: () => this.setState({ settingsOpen: false, pwResetOpen: true, newPw1: "", newPw2: "" }),
      pwResetOpen: this.state.pwResetOpen,
      pwResetClose: () => this.setState({ pwResetOpen: false }),
      newPw1: this.state.newPw1,
      newPw2: this.state.newPw2,
      onNewPw1: (e: any) => this.setState({ newPw1: e.target.value }),
      onNewPw2: (e: any) => this.setState({ newPw2: e.target.value }),
      submitNewPw: () => {
        const a = this.state.newPw1 || "", b = this.state.newPw2 || "";
        if (a.length < 6) { this.setState({ toast: "新密码至少 6 位" }); this.t.push(setTimeout(() => this.setState({ toast: "" }), 1800)); return; }
        if (a !== b) { this.setState({ toast: "两次密码不一致" }); this.t.push(setTimeout(() => this.setState({ toast: "" }), 1800)); return; }
        this.setState({ pwResetOpen: false, newPw1: "", newPw2: "", toast: "密码已修改" });
        this.t.push(setTimeout(() => this.setState({ toast: "" }), 1800));
      },
      cancelSub: () => { this.setState({ settingsOpen: false, toast: "订阅将在本周期结束后取消" }); this.t.push(setTimeout(() => this.setState({ toast: "" }), 2200)); },
      cookieOpen: this.state.cookieOpen,
      acceptCookie: () => this.acceptCookie(),
      privacyOpen: this.state.privacyOpen,
      openPrivacy: () => this.setState({ settingsOpen: false, privacyOpen: true }),
      privacyClose: () => this.setState({ privacyOpen: false }),
      termsOpen: this.state.termsOpen,
      openTerms: () => this.setState({ settingsOpen: false, termsOpen: true }),
      termsClose: () => this.setState({ termsOpen: false }),
      regPromptVisible: this.state.regPromptShown && !this.state.loggedIn && !this.state.regPromptDismissed,
      dismissRegPrompt: () => this.setState({ regPromptDismissed: true, regPromptShown: false }),
      settingsOpen: this.state.settingsOpen,
      settingsClose: () => this.setState({ settingsOpen: false }),
      setSound: this.state.setSound,
      setVibrate: this.state.setVibrate,
      setSubtitle: this.state.setSubtitle,
      setSoundTrack: this.state.setSound ? "#33C376" : "var(--ctrl)",
      setSoundDot: this.state.setSound ? "translateX(20px)" : "translateX(0)",
      setVibrateTrack: this.state.setVibrate ? "#33C376" : "var(--ctrl)",
      setVibrateDot: this.state.setVibrate ? "translateX(20px)" : "translateX(0)",
      setSubtitleTrack: this.state.setSubtitle ? "#33C376" : "var(--ctrl)",
      setSubtitleDot: this.state.setSubtitle ? "translateX(20px)" : "translateX(0)",
      toggleSound: () => this.setState((s) => ({ setSound: !s.setSound })),
      toggleVibrate: () => this.setState((s) => ({ setVibrate: !s.setVibrate })),
      toggleSubtitle: () => this.setState((s) => ({ setSubtitle: !s.setSubtitle })),
      favFromMenu: () => this.setState({ ...this.sheets(), menuOpen: false, favOpen: true }),
      billFromMenu: () => { this.setState({ ...this.sheets(), menuOpen: false, billsOpen: true }); this.loadBills(); },
      billsOpen: this.state.billsOpen,
      billsClose: () => this.setState({ billsOpen: false }),
      billsToRecharge: () => this.setState({ ...this.sheets(), rechargeOpen: true }),
      billsList: (this.realBills ?? this.bills).map((b) => ({
        title: b.title, date: b.date, mins: b.mins,
        minsColor: b.mins.startsWith("+") ? "#33A06B" : "var(--dim)",
        iconBg: b.type === "sub" ? "rgba(110,92,255,.12)" : (b.type === "invite" ? "rgba(255,79,123,.12)" : "rgba(46,123,255,.12)"),
        iconColor: b.type === "sub" ? "#6E5CFF" : (b.type === "invite" ? "#FF4F7B" : "#2E7BFF"),
        iconPath: b.type === "sub" ? "M20 12V8H6a2 2 0 0 1 0-4h12v4M4 6v12a2 2 0 0 0 2 2h14v-4M18 12a2 2 0 0 0 0 4h4v-4z" : (b.type === "invite" ? "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M19 8v6M22 11h-6" : "M6.62 10.79a15.05 15.05 0 0 0 6.59 6.59l2.2-2.2a1 1 0 0 1 1.02-.24 11.36 11.36 0 0 0 3.57.57 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.25.2 2.45.57 3.57a1 1 0 0 1-.24 1.02l-2.2 2.2z"),
      })),
      inviteFromMenu: () => this.setState({ ...this.sheets(), menuOpen: false, inviteOpen: true }),
      inviteOpen: this.state.inviteOpen,
      inviteClose: () => this.setState({ inviteOpen: false }),
      inviteCount: this.invites.filter((i) => i.status === "已注册").length,
      inviteList: this.invites.map((iv) => ({
        name: iv.name, initial: iv.name[0], date: iv.date, status: iv.status, reward: iv.reward,
        done: iv.status === "已注册",
        rewardColor: iv.status === "已注册" ? "#33A06B" : "var(--faint)",
        statusColor: iv.status === "已注册" ? "var(--dim)" : "#E0954F",
      })),
      langCurrent: this.state.lang,
      langClose: () => this.setState({ langOpen: false }),
      orbAnim: inCall ? "none" : orbAnim,
      fieldAnim: inCall ? "none" : `spin ${fieldDur}s linear infinite`,
      haloAnim: inCall ? "none" : `haloPulse ${haloDur}s ease-in-out infinite`,
      orbBg: `radial-gradient(circle at 38% 33%, rgba(255,255,255,.97), ${this.hexA(tint, .62)} 38%, ${this.hexA(tint, .20)} 64%, ${this.hexA(tint, .03)} 82%)`,
      orbShadow: `0 0 50px 4px ${this.hexA(tint, .28)}, 0 0 100px 22px rgba(110,92,255,.16)`,
      haloBg: `radial-gradient(circle, ${this.hexA(tint, .26)}, rgba(255,79,160,.10) 45%, transparent 72%)`,
    };
  }
}
