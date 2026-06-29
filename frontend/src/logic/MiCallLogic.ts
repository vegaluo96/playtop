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

// 中途 RTC 链路瞬断（connectionState=disconnected）后，给 ICE 多久自愈机会再主动回退 WS。
// 太短：1~2s 小抖动就误拆 RTC（丢硬件 AEC，本通退 WS 半双工）；太长：用户干等死寂会挂断重拨。
const RTC_DISCONNECT_GRACE_MS = 4000;

// 接通看门狗：RTC 建连多久还没 connected 就彻底放弃、拆掉 pc（通话继续走已起的 WS）。线上日志实测：大陆→香港经
// 443 TLS 中继，远端 relay 候选 ~+2s 才到、DTLS/ICE 再 ~+1s 完成 = 压在 3s 线上 → 3s 太紧会在握手将成的瞬间误杀、
// 落不到 RTC（丢硬件 AEC → WS 半双工自我打断「说一半停」）。放宽到 5s 提高 RTC 命中率。**已与 goLive 解耦**
// （接通即用 WS 起通话，见 onServerEvent:connected），故拉长看门狗只影响后台何时放弃 RTC，不再拖慢启动。
const RTC_CONNECT_WATCHDOG_MS = 5000;

// 续接重拨：网络掉线后这么久内重拨【同一角色】，后端会回灌上一通的最近几轮、AI 接着聊（不重新自我介绍）。
// 前端据此【保留字幕不清空】，让重拨画面承接旧对话、不闪空屏。窗口与后端 _CONTINUATION_WINDOW_S 对齐（4 分钟）。
const CONTINUATION_WINDOW_MS = 240000;

interface Char {
  name: string;
  hue: number;
  desc: string;
  traits: string[];
  bio: string;
  id?: string; // 出厂角色对应后端 spec 的 character_id（asset-pipeline/characters/*.json）；省略则回退 "c"+idx
  avatar?: string; // 后台生成的头像 URL（/api/avatar?c=...）；空则圆圈回退渐变球
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

/** 头像球色相：由角色 id 确定性哈希得到（0-359）。同一角色在用户端/后台/冷启动颜色恒定，
 *  且不随列表顺序变（旧版用列表下标 i*47%360，换序/默认置顶就整体变色）。后台用同一算法保持一致。 */
export function hueFromId(id: string): number {
  let h = 0;
  const s = id || "";
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return h;
}

export class MiCallLogic {
  props: MiCallProps;
  /** Called by setState to ask the React host to re-render. */
  private notify: () => void = () => {};

  // ── instance data (ported verbatim) ──────────────────────────────────────
  // 冷启动占位 = 后台设定的【默认角色 维佳/vega】本人。这样首屏（含无痕窗口·无缓存）第一帧就直接画默认角色的
  // 名字 + 球色，不再「先中性球(图一) → 秒切默认维佳(图二)」。loadCharacters 拉到全量后默认角色仍排首位(idx0)、
  // 同 id 同色同名，无任何变化、无闪。⚠️ 若将来在后台把默认角色从 vega 改掉，需同步这里的 id/name/desc。
  chars: Char[] = [
    // 头像 URL 也内置：默认角色 vega 已生成头像，首帧即直接显头像（不再先渐变球→秒切头像）；
    // 未生成时该 URL 404，img 的暗底占位会显一个中性暗圆兜底（不回到彩色球）。
    { name: "维佳", hue: hueFromId("vega"), desc: "在混沌里找非对称机会的人", traits: [], bio: "", id: "vega", avatar: "/api/avatar?c=vega" },
  ];
  // 角色已就绪：冷启动占位即真实默认角色(vega)，故首帧即可显示、不必再走中性占位窗口。
  // 返回访客由构造器读 micall_chars 缓存覆盖；loadCharacters 跑完用全量真实角色覆盖。三条路径都不闪。
  charsReady = true;
  private _scenesBuilt = false;

  state: State = { phase: "idle", seconds: 0, subtitle: "", theme: null, textMode: false, lines: [], scenario: null, scenarioOpen: false, mute: false, speaker: false, lang: "中文", langOpen: false, charIndex: 0, charOpen: false, charDetailOpen: false, rating: 0, feedback: [], menuOpen: false, favorites: [], favOpen: false, rechargeOpen: false, redeemCode: "", historyOpen: false, pendingSwitch: null, note: "", charTab: "rec", billing: "month", inviteOpen: false, billsOpen: false, sceneTab: "rec", customScene: null, customSceneText: "", expandedScene: null, customHistory: [], settingsOpen: false, toast: "", resetOpen: false, moreOpen: false, loggedIn: false, authOpen: false, authMode: "register", authEmail: "", authPw: "", regPromptShown: false, regPromptDismissed: false, pwResetOpen: false, newPw1: "", newPw2: "", cookieOpen: false, privacyOpen: false, termsOpen: false, logoutConfirmOpen: false, contactOpen: false, contactType: "建议反馈", contactMsg: "", tickets: [], voiceByChar: {}, lowWarned: false, micGranted: false, callFailed: false, remaining: 0, remainingLoaded: false, outOfMins: false, searchQ: "", previewing: null, showGuide: false, emotion: "idle", autoHangupMin: 3, autoHangupOpen: false, histSelMode: false, histSel: [], histDelConfirm: false, justConnected: false };

  t: Timer[] = [];
  i = 0;

  // realtime resources
  private sig: SignalingClient | null = null;
  private micStream: MediaStream | null = null;
  private micCapture: MicCapture | null = null;  // 麦克风 → 上行 PCM 帧
  private player = new AudioPlayer();             // 下行 TTS PCM → 播放
  private voiceRAF: number | null = null;        // 「活球」：每帧把真实语音振幅写进 --voice 供球呼吸/发光
  private halfDuplex = true;                      // 默认半双工（AI 外放时不上行，稳·无回声·无杂音）；?duplex=full 才关
  private rtcEnabled = false;                      // ?rtc=1：实验性服务端 WebRTC 媒体面（真全双工，可随时打断、外放硬件 AEC）
  private pc: RTCPeerConnection | null = null;     // WebRTC 媒体连接（仅 rtc 模式）
  private rtcAudioEl: HTMLAudioElement | null = null;  // 播远端 AI 语音轨（标准 WebRTC 远端音频，浏览器解码 Opus）
  private rtcWatchdog: ReturnType<typeof setTimeout> | null = null;  // 连不通就回退 WS 的看门狗
  private rtcDiscoTimer: ReturnType<typeof setTimeout> | null = null;  // 中途 disconnected 宽限计时器：到点仍未自愈才回退 WS
  private rtcFellBack = false;                     // 本通是否已回退（防重复回退）
  private _lostAt = 0;                              // 上次「非自愿掉线」时刻（ms）：窗口内重拨同一角色→续接、保留字幕
  private _lostCharIndex = -1;                      // 掉线时的角色下标：重拨须同一角色才续接
  private _authBusy = false;                        // 登录/注册请求进行中（防快速双击发两次）

  bills: any[] = [];

  invites: any[] = [];

  history: any[] = [];

  // 真实可选音色库（MiniMax 系统音色）+ 我每个角色已选音色（账号级，跨设备回显选中态）。
  private voiceLib: authApi.Voice[] = [];
  private myVoices: Record<string, string> = {};
  private popularity: Record<string, number> = {};   // 各角色累计通话数（/api/popular）：「热门」tab 真实排序

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
          // 缓存里可能存着旧算法的 hue（部署前是按下标算的）→ 一律按 id 现算，杜绝「首屏旧色 → 秒变新色」。
          this.chars = c.chars.map((ch: any) => ({ ...ch, hue: hueFromId(ch.id) }));
          // 首屏即定位到上次选的角色：优先按存的 id（换序也准），否则用缓存里的下标。刷新不回默认、也不闪默认。
          let idx = (typeof c.idx === "number" && c.idx >= 0 && c.idx < this.chars.length) ? c.idx : -1;
          try { const lid = localStorage.getItem("micall_lastchar"); if (lid) { const k = this.chars.findIndex((x: any) => x.id === lid); if (k >= 0) idx = k; } } catch { /* noop */ }
          if (idx >= 0) this.state.charIndex = idx;
          this.charsReady = true;   // 有真实缓存 → 首屏即可显真实角色，不走中性占位
        }
      }
    } catch { /* 缓存坏了就用内置兜底 */ }
    this.state.favorites = this.loadFavs();   // 收藏持久化：刷新不丢（按角色 id 存）
    this.loadPrefs();                         // 个人偏好持久化：主题/语言/外放/音色/自定义场景/自动挂断（刷新不丢）
    this.syncRootTheme(this.state.theme ?? "dark");   // 启动即把根文档底色刷成当前主题色，根治真机底部白条
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

  // ── 根文档底色（真机底部「白条」根治）────────────────────────────────────────
  // 我们刻意不开 viewport-fit=cover（否则要在顶部刘海再补一圈安全区，见 index.css 注释）。
  // 代价是：真机（尤其微信/iOS）会把 App 内容限制在安全区内，底部 home-indicator 那条由浏览器
  // 用「根文档背景」来画——而 html/body 此前没设背景（透明=系统白）→ 每屏底部都露出一条突兀白条。
  // 主题色 var(--bg) 只挂在 .phone/.screen 上，根文档够不着；这里直接给 html/body 兜一层与 App
  // 底边同色的纯色，安全区那条就与 App 融为一体。深色≈底边近黑(#070709)，浅色≈渐变末端(#E2ECF9)。
  private _rootBgTheme = "";
  private syncRootTheme(theme: "light" | "dark") {
    if (this._rootBgTheme === theme) return;
    this._rootBgTheme = theme;
    try {
      if (typeof document === "undefined") return;
      const base = theme === "dark" ? "#070709" : "#E2ECF9";
      document.documentElement.style.backgroundColor = base;
      if (document.body) document.body.style.backgroundColor = base;
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
    // 气泡(toast)统一自动消失：任何地方设了非空 toast 都自动清掉，杜绝「忘了 clearToastSoon →
    // 气泡一直挂着不消失」（历史多处遗漏：音色库失败/请先登录/自动挂断/识别中断…）。每次设 toast 重置计时。
    if (patch && Object.prototype.hasOwnProperty.call(patch, "toast")) this._armToastAutoClear();
    if (cb) cb();
  }

  private _toastTimer: ReturnType<typeof setTimeout> | null = null;
  private _armToastAutoClear() {
    if (this._toastTimer) { clearTimeout(this._toastTimer); this._toastTimer = null; }
    if (!this.state.toast) return;   // 清空 toast 不再排计时（避免空转/递归）
    this._toastTimer = setTimeout(() => {
      this._toastTimer = null;
      if (this.state.toast) this.setState({ toast: "" });
    }, 2800);
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
      // 配了 coturn（VITE_ICE_SERVERS 非空）就【默认开 RTC 全双工】（真打断 + 硬件 AEC）——这是产品要的。
      // 开场不等它（连接期间走 WS，见后端 audio_emit），RTC ~2s 后台连上即拿到打断；连不上自动回退 WS（恒半双工、
      // 已堵回声自我打断）。?rtc=0 可强制退 WS。无 VPN 下要 RTC 更稳，靠 coturn 的 TURN-over-TLS/443（见交付说明）。
      const rtcParam = qs.get("rtc");
      const hasIce = !!(((import.meta.env?.VITE_ICE_SERVERS as string) || "").trim());
      this.rtcEnabled = rtcParam !== "0" && (rtcParam === "1" || hasIce) &&
                        typeof RTCPeerConnection !== "undefined" && !this.usingMockSignaling();
    } catch (e) { /* noop */ }
    // 引导与 Cookie 同台会双层叠在中间「都点不了」。改为先 Cookie、后引导：引导仅在 Cookie 已处理后才出，
    // 二者不再同屏（Cookie 未处理时 guide 暂不显示，acceptCookie 后再补显引导）。
    this.setState({ showGuide: !seen && cookie, cookieOpen: !cookie });
    try {  // 邀请链接 ?invite=CODE：记下来，注册时带上 → 双方各得 60 分钟
      const code = new URLSearchParams(location.search).get("invite");
      if (code) { this.pendingInvite = code.trim(); localStorage.setItem("micall_invite", this.pendingInvite); }
      else { this.pendingInvite = localStorage.getItem("micall_invite") || ""; }
    } catch { /* noop */ }
    this.restoreSession();   // 用存的 token 恢复登录态 + 真实余额（接了后端才生效）
    this.loadCharacters();   // 从后端拉角色（含运营新建、剔除已删除）；失败保留内置 5 个
    this.loadInviteReward(); // 后台配置的邀请奖励（公开接口）：登录与否都显示真实值，不再写死 60
    this.loadVoices();       // 真实音色库 + 我已选音色（角色详情「音色」区据此选/试听，账号级生效）
    this.loadPopular();      // 各角色累计通话数（公开）：「热门」tab 真实排序
    this.prewarmSignaling(); // 提前接好信令长连接 → 点拨号即用、开头不卡握手（弱网/大陆→香港尤其明显）
  }

  /** 拉真实可选音色库 + 我每个角色的已选音色。失败则库空（音色区只显「原本音色」，不崩）。 */
  private async loadVoices() {
    if (!authApi.authConfigured()) return;
    const v = await authApi.getVoices();
    if (v) { this.voiceLib = v.voices; this.myVoices = v.mine || {}; this.notify(); }
    else if (this.state.loggedIn) {  // 已登录却拉不到（真实后端故障）→ 给提示，别让音色区空白无解释
      this.setState({ toast: "音色库加载失败，请稍后重试" });
      this.clearToastSoon(2400);
    }
  }

  /** 接后端则用后端角色列表（运营在后台可新建/删除）；演示或失败时保留内置 5 个真角色。 */
  private async loadCharacters() {
    // 任何提前返回都要置就绪：否则无后端/加载失败时头像球会一直停在中性占位。
    if (!authApi.authConfigured()) { this.charsReady = true; this.notify(); return; }
    const list = await authApi.getCharacters();
    if (!list || !list.length) { this.charsReady = true; this.notify(); return; }
    this.chars = list.map((c: any) => ({
      id: c.id, name: c.name || "TA", desc: c.desc || "",
      traits: Array.isArray(c.traits) ? c.traits : [], bio: c.bio || "",
      avatar: c.avatar || "",   // 后台生成的头像 URL（空则圆圈回退渐变球）
      hue: hueFromId(c.id),   // 由 id 确定性哈希：同角色颜色恒定、与后台一致，不随列表顺序变
      // 基础资料/喜好/富化维度从后端真值带过来（缺省留空，profileOf 按需显「—」/隐藏），让角色卡对齐后台设置。
      gender: c.gender || "", age: c.age, height: c.height, weight: c.weight,
      birthday: c.birthday || "", nationality: c.nationality || "", race: c.race || "",
      appearance: c.appearance || "", occupation: c.occupation || "", residence: c.residence || "", mbti: c.mbti || "",
      summary: c.summary || "",
      hobbies: Array.isArray(c.hobbies) ? c.hobbies : [], catchphrases: Array.isArray(c.catchphrases) ? c.catchphrases : [], quirks: Array.isArray(c.quirks) ? c.quirks : [],
      likes: Array.isArray(c.likes) ? c.likes : [], dislikes: Array.isArray(c.dislikes) ? c.dislikes : [],
    }));
    // 角色选择恢复优先级：①上次选的角色（按 id，刷新/换序都保留，登录用户不再每次回默认）；
    // ②否则后台默认角色（运营标 default 并排首位）；③再否则保持现下标（越界归零）。
    const savedId = (() => { try { return localStorage.getItem("micall_lastchar") || ""; } catch { return ""; } })();
    const si = savedId ? this.chars.findIndex((c) => c.id === savedId) : -1;
    const di = list.findIndex((c: any) => c && c.default);
    if (si >= 0) this.state.charIndex = si;
    else if (di >= 0) this.state.charIndex = di;
    else if (this.state.charIndex >= this.chars.length) this.state.charIndex = 0;
    // 缓存真实角色 + 默认下标：下次刷新首屏直接显真实数据（不再闪内置占位名）。
    try { localStorage.setItem("micall_chars", JSON.stringify({ chars: this.chars, idx: this.state.charIndex })); } catch { /* noop */ }
    this.state.favorites = this.loadFavs();   // 角色换序后按 id 重新映射收藏下标
    this.charsReady = true;   // 真实角色已就位 → 头像球/角色名从中性占位切到真实（无痕首访仅这一次）
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
      const has = s.favorites.includes(s.charIndex);
      const favs = has ? s.favorites.filter((x: number) => x !== s.charIndex) : [...s.favorites, s.charIndex];
      try { localStorage.setItem("micall_favs", JSON.stringify(favs.map((i: number) => this.chars[i]?.id).filter(Boolean))); } catch { /* noop */ }
      // 账号级同步：登录用户的收藏写到后端 → 跨设备一致（手机收的 PC 也看得到）。失败不影响本地。
      const cid = this.chars[s.charIndex]?.id;
      if (cid && this.state.loggedIn && authApi.authConfigured()) authApi.setFavorite(cid, !has).catch(() => {});
      return { favorites: favs };
    });
  }

  /** 拉「热门」真实数据：各角色累计通话数，热门 tab 据此排序（公开接口，登录与否都拿真实值）。 */
  private async loadPopular() {
    if (!authApi.authConfigured()) return;
    try { this.popularity = await authApi.getPopular(); this.notify(); } catch { /* noop */ }
  }

  /** 登录后同步收藏：把本地收藏并入账号（取并集），再用账号全集回填本地 + 状态 → 跨设备一致。 */
  private async syncFavorites() {
    if (!authApi.authConfigured() || !this.state.loggedIn) return;
    let localIds: string[] = [];
    try { const raw = localStorage.getItem("micall_favs"); if (raw) { const a = JSON.parse(raw); if (Array.isArray(a)) localIds = a.filter((x: any) => typeof x === "string"); } } catch { /* noop */ }
    const merged = await authApi.mergeFavorites(localIds);
    const ids = merged || localIds;
    try { localStorage.setItem("micall_favs", JSON.stringify(ids)); } catch { /* noop */ }
    this.setState({ favorites: this.loadFavs() });   // 从更新后的 localStorage + 当前 chars 重新映射下标（loadCharacters 完成后还会再映一次，无惧竞态）
  }

  // ── 音色试听（真实）：拉后端用该角色真实 voice_id 合成的 WAV 播放，不是占位动画 ──
  private previewAudio: HTMLAudioElement | null = null;
  private playPreview(ci: number, voiceId = "") {
    const cid = this.chars[ci]?.id || "";
    this.setState({ previewing: ci });
    const done = () => this.setState((s) => (s.previewing === ci ? { previewing: null } : {}));
    // 通话中【不试听】：试听的 <audio>.play() 会和通话音频抢同一个音频会话（尤其手机/iOS、RTC 远端轨），
    // 把通话声音挤断 →「换音色就出问题、听不到声」。换音色本就下一通才生效（已在 pickVoice 持久化），
    // 通话中试听既没用又有害 → 直接跳过。
    if (this.callActive()) { done(); return; }
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
    // voiceByChar 按 cid（角色 id 字符串）键，与 myVoices 一致：后台改角色顺序后下标会变、id 不变，避免本地音色错位。
    return this.myVoices[cid] ?? this.state.voiceByChar[cid] ?? "default";
  }

  /** 选定角色 ci 的音色：本地即时高亮 + 持久化 + 写后端（账号级、下一通即生效）+ 试听该音色。 */
  private pickVoice(ci: number, voiceId: string) {
    const cid = this.characterId(ci);
    this.myVoices = { ...this.myVoices, [cid]: voiceId };   // 即时高亮（与后端最终一致）
    this.setState((s) => ({ voiceByChar: { ...s.voiceByChar, [cid]: voiceId } }));   // 按 cid 键（换序不错位）
    this.savePrefs();
    void authApi.setUserVoice(cid, voiceId);   // "default" → 后端清覆盖回退出厂；其余 → 落库
    this.playPreview(ci, voiceId);
  }

  // ── 自定义音色：描述一句话 → 后端 LLM 在免费库里匹配一个真实音色（不给用户翻一长串列表）──
  setVoiceDesc(v: string) { this.setState({ voiceDesc: v }); }
  toggleVoiceList() { this.setState((s) => ({ voiceListOpen: !s.voiceListOpen })); }

  /** 把描述发后端 → LLM 命中库内一个免费 voice_id → 自动试听，满意再「用这个声音」。 */
  async matchVoiceByDesc() {
    const desc = (this.state.voiceDesc || "").trim();
    if (!desc) { this.toast("先描述一下你想要的声音，比如「温柔的成熟女声」"); return; }
    if (!authApi.authConfigured()) { this.toast("接入后端后可用"); return; }
    if (!this.state.loggedIn) { this.setState({ authOpen: true, authMode: "login", toast: "请先登录" }); return; }
    if (this.callActive()) { this.toast("通话中不能换音色"); return; }
    this.setState({ voiceMatching: true });
    const v = await authApi.matchVoice(desc);
    this.setState({ voiceMatching: false, voiceMatch: v });
    if (!v) { this.toast("没匹配上，换个说法再试试"); return; }
    this.playPreview(this.state.charIndex, v.voice_id);   // 自动试听匹配到的声音
  }

  /** 采用匹配到的音色：设为该角色音色（账号级、下一通生效）+ 再试听一次。 */
  useMatchedVoice() {
    const v = this.state.voiceMatch;
    if (!v) return;
    this.pickVoice(this.state.charIndex, v.voice_id);
    this.toast(`已设为「${v.name}」，下一通通话生效`);
  }

  // ── 首页「状态」：TA 当下的心情/近况/精力（per-角色，公开）──
  async openStatus() {
    if (!authApi.authConfigured()) { this.toast("接入后端后可用"); return; }
    const cid = this.characterId(this.state.charIndex);
    this.setState({ statusOpen: true, statusData: undefined });   // undefined = 加载中
    const st = await authApi.getCharacterStatus(cid);
    this.setState({ statusData: st || null });
  }
  closeStatus() { this.setState({ statusOpen: false }); }

  // ── 首页「回忆」：你和这个角色之间的关系/聊过的事（per-user×角色，需登录）──
  async openMemory() {
    if (!authApi.authConfigured()) { this.toast("接入后端后可用"); return; }
    if (!this.state.loggedIn) { this.setState({ authOpen: true, authMode: "login", toast: "登录后可查看你们的回忆" }); return; }
    const cid = this.characterId(this.state.charIndex);
    this.setState({ memoryOpen: true, memoryData: undefined });
    const m = await authApi.getMemories(cid);
    this.setState({ memoryData: m || null });
  }
  closeMemory() { this.setState({ memoryOpen: false }); }

  /** 刷新后凭 localStorage 的 token 向后端核验登录态，拉回邮箱与真实余额。 */
  private async restoreSession() {
    if (!authApi.authConfigured()) return;
    try {
      const u = await authApi.me();
      if (u) { this.setState({ loggedIn: true, authEmail: u.email, remaining: u.remaining_seconds, remainingLoaded: true }); this.loadHistory(); this.loadVoices(); this.syncFavorites(); return; }
    } catch { /* 离线/后端不可达：维持游客态 */ }
    // 游客：按 IP 拉真实剩余试用（刷新不重置，防刷）。用完显示 0 → 通话即提示注册。
    const g = await authApi.getGuestTrial();
    if (g != null) this.setState({ remaining: g, remainingLoaded: true });
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
  private realRegisterGift: number | null = null;    // 后台配置的注册赠送（分钟），公开接口拉取（不再写死 60）
  private async loadInviteReward() {
    if (!authApi.authConfigured()) return;
    const m = await authApi.getInviteReward();
    if (m != null) { this.realInviteReward = m; this.notify(); }
    const g = await authApi.getRegisterGift();
    if (g != null) { this.realRegisterGift = g; this.notify(); }
  }
  /** 注册赠送时长（分钟）：以后台配置为准，拉到前兜底 60。用于注册/弹层文案，不写死。 */
  private giftMin(): number {
    return this.realRegisterGift != null ? this.realRegisterGift : 60;
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
      return { id: c.id != null ? c.id : (i + 1), name: ch?.name || "TA", hue: ch?.hue ?? 0, avatar: ch?.avatar || "", idx, sceneKey: c.scenario || "chat",
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
      remaining: res.remaining_seconds ?? this.state.remaining, remainingLoaded: true,
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
    // Cookie 处理完才补显新手引导（首次访问时二者不同屏，避免双层叠住中间区）。
    let seen = false;
    try { seen = localStorage.getItem("micall_seen_guide") === "1"; } catch (e) { /* noop */ }
    this.setState({ cookieOpen: false, showGuide: !seen });
  }
  dismissGuide() {
    try { localStorage.setItem("micall_seen_guide", "1"); } catch (e) { /* noop */ }
    this.setState({ showGuide: false });
  }

  profileOf(idx: number) {
    const c = this.chars[idx];
    // 一律以后端真值（运营在后台设的）为准；缺省如实显「—」/留空，不再前端按下标编假数据。
    // （去掉与后端并行的假数据池=去重；前台所见 = 后台所设=对齐。slogan 也去掉：头部已显示 tagline，
    //  原 slogan 用静态场景文案、还会按 idx%5 多个角色撞同一句，属重复+假数据。）
    const cc: any = c;
    const has = (v: any) => v !== undefined && v !== null && v !== "";
    const join = (a: any) => (Array.isArray(a) && a.length) ? a.join("、") : "";
    const fmtBirthday = (b: string) => { const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(b || ""); return m ? `${m[1]}年${+m[2]}月${+m[3]}日` : b; };
    // 星座按生日算（和后端 _zodiac 同一规则，仅展示用）。md=月*100+日；cuts=每星座末日。
    const zodiac = (() => {
      const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(cc?.birthday || "");
      if (!m) return "";
      const md = +m[2] * 100 + +m[3];
      const cuts: [number, string][] = [[119, "摩羯座"], [218, "水瓶座"], [320, "双鱼座"], [419, "白羊座"], [520, "金牛座"], [621, "双子座"], [722, "巨蟹座"], [822, "狮子座"], [922, "处女座"], [1023, "天秤座"], [1122, "天蝎座"], [1221, "射手座"]];
      for (const [end, n] of cuts) if (md <= end) return n;
      return "摩羯座";
    })();
    const dash = "—";
    const g = has(cc?.gender) ? cc.gender : "";
    const hobbies = join(cc?.hobbies), catchphrases = join(cc?.catchphrases), quirks = join(cc?.quirks);
    return {
      gender: g || dash,
      genderColor: g === "女" ? "#FF6FA5" : (g === "男" ? "#5B8DEF" : "#9A9DA7"),
      age: has(cc?.age) ? cc.age : dash,
      zodiac: zodiac || dash,
      mbti: has(cc?.mbti) ? cc.mbti : dash,
      occupation: has(cc?.occupation) ? cc.occupation : dash,
      residence: has(cc?.residence) ? cc.residence : dash,
      height: has(cc?.height) ? cc.height : dash,
      weight: has(cc?.weight) ? cc.weight : dash,
      birthday: has(cc?.birthday) ? fmtBirthday(cc.birthday) : dash,
      nationality: has(cc?.nationality) ? cc.nationality : dash,
      race: has(cc?.race) ? cc.race : dash,
      nickname: c.name,
      tags: Array.isArray(cc?.traits) ? cc.traits.slice(0, 4) : [],
      // 富化维度（prose 段，空则前端 sc-if 隐藏，不显空标题）
      appearance: has(cc?.appearance) ? cc.appearance : "", hasAppearance: has(cc?.appearance),
      summary: has(cc?.summary) ? cc.summary : "", hasSummary: has(cc?.summary),
      hobbies, hasHobbies: !!hobbies,
      catchphrases, hasCatchphrases: !!catchphrases,
      quirks, hasQuirks: !!quirks,
      likes: (Array.isArray(cc?.likes) && cc.likes.length) ? cc.likes.join("、") : dash,
      dislikes: (Array.isArray(cc?.dislikes) && cc.dislikes.length) ? cc.dislikes.join("、") : dash,
    };
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
  selectChar(i: number) { this.rememberChar(i); this.setState({ charIndex: i, charOpen: false }); }
  /** 记住用户选的角色（按 id 存，列表换序也不丢）：刷新后 loadCharacters/构造器优先恢复它，不每次回默认。 */
  private rememberChar(i: number) {
    try { const id = this.chars[i]?.id; if (id) localStorage.setItem("micall_lastchar", id); } catch { /* noop */ }
  }

  clearTimers() { (this.t || []).forEach(clearTimeout); this.t = []; if (this.autoHangupTimer) { clearTimeout(this.autoHangupTimer); this.autoHangupTimer = null; } if (this.connectTimer) { clearTimeout(this.connectTimer); this.connectTimer = null; } this._stopReveal(); }

  // ── 字幕逐字揭开：按后端给的这句预估时长(dur 秒)在该时长内把文字揭完，让字幕跟住真实语音，
  //    而不是整句一下全出来再把后面顶走。无 dur（旧后端）→ 直接显全，优雅降级。 ──
  private _revealTimer: ReturnType<typeof setInterval> | null = null;
  _revealText = "";
  _revealLen = 0;
  private _startReveal(text: string, durSec: number) {
    this._stopReveal();
    this._revealText = text || "";
    const len = this._revealText.length;
    if (!durSec || durSec <= 0 || len === 0) { this._revealLen = len; return; }
    this._revealLen = 0;
    const start = Date.now();
    const durMs = durSec * 1000;
    this._revealTimer = setInterval(() => {
      const n = Math.min(len, Math.floor((len * (Date.now() - start)) / durMs));
      this._revealLen = n;
      if (n >= len) this._stopReveal();
      this.notify();
    }, 50);
  }
  private _stopReveal() { if (this._revealTimer) { clearInterval(this._revealTimer); this._revealTimer = null; } }

  // ── 无人说话自动挂断：通话中持续静默（用户/AI 都无新转写）达 autoHangupMin 分钟则自动结束。
  // 每次有人说话（subtitle / 被打断）就重新计时；设为「关闭」(0) 则不启用。 ──
  private autoHangupTimer: ReturnType<typeof setTimeout> | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;   // 接通仪式：justConnected 短暂为真，触发一次性绽放
  private callActive(): boolean {
    return ["calling", "listening", "thinking", "speaking"].includes(this.state.phase);
  }
  /** 从「正在接通」loading 转入「可对话」。RTC 开启时，等 RTC 真连上(或回退)才调——让 loading 真正盖住
   *  建连过程，loading 一结束就是已就绪。只在还卡在 calling 时转（防迟到/重复）。 */
  private goLive() {
    if (this.state.phase !== "calling") return;
    this.player.stopRing();    // 接通提示音停（传输已就绪）
    this.startVoiceMeter();    // 「活球」启动：球随真实语音呼吸/发光
    // 续接重拨：若是窗口内重拨【同一角色】（上次非自愿掉线），保留字幕承接旧对话、不闪空屏（后端会回灌上下文接着聊）。
    const continuing = this._lostAt > 0 && (Date.now() - this._lostAt) < CONTINUATION_WINDOW_MS
                       && this._lostCharIndex === this.state.charIndex;
    this._lostAt = 0; this._lostCharIndex = -1;   // 一次性消费，避免后续误判
    this.setState({ phase: "listening", seconds: 0, subtitle: "",
                    lines: continuing ? this.state.lines : [], callFailed: false, justConnected: true });
    // 接通仪式：一次性绽放（声纳般的光环向外散开），~900ms 后收起标记，绽放层卸载
    if (this.connectTimer) clearTimeout(this.connectTimer);
    this.connectTimer = setTimeout(() => { this.connectTimer = null; this.setState({ justConnected: false }); }, 900);
    // 告诉后端「传输已就绪」→ AI 接起来主动开口（开场白走在已就绪传输上）。phase 守卫保证整通只发一次。
    // 带上客户端真实时区（UTC 偏移分钟，UTC+8=480）→ 后端「现在几点」按用户本地算，出海用户不再被当成 UTC+8。
    try { this.ensureSignaling().send({ type: "ready", tz: -new Date().getTimezoneOffset() }); } catch { /* noop */ }
    this.armAutoHangup();      // 进入可对话才开始静默计时
    this.maybeEarphoneTip();   // 首通一次性提示：戴耳机打断更灵
  }

  // 「活球」声纹驱动：每帧读真实语音振幅 → 写 CSS 变量 --voice(0..1)，球的呼吸/发光/核心亮度跟着它走。
  // 不走 setState（避免每帧整树重渲）——直接改 :root 自定义属性，CSS 自行响应。尊重 prefers-reduced-motion。
  private startVoiceMeter() {
    if (this.voiceRAF !== null) return;
    if (typeof window === "undefined" || typeof requestAnimationFrame === "undefined" || typeof document === "undefined") return;
    try { if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return; } catch { /* noop */ }
    const root = document.documentElement;
    const tick = () => {
      if (!this.callActive()) { this.voiceRAF = null; root.style.setProperty("--voice", "0"); return; }
      const v = this.player.level();
      root.style.setProperty("--voice", v.toFixed(3));
      this.voiceRAF = requestAnimationFrame(tick);
    };
    this.voiceRAF = requestAnimationFrame(tick);
  }
  private stopVoiceMeter() {
    if (this.voiceRAF !== null && typeof cancelAnimationFrame !== "undefined") cancelAnimationFrame(this.voiceRAF);
    this.voiceRAF = null;
    try { if (typeof document !== "undefined") document.documentElement.style.setProperty("--voice", "0"); } catch { /* noop */ }
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
  /** 把一个 hex 颜色按 deg 旋转色相，得到「该角色的真实色」(与球上 hue-rotate 滤镜同源)，
   *  返回 rgba 串。用于把角色气场染进整屏氛围而无需对内容套滤镜。a=alpha。 */
  rotA(hex: string, deg: number, a: number) {
    const h = (hex || "#AAB8FF").replace("#", "");
    const n = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
    let r = parseInt(n.slice(0, 2), 16) / 255, g = parseInt(n.slice(2, 4), 16) / 255, b = parseInt(n.slice(4, 6), 16) / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
    let hh = 0, s = 0; const d = max - min;
    if (d) {
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      hh = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
      hh /= 6;
    }
    hh = (hh + (((deg % 360) + 360) % 360) / 360) % 1;
    const hue2 = (p: number, q: number, t: number) => {
      if (t < 0) t += 1; if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    if (s) {
      const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
      r = hue2(p, q, hh + 1 / 3); g = hue2(p, q, hh); b = hue2(p, q, hh - 1 / 3);
    } else { r = g = b = l; }
    return `rgba(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)},${a})`;
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

  /** 游客引导注册（注册即送 60 分钟免费时长）：关掉所有面板/菜单 → 打开注册弹层。
   *  extra 附加 state（如时长用完弹层要带 outOfMins:false）。复用 openRegister 的语义。 */
  private goRegister(extra: Partial<State> = {}) {
    this.setState({ ...this.sheets(), menuOpen: false, authOpen: true, authMode: "register",
      regPromptShown: false, regPromptDismissed: true, ...extra });
  }

  /** 需要登录才有意义的功能（邀请、账单等账号级数据）：游客 → 关菜单/面板、弹登录/注册并提示，
   *  绝不打开空壳面板假装有数据；已登录 → 执行 onOk。统一收口，避免「游客点了却是空/坏」的逻辑错。 */
  private requireAuth(onOk: () => void, toast: string, mode: "login" | "register" = "login") {
    if (this.state.loggedIn) { onOk(); return; }
    this.setState({ ...this.sheets(), menuOpen: false, authOpen: true, authMode: mode,
      regPromptShown: false, regPromptDismissed: true, toast });
  }

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
    // 预热的连接若闲置被掐断（CLOSING/CLOSED）→ 丢弃重建，避免点拨号把 start_call 发进死连接、拨不出。
    if (this.sig && this.sig.isDead?.()) {
      try { this.sig.close(); } catch { /* noop */ }
      this.sig = null;
    }
    if (!this.sig) {
      this.sig = createSignaling(
        (ev) => this.onServerEvent(ev),
        // 下行 TTS PCM → 播放。RTC 已连通时 AI 音频走 <audio> 远端轨，这里丢弃 WS 音频，杜绝两路双播/回声。
        // 挂断/结束后必须丢弃在途音频帧：WS 不随挂断关闭，后端取消生成有几十~上百毫秒延迟，期间已发出的
        // 帧若仍喂进 player 会被排进抖动缓冲继续播 → 「挂断后角色还把没说完的话说完」。仅在通话存活时收音。
        (frame) => { if (!this.callActive()) return; if (this.pc && this.pc.connectionState === "connected") return; this.player.play(frame); },
      );
    }
    return this.sig;
  }

  /** 预热信令连接：停留在拨号页时就提前把 WebSocket 接好（接通后它持久复用，不随挂断关闭）。点拨号即用
   *  已建好的长连接，省掉开头的 TCP+TLS+WS 握手卡顿（大陆→香港弱网下尤其明显）。预热失败/闲置被掐也无所谓，
   *  拨号时 ensureSignaling 会自动重建，绝不影响功能。 */
  private prewarmSignaling(): void {
    if (this.usingMockSignaling()) return;   // mock 无需预热
    try { this.ensureSignaling(); } catch { /* 预热失败：拨号时再建 */ }
  }

  /** 通话接通后启动麦克风上行：每帧 PCM 经信令二进制帧发给后端 ASR。 */
  private startMicUplink() {
    if (this.micCapture || !this.micStream) return;
    const sig = this.ensureSignaling();
    this.micCapture = new MicCapture(this.micStream, (pcm) => {
      if (this.state.mute) return;                       // 静音：不上行（本地已禁音轨）
      // WS 路径【恒半双工】：AI 在说话期间一律不上行——这条路没有硬件 AEC，全程开麦必把外放的 AI 声音回灌
      // 进麦克风，被服务器当成「你在插话」→ 触发打断「说到一半就停」。全双工打断只有 RTC（硬件 AEC）下才安全，
      // 那条走 addTrack、不经此函数；所以这里【无视 duplex=full】，从源头堵死回声自我打断。
      // 门控两条都要：① 音频在外放（含 600ms 拖尾，盖喇叭输出延迟）；② AI 这一轮还在进行（thinking/speaking）——
      // 后者堵住「句与句之间音频短暂停顿、playhead 已追上」的缝（那一瞬麦克风若开，正好录到 AI 的话）。
      if (this.player.isPlaying() || this.state.phase === "thinking" || this.state.phase === "speaking") return;
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
    // 拨号前先停掉音色试听音频——否则试听后直接拨号，试听会和通话叠着一起播。
    try { this.previewAudio?.pause(); this.previewAudio = null; } catch { /* noop */ }
    this.setState((s) => (s.previewing != null ? { previewing: null } : {}));
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
    if (this.state.phase === "idle" || this.state.phase === "ended") return;  // 防重入：autoHangup 与手动挂断并发时别重复播挂断音/重发 end_call
    this.clearTimers();
    this.player.playHangup();   // 挂断音效，与接通提示音呼应（stopMic 的 flush 会停 AI 音频/接通音，但不影响它）
    if (this.isConnected() || this.state.phase === "calling") this.send({ type: "end_call" });
    this.stopMic(); // release the microphone on hang-up (turns off the mic indicator)
    this.setState({ phase: "ended", textMode: false, rating: 0, feedback: [] });
  }

  switchTo(idx: number, sceneKey: string) {
    if (this.isConnected()) { this.setState({ pendingSwitch: { idx, sceneKey }, historyOpen: false }); return; }
    this.rememberChar(idx);
    this.setState({ charIndex: idx, scenario: sceneKey, historyOpen: false });
  }
  confirmSwitch() {
    const ps = this.state.pendingSwitch;
    this.clearTimers();
    if (this.isConnected() || this.state.phase === "calling") this.send({ type: "end_call" });
    this.stopMic();
    this.rememberChar(ps.idx);
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
    this.stopVoiceMeter();   // 「活球」停：--voice 归 0，球回静息
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
    if (this.pc) return;
    this.rtcFellBack = false;
    // 没麦克风（权限被撤/设备被占，micGranted 旧值为真但 acquireMic 失败）→ 绝不能卡在 loading：
    // 走 rtcFallback（teardown + 通知后端 rtc_close + 起 WS 上行 + goLive 发 ready），让通话照常推进。
    if (!this.micStream) { this.rtcFallback(); return; }
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
        if (st === "connected") {
          if (this.rtcWatchdog) { clearTimeout(this.rtcWatchdog); this.rtcWatchdog = null; }
          if (this.rtcDiscoTimer) { clearTimeout(this.rtcDiscoTimer); this.rtcDiscoTimer = null; }  // 自愈成功 → 撤销宽限回退，保住 RTC（硬件 AEC 全双工）
          this.stopMicUplink();   // 防御：RTC 接管上行（mic 轨已 addTrack 进 pc）→ 确保无 WS 上行残留（如 disconnected 自愈后）
          this.goLive();          // 已在 listening 时为 no-op（phase 守卫），不会清空转写
        } else if (st === "disconnected") {
          // 中继瞬断：下行 RTC 轨不再吐帧 → AI 声音僵住。先给 ~4s 宽限让 ICE 自愈（多数瞬断会自己回 connected）；
          // 到点仍没回来就主动 rtcFallback（发 rtc_close → 后端下行切回 WS，声音续上），而不是干等浏览器默认
          // 15~30s 才转 failed —— 那段死寂正是「说一半卡住、只能挂断重拨」的来源。
          if (!this.rtcDiscoTimer) {
            this.rtcDiscoTimer = setTimeout(() => {
              this.rtcDiscoTimer = null;
              if (this.pc && this.pc.connectionState !== "connected") this.rtcFallback();
            }, RTC_DISCONNECT_GRACE_MS);
          }
        } else if (st === "failed" || st === "closed") {
          this.rtcFallback();
        }
      };
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      sig.sendRaw?.({ type: "rtc_offer", sdp: offer.sdp });
      // 接通看门狗（见 RTC_CONNECT_WATCHDOG_MS）：开场音频已不等 RTC（连接期间走 WS，见后端 audio_emit），
      // 给足时间让 443 中继握手做完落到 RTC（拿全双工硬件 AEC），真连不上才退 WS。
      this.rtcWatchdog = setTimeout(() => { if (this.pc && this.pc.connectionState !== "connected") this.rtcFallback(); }, RTC_CONNECT_WATCHDOG_MS);
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
    if (this.callActive()) {
      this.startMicUplink();   // 接通中/通话中回退 → 起 WS 上行麦克风
      this.goLive();           // 若还卡在「正在接通」（RTC 没连上就回退）→ 转入可对话、结束 loading
    }
  }

  private teardownRtc() {
    if (this.rtcWatchdog) { clearTimeout(this.rtcWatchdog); this.rtcWatchdog = null; }
    if (this.rtcDiscoTimer) { clearTimeout(this.rtcDiscoTimer); this.rtcDiscoTimer = null; }
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
        // 拨通=「接通中」loading：RTC 开启时只起 RTC、【停在 loading】，等真连上(或回退 WS)才 goLive
        // （见 onconnectionstatechange:"connected" / rtcFallback）——把 RTC 连好、AEC 热好，AI 才接起来开口，
        // 开场白直接走在已就绪传输上（不切通道=不顿、AEC 已在=不自我打断、loading 盖住建连=不冷场）。
        // 不开 RTC：WS 立即就绪 → 直接起上行 + goLive。
        if (this.rtcEnabled) { this.player.startRing(); void this.startRtc(); }
        else { this.startMicUplink(); this.goLive(); }
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
        // 【接通中 loading 期(phase==="calling")忽略服务端状态】：后端 start() 即发 state:listening，但本端要
        // 停在 loading 直到传输就绪(goLive：RTC 连上/回退 WS)才退出——否则会被 state:listening 提前结束 loading、
        // 且 goLive(发 ready) 永不触发 → AI 不开口。就绪后(已非 calling)再照常按服务端状态切 thinking/speaking/listening。
        if (this.state.phase === "calling") break;
        // 麦克风上行门控不再看 phase，而是看「AI 音频是否在外放」（半双工，见 startMicUplink）——
        // 更确定：服务端状态回 listening 了，但前端可能还在播缓冲音频，那段也要继续静麦防回声。
        this.setState({ phase: ev.phase });
        break;
      case "interrupted":
        // speaking → listening hard jump (skip thinking), keep transcript.
        this.player.flush(); // barge-in：用户开口 → 立刻停掉 AI 正在播的音频（flush 后麦克风自动恢复上行）
        this._stopReveal();   // 打断：字幕揭字停在当前位置（≈实际说出的部分）
        this.setState({ phase: "listening", subtitle: "" });
        this.armAutoHangup();   // 用户开口打断 → 重新计时
        break;
      case "subtitle":
        this.armAutoHangup();   // 有人说话（用户或 AI）→ 重新计时静默挂断
        if (ev.role === "ai") {
          this.setState((s) => ({ subtitle: ev.text, lines: [...s.lines, { role: "ai", text: ev.text }].slice(-8) }));
          this._startReveal(ev.text, (ev as any).dur || 0);   // 在这句预估时长内逐字揭开，跟住真实语音
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
        // 服务端权威余额：seconds=elapsed 驱动计时文案。游客通话中【不弹注册横幅】（先完整体验这 1 分钟试用），
        // 试用结束由 out_of_minutes 的用完弹层引导注册——故这里只更新计时/余额，没有横幅分支。
        this.setState({ seconds: ev.elapsed, remaining: ev.remaining_seconds, remainingLoaded: true });
        break;
      case "low_minutes":
        // 仅对登录用户提示「快用完了」。游客试用就 1 分钟，阈值=60 秒会在第 1 秒就触发，
        // 弹「仅剩 1 分钟」反而打断体验、显得催促——游客不提示，让他把 1 分钟用完再由用完弹层引导。
        if (this.state.loggedIn) { this.setState({ lowWarned: true, toast: "时长仅剩 1 分钟" }); this.clearToastSoon(2400); }
        break;
      case "out_of_minutes":
        this.clearTimers();
        this.stopMic();
        this.setState({ remaining: 0, remainingLoaded: true, outOfMins: true, phase: "idle", subtitle: "", lines: [] });
        break;
      case "asr_failed":
        // 实时语音识别断流：通话不中断（文字仍可发），提示用户改用文字继续，别让 TA 对着没反应的麦克风干等。
        this.setState({ toast: "语音识别中断，可用文字继续对话" });
        this.clearToastSoon(2600);
        break;
      case "call_failed":
        // 只有【正在拨号/通话中】才弹「接通失败」。首页空闲时这条多半是预热 WS 报错（从未通话→everConnected=false→
        // signaling 误判成「拨号失败」）→ 跟通话无关，静默丢掉死连接、绝不弹框骚扰一个没在拨号的人。
        if (!this.callActive()) {
          try { this.sig?.close(); } catch { /* noop */ }
          this.sig = null;
          break;
        }
        this.clearTimers();
        this.stopMic();
        this.setState({ phase: "idle", callFailed: true });
        break;
      case "connection_lost":
        // 只有【正在通话/拨号中】掉线才提示重连。首页空闲时这条多半是「预热/复用的旧 WS 被浏览器后台
        // 挂起后关闭」（切出去过会儿回来）——跟通话无关 → 静默丢掉死连接（下次拨号 ensureSignaling 自动
        // 重建），绝不弹「重连」打扰一个根本没打电话的人。
        if (!this.callActive()) {
          try { this.sig?.close(); } catch { /* noop */ }
          this.sig = null;
          break;
        }
        // 接通后网络掉线（非自愿）：收掉这通、回到可重拨状态。记下时刻+角色，窗口内重拨同一角色即续接
        // （后端回灌最近几轮、AI 接着聊；前端保留字幕不闪空屏）。文案也把「接着聊」的预期立住。
        this.clearTimers();
        this.stopMic();
        this._lostAt = Date.now();
        this._lostCharIndex = this.state.charIndex;
        this.setState({ phase: "idle", callFailed: true, toast: "信号断了，重新拨入就能接着聊" });
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
    // 默认深色：这套视觉是深色原生（头像靠白 rim-light + screen 发光 + 暗角浮起，浅色复现不出）。
    // 用户显式选过浅色（state.theme==="light"，从 prefs 读）则尊重其选择；未选过 → 深色。
    const theme = this.state.theme ?? this.props.theme ?? "dark";
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
    // 真实余额/试用拉到后才显示「剩余 X 分钟」；拉到前留空，不再闪一个写死的「剩余 1 分钟」。
    const remainLabel = this.state.remainingLoaded ? ("剩余 " + remainMin + " 分钟") : "";
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
      const full = typeof m === "string" ? m : m.text;
      // 仅「最后一句 AI」按 dur 逐字揭开；前面的句子（已说完）一律显全。
      const animating = idx === arr.length - 1 && !isUser && full === this._revealText && this._revealLen < full.length;
      // 景深排版：最新一句是主角（大、实、weight 稍重），旧句按距离层层后退（字号小、透明度递减），
      // 像声音从远处飘来。最新 AI 句在逐字揭开时尾部带一个呼吸光标。颜色仍按你/TA 区分。
      const dist = arr.length - 1 - idx;                       // 0=最新
      const fontSize = dist === 0 ? "19px" : dist === 1 ? "16.5px" : "15px";
      const opacity = dist === 0 ? "1" : String(Math.max(0.34, 0.8 - (dist - 1) * 0.16).toFixed(2));
      const weight = dist === 0 ? "460" : "400";
      return {
        text: animating ? full.slice(0, this._revealLen) : full,   // 兼容旧的纯字符串
        align: isUser ? "flex-end" : "flex-start",   // 块靠右/靠左（align-self）
        // 文字本身也右排：长句换行时末行才会贴右边缘，否则块虽靠右但文字左排 → 看着像没对齐（用户反馈）。
        textAlign: isUser ? "right" : "left",
        color: isUser ? "#6E5CFF" : "var(--fg)",     // 深浅交给 opacity，颜色只分你(紫)/TA(前景)
        fontSize, opacity, weight,
        caretDisplay: animating ? "inline-block" : "none",   // 仅最新 AI 逐字揭开时显呼吸光标
      };
    });

    const char = this.chars[this.state.charIndex % this.chars.length];
    const charName = char.name;
    // 未就绪（无痕首访的加载窗口）：球走中性基色(hue-rotate 0)，等真实默认角色到位再切，
    // 不再「先占位色 → 秒变真实色」。就绪后才用该角色的确定性 id 色相。
    const orbHue = this.charsReady ? `hue-rotate(${char.hue}deg)` : "hue-rotate(0deg)";
    // 头像：有则圆圈显真实头像（大球/列表/详情都填满），无则回退渐变球（色相光晕始终保留）。
    const orbAvatar = (this.charsReady && char.avatar) ? char.avatar : "";
    // 乐章②+⑦ 气场与暗场：整屏氛围染上「这个角色」的色（换角色换气氛），叠一层暗角让球更聚光；
    // 通话时更浓、更私密。纯背景层叠在 var(--bg) 之上，不影响内容；未就绪用中性 tint 不抢色。
    const isDark = theme === "dark";
    // 有头像时把整屏气场色压淡（头像为主角，避免整屏也「球化」）；无头像的渐变球保持原浓度。
    const auraA = ((isDark ? 0.20 : 0.12) + (connected ? 0.05 : 0)) * (orbAvatar ? 0.55 : 1);
    const auraColor = this.charsReady ? this.rotA(tint, char.hue, auraA) : this.hexA(tint, auraA * 0.5);
    const vignette = isDark
      ? `radial-gradient(125% 115% at 50% 33%, transparent 50%, rgba(0,0,0,${connected ? 0.36 : 0.24}))`
      : `radial-gradient(125% 118% at 50% 38%, transparent 60%, rgba(22,14,42,${connected ? 0.075 : 0.05}))`;
    const screenBg = `${vignette}, radial-gradient(130% 92% at 50% 12%, ${auraColor}, transparent 58%), var(--bg)`;
    const charTab = this.state.charTab;
    const charList = this.chars.map((c, i) => ({
      name: c.name,
      desc: c.desc,
      hueFilter: `hue-rotate(${c.hue}deg)`,
      avatar: c.avatar || "", avatarDisplay: c.avatar ? "block" : "none",
      bg: "var(--ctrl)",
      border: i === this.state.charIndex ? "2px solid #6E5CFF" : "2px solid transparent",
      check: i === this.state.charIndex ? 1 : 0,
      favOp: this.state.favorites.includes(i) ? 1 : 0,
      _i: i,
      _id: c.id || "",
      pick: () => this.selectChar(i),
    // 推荐展示全部真角色；「收藏」按收藏夹过滤；「热门」按真实通话数降序（见下）。
    })).filter((o) => charTab === "fav" ? this.state.favorites.includes(o._i) : true)
      .filter((o) => { const q = (this.state.searchQ || "").trim(); return !q || o.name.includes(q) || o.desc.includes(q); });
    // 「热门」按真实累计通话数降序（/api/popular 的真值）→ 不再是「全展示」的假热门。同热度保持原序。
    if (charTab === "hot") charList.sort((a, b) => (this.popularity[b._id] || 0) - (this.popularity[a._id] || 0));
    const charListEmpty = charList.length === 0;
    const charDots = this.charsReady ? this.chars.map((_, i) => ({ op: i === this.state.charIndex ? 0.9 : 0.22 })) : [];   // 未就绪不显占位圆点
    const curFav = this.state.favorites.includes(this.state.charIndex);
    const favCurFill = curFav ? "#FF4F7B" : "none";
    const favCurStroke = curFav ? "#FF4F7B" : "var(--fg)";
    const favList = this.chars.map((c, i) => ({ name: c.name, desc: c.desc, hueFilter: `hue-rotate(${c.hue}deg)`, avatar: c.avatar || "", avatarDisplay: c.avatar ? "block" : "none", _i: i, pick: () => { this.rememberChar(i); this.setState({ charIndex: i, favOpen: false }); } })).filter((o) => this.state.favorites.includes(o._i));
    const hasFavs = favList.length > 0;
    const noFavs = favList.length === 0;
    const phaseIdle = p === "idle";
    const phaseEnded = p === "ended";
    // 简介(tagline)在 idle + 接通中(calling)都显示，跟未拨打状态对齐；真正接通(connected)/结束后才换成计时。
    const showTagline = this.charsReady && (p === "idle" || p === "calling");   // 未就绪先不显占位简介
    const showOrbStatus = p !== "idle" && p !== "calling";   // 头部计时仅真正通话/结束态显示（接通中让位给简介）
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
      title: p === "ended" ? "通话结束" : (this.charsReady ? charName : " "),   // 未就绪显空(占位高度不塌)，不闪占位名
      orbHue, showOrbStatus, showTagline, showUnderOrb, charDots,
      orbAvatar, hasOrbAvatar: !!orbAvatar, noOrbAvatar: !orbAvatar,   // 有头像→只显头像层(下方渐变球不渲染)；无头像→渐变球兜底
      connectRitual: !!this.state.justConnected,   // 接通瞬间：一次性绽放光环（挂载即播一次）
      screenBg,   // 乐章②+⑦：每角色气场 + 暗场，叠在 var(--bg) 之上

      charTagline: char.desc,
      charDetail: {
        name: char.name, tagline: char.desc, bio: char.bio, traits: char.traits, hueFilter: orbHue,
        avatar: orbAvatar, avatarDisplay: orbAvatar ? "block" : "none",
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
        // 「TA 的原声」= 角色在后台设定的音色（含克隆音色）：传空 voiceId → 后端按角色 spec 的 voice_id 合成，
        // 不再用用户个人选过的音色(myVoices/voiceByChar)顶替，故和后台音色设置一致。
        previewVoice: () => { this.playPreview(this.state.charIndex, ""); },
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
        // 自定义音色：描述 → LLM 匹配（默认入口，不再让用户翻一长串）。
        voiceDesc: this.state.voiceDesc || "",
        onVoiceDesc: (e: any) => this.setVoiceDesc(e.target.value),
        doMatchVoice: () => this.matchVoiceByDesc(),
        voiceMatching: !!this.state.voiceMatching,
        matchLabel: this.state.voiceMatching ? "匹配中…" : "匹配声音",
        hasVoiceMatch: !!this.state.voiceMatch,
        voiceMatchName: this.state.voiceMatch ? `${this.state.voiceMatch.name} · ${this.state.voiceMatch.gender}` : "",
        useMatchedVoice: () => this.useMatchedVoice(),
        replayMatch: () => { const v = this.state.voiceMatch; if (v) this.playPreview(this.state.charIndex, v.voice_id); },
        voiceListOpen: !!this.state.voiceListOpen,
        toggleVoiceList: () => this.toggleVoiceList(),
        voiceListLabel: this.state.voiceListOpen ? "收起" : "从全部音色里挑",
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
      // 首页「状态 / 回忆」入口 + 弹层视图模型
      openStatus: () => this.openStatus(),
      openMemory: () => this.openMemory(),
      statusOpen: !!this.state.statusOpen,
      closeStatus: () => this.closeStatus(),
      memoryOpen: !!this.state.memoryOpen,
      closeMemory: () => this.closeMemory(),
      statusView: (() => {
        const name = this.chars[this.state.charIndex]?.name || "TA";
        const d = this.state.statusData;
        if (d === undefined) return { name, loading: true, items: [], empty: false, emptyText: "" };
        const items: any[] = [];
        if (d && d.mood) items.push({ label: "心情", value: d.mood });
        if (d && d.recent) items.push({ label: "最近在经历", value: d.recent });
        if (d && d.energy) items.push({ label: "此刻精力", value: d.energy });
        if (d && d.anticipating) items.push({ label: "在期待", value: d.anticipating });
        return { name, loading: false, items, empty: items.length === 0,
                 emptyText: `${name}现在状态挺好，随时可以接你电话～` };
      })(),
      memoryView: (() => {
        const name = this.chars[this.state.charIndex]?.name || "TA";
        const d = this.state.memoryData;
        if (d === undefined) return { name, loading: true, items: [], facts: [], empty: false, emptyText: "" };
        const items: any[] = [];
        if (d && d.stage) items.push({ label: "你们的关系", value: d.stage });
        if (d && d.last_topic) items.push({ label: "上次聊到", value: d.last_topic });
        if (d && d.last_mood) items.push({ label: "上次的心情", value: d.last_mood });
        if (d && Array.isArray(d.shared_refs) && d.shared_refs.length) items.push({ label: "你们的梗", value: d.shared_refs.join("、") });
        if (d && Array.isArray(d.open_threads) && d.open_threads.length) items.push({ label: "还没聊完的", value: d.open_threads.join("、") });
        const facts = (d && Array.isArray(d.facts)) ? d.facts : [];
        const empty = items.length === 0 && facts.length === 0;
        return { name, loading: false, items, facts, hasFacts: facts.length > 0, empty,
                 emptyText: `你和${name}还没什么回忆，打个电话开始吧～` };
      })(),
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
      themeToggle: () => { const nt = theme === "dark" ? "light" : "dark"; this.setState({ theme: nt }); this.savePrefs(); this.syncRootTheme(nt); },
      themeLabel: theme === "dark" ? "深色" : "浅色",
      appVersion: (typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "v1.0.0"),   // 构建期注入：版本+构建日期，发布即更新
      menuOpen: this.state.menuOpen,
      menuToggle: () => this.setState((s) => ({ menuOpen: !s.menuOpen })),
      menuClose: () => this.setState({ menuOpen: false }),
      favCurFill, favCurStroke,
      favList, hasFavs, noFavs,
      favOpen: this.state.favOpen,
      favClose: () => this.setState({ favOpen: false }),
      rechargeOpen: this.state.rechargeOpen,
      // 空闲态剩余条入口：游客→注册领免费时长（无账号充不了值），登录→充值。
      remainCtaLabel: this.state.loggedIn ? "充值" : "注册领免费时长",
      remainCta: () => { if (this.state.loggedIn) this.setState((s) => ({ rechargeOpen: !s.rechargeOpen })); else this.goRegister(); },
      rechargeClose: () => this.setState({ rechargeOpen: false }),
      redeemCode: this.state.redeemCode,
      onRedeemCode: (e: any) => this.setState({ redeemCode: e.target.value }),
      doRedeem: () => this.doRedeem(),
      billPeriod: this.state.billing,
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
            avatar: h.avatar || "", avatarDisplay: h.avatar ? "block" : "none",
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
      // 时长用完弹层：游客没账号、充不了值——引导注册（注册即送 60 分钟）；登录用户照旧走充值。
      outTitle: this.state.loggedIn ? "通话时长已用完" : "试用时长用完了",
      outBody: this.state.loggedIn ? "本月的通话时长用完了。充值后可以继续和 TA 聊。" : ("注册即送 " + this.giftMin() + " 分钟免费时长，继续和 TA 聊。"),
      outPrimaryLabel: this.state.loggedIn ? "去充值" : ("注册领 " + this.giftMin() + " 分钟"),
      outPrimary: () => { if (this.state.loggedIn) this.setState({ outOfMins: false, rechargeOpen: true }); else this.goRegister({ outOfMins: false }); },
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
      // 登录/注册共用一个弹窗：输入一样，一个按钮搞定——已注册→登录，未注册→自动创建账号并赠送时长。
      authIsRegister: true,
      authTitle: "登录 / 注册",
      authSubtitle: "注册即送 " + this.giftMin() + " 分钟免费通话时长，老用户直接登录",
      authSubmitLabel: "登录 / 注册",
      authHint: "未注册的邮箱会自动创建账号，已注册则直接登录",
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
        // 纯演示（未接后端）：假登录，按后台配置的赠送时长给额度。
        if (!authApi.authConfigured()) {
          this.setState((s) => ({ loggedIn: true, authOpen: false, authPw: "", regPromptShown: false,
            remaining: Math.max(s.remaining, this.giftMin() * 60), remainingLoaded: true, toast: "登录成功" }));
          this.clearToastSoon(2200);
          return;
        }
        // 真实后端·登录注册合一：先按登录试；登录不成（多半是还没注册）→ 自动注册并赠送时长。
        // 已注册+密码对→登录成功；已注册+密码错→登录失败、注册也失败→报登录的「密码错」；新邮箱→注册成功。
        if (this._authBusy) return;   // 防快速双击
        this._authBusy = true;
        this.setState({ toast: "处理中…" });
        try {
          let res = await authApi.login(email, pw);
          let isNew = false;
          if (!res.ok || !res.token) {
            const reg = await authApi.register(email, pw, this.pendingInvite);
            if (reg.ok && reg.token) { res = reg; isNew = true; }
            else { this.setState({ toast: res.error || reg.error || "登录失败，请检查邮箱或密码" }); this.clearToastSoon(2400); return; }
          }
          authApi.setToken(res.token || "");
          if (isNew) { this.pendingInvite = ""; try { localStorage.removeItem("micall_invite"); } catch { /* noop */ } }
          this.resetSignaling();   // 让下一通电话带上新 token 重连
          this.setState({ loggedIn: true, authOpen: false, authPw: "", regPromptShown: false,
            remaining: res.user?.remaining_seconds ?? this.state.remaining, remainingLoaded: true,
            toast: isNew ? ("注册成功，已送 " + this.giftMin() + " 分钟免费时长") : "登录成功" });
          this.loadVoices();       // 登录后拉本账号已选音色 → 音色页跨设备回显一致
          this.syncFavorites();    // 登录后把本地收藏并入账号 + 拉回账号全集 → 跨设备一致
          this.clearToastSoon(2200);
        } finally {
          this._authBusy = false;
        }
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
      giftLabel: "注册即送 " + this.giftMin() + " 分钟",
      settingsOpen: this.state.settingsOpen,
      settingsClose: () => this.setState({ settingsOpen: false }),
      billFromMenu: () => this.requireAuth(() => { this.setState({ ...this.sheets(), menuOpen: false, billsOpen: true }); this.loadBills(); }, "登录后查看账单"),
      billsOpen: this.state.billsOpen,
      billsClose: () => this.setState({ billsOpen: false }),
      billsToRecharge: () => { if (this.state.loggedIn) this.setState({ ...this.sheets(), rechargeOpen: true }); else this.goRegister(); },
      billsList: (this.realBills ?? this.bills).map((b) => ({
        title: b.title, date: b.date, mins: b.mins,
        minsColor: b.mins.startsWith("+") ? "#33A06B" : "var(--dim)",
        iconBg: b.type === "sub" ? "rgba(110,92,255,.12)" : (b.type === "invite" ? "rgba(255,79,123,.12)" : "rgba(46,123,255,.12)"),
        iconColor: b.type === "sub" ? "#6E5CFF" : (b.type === "invite" ? "#FF4F7B" : "#2E7BFF"),
        iconPath: b.type === "sub" ? "M20 12V8H6a2 2 0 0 1 0-4h12v4M4 6v12a2 2 0 0 0 2 2h14v-4M18 12a2 2 0 0 0 0 4h4v-4z" : (b.type === "invite" ? "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M19 8v6M22 11h-6" : "M6.62 10.79a15.05 15.05 0 0 0 6.59 6.59l2.2-2.2a1 1 0 0 1 1.02-.24 11.36 11.36 0 0 0 3.57.57 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.25.2 2.45.57 3.57a1 1 0 0 1-.24 1.02l-2.2 2.2z"),
      })),
      inviteFromMenu: () => this.requireAuth(() => { this.setState({ ...this.sheets(), menuOpen: false, inviteOpen: true }); this.loadInvite(); }, "注册后生成你的专属邀请链接，邀请成功双方各得 " + (this.realInviteReward != null ? this.realInviteReward : 60) + " 分钟", "register"),
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
      // 首页(idle)球与光晕固定住、不缩放（用户嫌「一会大一会小」）；色场仍 spin（只旋转、不改大小=有生气不变形）。
      // 拨号(calling)仍呼吸有生气；真正通话中(connected)本就静止。
      orbAnim: (connected || p === "idle") ? "none" : orbAnim,
      fieldAnim: connected ? "none" : `spin ${fieldDur}s linear infinite`,
      haloAnim: (connected || p === "idle") ? "none" : `haloPulse ${haloDur}s ease-in-out infinite`,
      orbBg: `radial-gradient(circle at 38% 33%, rgba(255,255,255,.97), ${this.hexA(tint, .62)} 38%, ${this.hexA(tint, .20)} 64%, ${this.hexA(tint, .03)} 82%)`,
      orbShadow: `0 0 50px 4px ${this.hexA(tint, .28)}, 0 0 100px 22px rgba(110,92,255,.16)`,
      haloBg: `radial-gradient(circle, ${this.hexA(tint, .26)}, rgba(255,79,160,.10) 45%, transparent 72%)`,
      // 头像边缘光：深色=白 studio rim-light（随声纹亮起，发光感）；浅色=【角色色相描边环 + 柔影】恒亮，
      // 让头像从浅底「浮起来」、不糊进背景（修浅色 figure-ground，白 rim 在浅底上看不见）。
      orbRim: isDark
        ? `inset 0 0 18px 1px rgba(255,255,255,.30), 0 0 calc(10px + var(--voice,0) * 24px) rgba(255,255,255,.16)`
        : `inset 0 0 0 2.5px ${this.rotA(tint, char.hue, .55)}, 0 16px 38px rgba(0,0,0,.20), 0 2px 8px rgba(0,0,0,.10)`,
      orbRimOpacity: isDark ? `calc(.16 + var(--voice,0) * .84)` : `1`,
    };
  }
}
