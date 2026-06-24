// Realtime control-signaling client (前端 ⇆ 服务端 控制通道).
//
// Implements the protocol from docs/03-前端对接规格.md §4/§5. Two
// implementations share one interface:
//   • WebSocketSignalingClient — production; endpoint comes from
//     VITE_SIGNALING_URL (config, never hardcoded — CLAUDE.md 铁律2).
//   • MockSignalingClient — drives the documented events with timers so the
//     UI runs standalone with no backend. NOTE: the prototype's fake "18%
//     接通失败" is intentionally NOT reproduced here (deleted per spec §3).
//
// Audio itself rides a separate WebRTC media channel (not modelled here); this
// channel only carries control events. 媒体归媒体，控制归控制 (后端规格 §1.1).

// ─────────────────────────────── Protocol ───────────────────────────────

export type CallPhase = "listening" | "thinking" | "speaking";

/** 服务端 → 前端 (control downlink). */
export type ServerEvent =
  | { type: "connected" } // calling → listening
  | { type: "state"; phase: CallPhase }
  | { type: "interrupted" } // speaking → listening (skip thinking)
  | { type: "subtitle"; role: "user" | "ai"; text: string; partial?: boolean }
  | { type: "emotion"; tag: string } // drives 影像 crossfade
  | { type: "billing"; remaining_seconds: number; elapsed: number }
  | { type: "low_minutes"; remaining_seconds: number }
  | { type: "out_of_minutes" }
  | { type: "call_failed"; reason: string }
  | { type: "ended" }
  | { type: "connection_lost" }           // 接通后网络掉线（WS 异常关闭）→ 前端给「连接中断·重拨」
  | { type: "rtc_answer"; sdp: string }   // 可选 WebRTC：服务端 answer
  | { type: "rtc_unavailable" };          // 后端没装 aiortc → 前端回退 WS

/** 前端 → 服务端 (control uplink). */
export type ClientMessage =
  | { type: "start_call"; character_id: string; scenario: string }
  | { type: "end_call" }
  | { type: "mute"; on: boolean }
  | { type: "switch_character"; character_id: string; scenario: string }
  | { type: "set_scene"; scene: string }
  | { type: "text_input"; text: string }
  | { type: "reset_memory"; character_id: string };

export type ServerHandler = (ev: ServerEvent) => void;
/** 下行二进制音频帧（TTS PCM）。媒体归媒体、控制归控制（后端规格 §1.1）。 */
export type AudioHandler = (frame: ArrayBuffer) => void;

export interface SignalingClient {
  send(msg: ClientMessage): void;
  /** 上行二进制音频帧（麦克风 PCM）。Mock 下为 no-op。 */
  sendAudio(frame: ArrayBufferLike): void;
  /** 发任意 JSON 控制帧（WebRTC 信令 rtc_offer/rtc_ice）。Mock 不支持。 */
  sendRaw?(obj: unknown): void;
  close(): void;
}

// ──────────────────────────── WebSocket (prod) ───────────────────────────

class WebSocketSignalingClient implements SignalingClient {
  private ws: WebSocket;
  private queue: ClientMessage[] = [];
  private everConnected = false;   // 接通后的 error 不再当「呼叫失败」（防网络瞬抖误掉线）
  private terminal = false;        // 已正常收尾（ended/out_of_minutes/call_failed）→ close 不再报「连接中断」
  private closedByUs = false;      // 本端主动挂断 → close 不报「连接中断」

  constructor(url: string, private onEvent: ServerHandler, private onAudio?: AudioHandler) {
    this.ws = new WebSocket(url);
    this.ws.binaryType = "arraybuffer";
    this.ws.addEventListener("open", () => {
      for (const m of this.queue) this.ws.send(JSON.stringify(m));
      this.queue = [];
    });
    this.ws.addEventListener("message", (e) => {
      if (typeof e.data !== "string") {
        this.onAudio?.(e.data as ArrayBuffer); // 二进制 = 下行 TTS 音频
        return;
      }
      try {
        const sev = JSON.parse(e.data) as ServerEvent;
        if (sev.type === "connected") this.everConnected = true;
        if (sev.type === "ended" || sev.type === "out_of_minutes" || sev.type === "call_failed") this.terminal = true;
        this.onEvent(sev);
      } catch {
        /* ignore malformed frames */
      }
    });
    this.ws.addEventListener("error", () => {
      // 只在「接通前」把 error 当呼叫失败；接通后的网络瞬抖不掉线，否则活的通话被弹失败框。
      if (!this.everConnected) this.onEvent({ type: "call_failed", reason: "network" });
    });
    this.ws.addEventListener("close", () => {
      // 接通后、非正常收尾、非本端挂断而 socket 关闭 = 网络掉线。给上层「连接中断·重拨」明确状态，
      // 而不是把活的通话界面冻在那（此前无 close 处理 → 用户对着死屏，不知发生了什么）。
      if (this.everConnected && !this.terminal && !this.closedByUs) {
        this.onEvent({ type: "connection_lost" });
      }
    });
  }

  send(msg: ClientMessage): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
    else this.queue.push(msg);
  }

  sendAudio(frame: ArrayBufferLike): void {
    // 实时音频不排队：连接没就绪就丢（迟到的帧无意义）。
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(frame);
  }

  sendRaw(obj: unknown): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
    else this.queue.push(obj as ClientMessage);   // 入队，open 后随其它控制帧一起发
  }

  close(): void {
    this.closedByUs = true;   // 本端主动挂断：随后的 close 事件不报「连接中断」
    try {
      this.ws.close();
    } catch {
      /* noop */
    }
  }
}

// ─────────────────────────── Mock backend (dev) ──────────────────────────

// Canned content for the mock backend ONLY. This is the stand-in "server"
// talking — it is not the frontend faking a conversation. The real backend
// supplies subtitles/emotions over the wire.
const MOCK_TURNS: { text: string; emotion: string }[] = [
  { text: "嗯，我在听。", emotion: "listening" },
  { text: "今天过得怎么样？", emotion: "tender" },
  { text: "别急，慢慢说，我陪着你。", emotion: "caring" },
  { text: "我懂，那一定挺累的。", emotion: "caring" },
  { text: "把心里的话说出来吧。", emotion: "tender" },
  { text: "你今天，已经很努力了。", emotion: "tender" },
];

class MockSignalingClient implements SignalingClient {
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private billingTimer: ReturnType<typeof setInterval> | null = null;
  private elapsed = 0;
  private remaining = 720; // 12 min, mirrors the prototype's starting balance
  private turn = 0;
  private lowWarned = false;
  private running = false;

  constructor(private onEvent: ServerHandler) {}

  private after(ms: number, fn: () => void) {
    const id = setTimeout(() => {
      this.timers.delete(id);
      fn();
    }, ms);
    this.timers.add(id);
  }

  private clearTimers() {
    this.timers.forEach(clearTimeout);
    this.timers.clear();
  }

  private emit(ev: ServerEvent) {
    if (!this.running && ev.type !== "ended") return;
    this.onEvent(ev);
  }

  send(msg: ClientMessage): void {
    switch (msg.type) {
      case "start_call":
        this.beginSession();
        break;
      case "switch_character":
        this.stopSession(false);
        this.beginSession();
        break;
      case "end_call":
        this.stopSession(true);
        break;
      case "text_input":
        this.onUserText(msg.text);
        break;
      case "mute":
      case "set_scene":
        // The mock server simply acknowledges by doing nothing observable.
        break;
    }
  }

  sendAudio(): void {
    /* mock 后端不消费音频 */
  }

  close(): void {
    this.stopSession(false);
  }

  private beginSession() {
    this.clearTimers();
    if (this.billingTimer) clearInterval(this.billingTimer);
    this.running = true;
    this.elapsed = 0;
    this.lowWarned = false;
    this.turn = 0;
    // 接通 (no fake failure — real backend would emit call_failed on real errors).
    this.after(1600, () => {
      this.emit({ type: "connected" });
      this.startBilling();
      this.loopListen();
    });
  }

  private startBilling() {
    this.billingTimer = setInterval(() => {
      if (!this.running) return;
      this.elapsed += 1;
      this.remaining = Math.max(0, this.remaining - 1);
      this.emit({ type: "billing", remaining_seconds: this.remaining, elapsed: this.elapsed });
      if (this.remaining <= 60 && !this.lowWarned) {
        this.lowWarned = true;
        this.emit({ type: "low_minutes", remaining_seconds: this.remaining });
      }
      if (this.remaining <= 0) {
        this.emit({ type: "out_of_minutes" });
        this.stopSession(false);
      }
    }, 1000);
  }

  private loopListen() {
    this.emit({ type: "state", phase: "listening" });
    this.after(3000, () => this.loopThink());
  }

  private loopThink() {
    this.emit({ type: "state", phase: "thinking" });
    this.after(1900, () => this.loopSpeak());
  }

  private loopSpeak() {
    const t = MOCK_TURNS[this.turn++ % MOCK_TURNS.length];
    this.emit({ type: "state", phase: "speaking" });
    this.emit({ type: "emotion", tag: t.emotion });
    this.emit({ type: "subtitle", role: "ai", text: t.text });
    this.after(3400, () => this.loopListen());
  }

  private onUserText(text: string) {
    if (!this.running) return;
    this.clearTimers();
    this.emit({ type: "subtitle", role: "user", text });
    this.emit({ type: "state", phase: "thinking" });
    this.after(1400, () => this.loopSpeak());
  }

  private stopSession(emitEnded: boolean) {
    this.running = false;
    this.clearTimers();
    if (this.billingTimer) {
      clearInterval(this.billingTimer);
      this.billingTimer = null;
    }
    if (emitEnded) this.onEvent({ type: "ended" });
  }
}

// ─────────────────────────────── Factory ─────────────────────────────────

/** Build the signaling client. Uses the real WS endpoint when configured,
 *  otherwise the in-browser mock so the app runs with no backend. */
export function createSignaling(onEvent: ServerHandler, onAudio?: AudioHandler): SignalingClient {
  const url = import.meta.env.VITE_SIGNALING_URL;
  if (url && url.trim()) {
    let full = url.trim();
    // 登录态：把 token 带进握手 URL，后端据此解析真实 user_id（替换游客）。未登录则不带。
    try {
      const tok = localStorage.getItem("micall_token") || "";
      if (tok) full += (full.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(tok);
    } catch { /* noop */ }
    return new WebSocketSignalingClient(full, onEvent, onAudio);
  }
  return new MockSignalingClient(onEvent);
}
