"""记忆检索向量化 provider —— 阿里云百炼 text-embedding-v3（OpenAI 兼容 /embeddings）。

docs/02 §3.1/§7.9「Embedding · 记忆检索」节点：把事实层片段向量化，供情节记忆按余弦相似
检索（真实落 pgvector）。endpoint/key 全配置（铁律2），形如
  https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings（北京）
  https://dashscope-intl.aliyuncs.com/compatible-mode/v1/embeddings（新加坡）
未配置时工厂回退 None → 仓储用关键词近似召回（骨架可独立跑）。需 httpx。
"""
from __future__ import annotations

from typing import Sequence

from ..config import NodeConfig

try:
    import httpx
except ImportError:  # pragma: no cover
    httpx = None  # type: ignore

_BATCH = 10  # text-embedding-v3 单次 input 上限，分批喂


def _embed_endpoint(ep: str) -> str:
    """容错归一：填了 base（.../v1 或 .../compatible-mode/v1）就补全 /embeddings，避免 404。"""
    ep = (ep or "").strip().rstrip("/")
    if ep.endswith("/embeddings"):
        return ep
    if ep.endswith("/v1"):
        return ep + "/embeddings"
    return ep


from ._http import loop_client, pool_limits


def _shared_client() -> "httpx.AsyncClient":
    """共享 HTTP 连接池，按事件循环隔离（见 providers/_http.loop_client）。实时路径每轮召回都向
    （多在新加坡的）Embedding 发一次，复用 keep-alive 省掉「每轮一次 TCP+TLS 握手」→ AI 接话更跟手。
    与 minimax_tts/apiyi_llm 同法：管理端连通性测试走 asyncio.run（一次性循环），跨循环复用会 PoolTimeout，
    故每个循环各持一个 client（此前本 provider 缺该隔离，是连通性测试后召回卡死的隐患）。"""
    return loop_client(lambda: httpx.AsyncClient(
        timeout=httpx.Timeout(10.0, connect=5.0, pool=5.0),
        limits=pool_limits(),
    ))


class BailianEmbedding:
    def __init__(self, node: NodeConfig) -> None:
        if httpx is None:  # pragma: no cover
            raise RuntimeError("BailianEmbedding 需要 httpx：pip install -r requirements.txt")
        if not node.configured:
            raise RuntimeError(f"节点 {node.name} 未配置 endpoint/api_key（铁律2）")
        self.node = node
        self.endpoint = _embed_endpoint(node.endpoint)
        self.model = node.params.get("model", "text-embedding-v4")

    async def embed(self, texts: Sequence[str]) -> list[list[float]]:  # pragma: no cover （需真实网络/密钥）
        """批量向量化。返回与输入等长的向量列表（按 index 归位，空输入 → []）。"""
        items = [t for t in texts if (t or "").strip()]
        if not items:
            return []
        headers = {
            "Authorization": f"Bearer {self.node.api_key}",
            "Content-Type": "application/json",
        }
        out: list[list[float]] = []
        client = _shared_client()   # 进程级连接池，复用 keep-alive（不再 async with 关客户端）
        for i in range(0, len(items), _BATCH):
            chunk = items[i : i + _BATCH]
            resp = await client.post(
                self.endpoint, headers=headers,
                json={"model": self.model, "input": chunk},
            )
            if resp.status_code >= 400:
                detail = resp.text[:300]
                raise RuntimeError(f"HTTP {resp.status_code} · {detail}")
            data = resp.json().get("data") or []
            # 按 index 排序，保证与输入顺序一致。
            data.sort(key=lambda d: d.get("index", 0))
            out.extend([list(d.get("embedding") or []) for d in data])
        return out

    async def embed_one(self, text: str) -> list[float]:  # pragma: no cover
        vecs = await self.embed([text])
        return vecs[0] if vecs else []
