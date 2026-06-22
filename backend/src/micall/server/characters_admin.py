"""后台「角色管理」读写（docs/01 角色资产 + 铁律7）。

出厂角色 spec 在 asset-pipeline/characters/*.json（入库、全用户共享）；运营在后台改的人设/
音色等落到 config/character_overrides.json（gitignored，不污染仓库、git pull 不冲掉），加载时
深合并到出厂 spec 上。通话端每通电话重载 → 改完下一通即生效。

只允许编辑「已存在的出厂角色」的有限字段（人设/说话风格/喜好/音色/口吻），不允许凭空建 id、
不碰视觉资产（视觉全局固定，在资产轨强制）。列表字段（性格/喜欢/不喜欢）在读出时用「、」连成
串便于编辑，写回时再拆回列表。
"""
from __future__ import annotations

import json
import re
from pathlib import Path

from ..config import _REPO_DEFAULT, _deep_merge

_REPO_ROOT = Path(__file__).resolve().parents[4]
_CHARACTERS_DIR = _REPO_ROOT / "asset-pipeline" / "characters"
CHAR_OVERRIDES_PATH = _REPO_DEFAULT.parent / "character_overrides.json"

_LIST_SEP = re.compile(r"[、,，;；\n]+")


def _split(s: str) -> list[str]:
    return [x.strip() for x in _LIST_SEP.split(str(s or "")) if x.strip()]


def _join(xs) -> str:
    return "、".join(xs or [])


def factory_specs() -> dict[str, dict]:
    """出厂 spec（不含 overrides），按 character_id 归档。"""
    out: dict[str, dict] = {}
    if _CHARACTERS_DIR.is_dir():
        for p in sorted(_CHARACTERS_DIR.glob("*.json")):
            try:
                spec = json.loads(p.read_text(encoding="utf-8"))
            except (ValueError, OSError):
                continue
            cid = spec.get("identity", {}).get("character_id", "")
            if cid:
                out[cid] = spec
    return out


def load_overrides() -> dict:
    if CHAR_OVERRIDES_PATH.exists():
        try:
            return json.loads(CHAR_OVERRIDES_PATH.read_text(encoding="utf-8"))
        except (ValueError, OSError):
            return {}
    return {}


def effective_specs() -> dict[str, dict]:
    """出厂 spec 深合并运营 overrides → 生效中的角色定义（通话端与后台都用这个）。"""
    overrides = load_overrides()
    out: dict[str, dict] = {}
    for cid, spec in factory_specs().items():
        ov = overrides.get(cid)
        out[cid] = _deep_merge(spec, ov) if isinstance(ov, dict) else spec
    return out


# ── 后台读：把可编辑字段摊平成扁平 dict（列表 join 成串）──
def read_characters_for_admin() -> list[dict]:
    out: list[dict] = []
    for cid, s in effective_specs().items():
        ident = s.get("identity", {}) or {}
        persona = s.get("persona", {}) or {}
        voice = s.get("voice", {}) or {}
        ro = s.get("runtime_overrides", {}) or {}
        out.append({
            "id": cid,
            "name": ident.get("name", ""),
            "tagline": ident.get("tagline", ""),
            "gender": ident.get("gender", ""),
            "age": ident.get("age", ""),
            "traits": _join(persona.get("core_traits")),
            "speaking_style": persona.get("speaking_style", ""),
            "background_story": persona.get("background_story", ""),
            "values": persona.get("values_and_boundaries", ""),
            "likes": _join(persona.get("likes")),
            "dislikes": _join(persona.get("dislikes")),
            "voice_id": voice.get("voice_id", ""),
            "prompt_extra": ro.get("realtime_prompt_extra", "") or "",
        })
    return out


# ── 后台写：把扁平 dict 的改动并回 character_overrides.json（仅已知出厂角色、仅白名单字段）──
def write_character_from_admin(payload: dict) -> None:
    cid = str((payload or {}).get("id", "")).strip()
    if not cid:
        raise ValueError("缺少角色 id")
    if cid not in factory_specs():
        raise ValueError(f"未知出厂角色 {cid!r}（不允许凭空新建）")
    ov = load_overrides()
    node = ov.setdefault(cid, {})
    ident = node.setdefault("identity", {})
    persona = node.setdefault("persona", {})
    voice = node.setdefault("voice", {})
    ro = node.setdefault("runtime_overrides", {})
    p = payload

    def s(v) -> str:
        return str(v).strip()

    if "name" in p:            ident["name"] = s(p["name"])
    if "tagline" in p:         ident["tagline"] = s(p["tagline"])
    if "traits" in p:          persona["core_traits"] = _split(p["traits"])
    if "speaking_style" in p:  persona["speaking_style"] = s(p["speaking_style"])
    if "background_story" in p: persona["background_story"] = s(p["background_story"])
    if "values" in p:          persona["values_and_boundaries"] = s(p["values"])
    if "likes" in p:           persona["likes"] = _split(p["likes"])
    if "dislikes" in p:        persona["dislikes"] = _split(p["dislikes"])
    if "voice_id" in p:        voice["voice_id"] = s(p["voice_id"])
    if "prompt_extra" in p:    ro["realtime_prompt_extra"] = s(p["prompt_extra"])

    tmp = CHAR_OVERRIDES_PATH.with_name(CHAR_OVERRIDES_PATH.name + ".tmp")
    tmp.write_text(json.dumps(ov, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(CHAR_OVERRIDES_PATH)
