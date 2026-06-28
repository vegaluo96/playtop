"""真实快脑 LLM provider 骨架 —— apiyi 聚合网关（DeepSeek-V4-Flash），OpenAI 兼容 SSE。

endpoint/key 全部来自 NodeConfig（铁律2）。先全走 apiyi；若 TTFT 抖动/不透传 prefix
caching（§1.7 apiyi 风险），只改配置切直连 DeepSeek，本文件逻辑不动。

依赖 httpx（requirements.txt）；未安装时构造即报错，工厂会在节点未配置时回退 StubLLM，
所以骨架运行/测试不触发本文件。
"""
from __future__ import annotations

import json
import logging
from typing import AsyncIterator, Sequence

from ..config import NodeConfig, as_float
from .base import LLMProvider, Message

log = logging.getLogger("micall.llm")

try:  # 真实接入才需要；缺失不影响骨架/测试
    import httpx
except ImportError:  # pragma: no cover
    httpx = None  # type: ignore


def _usage_brief(usage: dict) -> str:
    """把 LLM 用量摘成一行，重点是【前缀缓存命中率】——验证 §1.7 的核心优化（系统前缀走缓存、重复轮近免费）
    到底有没有真生效。DeepSeek 原生返回 prompt_cache_hit_tokens/miss；命中越高，延迟与成本越低。纯函数，便于测试。"""
    pt = int(usage.get("prompt_tokens", 0) or 0)
    ct = int(usage.get("completion_tokens", 0) or 0)
    hit = usage.get("prompt_cache_hit_tokens")
    miss = usage.get("prompt_cache_miss_tokens")
    if hit is not None or miss is not None:
        h, m = int(hit or 0), int(miss or 0)
        rate = (100 * h // (h + m)) if (h + m) else 0
        return f"prompt={pt}（缓存命中{h}/未命中{m}={rate}%）completion={ct}"
    return f"prompt={pt} completion={ct}（该端点未回缓存字段——多半是网关没透传 prefix caching）"


def _chat_endpoint(ep: str) -> str:
    """容错归一：很多人把 apiyi/OpenAI 文档里的 base_url（.../v1）当 endpoint 填，少了
    /chat/completions → 404。这里自动补全：已是 chat/completions 原样；以 /v1 结尾则补全。"""
    ep = (ep or "").strip().rstrip("/")
    if ep.endswith("/chat/completions"):
        return ep
    if ep.endswith("/v1"):
        return ep + "/chat/completions"
    return ep


from ._http import loop_client


def _shared_client() -> "httpx.AsyncClient":
    """共享 HTTP 连接池，按事件循环隔离（见 providers/_http.loop_client）。
    管理端连通性测试走 asyncio.run（一次性循环），通话走 wsserver 常驻循环；同一 httpx client 跨循环复用
    会污染连接池 → PoolTimeout。每个循环各持一个 client（常驻循环零重建，一次性循环用完即弃）。"""
    return loop_client(lambda: httpx.AsyncClient(
        timeout=httpx.Timeout(30.0, connect=5.0, pool=5.0),
        limits=httpx.Limits(max_connections=32, max_keepalive_connections=8, keepalive_expiry=15.0),
    ))


class ApiyiLLM(LLMProvider):
    def __init__(self, node: NodeConfig) -> None:
        if httpx is None:  # pragma: no cover
            raise RuntimeError("ApiyiLLM 需要 httpx：pip install -r requirements.txt")
        if not node.configured:
            raise RuntimeError(f"节点 {node.name} 未配置 endpoint/api_key（铁律2）")
        self._node = node
        self._endpoint = _chat_endpoint(node.endpoint)
        self._model = node.params.get("model", "deepseek-v4-flash")
        # 配置透传的额外请求字段（铁律2，走配置不硬编码）。用途如：给会思考的快脑关思考——
        # DeepSeek 这类模型实测接受 reasoning_effort(low/medium/high) / thinking 等参数；快脑空想纯属
        # 拖慢接话（思考过程我们根本不取用）。在 nodes.llm_fast.extra_body 里配，逻辑不动即可调。
        eb = node.params.get("extra_body")
        self._extra_body = dict(eb) if isinstance(eb, dict) else {}
        # 「榨干 LLM」——用上几样我们一直没用、却不花钱/不加延迟的能力（都走配置，铁律2）：
        # · frequency_penalty/presence_penalty：压「翻来覆去说类似的话」（治开场/口头重复）。
        #   注意：DeepSeek 思考模式下 frequency_penalty 不生效——快脑已 thinking=disabled，故有效。默认 0=不动。
        self._freq_penalty = as_float(node.params.get("frequency_penalty"), 0.0)
        self._pres_penalty = as_float(node.params.get("presence_penalty"), 0.0)
        # · stream_options.include_usage：流末多回一块 usage（含 DeepSeek 的 prompt_cache_hit/miss_tokens）→
        #   终于能【量到前缀缓存命中率】，验证 §1.7 那个核心省钱/降延迟优化是真生效还是被网关吞了。零延迟影响。
        self._report_usage = bool(node.params.get("report_usage", True))
        self.last_usage: dict = {}   # 最近一轮用量（供计费/诊断读取）

    def _payload(self, messages: Sequence[Message], temperature: float, max_tokens: int) -> dict:
        """组 chat/completions 请求体（抽出便于单测：确认新能力字段真带上了）。核心字段在 extra_body 之后，永不被覆盖。"""
        payload: dict = {
            **self._extra_body,          # 配置透传字段（如关思考）；核心字段在后，永不被覆盖
            "model": self._model,
            "messages": list(messages),
            "temperature": temperature,
            "max_tokens": max_tokens,
            "stream": True,
        }
        if self._freq_penalty:
            payload["frequency_penalty"] = self._freq_penalty
        if self._pres_penalty:
            payload["presence_penalty"] = self._pres_penalty
        if self._report_usage:
            payload["stream_options"] = {"include_usage": True}
        return payload

    async def stream(
        self, messages: Sequence[Message], *, temperature: float = 0.8, max_tokens: int = 256
    ) -> AsyncIterator[str]:  # pragma: no cover  （需真实网络/密钥，不在测试路径）
        payload = self._payload(messages, temperature, max_tokens)
        headers = {
            "Authorization": f"Bearer {self._node.api_key}",
            "Content-Type": "application/json",
        }
        # OpenAI 兼容 SSE：逐行 data: {json}，token 在 choices[0].delta.content；末块 choices=[] 带 usage。
        async with _shared_client().stream(
            "POST", self._endpoint, headers=headers, json=payload
        ) as resp:
            resp.raise_for_status()
            async for line in resp.aiter_lines():
                if not line or not line.startswith("data:"):
                    continue
                data = line[5:].strip()
                if data == "[DONE]":
                    break
                try:
                    obj = json.loads(data)
                except ValueError:
                    continue
                usage = obj.get("usage")
                if usage:   # include_usage 的末块：记下用量 + 打缓存命中诊断（每轮一次，可 grep 💰）
                    self.last_usage = usage
                    log.info("💰 LLM用量 %s", _usage_brief(usage))
                choices = obj.get("choices") or []
                if not choices:
                    continue
                delta = (choices[0].get("delta") or {}).get("content")
                if delta:
                    yield delta
