// 实时语音的音频管线（纯逻辑层，不走 DC 模板）。媒体走二进制帧，控制走 JSON（见 signaling.ts）。
//   • MicCapture：麦克风 MediaStream → 16kHz PCM16 帧（上行喂后端 ASR）。
//   • AudioPlayer：后端下行的 PCM16 @ 24kHz 音频块 → Web Audio 播放（H5/iOS 稳，无需 MSE）。
// 采样率与后端约定一致：上行 16k（ASR session），下行 24k（config tts.sample_rate）。

const MIC_RATE = 16000;
const TTS_RATE = 24000;

type Ctor = { new (): AudioContext };
function audioCtx(): AudioContext {
  const C = (window.AudioContext || (window as unknown as { webkitAudioContext: Ctor }).webkitAudioContext) as Ctor;
  return new C();
}

function clamp16(s: number): number {
  s = Math.max(-1, Math.min(1, s));
  return s < 0 ? s * 0x8000 : s * 0x7fff;
}

function downsampleToInt16(input: Float32Array, inRate: number, outRate: number): ArrayBuffer {
  if (inRate <= outRate) {
    const out = new Int16Array(input.length);
    for (let i = 0; i < input.length; i++) out[i] = clamp16(input[i]);
    return out.buffer;
  }
  const ratio = inRate / outRate;
  const outLen = Math.floor(input.length / ratio);
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) out[i] = clamp16(input[Math.floor(i * ratio)]);
  return out.buffer;
}

// 上行 VAD 门控阈值（对归一化 RMS，[0,1]）。带迟滞：开门高、关门低，避免临界抖动。
// 省钱核心：ASR 按音频秒数计费——静音/AI 说话（经 AEC 后麦克风近静音）不上行 → 不计费。
const VAD_OPEN = 0.018;   // 高于此判为「有人在说」→ 开门
const VAD_CLOSE = 0.010;  // 低于此才开始计静音；说话期间不反复关
const VAD_HANGOVER_MS = 800;   // 静音后继续上行的尾音时长：留够让服务端 server_vad 收尾断句
const VAD_PREROLL_MS = 200;    // 开门前回补的预卷，避免吃掉句首

function rms(buf: Float32Array): number {
  let s = 0;
  for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
  return Math.sqrt(s / Math.max(1, buf.length));
}

/** 麦克风 → 16kHz PCM16 帧。用 ScriptProcessor（广泛支持、含 iOS；无需独立 worklet 文件）。
 *  默认带能量 VAD 门控：仅在「有人说话」时上行，静音与 AI 回声期不发 → 省 ASR 计费。 */
export class MicCapture {
  private ctx: AudioContext | null = null;
  private src: MediaStreamAudioSourceNode | null = null;
  private node: ScriptProcessorNode | null = null;
  // VAD 状态
  private gateOpen = false;
  private hangover = 0;             // 剩余尾音帧数
  private preroll: ArrayBuffer[] = [];
  private prerollMax = 2;           // 预卷帧数（start() 里按帧时长换算）
  private hangoverFrames = 10;      // 尾音帧数（start() 里按帧时长换算）

  constructor(
    private stream: MediaStream,
    private onFrame: (pcm: ArrayBuffer) => void,
    private vad = true,
  ) {}

  start(): void {
    if (this.ctx) return;
    this.ctx = audioCtx();
    this.src = this.ctx.createMediaStreamSource(this.stream);
    const FRAME = 4096;
    this.node = this.ctx.createScriptProcessor(FRAME, 1, 1);
    const inRate = this.ctx.sampleRate;
    const frameMs = (FRAME / inRate) * 1000;             // 每帧时长（约 85ms @48k）
    this.hangoverFrames = Math.ceil(VAD_HANGOVER_MS / frameMs);
    this.prerollMax = Math.max(1, Math.round(VAD_PREROLL_MS / frameMs));
    this.node.onaudioprocess = (e: AudioProcessingEvent) => {
      const input = e.inputBuffer.getChannelData(0);
      const pcm = downsampleToInt16(input, inRate, MIC_RATE);
      if (!pcm.byteLength) return;
      if (!this.vad) { this.onFrame(pcm); return; }
      this.gate(rms(input), pcm);
    };
    this.src.connect(this.node);
    this.node.connect(this.ctx.destination); // 触发 onaudioprocess；不写 output → 静默，无回授
    if (this.ctx.state === "suspended") void this.ctx.resume();
  }

  /** 能量门控状态机：开门即先补预卷再持续上行；转静音后再送够尾音帧让服务端断句，然后闭门。 */
  private gate(level: number, pcm: ArrayBuffer): void {
    if (this.gateOpen) {
      this.onFrame(pcm);
      if (level > VAD_CLOSE) this.hangover = this.hangoverFrames; // 还在说 → 续命
      else if (--this.hangover <= 0) this.gateOpen = false;       // 尾音耗尽 → 闭门
      return;
    }
    // 闭门期：缓存预卷，只有越过开门阈值才开门并回补句首
    this.preroll.push(pcm);
    if (this.preroll.length > this.prerollMax) this.preroll.shift();
    if (level > VAD_OPEN) {
      this.gateOpen = true;
      this.hangover = this.hangoverFrames;
      for (const f of this.preroll) this.onFrame(f);
      this.preroll = [];
    }
  }

  stop(): void {
    if (this.node) this.node.onaudioprocess = null;
    try { this.node?.disconnect(); } catch { /* noop */ }
    try { this.src?.disconnect(); } catch { /* noop */ }
    try { void this.ctx?.close(); } catch { /* noop */ }
    this.node = this.src = this.ctx = null;
    this.gateOpen = false; this.hangover = 0; this.preroll = [];
  }
}

/** 下行 PCM16 @ 24kHz 音频块 → 排队播放。打断时 flush 停掉队列（barge-in）。 */
export class AudioPlayer {
  private ctx: AudioContext | null = null;
  private playhead = 0;
  private sources = new Set<AudioBufferSourceNode>();
  private logged = false;

  /** 必须在用户手势（点接听）里调一次，iOS 才允许出声。 */
  resume(): void {
    if (!this.ctx) this.ctx = audioCtx();
    if (this.ctx.state === "suspended") void this.ctx.resume();
  }

  play(frame: ArrayBuffer): void {
    this.resume();
    if (!this.ctx || frame.byteLength < 2) return;
    if (!this.logged) {
      this.logged = true;
      console.info("[micall] 收到下行 TTS 音频，开始播放（首帧", frame.byteLength, "bytes）");
    }
    try {
      const n = frame.byteLength >> 1; // 偶数对齐：丢弃可能的半个样本，避免构造异常
      const pcm = new Int16Array(frame, 0, n);
      const f32 = new Float32Array(n);
      for (let i = 0; i < n; i++) f32[i] = pcm[i] / 0x8000;
      const buf = this.ctx.createBuffer(1, n, TTS_RATE);
      buf.getChannelData(0).set(f32);
      const node = this.ctx.createBufferSource();
      node.buffer = buf;
      node.connect(this.ctx.destination);
      const start = Math.max(this.ctx.currentTime + 0.02, this.playhead);
      node.start(start);
      this.playhead = start + buf.duration;
      this.sources.add(node);
      node.onended = () => this.sources.delete(node);
    } catch (e) {
      console.warn("[micall] 播放音频块失败", e);
    }
  }

  /** 打断/挂断：停掉所有排队中的音频。 */
  flush(): void {
    for (const s of this.sources) { try { s.stop(); } catch { /* noop */ } }
    this.sources.clear();
    this.playhead = 0;
  }

  close(): void {
    this.flush();
    try { void this.ctx?.close(); } catch { /* noop */ }
    this.ctx = null;
  }
}
