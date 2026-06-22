"""供应商工厂：按 NodeConfig 选实现；未配置 endpoint/key 的节点回退 stub。

"先走 apiyi、卡了切直连"只改配置不动逻辑（铁律2 / §1.7）—— 工厂是这一策略的唯一开关点。
"""
from __future__ import annotations

from ..config import NodeConfig
from .base import ASRProvider, LLMProvider, TTSProvider
from .stub import StubASR, StubLLM, StubTTS


def make_llm(node: NodeConfig) -> LLMProvider:
    if not node.configured:
        return StubLLM()
    if node.provider in ("apiyi_deepseek", "apiyi", "deepseek", "openai"):
        from .apiyi_llm import ApiyiLLM

        return ApiyiLLM(node)
    return StubLLM()


def make_tts(node: NodeConfig) -> TTSProvider:
    if not node.configured:
        return StubTTS()
    if node.provider in ("minimax", "minimax_tts"):
        from .minimax_tts import MiniMaxTTS

        return MiniMaxTTS(node)
    return StubTTS()


def make_asr(node: NodeConfig) -> ASRProvider:
    if not node.configured:
        return StubASR()
    # 真实：阿里百炼 Qwen3-ASR-Flash 流式直连。骨架未接，回退 stub。
    return StubASR()


__all__ = [
    "ASRProvider", "LLMProvider", "TTSProvider",
    "StubASR", "StubLLM", "StubTTS",
    "make_asr", "make_llm", "make_tts",
]
