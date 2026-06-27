// 实时语音的音频管线（纯逻辑层，不走 DC 模板）。媒体走二进制帧，控制走 JSON（见 signaling.ts）。
//   • MicCapture：麦克风 MediaStream → 16kHz PCM16 帧（上行喂后端 ASR）。
//   • AudioPlayer：后端下行的 PCM16 @ 24kHz 音频块 → Web Audio 播放（H5/iOS 稳，无需 MSE）。
// 采样率与后端约定一致：上行 16k（ASR session），下行 24k（config tts.sample_rate）。
//
// 公放回声的成熟解法（缺硬件 AEC 时的通用做法）= **半双工**：AI 的声音正在外放时，麦克风
// 干脆不上行——AI 自然「听不见自己」，从源头杜绝回声被 ASR 当成用户说话（自己断/凭空冒话/重复
// 「你好」）。靠 AudioPlayer.isPlaying 按真实播放状态门控麦克风上行（确定性，不靠猜阈值）。
// 注：曾试过把 TTS 经 MediaStream+<audio> 出声以启用浏览器 AEC 做全双工，但部分机型出现电流声/
// 卡顿，已撤回直连播放（稳）。真·全双工（边说边随时打断）的可靠方案是服务端 WebRTC，留作后续。

const MIC_RATE = 16000;
const TTS_RATE = 24000;

// 接通中（loading 等 RTC 连好）的提示音：柔和、低音量、间歇，像真电话在响——把「正在接通」的等待感做实，
// 而不是死寂。改 false 即整体关闭。
const RING_ENABLED = true;

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

/** 麦克风 → 16kHz PCM16 帧。用 ScriptProcessor（广泛支持、含 iOS；无需独立 worklet 文件）。
 *  纯采集，不做内部门控：是否上行由上层按真实播放状态决定（半双工，见 MiCallLogic.startMicUplink）。
 *  这样「AI 在外放→不上行」是一条确定性规则，而不是靠 RMS 阈值猜回声（外放回声常比真人还响，猜不准）。 */
export class MicCapture {
  private ctx: AudioContext | null = null;
  private src: MediaStreamAudioSourceNode | null = null;
  private node: ScriptProcessorNode | null = null;

  constructor(
    private stream: MediaStream,
    private onFrame: (pcm: ArrayBuffer) => void,
  ) {}

  start(): void {
    if (this.ctx) return;
    this.ctx = audioCtx();
    this.src = this.ctx.createMediaStreamSource(this.stream);
    const FRAME = 4096;
    this.node = this.ctx.createScriptProcessor(FRAME, 1, 1);
    const inRate = this.ctx.sampleRate;
    this.node.onaudioprocess = (e: AudioProcessingEvent) => {
      const input = e.inputBuffer.getChannelData(0);
      const pcm = downsampleToInt16(input, inRate, MIC_RATE);
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
  private ringOsc: OscillatorNode | null = null;       // 接通提示音（loading 期）
  private ringGain: GainNode | null = null;
  private ringTimer: ReturnType<typeof setInterval> | null = null;

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
      node.connect(this.ctx.destination);   // 直连输出：稳、无杂音（MediaStream+<audio> 那条 AEC 路径在部分机型出电流声，已撤）
      const start = Math.max(this.ctx.currentTime + 0.02, this.playhead);
      node.start(start);
      this.playhead = start + buf.duration;
      this.sources.add(node);
      node.onended = () => this.sources.delete(node);
    } catch (e) {
      console.warn("[micall] 播放音频块失败", e);
    }
  }

  /** AI 音频此刻是否正在外放（含一小段衰减拖尾）。仅"半双工兜底模式"用它判断要不要暂停上行：
   *  playhead = 已排队音频播放到的终点；currentTime 还没追上 playhead+tail 就当作「还在响」。
   *  flush 后 playhead 归 0 → false；自然播完后 currentTime 越过终点 → false。 */
  isPlaying(tailMs = 600): boolean {
    // 拖尾 600ms：手机外放有「已排队播完」到「喇叭真正出完声」的物理延迟，尾巴太短会让麦克风提前开、
    // 录到 AI 最后几个字 → 被当成用户说话（自我打断/把自己的话当我说的）。600ms 覆盖多数机型的输出延迟。
    if (!this.ctx || this.playhead <= 0) return false;
    return this.ctx.currentTime < this.playhead + tailMs / 1000;
  }

  /** 接通中提示音：复用本播放器的 AudioContext 起一个 sine 振荡器，按 ~1.7s 周期柔和渐入渐出（间歇响铃感），
   *  低音量(0.05)不刺耳。必须已在用户手势里 resume 过（点接听时），iOS 才出声。goLive/挂断即 stopRing。 */
  startRing(): void {
    if (!RING_ENABLED || this.ringOsc) return;
    this.resume();
    if (!this.ctx) return;
    try {
      const ctx = this.ctx;
      const gain = ctx.createGain();
      gain.gain.value = 0.0001;
      gain.connect(ctx.destination);
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = 480;          // 柔和中频，非刺耳电话铃
      osc.connect(gain);
      osc.start();
      this.ringOsc = osc;
      this.ringGain = gain;
      const beat = () => {
        if (!this.ctx || !this.ringGain) return;
        const t = this.ctx.currentTime;
        const g = this.ringGain.gain;
        g.cancelScheduledValues(t);
        g.setValueAtTime(0.0001, t);
        g.exponentialRampToValueAtTime(0.05, t + 0.35);   // 渐入
        g.exponentialRampToValueAtTime(0.0001, t + 1.0);  // 渐出（留 ~0.7s 静默 → 间歇感）
      };
      beat();
      this.ringTimer = setInterval(beat, 1700);
    } catch { this.stopRing(); }
  }

  /** 停接通提示音（传输就绪/挂断）。幂等。 */
  stopRing(): void {
    if (this.ringTimer !== null) { clearInterval(this.ringTimer); this.ringTimer = null; }
    try {
      if (this.ctx && this.ringGain) {
        const t = this.ctx.currentTime;
        this.ringGain.gain.cancelScheduledValues(t);
        this.ringGain.gain.setValueAtTime(0.0001, t);   // 立即压低，避免咔哒
      }
      this.ringOsc?.stop((this.ctx?.currentTime ?? 0) + 0.05);
    } catch { /* noop */ }
    this.ringOsc = null;
    this.ringGain = null;
  }

  /** 挂断提示音：与接通音呼应——同音色(sine)，短促【下行两声 doo-doo↓】示意「通话结束」。
   *  一次性、振荡器自停，不进 sources（flush 不会误杀它）。RING_ENABLED 关时连同接通音一起静默。
   *  关键：RTC 通话里 AI 声音走 <audio>、本 ctx 长期闲置常被浏览器挂起(suspended)——必须【先 resume
   *  再排程】，否则在 suspended 的 ctx 上按 currentTime 排的振荡器不出声（正是「挂断音没听到」）。 */
  playHangup(): void {
    if (!RING_ENABLED) return;
    if (!this.ctx) this.ctx = audioCtx();
    const ctx = this.ctx;
    const fire = () => {
      try {
        const t0 = ctx.currentTime + 0.02;
        [480, 360].forEach((freq, i) => {   // 两声下行：480→360Hz
          const t = t0 + i * 0.17;
          const gain = ctx.createGain();
          gain.connect(ctx.destination);
          const osc = ctx.createOscillator();
          osc.type = "sine";
          osc.frequency.value = freq;
          osc.connect(gain);
          gain.gain.setValueAtTime(0.0001, t);
          gain.gain.exponentialRampToValueAtTime(0.12, t + 0.03);   // 渐入（音量比接通音高一档，挂断更明确）
          gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.22); // 渐出
          osc.start(t);
          osc.stop(t + 0.26);
        });
      } catch { /* noop */ }
    };
    if (ctx.state === "suspended") void ctx.resume().then(fire).catch(() => { /* noop */ });
    else fire();
  }

  /** 打断/挂断：停掉所有排队中的音频。 */
  flush(): void {
    this.stopRing();   // 任何挂断/打断路径都确保提示音停（loading 期挂断兜底）
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
