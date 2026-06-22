"""合成一句语音存成文件试听 —— 验证 MiniMax TTS 接入与音色。

用法（需先把 MiniMax 的 endpoint/key 写进 micall.env 并 source）：
  cd backend
  set -a; . config/micall.env; set +a
  PYTHONPATH=src python3 scripts/tts_once.py "你好，我是林晚，很高兴认识你。" linwan.mp3
然后把生成的 mp3 下载到本地试听。
"""
import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from micall.config import load_config  # noqa: E402
from micall.providers import make_tts  # noqa: E402


async def main() -> None:
    text = sys.argv[1] if len(sys.argv) > 1 else "你好，我是林晚，很高兴认识你。"
    out = sys.argv[2] if len(sys.argv) > 2 else "linwan.mp3"
    voice_override = sys.argv[3] if len(sys.argv) > 3 else ""

    cfg = load_config()
    node = cfg.node("tts")
    tts = make_tts(node)
    voice = voice_override or cfg.global_defaults.get("default_voice", "")
    print(f"provider={type(tts).__name__}  model={node.params.get('model')}  voice={voice!r}")
    print(f"text={text!r}")

    import time

    t0 = time.perf_counter()
    first_ms: float | None = None
    buf = bytearray()
    try:
        async for chunk in tts.synthesize(text, voice_id=voice, emotion=""):
            if first_ms is None:
                first_ms = (time.perf_counter() - t0) * 1000
            buf += chunk
    except Exception as e:
        print(f"\n⚠ TTS 失败：{e}")
        print(f"   （未写 {out}，保留原文件）")
        return
    total_ms = (time.perf_counter() - t0) * 1000

    if buf:
        Path(out).write_bytes(bytes(buf))
        print(f"\n✅ 已写 {out}（{len(buf)} bytes）。下载到本地试听。")
        print(f"   ⏱ 首音频块 {first_ms:.0f}ms · 整句合成 {total_ms:.0f}ms · 文本 {len(text)} 字")
        print("   （流式合成：首块一出即可下行 → 通话里据此抢跑，用户感知的开口≈首块延迟）")
    else:
        # 没拿到音频就别写空文件，避免把之前的好文件覆盖成 0 字节。
        print(f"\n⚠ 没拿到音频（未写 {out}，保留原文件）。看上面的报错——多半是 TTS endpoint/key/voice 问题。")


if __name__ == "__main__":
    asyncio.run(main())
