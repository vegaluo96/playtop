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
    if node.provider in ("bailian_qwen3_asr", "bailian", "dashscope_asr", "qwen_asr"):
        from .bailian_asr import BailianASR

        return BailianASR(node)
    return StubASR()


def make_realtime_asr(node: NodeConfig, *, on_event=None):
    """真·实时流式 ASR，按 realtime_model 自动选协议：
      • qwen*（qwen3-asr-flash-realtime，国际站可用）→ OpenAI-Realtime 协议（/api-ws/v1/realtime）
      • 其它（paraformer-realtime-*，主要北京区）→ DashScope run-task 协议（/api-ws/v1/inference）
    WS 主机按区域从 ASR 的 HTTP endpoint 推断（通用区域端点，非专属域名）。
    """
    model = node.params.get("realtime_model", "qwen3-asr-flash-realtime")
    if model.startswith("qwen"):
        from .qwen_realtime_asr import QwenRealtimeASR

        return QwenRealtimeASR(node, on_event=on_event)
    from .realtime_asr import RealtimeBailianASR

    return RealtimeBailianASR(node, on_event=on_event)


__all__ = [
    "ASRProvider", "LLMProvider", "TTSProvider",
    "StubASR", "StubLLM", "StubTTS",
    "make_asr", "make_llm", "make_tts", "make_realtime_asr",
]
