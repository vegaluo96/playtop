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

/** 麦克风 → 16kHz PCM16 帧。用 ScriptProcessor（广泛支持、含 iOS；无需独立 worklet 文件）。 */
export class MicCapture {
  private ctx: AudioContext | null = null;
  private src: MediaStreamAudioSourceNode | null = null;
  private node: ScriptProcessorNode | null = null;

  constructor(private stream: MediaStream, private onFrame: (pcm: ArrayBuffer) => void) {}

  start(): void {
    if (this.ctx) return;
    this.ctx = audioCtx();
    this.src = this.ctx.createMediaStreamSource(this.stream);
    this.node = this.ctx.createScriptProcessor(4096, 1, 1);
    const inRate = this.ctx.sampleRate;
    this.node.onaudioprocess = (e: AudioProcessingEvent) => {
      const pcm = downsampleToInt16(e.inputBuffer.getChannelData(0), inRate, MIC_RATE);
      if (pcm.byteLength) this.onFrame(pcm);
    };
    this.src.connect(this.node);
    this.node.connect(this.ctx.destination); // 触发 onaudioprocess；不写 output → 静默，无回授
    if (this.ctx.state === "suspended") void this.ctx.resume();
  }

  stop(): void {
    if (this.node) this.node.onaudioprocess = null;
    try { this.node?.disconnect(); } catch { /* noop */ }
    try { this.src?.disconnect(); } catch { /* noop */ }
    try { void this.ctx?.close(); } catch { /* noop */ }
    this.node = this.src = this.ctx = null;
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
