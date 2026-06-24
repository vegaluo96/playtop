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
  private _scenesBuilt = false;

  state: State = { phase: "idle", seconds: 0, subtitle: "", theme: null, textMode: false, lines: [], scenario: null, scenarioOpen: false, mute: false, speaker: false, lang: "中文", langOpen: false, charIndex: 0, charOpen: false, charDetailOpen: false, rating: 0, feedback: [], menuOpen: false, favorites: [], favOpen: false, rechargeOpen: false, redeemCode: "", historyOpen: false, pendingSwitch: null, note: "", charTab: "rec", billing: "month", inviteOpen: false, billsOpen: false, sceneTab: "rec", customScene: null, customSceneText: "", expandedScene: null, customHistory: [], settingsOpen: false, toast: "", resetOpen: false, moreOpen: false, loggedIn: false, authOpen: false, authMode: "register", authEmail: "", authPw: "", regPromptShown: false, regPromptDismissed: false, pwResetOpen: false, newPw1: "", newPw2: "", cookieOpen: false, privacyOpen: false, termsOpen: false, logoutConfirmOpen: false, contactOpen: false, contactType: "建议反馈", contactMsg: "", tickets: [], voiceByChar: {}, lowWarned: false, micGranted: false, callFailed: false, remaining: 60, outOfMins: false, searchQ: "", previewing: null, showGuide: false, emotion: "idle", autoHangupMin: 3, autoHangupOpen: false, histSelMode: false, histSel: [], histDelConfirm: false };

  t: Timer[] = [];
  i = 0;

  // realtime resources
  private sig: SignalingClient | null = null;
  private micStream: MediaStream | null = null;
  private micCapture: MicCapture | null = null;  // 麦克风 → 上行 PCM 帧
  private player = new AudioPlayer();             // 下行 TTS PCM → 播放
  private halfDuplex = true;                      // 默认半双工（AI 外放时不上行，稳·无回声·无杂音）；?duplex=full 才关
  private rtcEnabled = false;                      // ?rtc=1：实验性服务端 WebRTC 媒体面（真全双工，可随时打断、外放硬件 AEC）
  private pc: RTCPeerConnection | null = null;     // WebRTC 媒体连接（仅 rtc 模式）
  private rtcAudioEl: HTMLAudioElement | null = null;  // 播远端 AI 语音轨（标准 WebRTC 远端音频，浏览器解码 Opus）
  private rtcWatchdog: ReturnType<typeof setTimeout> | null = null;  // 连不通就回退 WS 的看门狗
  private rtcFellBack = false;                     // 本通是否已回退（防重复回退）

  bills: any[] = [];

  invites: any[] = [];

  history: any[] = [];

  // 真实可选音色库（MiniMax 系统音色）+ 我每个角色已选音色（账号级，跨设备回显选中态）。
  private voiceLib: authApi.Voice[] = [];
  private myVoices: Record<string, string> = {};

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
    // 用上次拉到的**真实**角色（含后台改过的名字/默认角色）做首屏，杜绝刷新先闪一下内置的「林晚」等占位名。
    // 内置 chars 只在从没连过后端的全新设备上兜底；连过一次后永远先显真实数据。
    try {
      const raw = localStorage.getItem("micall_chars");
      if (raw) {
        const c = JSON.parse(raw);
        if (c && Array.isArray(c.chars) && c.chars.length) {
          this.chars = c.chars;
          if (typeof c.idx === "number" && c.idx >= 0 && c.idx < c.chars.length) this.state.charIndex = c.idx;
        }
      }
    } catch { /* 缓存坏了就用内置兜底 */ }
    this.state.favorites = this.loadFavs();   // 收藏持久化：刷新不丢（按角色 id 存）
    this.loadPrefs();                         // 个人偏好持久化：主题/语言/外放/音色/自定义场景/自动挂断（刷新不丢）
  }

  // ── 个人偏好持久化（micall_prefs）：用户改过的设置刷新后仍在，不再「设了等于没设」──
  private loadPrefs() {
    try {
      const raw = localStorage.getItem("micall_prefs");
      if (!raw) return;
      const p = JSON.parse(raw);
      if (!p || typeof p !== "object") return;
      if (p.theme === "light" || p.theme === "dark") this.state.theme = p.theme;
      if (typeof p.lang === "string") this.state.lang = p.lang;
      if (typeof p.speaker === "boolean") this.state.speaker = p.speaker;
      if (p.voiceByChar && typeof p.voiceByChar === "object") this.state.voiceByChar = p.voiceByChar;
      if (Array.isArray(p.customHistory)) this.state.customHistory = p.customHistory.slice(0, 8);
      if (typeof p.autoHangupMin === "number" && p.autoHangupMin >= 0) this.state.autoHangupMin = p.autoHangupMin;
    } catch { /* noop */ }
  }
  private savePrefs() {
    try {
      const s = this.state;
      localStorage.setItem("micall_prefs", JSON.stringify({
        theme: s.theme, lang: s.lang, speaker: s.speaker,
        voiceByChar: s.voiceByChar,
        customHistory: s.customHistory, autoHangupMin: s.autoHangupMin,
      }));
    } catch { /* noop */ }
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
      // 通话模式：默认半双工（稳——AI 一定说得出话、外放无回声/不自我打断）。打断走 RTC（连上 coturn 即真全双工）
      // 或戴耳机后 ?duplex=full。外放强开全双工会"自己打断自己"(AI 录到自己的声音)，故不设默认。
      //   ?duplex=half（默认，稳）  ?duplex=full（麦克风全程开可插话；外放有回声，建议配耳机）
      const qs = new URLSearchParams(location.search);
      const dux = qs.get("duplex");
      if (dux === "half" || dux === "full") localStorage.setItem("micall_duplex", dux);
      this.halfDuplex = localStorage.getItem("micall_duplex") !== "full";  // 缺省即半双工（稳）
      // WebRTC 全双工（真打断 + 外放硬件 AEC）：配了自建 coturn（VITE_ICE_SERVERS 非空）就默认开——
      // 此时 ICE 走境内可达的 STUN/TURN，建连快且稳。没配 coturn 时默认仍走「即时接通」的 WS（稳，
      // 境内弱网不卡），仅 ?rtc=1 试。?rtc=0 可随时强制退回 WS；连不通也会自动回退，不会坏掉通话。
      const rtcParam = qs.get("rtc");
      const hasIce = !!(((import.meta.env?.VITE_ICE_SERVERS as string) || "").trim());
      this.rtcEnabled = rtcParam !== "0" && (rtcParam === "1" || hasIce) &&
                        typeof RTCPeerConnection !== "undefined" && !this.usingMockSignaling();
    } catch (e) { /* noop */ }
    this.setState({ showGuide: !seen, cookieOpen: !cookie });
    try {  // 邀请链接 ?invite=CODE：记下来，注册时带上 → 双方各得 60 分钟
      const code = new URLSearchParams(location.search).get("invite");
      if (code) { this.pendingInvite = code.trim(); localStorage.setItem("micall_invite", this.pendingInvite); }
      else { this.pendingInvite = localStorage.getItem("micall_invite") || ""; }
    } catch { /* noop */ }
    this.restoreSession();   // 用存的 token 恢复登录态 + 真实余额（接了后端才生效）
    this.loadCharacters();   // 从后端拉角色（含运营新建、剔除已删除）；失败保留内置 5 个
    this.loadInviteReward(); // 后台配置的邀请奖励（公开接口）：登录与否都显示真实值，不再写死 60
    this.loadVoices();       // 真实音色库 + 我已选音色（角色详情「音色」区据此选/试听，账号级生效）
  }

  /** 拉真实可选音色库 + 我每个角色的已选音色。失败则库空（音色区只显「原本音色」，不崩）。 */
  private async loadVoices() {
    if (!authApi.authConfigured()) return;
    const v = await authApi.getVoices();
    if (v) { this.voiceLib = v.voices; this.myVoices = v.mine || {}; this.notify(); }
  }

  /** 接后端则用后端角色列表（运营在后台可新建/删除）；演示或失败时保留内置 5 个真角色。 */
  private async loadCharacters() {
    if (!authApi.authConfigured()) return;
    const list = await authApi.getCharacters();
    if (!list || !list.length) return;
    const HUE: Record<string, number> = { lin_wan: 0, jiang_ye: 135, xia_ming: 60, gu_ci: 225, su_yao: 300 };
    this.chars = list.map((c: any, i: number) => ({
      id: c.id, name: c.name || "TA", desc: c.desc || "",
      traits: Array.isArray(c.traits) ? c.traits : [], bio: c.bio || "",
      hue: HUE[c.id] ?? ((i * 47) % 360),
    }));
    // 默认角色（运营在后台设、后端把它标 default 并排首位）：进来先选它。
    const di = list.findIndex((c: any) => c && c.default);
    if (di >= 0) this.state.charIndex = di;
    else if (this.state.charIndex >= this.chars.length) this.state.charIndex = 0;
    // 缓存真实角色 + 默认下标：下次刷新首屏直接显真实数据（不再闪内置占位名）。
    try { localStorage.setItem("micall_chars", JSON.stringify({ chars: this.chars, idx: this.state.charIndex })); } catch { /* noop */ }
    this.state.favorites = this.loadFavs();   // 角色换序后按 id 重新映射收藏下标
    this.notify();
  }

  // ── 收藏持久化（按角色 id 存，刷新/换序都不丢；favorites 状态仍是下标，由 id 反查）──
  private loadFavs(): number[] {
    try {
      const raw = localStorage.getItem("micall_favs");
      if (!raw) return [];
      const ids = JSON.parse(raw);
      if (!Array.isArray(ids)) return [];
      const out: number[] = [];
      ids.forEach((id: string) => { const i = this.chars.findIndex((c) => c.id === id); if (i >= 0 && !out.includes(i)) out.push(i); });
      return out;
    } catch { return []; }
  }
  private toggleFav() {
    this.setState((s) => {
      const favs = s.favorites.includes(s.charIndex)
        ? s.favorites.filter((x: number) => x !== s.charIndex)
        : [...s.favorites, s.charIndex];
      try { localStorage.setItem("micall_favs", JSON.stringify(favs.map((i: number) => this.chars[i]?.id).filter(Boolean))); } catch { /* noop */ }
      return { favorites: favs };
    });
  }

  // ── 音色试听（真实）：拉后端用该角色真实 voice_id 合成的 WAV 播放，不是占位动画 ──
  private previewAudio: HTMLAudioElement | null = null;
  private playPreview(ci: number, voiceId = "") {
    const cid = this.chars[ci]?.id || "";
    this.setState({ previewing: ci });
    const done = () => this.setState((s) => (s.previewing === ci ? { previewing: null } : {}));
    // 未接后端（纯演示）或无角色 id：给一个短促的状态反馈即可，不假装在放声音。
    if (!authApi.authConfigured() || !cid) { this.t.push(setTimeout(done, 1400)); return; }
    try { this.previewAudio?.pause(); } catch { /* noop */ }
    try {
      // voiceId 非空（default 视为空）→ 试听该指定音色；否则角色默认音色。
      const vid = voiceId && voiceId !== "default" ? voiceId : "";
      const a = new Audio(authApi.voicePreviewUrl(cid, vid) + "&t=" + Date.now());
      this.previewAudio = a;
      a.onended = done; a.onerror = done;
      a.play().catch(done);
      this.t.push(setTimeout(done, 14000));   // 兜底：再长也清状态
    } catch { done(); }
  }

  /** 角色 ci 当前生效音色：账号级（myVoices，跨设备）优先，回退本地选择，再回退「原本音色」。 */
  private selectedVoice(ci: number): string {
    const cid = this.characterId(ci);
    return this.myVoices[cid] ?? this.state.voiceByChar[ci] ?? "default";
  }

  /** 选定角色 ci 的音色：本地即时高亮 + 持久化 + 写后端（账号级、下一通即生效）+ 试听该音色。 */
  private pickVoice(ci: number, voiceId: string) {
    const cid = this.characterId(ci);
    this.myVoices = { ...this.myVoices, [cid]: voiceId };   // 即时高亮（与后端最终一致）
    this.setState((s) => ({ voiceByChar: { ...s.voiceByChar, [ci]: voiceId } }));
    this.savePrefs();
    void authApi.setUserVoice(cid, voiceId);   // "default" → 后端清覆盖回退出厂；其余 → 落库
    this.playPreview(ci, voiceId);
  }

  /** 刷新后凭 localStorage 的 token 向后端核验登录态，拉回邮箱与真实余额。 */
  private async restoreSession() {
    if (!authApi.authConfigured()) return;
    try {
      const u = await authApi.me();
      if (u) { this.setState({ loggedIn: true, authEmail: u.email, remaining: u.remaining_seconds }); this.loadHistory(); this.loadVoices(); return; }
    } catch { /* 离线/后端不可达：维持游客态 */ }
    // 游客：按 IP 拉真实剩余试用（刷新不重置，防刷）。用完显示 0 → 通话即提示注册。
    const g = await authApi.getGuestTrial();
    if (g != null) this.setState({ remaining: g });
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
  private realInvite: { code: string; invited: number; reward_seconds: number; reward_minutes?: number } | null = null;
  private pendingInvite = "";                 // 注册时携带的邀请码（来自 ?invite= 链接）

  private realInviteReward: number | null = null;   // 后台配置的邀请奖励（分钟），公开接口拉取
  private async loadInviteReward() {
    if (!authApi.authConfigured()) return;
    const m = await authApi.getInviteReward();
    if (m != null) { this.realInviteReward = m; this.notify(); }
  }
  private async loadInvite() {
    if (!authApi.authConfigured() || !this.state.loggedIn) { this.realInvite = null; return; }
    const inv = await authApi.getInvite();
    if (inv) { this.realInvite = inv; this.notify(); }
  }
  private copyInviteLink() {
    const code = this.realInvite ? this.realInvite.code : "MICALL-7K2F";
    const link = `${location.origin}/?invite=${encodeURIComponent(code)}`;
    try { navigator.clipboard?.writeText(link); } catch { /* noop */ }
    this.toast("邀请链接已复制，发给好友即可");
  }

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
    this.realHistory = calls.map((c, i) => {
      const idx = this.idxForCharId(c.character_id), ch = this.chars[idx];
      return { id: c.id != null ? c.id : (i + 1), name: ch?.name || "TA", hue: ch?.hue ?? 0, idx, sceneKey: c.scenario || "chat",
               scene: this.sceneNameOf(c.scenario), dur: this.fmtDur(c.duration_seconds || 0),
               when: this.fmtWhen(c.started_at) };
    });
    this.notify();
  }

  // ── 删除通话记录（账号级软删除：调后端隐藏，该用户所有设备刷新后都不再显示；后台统计不受影响）──
  private toggleHistSel(id: number) {
    this.setState((s) => { const cur: number[] = s.histSel || []; return { histSel: cur.includes(id) ? cur.filter((x: number) => x !== id) : [...cur, id] }; });
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
    this.clearToastSoon(2200);
  }
  private toast(msg: string, ms = 2000) { this.setState({ toast: msg }); this.clearToastSoon(ms); }
  /** ms 后自动清空 toast（已清则跳过一次多余渲染）。集中这一处定时清除，免到处复写样板。 */
  private clearToastSoon(ms = 2000) { this.t.push(setTimeout(() => this.setState((s) => (s.toast ? { toast: "" } : {})), ms)); }

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
    const def = this.scenarioDefs.find((d) => d.key === key);
    const live = this.isConnected();
    // 通话中切场景也支持：发完整情境指令（不是 key），AI 下一轮即进入新场景；给个确认提示让用户知道生效了。
    this.setState({ scenario: key, scenarioOpen: false, ...(live ? { toast: "已切到「" + (def?.name || "新场景") + "」，下一句起生效" } : {}) });
    if (live) {
      this.send({ type: "set_scene", scene: def?.prompt || key });
      this.clearToastSoon(2400);
    }
  }
  selectLang(l: string) { this.setState({ lang: l, langOpen: false }); this.savePrefs(); }
  selectChar(i: number) { this.setState({ charIndex: i, charOpen: false }); }

  clearTimers() { (this.t || []).forEach(clearTimeout); this.t = []; if (this.autoHangupTimer) { clearTimeout(this.autoHangupTimer); this.autoHangupTimer = null; } }

  // ── 无人说话自动挂断：通话中持续静默（用户/AI 都无新转写）达 autoHangupMin 分钟则自动结束。
  // 每次有人说话（subtitle / 被打断）就重新计时；设为「关闭」(0) 则不启用。 ──
  private autoHangupTimer: ReturnType<typeof setTimeout> | null = null;
  private callActive(): boolean {
    return ["calling", "listening", "thinking", "speaking"].includes(this.state.phase);
  }
  private armAutoHangup() {
    if (this.autoHangupTimer) { clearTimeout(this.autoHangupTimer); this.autoHangupTimer = null; }
    const mins = Number(this.state.autoHangupMin) || 0;
    if (mins <= 0 || !this.callActive()) return;
    this.autoHangupTimer = setTimeout(() => {
      this.autoHangupTimer = null;
      if (!this.callActive()) return;
      this.endCall();
      this.setState({ toast: "长时间无人说话，已自动挂断" });
      this.clearToastSoon(2600);
    }, mins * 60 * 1000);
  }

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
    return { favOpen: false, langOpen: false, settingsOpen: false, charDetailOpen: false, charOpen: false, scenarioOpen: false, billsOpen: false, inviteOpen: false, rechargeOpen: false, historyOpen: false, contactOpen: false, termsOpen: false, privacyOpen: false, moreOpen: false, authOpen: false, pwResetOpen: false, autoHangupOpen: false };
  }

  // ── 手势驱动（侧栏滑入/滑出、底部弹窗下滑关闭）；纯 state 操作，零视觉/DOM 改动 ──
  // 供 useGestures 在 touchend 判定后调用，等价于点击对应的开/关，复用既有 setState 语义。
  gestureSnapshot() {
    const s = this.state;
    const sheetOpen =
      s.favOpen || s.langOpen || s.settingsOpen || s.charDetailOpen || s.charOpen ||
      s.scenarioOpen || s.billsOpen || s.inviteOpen || s.rechargeOpen || s.contactOpen ||
      s.termsOpen || s.privacyOpen || s.moreOpen || s.authOpen || s.pwResetOpen || s.autoHangupOpen;
    // 中心模态/对话框（权限、呼叫失败、时长耗尽、切换确认、删除确认…）期间不接管手势。
    const modal =
      s.callFailed || s.outOfMins || s.pendingSwitch ||
      s.logoutConfirmOpen || s.resetOpen || s.histDelConfirm;
    return { menuOpen: !!s.menuOpen, historyOpen: !!s.historyOpen, sheetOpen: !!sheetOpen, modal: !!modal };
  }
  openMenu() { if (!this.state.menuOpen) this.setState({ menuOpen: true, historyOpen: false }); }
  openHistory() { if (!this.state.historyOpen) { this.setState({ historyOpen: true, menuOpen: false, histSelMode: false, histSel: [] }); this.loadHistory(); } }
  closeMenu() { if (this.state.menuOpen) this.setState({ menuOpen: false }); }
  closeHistory() { if (this.state.historyOpen) this.setState({ historyOpen: false }); }
  closeTopSheet() { this.setState(this.sheets()); }

  // ── realtime call flow (signaling-driven) ─────────────────────────────────
  private isConnected() {
    return ["listening", "thinking", "speaking"].includes(this.state.phase);
  }
  private characterId(idx: number) { return this.chars[idx]?.id ?? "c" + idx; }
  private currentScenarioKey() { return this.state.scenario || "chat"; }
  /** 当前场景的完整情境指令（喂 LLM 用，不是 key）。自定义场景 = 用户输入的文本；内置 = scenarioDefs[].prompt。
   *  这才是让 AI 真正进入场景的内容；start_call/set_scene 都带它，key 只留作记录/统计标签。 */
  private currentScenarioPrompt(): string {
    if (!this._scenesBuilt) { this.buildScenarios(); this._scenesBuilt = true; }
    if (this.state.scenario === "__custom") return this.state.customScene || "";
    return this.scenarioDefs.find((d) => d.key === this.currentScenarioKey())?.prompt || "";
  }

  private ensureSignaling(): SignalingClient {
    if (!this.sig) {
      this.sig = createSignaling(
        (ev) => this.onServerEvent(ev),
        // 下行 TTS PCM → 播放。RTC 已连通时 AI 音频走 <audio> 远端轨，这里丢弃 WS 音频，杜绝两路双播/回声。
        (frame) => { if (this.pc && this.pc.connectionState === "connected") return; this.player.play(frame); },
      );
    }
    return this.sig;
  }

  /** 通话接通后启动麦克风上行：每帧 PCM 经信令二进制帧发给后端 ASR。 */
  private startMicUplink() {
    if (this.micCapture || !this.micStream) return;
    const sig = this.ensureSignaling();
    this.micCapture = new MicCapture(this.micStream, (pcm) => {
      if (this.state.mute) return;                       // 静音：不上行（本地已禁音轨）
      // 默认半双工（稳）：AI 音频正在外放时不上行，从源头杜绝公放回声（自己断/凭空冒话/重复「你好」）。
      // 仅 ?duplex=full 时关掉这道门，麦克风全程开（实验性，无服务端 WebRTC 时部分机型会回声）。
      if (this.halfDuplex && this.player.isPlaying()) return;
      sig.sendAudio(pcm);
    });
    try { this.micCapture.start(); } catch { /* 不支持音频采集时静默降级 */ }
  }
  private stopMicUplink() {
    this.micCapture?.stop();
    this.micCapture = null;
  }
  /** 首通一次性提示：全双工下戴耳机打断最灵、无回声（外放靠 AEC，难免有残余）。只提示一次。 */
  private maybeEarphoneTip() {
    if (this.halfDuplex) return;   // 半双工本就不支持打断，不提示
    try {
      if (localStorage.getItem("micall_earphone_tip") === "1") return;
      localStorage.setItem("micall_earphone_tip", "1");
    } catch { return; }
    this.toast("🎧 戴耳机体验最佳：随时打断、无回声", 4200);
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
      // 开回声消除/降噪/自动增益即可（已验证稳）。不再加 channelCount/sampleRate/voiceIsolation 等
      // 约束——它们在部分机型上会让采集行为异常（卡顿/杂音），属于上次"最差更新"的一部分，撤回。
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      this.micStream = stream;
      this.applyMuteToTracks();
      return true;
    } catch {
      return false;
    }
  }

  async startCall() {
    if (this.state.phase !== "idle") return;
    this.player.resume();   // 在点击手势同步链里先解锁音频（iOS 要求），再去要麦克风
    if (!this.state.micGranted) {
      // 直接触发浏览器原生授权弹窗——不再叠一层自定义「允许」弹窗（避免双弹窗、少一次点击）。
      const ok = await this.acquireMic();
      if (ok || this.usingMockSignaling()) {
        this.setState({ micGranted: true });
      } else {
        this.toast("需要麦克风权限才能通话，请在浏览器允许后重试");
        return;
      }
    }
    void this.beginCall();
  }

  private async beginCall() {
    this.clearTimers();
    // (Re)acquire the mic for this call. Permission persists once granted, so
    // re-acquiring after a previous hang-up is silent (no prompt).
    if (this.state.micGranted && !this.micStream) await this.acquireMic();
    this.player.resume(); // 必须在点接听的手势链里，iOS 才允许出声
    this.setState({ phase: "calling", callFailed: false, lowWarned: false });
    // scenario = key（记录/统计的稳定标签）；scenario_prompt = 完整情境指令（喂 LLM，让 AI 真进入场景）。
    const msg: ClientMessage = {
      type: "start_call", character_id: this.characterId(this.state.charIndex),
      scenario: this.currentScenarioKey(), scenario_prompt: this.currentScenarioPrompt(),
    };
    this.send(msg);
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
    // 取消「拨号中」也要通知服务端结束，否则后端会话/计费成孤儿（一直挂着）。
    if (this.callActive()) { try { this.send({ type: "end_call" }); } catch { /* noop */ } }
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
    this.teardownRtc();
    this.player.flush(); // 挂断/失败：停掉残留下行音频
    if (this.micStream) { this.micStream.getTracks().forEach((tr) => tr.stop()); this.micStream = null; }
  }

  /** 服务端 WebRTC 媒体握手：麦克风 Opus 上行 + AI 语音 Opus 下行，浏览器进通信模式
   *  → 外放硬件 AEC、可随时打断。信令复用现有 WS（sendRaw）。
   *  关键保险：连不通（对称 NAT / UDP 被封 / 后端没装）一律在 7s 看门狗或 failed 状态时回退默认 WS，
   *  绝不让用户听到死寂。所以即便设成默认，网络不行的人也只是退回到稳的 WS 半双工，不会坏掉通话。 */
  /** ICE 服务器：构建期由 VITE_ICE_SERVERS（JSON）注入自建 coturn（STUN+TURN）。没配则只用 host 候选
   *  （公网 IP 直连，多数公网 IP 服务端可通；境内手机弱网/对称 NAT 需要 coturn 才稳）。 */
  private iceServers(): RTCIceServer[] {
    try {
      const raw = (import.meta.env?.VITE_ICE_SERVERS as string) || "";
      if (raw.trim()) { const v = JSON.parse(raw); if (Array.isArray(v)) return v; }
    } catch { /* 配置坏了就退 host 直连 */ }
    return [];
  }

  private async startRtc() {
    if (this.pc || !this.micStream) return;
    this.rtcFellBack = false;
    const sig = this.ensureSignaling();
    try {
      const ice = this.iceServers();
      // 境内 NAT 下 host/srflx 基本连不通，先尝试它们只会白等几秒超时 → 配了 coturn 就直接 relay，开场更快更确定。
      const pc = new RTCPeerConnection({ iceServers: ice, iceTransportPolicy: ice.length ? "relay" : "all" });
      this.pc = pc;
      this.micStream.getAudioTracks().forEach((t) => pc.addTrack(t, this.micStream!));  // 上行麦克风
      pc.ontrack = (e) => {                                                              // 下行 AI 语音 → <audio>
        if (!this.rtcAudioEl) {
          const el = document.createElement("audio");
          el.autoplay = true; el.setAttribute("playsinline", ""); (el as HTMLAudioElement & { playsInline?: boolean }).playsInline = true;
          el.style.cssText = "position:fixed;width:0;height:0;opacity:0;pointer-events:none;";
          document.body.appendChild(el); this.rtcAudioEl = el;
        }
        this.rtcAudioEl.srcObject = e.streams[0] || new MediaStream([e.track]);
        void this.rtcAudioEl.play().catch(() => { /* 手势内已解锁 */ });
      };
      pc.onicecandidate = (e) => {
        if (e.candidate) sig.sendRaw?.({ type: "rtc_ice", candidate: e.candidate.candidate, sdpMid: e.candidate.sdpMid, sdpMLineIndex: e.candidate.sdpMLineIndex });
      };
      pc.onconnectionstatechange = () => {
        const st = pc.connectionState;
        if (st === "connected") { if (this.rtcWatchdog) { clearTimeout(this.rtcWatchdog); this.rtcWatchdog = null; } }
        else if (st === "failed" || st === "closed") this.rtcFallback();
      };
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      sig.sendRaw?.({ type: "rtc_offer", sdp: offer.sdp });
      // 看门狗：4.5s 内没连上（对称 NAT / UDP 封 / 没收到 answer）→ 回退 WS。服务端已去掉境内连不通的
      // STUN（开场不再卡 ~5s），正常 1~2s 即连上；连不上的快速退回 WS，把"一上来很慢"的尾巴也压短。
      this.rtcWatchdog = setTimeout(() => { if (this.pc && this.pc.connectionState !== "connected") this.rtcFallback(); }, 2500);
    } catch {
      this.rtcFallback();   // 建不起来 → 回退 WS
    }
  }

  /** WebRTC 连不通 → 干净回退默认 WS：拆 RTC、告诉服务端别再走 RTC（下行改回 WS）、起 WS 上行麦克风。
   *  本通只回退一次。 */
  private rtcFallback() {
    if (this.rtcFellBack) return;
    this.rtcFellBack = true;
    if (this.rtcWatchdog) { clearTimeout(this.rtcWatchdog); this.rtcWatchdog = null; }
    this.teardownRtc();
    try { this.ensureSignaling().sendRaw?.({ type: "rtc_close" }); } catch { /* noop */ }
    if (this.state.phase === "listening" || this.state.phase === "thinking" || this.state.phase === "speaking") {
      this.startMicUplink();   // 仅在通话中才起 WS 上行（挂断后不需要）
    }
  }

  private teardownRtc() {
    if (this.rtcWatchdog) { clearTimeout(this.rtcWatchdog); this.rtcWatchdog = null; }
    if (this.pc) { try { this.pc.onconnectionstatechange = null; this.pc.close(); } catch { /* noop */ } this.pc = null; }
    if (this.rtcAudioEl) { try { this.rtcAudioEl.pause(); this.rtcAudioEl.srcObject = null; this.rtcAudioEl.remove(); } catch { /* noop */ } this.rtcAudioEl = null; }
  }

  /** Map server control events → state (docs/03 §4). */
  private onServerEvent(ev: ServerEvent) {
    // 挂断/空闲后丢弃迟到的「通话中」事件：否则它们会把已结束的通话改回 listening/speaking、刷新计时，
    // 造成「挂断后界面残留 / 通话像复活了 / 计时乱跳」。connected/ended/失败/时长耗尽等终止类不在此列。
    const inCall = ["state", "subtitle", "billing", "emotion", "interrupted", "low_minutes"].indexOf(ev.type) >= 0;
    if (inCall && !this.callActive()) return;
    switch (ev.type) {
      case "connected":
        this.setState({ phase: "listening", seconds: 0, subtitle: "", lines: [], callFailed: false });
        if (this.rtcEnabled) void this.startRtc();   // 实验：WebRTC 媒体面（真全双工）
        else this.startMicUplink();                  // 默认：WS 上行麦克风音频
        this.armAutoHangup();                        // 接通即开始静默计时
        this.maybeEarphoneTip();                     // 首通一次性提示：戴耳机打断更灵、无回声
        break;
      case "rtc_answer":
        if (this.pc && (ev as { sdp?: string }).sdp) {
          void this.pc.setRemoteDescription({ type: "answer", sdp: (ev as { sdp: string }).sdp }).catch(() => this.rtcFallback());  // 设远端失败 → 立刻回退 WS，不干等看门狗
        }
        break;
      case "rtc_unavailable":
        // 后端没装 aiortc → 回退默认 WS 音频路径，体验不受影响。
        this.rtcFallback();
        break;
      case "state":
        // 麦克风上行门控不再看 phase，而是看「AI 音频是否在外放」（半双工，见 startMicUplink）——
        // 更确定：服务端状态回 listening 了，但前端可能还在播缓冲音频，那段也要继续静麦防回声。
        this.setState({ phase: ev.phase });
        break;
      case "interrupted":
        // speaking → listening hard jump (skip thinking), keep transcript.
        this.player.flush(); // barge-in：用户开口 → 立刻停掉 AI 正在播的音频（flush 后麦克风自动恢复上行）
        this.setState({ phase: "listening", subtitle: "" });
        this.armAutoHangup();   // 用户开口打断 → 重新计时
        break;
      case "subtitle":
        this.armAutoHangup();   // 有人说话（用户或 AI）→ 重新计时静默挂断
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
        this.clearToastSoon(2400);
        break;
      case "out_of_minutes":
        this.clearTimers();
        this.stopMic();
        this.setState({ remaining: 0, outOfMins: true, phase: "idle", subtitle: "", lines: [] });
        break;
      case "call_failed":
        this.clearTimers();
        this.stopMic();
        this.setState({ phase: "idle", callFailed: true });
        break;
      case "connection_lost":
        // 接通后网络掉线：收掉这通、回到可重拨状态，并明确告知（别让用户对着冻屏）。
        this.clearTimers();
        this.stopMic();
        this.setState({ phase: "idle", callFailed: true, toast: "连接中断，请重新拨打" });
        this.clearToastSoon(3200);
        break;
      case "ended":
        if (this.state.phase !== "ended") { this.clearTimers(); this.stopMic(); this.setState({ phase: "ended", textMode: false }); }
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
    else if (p === "calling") subline = "";   // 拨号态顶部留白，连接动效集中到球下「正在为你接通···」一处，不重复
    else subline = this.fmt(this.state.seconds);

    // 球模式（非文字页）：球下方只显示当前角色状态，固定一行、绝不撑大布局。
    // AI 说话的逐句字幕是文字模式才展开的内容，不放这里（之前放整句字幕会把球顶上去/抖动）。
    let underOrb = "";
    if (p === "listening") underOrb = "正在聆听";
    else if (p === "thinking") underOrb = "正在思考";
    else if (p === "speaking") underOrb = "正在说话";
    else if (p === "ended") underOrb = "这次聊得怎么样？";

    let actionLabel = "轻点呼叫";
    if (p === "calling") actionLabel = "取消";
    else if (connected) actionLabel = "挂断";
    else if (p === "ended") actionLabel = "再次呼叫";
    const isCall = p === "idle" || p === "ended";
    const actionBg = isCall ? "#33C376" : "#F2554E";
    const actionGlow = isCall ? "rgba(51,195,118,.40)" : "rgba(242,85,78,.40)";

    const remainMin = Math.max(0, Math.round((this.state.remaining || 0) / 60));
    const remainLabel = "剩余 " + remainMin + " 分钟";
    let hint = "";
    if (p === "idle") hint = remainLabel;
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
    // 推荐/热门都展示全部真角色（只有 5 个出厂角色，按模运算藏掉任何一个都是 bug：后台 5 个、用户端却 4 个）；
    // 仅「收藏」按收藏夹过滤。
    })).filter((o) => charTab === "fav" ? this.state.favorites.includes(o._i) : true)
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
    // 「正在接通」的丝滑等待：拨号阶段球体保持有生气（呼吸+光场+光晕，见 orbAnim/fieldAnim/haloAnim 改用
    // connected 而非 inCall 门控），球下方走三个跳动圆点的连接动效；接通后这道动效收起，球转入沉稳通话态。
    const showUnderOrb = showOrbStatus && !phaseCalling;   // 接通中用专属圆点动效，故球下状态文字仅非拨号态显示
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
      orbHue, showOrbStatus, showUnderOrb, charDots,
      charTagline: char.desc,
      charDetail: {
        name: char.name, tagline: char.desc, bio: char.bio, traits: char.traits, hueFilter: orbHue,
        fav: this.state.favorites.includes(this.state.charIndex),
        favFill: this.state.favorites.includes(this.state.charIndex) ? "#FF4F7B" : "none",
        favStroke: this.state.favorites.includes(this.state.charIndex) ? "#FF4F7B" : "var(--dim)",
        favLabel: this.state.favorites.includes(this.state.charIndex) ? "已收藏" : "收藏",
        favLabelColor: this.state.favorites.includes(this.state.charIndex) ? "#FF4F7B" : "var(--dim)",
        favBtnBg: this.state.favorites.includes(this.state.charIndex) ? "rgba(255,79,123,.10)" : "var(--ctrl)",
        favToggle: () => this.toggleFav(),
        previewing: this.state.previewing === this.state.charIndex,
        notPreviewing: this.state.previewing !== this.state.charIndex,
        previewLabel: this.state.previewing === this.state.charIndex ? "正在试听…" : "试听声音",
        previewVoice: () => { this.playPreview(this.state.charIndex, this.selectedVoice(this.state.charIndex)); },
        ...this.profileOf(this.state.charIndex),
        voiceChips: (() => {
          const ci = this.state.charIndex;
          const sel = this.selectedVoice(ci);   // 当前生效音色（账号级 myVoices 优先，回退本地）
          const mk = (name: string, key: string) => ({
            name, sel: sel === key,
            bg: sel === key ? "rgba(110,92,255,.12)" : "var(--ctrl)",
            color: sel === key ? "#6E5CFF" : "var(--fg)",
            pick: () => this.pickVoice(ci, key),
          });
          // 「原本音色」（角色出厂默认）+ 真实音色库（MiniMax 系统音色，名字带性别便于辨识）。
          return [mk("原本音色", "default"), ...this.voiceLib.map((v) => mk(`${v.name}·${v.gender}`, v.voice_id))];
        })(),
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
      remainLabel,
      remainMinNum: Math.max(0, Math.round((this.state.remaining || 0) / 60)),
      remainPct: Math.max(4, Math.min(100, Math.round((this.state.remaining || 0) / (this.state.loggedIn ? 3600 : 60) * 100))) + "%",
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
      undoLast: () => { this.setState((s) => ({ lines: s.lines.slice(0, -1), toast: "已撤回上一句", moreOpen: false })); this.clearToastSoon(1600); },
      resetMemory: () => {
        // 真清后端记忆（事实层+理解层），不只是清屏；接了真实信令才发，Mock 下静默。
        if (!this.usingMockSignaling()) {
          try { this.send({ type: "reset_memory", character_id: this.characterId(this.state.charIndex) }); } catch { /* 未连接则忽略 */ }
        }
        this.setState({ lines: [], toast: "记忆已重置", resetOpen: false });
        this.clearToastSoon(1600);
      },
      askReset: () => this.setState({ resetOpen: true, moreOpen: false }),
      moreOpen: this.state.moreOpen,
      moreToggle: () => this.setState((s) => ({ moreOpen: !s.moreOpen })),
      moreClose: () => this.setState({ moreOpen: false }),
      resetOpen: this.state.resetOpen,
      cancelReset: () => this.setState({ resetOpen: false }),
      toast: this.state.toast,
      showToast: !!this.state.toast,
      speakerToggle: () => { this.setState((s) => ({ speaker: !s.speaker })); this.savePrefs(); },
      themeToggle: () => { this.setState({ theme: theme === "dark" ? "light" : "dark" }); this.savePrefs(); },
      themeLabel: theme === "dark" ? "深色" : "浅色",
      menuOpen: this.state.menuOpen,
      menuToggle: () => this.setState((s) => ({ menuOpen: !s.menuOpen })),
      menuClose: () => this.setState({ menuOpen: false }),
      favCurFill, favCurStroke,
      favToggleCur: () => this.toggleFav(),
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
          return { tile: t.tile, iconPath: t.iconPath, name: t.name, mins: t.mins, price: fmt(total), unit: cfg.unit, note, pick: () => { this.setState({ toast: "会员套餐即将上线，当前请用兑换码充值" }); this.clearToastSoon(2200); } };
        });
      })(),
      historyOpen: this.state.historyOpen,
      historyToggle: () => this.setState((s) => ({ historyOpen: !s.historyOpen }), () => { if (this.state.historyOpen) this.loadHistory(); }),
      historyClose: () => this.setState({ historyOpen: false, histSelMode: false, histSel: [] }),
      historyList: (() => {
        const selMode = !!this.state.histSelMode;
        const sel: number[] = this.state.histSel || [];
        return (this.realHistory ?? this.history).map((h) => {
          const picked = sel.includes(h.id);
          return { name: h.name, scene: h.scene, dur: h.dur, when: h.when, hueFilter: `hue-rotate(${h.hue}deg)`,
            selDisplay: selMode ? "flex" : "none", picked,
            checkOpacity: picked ? 1 : 0, checkBg: picked ? "#6E5CFF" : "transparent", checkBorder: picked ? "#6E5CFF" : "var(--faint)",
            pick: () => { if (this.state.histSelMode) this.toggleHistSel(h.id); else this.switchTo(h.idx, h.sceneKey); } };
        });
      })(),
      // 删除通话记录（单选/多选 + 二次确认；账号级软删除，跨设备一致；后台统计不受影响）
      histSelMode: !!this.state.histSelMode,
      // 选择入口仅登录用户可见（删除走后端、跨设备同步）；未登录看到的是空/演示历史
      histShowSelect: !this.state.histSelMode && this.state.loggedIn && (this.realHistory ?? this.history).length > 0,
      histSelCount: (this.state.histSel || []).length,
      histHasSel: (this.state.histSel || []).length > 0,
      histDelBtnBg: (this.state.histSel || []).length ? "rgba(224,89,79,.12)" : "var(--ctrl)",
      histDelBtnColor: (this.state.histSel || []).length ? "#E0594F" : "var(--faint)",
      histDelBtnText: (this.state.histSel || []).length ? ("删除（" + (this.state.histSel || []).length + "）") : "删除",
      enterHistSel: () => this.setState({ histSelMode: true, histSel: [] }),
      exitHistSel: () => this.setState({ histSelMode: false, histSel: [] }),
      histDelAsk: () => { if ((this.state.histSel || []).length) this.setState({ histDelConfirm: true }); },
      histDelCancel: () => this.setState({ histDelConfirm: false }),
      histDelConfirm: this.state.histDelConfirm,
      histDoDelete: async () => {
        const ids = (this.state.histSel || []) as number[];
        this.setState({ histDelConfirm: false });
        const ok = await authApi.deleteCalls(ids);
        if (ok) {
          await this.loadHistory();   // 重新拉后端 → 当前及其它设备刷新后都一致
          this.setState({ histSelMode: false, histSel: [], toast: "已删除所选通话记录" });
        } else {
          this.setState({ toast: "删除失败，请重试" });
        }
        this.clearToastSoon(1800);
      },
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
      applyCustomScene: () => { const v = (this.state.customSceneText || "").trim(); if (!v) return; this.setState((s) => ({ customScene: v, scenario: "__custom", scenarioOpen: false, customSceneText: "", customHistory: [v, ...s.customHistory.filter((x: string) => x !== v)].slice(0, 8) })); this.savePrefs(); if (this.isConnected()) this.send({ type: "set_scene", scene: v }); },
      customSuggestions: ["陪我准备演讲", "假装在海边散步", "哄我睡觉", "听我吐槽工作", "用英文聊天", "玩角色扮演"].map((txt) => ({ text: txt, pick: () => { this.setState((s) => ({ customScene: txt, scenario: "__custom", scenarioOpen: false, customHistory: [txt, ...s.customHistory.filter((x: string) => x !== txt)].slice(0, 8) })); this.savePrefs(); if (this.isConnected()) this.send({ type: "set_scene", scene: txt }); } })),
      customHistory: this.state.customHistory.map((txt: string) => ({ text: txt, pick: () => { this.setState((s) => ({ customScene: txt, scenario: "__custom", scenarioOpen: false, customHistory: [txt, ...s.customHistory.filter((x: string) => x !== txt)].slice(0, 8) })); this.savePrefs(); if (this.isConnected()) this.send({ type: "set_scene", scene: txt }); } })),
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
      langFromSettings: () => this.setState({ ...this.sheets(), settingsOpen: false, langOpen: true }),
      // 无人说话自动挂断（设置菜单内，默认 3 分钟，可改）：通话中持续静默达此时长自动结束。
      autoHangupLabel: this.state.autoHangupMin <= 0 ? "关闭" : (this.state.autoHangupMin + " 分钟"),
      autoHangupOpen: this.state.autoHangupOpen,
      autoHangupOpenSheet: () => this.setState({ ...this.sheets(), settingsOpen: false, autoHangupOpen: true }),
      autoHangupClose: () => this.setState({ autoHangupOpen: false }),
      autoHangupOpts: [0, 1, 2, 3, 5, 10, 15, 30].map((m) => {
        const sel = this.state.autoHangupMin === m;
        return { name: m <= 0 ? "关闭" : (m + " 分钟"), sel,
          bg: sel ? "rgba(110,92,255,.12)" : "var(--ctrl)", border: sel ? "1px solid rgba(110,92,255,.35)" : "1px solid transparent",
          color: sel ? "#6E5CFF" : "var(--fg)", check: sel ? 1 : 0,
          pick: () => { this.setState({ autoHangupMin: m, autoHangupOpen: false }); this.savePrefs(); this.armAutoHangup(); } };
      }),
      callFailed: this.state.callFailed,
      retryDial: () => this.retryDial(),
      dismissFail: () => this.setState({ callFailed: false }),
      outOfMins: this.state.outOfMins,
      outToRecharge: () => this.setState({ outOfMins: false, rechargeOpen: true }),
      dismissOut: () => this.setState({ outOfMins: false }),
      settingsFromMenu: () => this.setState({ ...this.sheets(), menuOpen: false, settingsOpen: true }),
      contactFromMenu: () => { this.setState({ ...this.sheets(), menuOpen: false, contactOpen: true }); this.loadTickets(); },
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
          this.clearToastSoon(2200);
          return;
        }
        if (!this.state.loggedIn) { this.setState({ contactOpen: false, authOpen: true, authMode: "login", toast: "请先登录再提交" }); return; }
        const res = await authApi.submitTicket(type, msg);
        if (!res.ok) { this.toast(res.error || "提交失败"); return; }
        this.setState({ contactMsg: "", toast: "已提交，回复会显示在下方" });
        this.clearToastSoon(2200);
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
          this.clearToastSoon(2000);
          return;
        }
        const reg = this.state.authMode === "register";
        const okMsg = reg ? "注册成功，已送 60 分钟免费时长" : "登录成功";
        // 纯演示（未接后端）：保留原前端假登录。
        if (!authApi.authConfigured()) {
          this.setState((s) => ({ loggedIn: true, authOpen: false, authPw: "", regPromptShown: false, remaining: reg ? Math.max(s.remaining, 3600) : s.remaining, toast: okMsg }));
          this.clearToastSoon(2200);
          return;
        }
        // 真实后端：打 /api/auth/*，存 token，余额以服务端为准。
        this.setState({ toast: reg ? "注册中…" : "登录中…" });
        const res = reg ? await authApi.register(email, pw, this.pendingInvite) : await authApi.login(email, pw);
        if (!res.ok || !res.token) {
          this.setState({ toast: res.error || "操作失败，请重试" });
          this.clearToastSoon(2200);
          return;
        }
        authApi.setToken(res.token);
        if (reg) { this.pendingInvite = ""; try { localStorage.removeItem("micall_invite"); } catch { /* noop */ } }
        this.resetSignaling();   // 让下一通电话带上新 token 重连
        this.setState({ loggedIn: true, authOpen: false, authPw: "", regPromptShown: false, remaining: res.user?.remaining_seconds ?? this.state.remaining, toast: okMsg });
        this.loadVoices();       // 登录后拉本账号已选音色 → 音色页跨设备回显一致
        this.clearToastSoon(2200);
      },
      logout: () => this.setState({ logoutConfirmOpen: true, menuOpen: false }),
      logoutConfirmOpen: this.state.logoutConfirmOpen,
      cancelLogout: () => this.setState({ logoutConfirmOpen: false }),
      confirmLogout: () => { authApi.logout().catch(() => {}); this.resetSignaling(); this.realHistory = null; this.realBills = null; this.realTickets = null; this.realInvite = null; this.setState({ loggedIn: false, logoutConfirmOpen: false, authEmail: "", toast: "已退出登录" }); this.clearToastSoon(1600); },
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
      submitNewPw: async () => {
        const a = this.state.newPw1 || "", b = this.state.newPw2 || "";
        if (a.length < 6) { this.toast("新密码至少 6 位"); return; }
        if (a !== b) { this.toast("两次密码不一致"); return; }
        if (!authApi.authConfigured()) { this.setState({ pwResetOpen: false, newPw1: "", newPw2: "", toast: "密码已修改" }); this.clearToastSoon(1800); return; }
        if (!this.state.loggedIn) { this.setState({ pwResetOpen: false, authOpen: true, authMode: "login", toast: "请先登录" }); return; }
        const res = await authApi.changePassword(a);
        if (!res.ok) { this.toast(res.error || "修改失败"); return; }
        this.setState({ pwResetOpen: false, newPw1: "", newPw2: "", toast: "密码已修改" });
        this.clearToastSoon(1800);
      },
      cancelSub: () => { this.setState({ settingsOpen: false, toast: "订阅将在本周期结束后取消" }); this.clearToastSoon(2200); },
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
      inviteFromMenu: () => { this.setState({ ...this.sheets(), menuOpen: false, inviteOpen: true }); this.loadInvite(); },
      inviteOpen: this.state.inviteOpen,
      inviteClose: () => this.setState({ inviteOpen: false }),
      // 后台配置的邀请奖励（分钟）：优先登录态拉到的值，其次公开接口值，最后才兜底 60（不写死后台设置）。
      inviteRewardMin: (this.realInvite && (this.realInvite as { reward_minutes?: number }).reward_minutes != null)
        ? (this.realInvite as { reward_minutes?: number }).reward_minutes
        : (this.realInviteReward != null ? this.realInviteReward : 60),
      inviteCode: this.realInvite ? this.realInvite.code : "MICALL-7K2F",
      copyInvite: () => this.copyInviteLink(),
      shareInvite: () => this.copyInviteLink(),
      inviteCount: this.realInvite ? this.realInvite.invited : this.invites.filter((i) => i.status === "已注册").length,
      inviteList: (this.realInvite ? [] : this.invites).map((iv) => ({
        name: iv.name, initial: iv.name[0], date: iv.date, status: iv.status, reward: iv.reward,
        done: iv.status === "已注册",
        rewardColor: iv.status === "已注册" ? "#33A06B" : "var(--faint)",
        statusColor: iv.status === "已注册" ? "var(--dim)" : "#E0954F",
      })),
      langCurrent: this.state.lang,
      langClose: () => this.setState({ langOpen: false }),
      orbAnim: connected ? "none" : orbAnim,            // 拨号时仍呼吸（有生气），仅真正通话中(listening/speaking)才静止
      fieldAnim: connected ? "none" : `spin ${fieldDur}s linear infinite`,
      haloAnim: connected ? "none" : `haloPulse ${haloDur}s ease-in-out infinite`,
      orbBg: `radial-gradient(circle at 38% 33%, rgba(255,255,255,.97), ${this.hexA(tint, .62)} 38%, ${this.hexA(tint, .20)} 64%, ${this.hexA(tint, .03)} 82%)`,
      orbShadow: `0 0 50px 4px ${this.hexA(tint, .28)}, 0 0 100px 22px rgba(110,92,255,.16)`,
      haloBg: `radial-gradient(circle, ${this.hexA(tint, .26)}, rgba(255,79,160,.10) 45%, transparent 72%)`,
    };
  }
}
