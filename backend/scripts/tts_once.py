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

    buf = bytearray()
    async for chunk in tts.synthesize(text, voice_id=voice, emotion=""):
        buf += chunk

    Path(out).write_bytes(bytes(buf))
    print(f"\n✅ 已写 {out}（{len(buf)} bytes）。下载到本地试听。"
          if buf else "\n⚠ 没拿到音频，看上面的报错。")


if __name__ == "__main__":
    asyncio.run(main())
