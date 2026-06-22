"""命令行和 AI 对话一次 —— 连本机正在运行的信令服务器，发一句话，打印 AI 真实回复。

不依赖前端 UI，用来快速验证「真大脑」是否打通。用法（需 websockets）：
  cd backend && PYTHONPATH=src python3 scripts/chat_once.py "我今天面试搞砸了，有点难受"
"""
import asyncio
import json
import sys


async def main() -> None:
    text = sys.argv[1] if len(sys.argv) > 1 else "我今天有点累"
    from websockets.asyncio.client import connect

    async with connect("ws://127.0.0.1:8787/realtime/signal") as ws:
        await ws.send(json.dumps({"type": "start_call", "character_id": "lin_wan", "scenario": "heart"}))
        await ws.send(json.dumps({"type": "text_input", "text": text}))
        print(f"\n你:  {text}\n", flush=True)
        got: list[str] = []
        try:
            while True:
                ev = json.loads(await asyncio.wait_for(ws.recv(), timeout=20))
                t = ev.get("type")
                if t == "emotion":
                    print(f"  [情绪标签] {ev['tag']}", flush=True)
                elif t == "subtitle" and ev.get("role") == "ai":
                    print(f"林晚: {ev['text']}", flush=True)
                    got.append(ev["text"])
                elif t == "state" and ev.get("phase") == "listening" and got:
                    break
                elif t == "call_failed":
                    print(f"  [接通失败] {ev.get('reason')}", flush=True)
                    break
        except asyncio.TimeoutError:
            print("  （20s 没收完，LLM 可能较慢或出错，看 journalctl）", flush=True)
        await ws.send(json.dumps({"type": "end_call"}))

    print("\n✅ 以上由 DeepSeek 真实生成。" if got else "\n⚠ 没收到 AI 回复，看 journalctl 排查。", flush=True)


if __name__ == "__main__":
    asyncio.run(main())
