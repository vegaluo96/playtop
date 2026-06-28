"""配置系统 —— CLAUDE.md 铁律2：所有外部服务 endpoint/key 走配置，绝不硬编码。

加载顺序（后者覆盖前者）：
  1. config/default.json          仓库内占位（不含真实密钥）
  2. $MICALL_CONFIG 指向的 JSON   部署时的真实配置/密钥（不入库）
  3. 进程环境变量                 MICALL_<NODE>_API_KEY / MICALL_<NODE>_ENDPOINT（密钥最高优先级）

节点与 Admin「接口配置」5 节点一致（docs/02 §7.9）：asr / llm_fast / tts / llm_slow / embedding。
切供应商（"先走 apiyi、卡了切直连 DeepSeek"）只改配置，对话逻辑不动（§1.7）。

另含 §6.1 三级配置覆盖（用户自定义 > 角色配置 > 全局默认）的纯函数解析。
"""
from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

_REPO_DEFAULT = Path(__file__).resolve().parents[2] / "config" / "default.json"

# Admin「接口配置」的节点（docs/02 §7.9）。llm_eval=顶级评测/分析脑（图灵测试裁判·分析师、后台 AI 生成），
# 离线/偶发调用、延迟无所谓 → 配最强模型；未配则按 make_eval_llm 回退 llm_slow→llm_fast。
# llm_search=联网脑（自带网络检索的模型，如 apiyi 的 grok-4-all）：离线给角色抓「现居地真实天气+安全话题」
# →写进自主状态，让 TA 像真活在世界里；未配则角色现居地近况退回慢脑的季节推测（不联网）。
NODE_KEYS = ("asr", "llm_fast", "tts", "llm_slow", "embedding", "image", "llm_eval", "llm_search")


def _header_safe(s: str) -> str:
    """清洗将进 HTTP 头的字段（endpoint/key）：去掉复制粘贴常带进来的 U+2028/2029 行段分隔符、
    不间断空格(\\xa0)、零宽字符(\\u200b-\\u200d/\\ufeff)、换行/制表等。否则塞进 Authorization 头时
    httpx 报「'ascii' codec can't encode character '\\u2028'」→ 测试连接/通话直接失败。
    endpoint/key 本就是可见 ASCII，过滤到 0x21-0x7E（连内部空白一起去掉，键里不该有空格）。"""
    return "".join(ch for ch in (s or "") if 0x21 <= ord(ch) <= 0x7E)


def as_int(v: Any, default: int) -> int:
    """容错取整：后台/override 写入的数字字段可能是非数字串（如 ""/"abc"）。直接 int() 会 ValueError
    崩服务，这里失败即回退默认，让坏配置最多无效、绝不致命。"""
    try:
        return int(float(str(v).strip()))
    except (TypeError, ValueError):
        return default


def as_float(v: Any, default: float) -> float:
    """容错取浮点：同 as_int，失败回退默认。"""
    try:
        return float(str(v).strip())
    except (TypeError, ValueError):
        return default


@dataclass
class NodeConfig:
    """单个供应商节点（endpoint + key + 其余参数）。"""

    name: str
    provider: str = ""
    endpoint: str = ""
    api_key: str = ""
    params: dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        # endpoint/key 统一清洗：无论来自 load_config 还是后台测试直接构造，都不带非法头字符。
        self.endpoint = _header_safe(self.endpoint)
        self.api_key = _header_safe(self.api_key)

    @property
    def configured(self) -> bool:
        """endpoint 与 key 都就绪才算可真实调用；否则编排回退到 stub。"""
        return bool(self.endpoint.strip() and self.api_key.strip())


@dataclass
class Config:
    nodes: dict[str, NodeConfig]
    global_defaults: dict[str, Any]
    server: dict[str, Any]
    billing: dict[str, Any]
    turn: dict[str, Any]
    database: dict[str, Any]
    cost: dict[str, Any] = field(default_factory=dict)
    raw: dict[str, Any] = field(default_factory=dict)

    def node(self, key: str) -> NodeConfig:
        if key not in self.nodes:
            raise KeyError(f"未知节点 {key!r}，应为 {NODE_KEYS}")
        return self.nodes[key]


def _deep_merge(base: dict[str, Any], over: dict[str, Any]) -> dict[str, Any]:
    out = dict(base)
    for k, v in over.items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = _deep_merge(out[k], v)
        else:
            out[k] = v
    return out


def _load_json(path: str | Path) -> dict[str, Any]:
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def _apply_env_secrets(raw: dict[str, Any]) -> dict[str, Any]:
    """环境变量注入密钥/端点（最高优先级），密钥永不落仓库。
    约定：MICALL_LLM_FAST_API_KEY / MICALL_LLM_FAST_ENDPOINT … （节点名大写）。"""
    nodes = raw.setdefault("nodes", {})
    for key in NODE_KEYS:
        node = nodes.setdefault(key, {})
        ek = f"MICALL_{key.upper()}_API_KEY"
        ep = f"MICALL_{key.upper()}_ENDPOINT"
        if os.environ.get(ek):
            node["api_key"] = os.environ[ek]
        if os.environ.get(ep):
            node["endpoint"] = os.environ[ep]
    if os.environ.get("MICALL_DATABASE_DSN"):
        raw.setdefault("database", {})["dsn"] = os.environ["MICALL_DATABASE_DSN"]
    return raw


def load_config(path: str | Path | None = None) -> Config:
    """加载并合并配置。path 缺省走仓库 default.json + $MICALL_CONFIG + 环境密钥。"""
    raw = _load_json(path or _REPO_DEFAULT)
    override = os.environ.get("MICALL_CONFIG")
    if override:
        raw = _deep_merge(raw, _load_json(override))
    raw = _apply_env_secrets(raw)
    # 后台「接口配置」网页写入的覆盖（最高优先级）：网页配的 > micall.env > default.json。
    # 只含运营实际填过的非空字段，缺省项仍回退 env/default（见 server/adminapi.py）。
    admin_overrides = _REPO_DEFAULT.parent / "admin_overrides.json"
    if path is None and admin_overrides.exists():
        try:
            raw = _deep_merge(raw, _load_json(admin_overrides))
        except (ValueError, OSError):
            pass

    nodes: dict[str, NodeConfig] = {}
    for key in NODE_KEYS:
        n = dict(raw.get("nodes", {}).get(key, {}))
        nodes[key] = NodeConfig(
            name=key,
            provider=n.pop("provider", ""),
            endpoint=n.pop("endpoint", ""),
            api_key=n.pop("api_key", ""),
            params={k: v for k, v in n.items() if not k.startswith("_")},
        )
    return Config(
        nodes=nodes,
        global_defaults=raw.get("global_defaults", {}),
        server=raw.get("server", {}),
        billing=raw.get("billing", {}),
        turn=raw.get("turn", {}),
        database=raw.get("database", {}),
        cost=raw.get("cost", {}),
        raw=raw,
    )


# ─────────────────────── 三级配置覆盖（docs/02 §6.1）───────────────────────
# 优先级链：用户自定义 > 角色配置 > 全局默认。视觉/背景全局固定、不可覆盖（在资产轨强制）。

_RUNTIME_KEYS = ("tts_model", "memory_depth", "reply_max_tokens", "realtime_prompt_extra")


def resolve_runtime(
    global_defaults: dict[str, Any],
    char_overrides: dict[str, Any] | None = None,
    user_overrides: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """合并出本次通话的运行时行为参数（行为层，非视觉）。None 值视为「未设、跳过」。"""
    out: dict[str, Any] = {}
    for k in _RUNTIME_KEYS:
        if k in global_defaults and global_defaults[k] is not None:
            out[k] = global_defaults[k]
    for src in (char_overrides, user_overrides):
        if not src:
            continue
        for k, v in src.items():
            if v is not None:
                out[k] = v
    return out


def resolve_voice(
    global_default_voice: str,
    char_voice_id: str | None = None,
    user_voice_id: str | None = None,
) -> str:
    """运行时取音色（§6.1）：user_voice ?? character.voice_id ?? global.default_voice。"""
    if user_voice_id and user_voice_id.strip():
        return user_voice_id
    if char_voice_id and char_voice_id.strip():
        return char_voice_id
    return global_default_voice
