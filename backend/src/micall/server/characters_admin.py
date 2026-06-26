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
CUSTOM_CHARS_PATH = _REPO_DEFAULT.parent / "custom_characters.json"   # 运营新建的角色（全 spec）
DELETED_CHARS_PATH = _REPO_DEFAULT.parent / "deleted_characters.json"  # 被隐藏/删除的角色 id
DEFAULT_CHAR_PATH = _REPO_DEFAULT.parent / "default_character.json"   # 运营设定的默认角色 id（用户端进来先选它）

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


def _load_json_file(path: Path, default):
    if path.exists():
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (ValueError, OSError):
            return default
    return default


def _save_json_file(path: Path, data) -> None:
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)


def load_custom() -> dict:
    d = _load_json_file(CUSTOM_CHARS_PATH, {})
    return d if isinstance(d, dict) else {}


def load_deleted() -> set:
    d = _load_json_file(DELETED_CHARS_PATH, [])
    return set(d) if isinstance(d, list) else set()


def effective_specs() -> dict[str, dict]:
    """出厂 spec + 运营新建角色，深合并 overrides、剔除已删除 → 生效中的角色定义（通话端/后台/用户端都用）。"""
    overrides = load_overrides()
    deleted = load_deleted()
    base = dict(factory_specs())
    base.update(load_custom())   # 运营新建的自定义角色
    out: dict[str, dict] = {}
    for cid, spec in base.items():
        if cid in deleted:
            continue
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
        prof = ident.get("profile", {}) or {}
        out.append({
            "id": cid,
            "name": ident.get("name", ""),
            "tagline": ident.get("tagline", ""),
            "gender": ident.get("gender", ""),
            "age": ident.get("age", ""),
            # 基础资料：过去后台只「显示」（且是前端写死的假数据），从不回真 spec、也存不回去——
            # 于是「后台显示 18 岁、通话里却按出厂 24 岁」对不上。把真值读出来，让后台能改、能存、能生效。
            "appearance": ident.get("appearance", ""),
            "nationality": ident.get("nationality", ""),
            "height": prof.get("height_cm", ""),
            "weight": prof.get("weight_kg", ""),
            "birthday": prof.get("birthday", ""),
            "race": prof.get("race", ""),
            "traits": _join(persona.get("core_traits")),
            "speaking_style": persona.get("speaking_style", ""),
            "background_story": persona.get("background_story", ""),
            "hidden_layer": persona.get("hidden_layer", ""),
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

    def num(v):
        """年龄/身高/体重：纯数字存成数字（_identity_line 才好用），非数字（如空）则跳过。"""
        t = s(v)
        if t == "":
            return None
        try:
            return int(float(t))
        except ValueError:
            return t

    if "name" in p:            ident["name"] = s(p["name"])
    if "tagline" in p:         ident["tagline"] = s(p["tagline"])
    # 基础资料：身份字段写回 identity（profile 子块放身高/体重/生日/种族），让后台改的年龄等真正进通话提示词。
    if "gender" in p:          ident["gender"] = s(p["gender"])
    if "age" in p and num(p["age"]) is not None:        ident["age"] = num(p["age"])
    if "nationality" in p:     ident["nationality"] = s(p["nationality"])
    if "appearance" in p:      ident["appearance"] = s(p["appearance"])
    if any(k in p for k in ("height", "weight", "birthday", "race")):
        prof = ident.setdefault("profile", {})
        if "height" in p and num(p["height"]) is not None:  prof["height_cm"] = num(p["height"])
        if "weight" in p and num(p["weight"]) is not None:  prof["weight_kg"] = num(p["weight"])
        if "birthday" in p:    prof["birthday"] = s(p["birthday"])
        if "race" in p:        prof["race"] = s(p["race"])
    if "traits" in p:          persona["core_traits"] = _split(p["traits"])
    if "speaking_style" in p:  persona["speaking_style"] = s(p["speaking_style"])
    if "background_story" in p: persona["background_story"] = s(p["background_story"])
    if "hidden_layer" in p:    persona["hidden_layer"] = s(p["hidden_layer"])
    if "values" in p:          persona["values_and_boundaries"] = s(p["values"])
    if "likes" in p:           persona["likes"] = _split(p["likes"])
    if "dislikes" in p:        persona["dislikes"] = _split(p["dislikes"])
    if "voice_id" in p:        voice["voice_id"] = s(p["voice_id"])
    if "prompt_extra" in p:    ro["realtime_prompt_extra"] = s(p["prompt_extra"])

    tmp = CHAR_OVERRIDES_PATH.with_name(CHAR_OVERRIDES_PATH.name + ".tmp")
    tmp.write_text(json.dumps(ov, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(CHAR_OVERRIDES_PATH)


# ── 新建自定义角色：扁平字段 → 全 spec，存 custom_characters.json ──
def _spec_from_flat(cid: str, p: dict) -> dict:
    def s(v) -> str:
        return str(v or "").strip()

    def n(v):
        t = s(v)
        if t == "":
            return ""
        try:
            return int(float(t))
        except ValueError:
            return t

    prof = {k: v for k, v in (
        ("height_cm", n(p.get("height"))), ("weight_kg", n(p.get("weight"))),
        ("birthday", s(p.get("birthday"))), ("race", s(p.get("race"))),
    ) if v != ""}
    return {
        "identity": {"character_id": cid, "name": s(p.get("name")) or "新角色",
                     "tagline": s(p.get("tagline")), "gender": s(p.get("gender")), "age": n(p.get("age")),
                     "nationality": s(p.get("nationality")), "appearance": s(p.get("appearance")),
                     **({"profile": prof} if prof else {}),
                     "version": "1"},
        "persona": {"core_traits": _split(p.get("traits", "")), "speaking_style": s(p.get("speaking_style")),
                    "background_story": s(p.get("background_story")),
                    "hidden_layer": s(p.get("hidden_layer")),
                    "values_and_boundaries": s(p.get("values")),
                    "likes": _split(p.get("likes", "")), "dislikes": _split(p.get("dislikes", ""))},
        "voice": {"voice_id": s(p.get("voice_id"))},
        "runtime_overrides": {"realtime_prompt_extra": s(p.get("prompt_extra"))},
    }


def create_character(payload: dict) -> str:
    """新建自定义角色，返回新 character_id。"""
    import secrets
    if not str((payload or {}).get("name", "")).strip():
        raise ValueError("角色名不能为空")
    cid = "custom_" + secrets.token_hex(4)
    custom = load_custom()
    custom[cid] = _spec_from_flat(cid, payload)
    _save_json_file(CUSTOM_CHARS_PATH, custom)
    return cid


def load_default_character() -> str:
    """运营设定的默认角色 id；未设或已失效（被删/改名/不存在）→ 回退第一个生效角色。"""
    specs = effective_specs()
    if not specs:
        return ""
    d = _load_json_file(DEFAULT_CHAR_PATH, {})
    cid = d.get("id") if isinstance(d, dict) else ""
    if cid and cid in specs:
        return cid
    return "lin_wan" if "lin_wan" in specs else next(iter(specs.keys()))  # 未设：回退产品主角林晚，否则第一个


def set_default_character(cid: str) -> bool:
    """设默认角色：只允许设成「生效中」的角色（出厂/运营新建、未被删除）。"""
    cid = str(cid or "").strip()
    if cid not in effective_specs():
        return False
    _save_json_file(DEFAULT_CHAR_PATH, {"id": cid})
    return True


def delete_character(cid: str) -> bool:
    """删除角色：自定义角色直接删除其 spec；出厂角色加入隐藏名单（不动只读资产）。"""
    cid = str(cid or "").strip()
    if not cid:
        return False
    custom = load_custom()
    if cid in custom:
        custom.pop(cid)
        _save_json_file(CUSTOM_CHARS_PATH, custom)
        return True
    if cid in factory_specs():
        deleted = load_deleted()
        deleted.add(cid)
        _save_json_file(DELETED_CHARS_PATH, sorted(deleted))
        return True
    return False


async def generate_character(prompt: str, llm) -> dict:
    """AI 一键生成：让 LLM 按描述产出角色字段（JSON）。返回扁平字段供运营预览/保存。"""
    sys = (
        "你是角色设定生成器。根据用户描述，生成一个适合语音陪伴 App 的虚拟角色。"
        "只输出 JSON，字段：name(中文名2-3字)、tagline(一句话简介)、gender(男/女)、age(数字)、"
        "traits(性格，3-4个，顿号分隔)、speaking_style(说话风格一句话)、background_story(背景故事2-3句)、"
        "likes(喜欢，顿号分隔)、dislikes(不喜欢，顿号分隔)、values(价值观与边界一句话)。不要任何解释。"
    )
    buf = ""
    async for tok in llm.stream([{"role": "system", "content": sys},
                                 {"role": "user", "content": prompt or "生成一个温柔治愈的角色"}],
                                max_tokens=800):
        buf += tok
    m = re.search(r"\{.*\}", buf, re.S)
    if not m:
        raise ValueError("生成失败，未返回有效内容")
    data = json.loads(m.group())
    return {k: data.get(k, "") for k in
            ("name", "tagline", "gender", "age", "traits", "speaking_style", "background_story", "likes", "dislikes", "values")}


# ── 用户端公开角色列表（GET /api/characters）──
def public_characters() -> list[dict]:
    """给用户端 App 的角色卡列表（剔除已删除，含运营新建）。hue 由前端按 id 配色。
    标注并把「默认角色」排到第一位——用户端进来先选它（运营在后台「角色管理」可改默认）。"""
    out: list[dict] = []
    default_id = load_default_character()
    for cid, s in effective_specs().items():
        ident = s.get("identity", {}) or {}
        persona = s.get("persona", {}) or {}
        prof = ident.get("profile", {}) or {}
        out.append({
            "id": cid, "name": ident.get("name", ""), "desc": ident.get("tagline", ""),
            "traits": persona.get("core_traits", []) or [],
            "bio": persona.get("background_story", ""),
            # 基础资料 + 喜好：过去用户端这些是按下标瞎编的假数据（与后台对不上）。回真值，让角色卡=后台设置。
            "gender": ident.get("gender", ""), "age": ident.get("age", ""),
            "appearance": ident.get("appearance", ""), "nationality": ident.get("nationality", ""),
            "height": prof.get("height_cm", ""), "weight": prof.get("weight_kg", ""),
            "birthday": prof.get("birthday", ""), "race": prof.get("race", ""),
            "likes": persona.get("likes", []) or [], "dislikes": persona.get("dislikes", []) or [],
            "default": cid == default_id,
        })
    out.sort(key=lambda c: 0 if c.get("default") else 1)  # stable：默认排首位，其余保持原序
    return out
