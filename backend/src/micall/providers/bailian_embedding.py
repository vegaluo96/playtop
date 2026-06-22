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


class BailianEmbedding:
    def __init__(self, node: NodeConfig) -> None:
        if httpx is None:  # pragma: no cover
            raise RuntimeError("BailianEmbedding 需要 httpx：pip install -r requirements.txt")
        if not node.configured:
            raise RuntimeError(f"节点 {node.name} 未配置 endpoint/api_key（铁律2）")
        self.node = node
        self.model = node.params.get("model", "text-embedding-v3")

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
        async with httpx.AsyncClient(timeout=httpx.Timeout(10.0, connect=5.0)) as client:
            for i in range(0, len(items), _BATCH):
                chunk = items[i : i + _BATCH]
                resp = await client.post(
                    self.node.endpoint, headers=headers,
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
