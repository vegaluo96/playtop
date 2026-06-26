"""真实快脑 LLM provider 骨架 —— apiyi 聚合网关（DeepSeek-V4-Flash），OpenAI 兼容 SSE。

endpoint/key 全部来自 NodeConfig（铁律2）。先全走 apiyi；若 TTFT 抖动/不透传 prefix
caching（§1.7 apiyi 风险），只改配置切直连 DeepSeek，本文件逻辑不动。

依赖 httpx（requirements.txt）；未安装时构造即报错，工厂会在节点未配置时回退 StubLLM，
所以骨架运行/测试不触发本文件。
"""
from __future__ import annotations

import json
from typing import AsyncIterator, Sequence

from ..config import NodeConfig
from .base import LLMProvider, Message

try:  # 真实接入才需要；缺失不影响骨架/测试
    import httpx
except ImportError:  # pragma: no cover
    httpx = None  # type: ignore


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

    async def stream(
        self, messages: Sequence[Message], *, temperature: float = 0.8, max_tokens: int = 256
    ) -> AsyncIterator[str]:  # pragma: no cover  （需真实网络/密钥，不在测试路径）
        payload = {
            **self._extra_body,          # 配置透传字段（如关思考）；核心字段在后，永不被覆盖
            "model": self._model,
            "messages": list(messages),
            "temperature": temperature,
            "max_tokens": max_tokens,
            "stream": True,
        }
        headers = {
            "Authorization": f"Bearer {self._node.api_key}",
            "Content-Type": "application/json",
        }
        # OpenAI 兼容 SSE：逐行 data: {json}，token 在 choices[0].delta.content。
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
                    delta = json.loads(data)["choices"][0]["delta"].get("content")
                except (KeyError, IndexError, ValueError):
                    continue
                if delta:
                    yield delta
