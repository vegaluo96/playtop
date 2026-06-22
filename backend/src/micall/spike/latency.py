"""尺度一延迟 spike（docs/02 §1.6 / §8）——「后端第一个动作」：实测 LLM 的 TTFT 与缓存。

TTFT 是延迟主瓶颈（§1.7）；长 prompt（四层注入）会推高它。本工具对配置的 LLM 节点
（默认 llm_fast，走 apiyi）发一个长 prompt 的流式请求，测「首 token 时间 TTFT」与「总时长」，
多轮取 p50/p95，作为地基可行性的生死验证。endpoint/key 全来自配置（铁律2）。

apiyi 风险（§1.7）：聚合网关可能 TTFT 抖动、不透传 prefix caching。本工具就是用来量化它的；
卡了把 llm_fast 配置切直连 DeepSeek 再测，对比即可——对话逻辑一行不动。
"""
from __future__ import annotations

import json
import statistics
import time

from ..config import Config, NodeConfig


def _long_messages(approx_tokens: int) -> list[dict]:
    # 中文约 1.5 char/token；构造稳定长前缀模拟四层注入（也便于观察 prefix caching 效果）。
    filler = "这是用于延迟基准测试的稳定前缀内容，模拟人格与记忆的长上下文注入。" * max(
        1, approx_tokens // 18
    )
    return [
        {"role": "system", "content": filler},
        {"role": "user", "content": "用一句温柔的话回应我。"},
    ]


def _measure_once(node: NodeConfig, messages: list[dict], max_tokens: int) -> tuple[float, float]:
    import httpx

    payload = {
        "model": node.params.get("model", ""),
        "messages": messages,
        "temperature": node.params.get("temperature", 0.8),
        "max_tokens": max_tokens,
        "stream": True,
    }
    headers = {"Authorization": f"Bearer {node.api_key}", "Content-Type": "application/json"}
    t0 = time.perf_counter()
    ttft: float | None = None
    with httpx.Client(timeout=httpx.Timeout(30.0, connect=5.0)) as client:
        with client.stream("POST", node.endpoint, headers=headers, json=payload) as resp:
            resp.raise_for_status()
            for line in resp.iter_lines():
                if not line or not line.startswith("data:"):
                    continue
                data = line[5:].strip()
                if data == "[DONE]":
                    break
                try:
                    delta = json.loads(data)["choices"][0]["delta"].get("content")
                except (KeyError, IndexError, ValueError):
                    continue
                if delta and ttft is None:
                    ttft = time.perf_counter() - t0
    total = time.perf_counter() - t0
    return (ttft if ttft is not None else total), total


def run_spike(
    config: Config,
    node_key: str = "llm_fast",
    prompt_tokens: int = 2000,
    rounds: int = 5,
    model: str | None = None,
) -> None:
    node = config.node(node_key)
    if model:
        node.params["model"] = model  # 命令行临时覆盖模型名（横向对比选最快），不改配置
    print(f"=== MiCall 延迟 spike · 节点 {node_key}（{node.provider or 'unset'}）· "
          f"模型 {node.params.get('model') or '?'} ===")
    print(f"长 prompt ≈ {prompt_tokens} tokens × {rounds} 轮\n")

    if not node.configured:
        print("⚠ 该节点未配置 endpoint/api_key（铁律2）。注入后重跑，例如：")
        print(f"  MICALL_{node_key.upper()}_ENDPOINT=https://api.apiyi.com/v1/chat/completions \\")
        print(f"  MICALL_{node_key.upper()}_API_KEY=sk-xxx \\")
        print(f"  PYTHONPATH=src python3 -m micall.cli spike --node {node_key}")
        return
    try:
        import httpx  # noqa: F401
    except ImportError:
        print("需要 httpx：pip install -r requirements.txt")
        return

    messages = _long_messages(prompt_tokens)
    ttfts: list[float] = []
    totals: list[float] = []
    for i in range(rounds):
        try:
            ttft, total = _measure_once(node, messages, max_tokens=64)
        except Exception as e:  # 网络/鉴权/超时
            print(f"  round {i + 1}: 失败 {e!r}")
            continue
        ttfts.append(ttft)
        totals.append(total)
        print(f"  round {i + 1}: TTFT={ttft * 1000:.0f}ms  total={total * 1000:.0f}ms")

    if not ttfts:
        print("\n所有轮次失败，无法给出基准。检查 endpoint/key/网络。")
        return

    def pct(xs: list[float], p: float) -> float:
        xs = sorted(xs)
        return xs[min(len(xs) - 1, int(p * len(xs)))]

    print("\n--- 基准（TTFT 是关键）---")
    print(f"TTFT  p50={pct(ttfts, 0.5) * 1000:.0f}ms  p95={pct(ttfts, 0.95) * 1000:.0f}ms  "
          f"mean={statistics.mean(ttfts) * 1000:.0f}ms")
    print(f"total p50={pct(totals, 0.5) * 1000:.0f}ms  p95={pct(totals, 0.95) * 1000:.0f}ms")
    # 红灯参考（§1.7）：对话首句 TTFT 目标通常 < 1s；持续 > 1.5s 即考虑切直连/加 prefix cache。
    if pct(ttfts, 0.5) > 1.5:
        print("🔴 TTFT 偏高：考虑 ① prefix caching ② 句子级首句抢跑 ③ 切直连 DeepSeek（只改配置）。")
    elif pct(ttfts, 0.5) > 1.0:
        print("🟡 TTFT 临界：首句抢跑可掩盖，但需关注长 prompt 抖动。")
    else:
        print("🟢 TTFT 健康。")
