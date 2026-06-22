"""实时流式 ASR 联调 —— 把音频文件按 100ms 帧「实时」喂给流式 ASR，打印中间/最终结果。

按 realtime_model 自动选协议（make_realtime_asr）：
  • qwen3-asr-flash-realtime（国际站默认）→ OpenAI-Realtime 协议
  • paraformer-realtime-*（北京区）→ run-task 协议
endpoint/key 取配置（micall.env / 后台「接口配置」），WS 主机按区域自动推断。

依赖：websockets；ffmpeg（任意音频转 pcm16/16k/mono，模拟麦克风）。
用法：
  cd backend; set -a; . config/micall.env; set +a
  PYTHONPATH=src python3 scripts/asr_stream_once.py sample.mp3 --debug --realtime
  # 换模型/端点联调：
  PYTHONPATH=src python3 scripts/asr_stream_once.py sample.mp3 --debug --realtime --model paraformer-realtime-v1
  PYTHONPATH=src python3 scripts/asr_stream_once.py sample.mp3 --debug --ws wss://dashscope-intl.aliyuncs.com/api-ws/v1/realtime
"""
import argparse
import asyncio
import os
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from micall.config import load_config  # noqa: E402
from micall.providers import make_realtime_asr  # noqa: E402

SR = 16000
FRAME_MS = 100
FRAME_BYTES = SR * 2 * FRAME_MS // 1000  # 3200


def _pcm16_mono_16k(path: str) -> bytes:
    cmd = ["ffmpeg", "-v", "error", "-i", path, "-f", "s16le",
           "-acodec", "pcm_s16le", "-ac", "1", "-ar", str(SR), "-"]
    try:
        return subprocess.run(cmd, capture_output=True, check=True).stdout
    except FileNotFoundError:
        raise SystemExit("需要 ffmpeg：sudo apt install -y ffmpeg")
    except subprocess.CalledProcessError as e:
        raise SystemExit(f"ffmpeg 转码失败：{e.stderr.decode('utf-8', 'ignore')[:300]}")


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("audio", nargs="?", default="sample.mp3")
    ap.add_argument("--ws", default="", help="覆盖 WS 端点（默认按区域+协议推断）")
    ap.add_argument("--model", default="qwen3-asr-flash-realtime", help="实时模型名（决定协议）")
    ap.add_argument("--debug", action="store_true", help="打印每个原始服务端事件（锁协议）")
    ap.add_argument("--realtime", action="store_true", help="逐帧 sleep 100ms 模拟真实语速")
    args = ap.parse_args()

    if not Path(args.audio).exists():
        raise SystemExit(f"找不到 {args.audio}。先用 tts_once 合一个 sample.mp3。")
    if Path(args.audio).stat().st_size == 0:
        raise SystemExit(f"{args.audio} 是 0 字节空文件。先用 tts_once 重新合一个非空 sample.mp3。")

    pcm = _pcm16_mono_16k(args.audio)
    nframes = (len(pcm) + FRAME_BYTES - 1) // FRAME_BYTES

    cfg = load_config()
    node = cfg.node("asr")
    if not node.api_key.strip():
        raise SystemExit("ASR 未配 key。先 set -a; . config/micall.env; set +a（或后台「接口配置」填）。")
    node.params["realtime_model"] = args.model
    node.params["sample_rate"] = SR
    if args.ws:
        node.params["ws_endpoint"] = args.ws

    def on_event(evt: dict) -> None:
        if args.debug:
            import json as _j
            et = evt.get("type") or (evt.get("header") or {}).get("event", "?")
            print(f"  «{et}» {_j.dumps(evt, ensure_ascii=False)[:240]}")

    asr = make_realtime_asr(node, on_event=on_event)
    print(f"provider={type(asr).__name__}  model={args.model}")
    print(f"WS={asr.ws_url}")
    print(f"音频→pcm16/16k/mono：{len(pcm)} bytes ≈ {len(pcm) / (SR * 2):.1f}s · "
          f"{nframes} 帧×{FRAME_MS}ms · realtime={args.realtime}\n")

    async def _frames():
        for i in range(nframes):
            yield pcm[i * FRAME_BYTES:(i + 1) * FRAME_BYTES]
            if args.realtime:
                await asyncio.sleep(FRAME_MS / 1000)

    t0 = time.perf_counter()
    first_partial: float | None = None
    finals: list[str] = []
    last_partial = ""
    try:
        async for text, is_final in asr.stream(_frames()):
            now = (time.perf_counter() - t0) * 1000
            if first_partial is None:
                first_partial = now
            if is_final:
                finals.append(text)
                print(f"  [final  {now:6.0f}ms] {text}")
                break  # 单句联调：收到最终结果即收尾（连续模式由编排长跑）
            last_partial = text
            if args.debug:
                print(f"  [partial {now:6.0f}ms] {text}")
    except Exception as e:
        print(f"\n⚠ 失败：{e!r}")
        print("  排查：① 模型名是否本区可用（看上面 --debug 的 task-failed/error）"
              "② --model 换 qwen3-asr-flash-realtime / paraformer-realtime-v1 ③ --ws 覆盖端点。")
        return

    print(f"\n📝 最终：{' '.join(finals) or last_partial!r}")
    if first_partial is not None:
        print(f"⏱ 首个结果 {first_partial:.0f}ms")
    print("（真实通话关心的是用户停顿后多快出 final；这里单句验证协议+识别正确性。）")


if __name__ == "__main__":
    asyncio.run(main())
