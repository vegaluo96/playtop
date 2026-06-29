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
from ..context.models import AutonomousState

_REPO_ROOT = Path(__file__).resolve().parents[4]
_CHARACTERS_DIR = _REPO_ROOT / "asset-pipeline" / "characters"
CHAR_OVERRIDES_PATH = _REPO_DEFAULT.parent / "character_overrides.json"
CUSTOM_CHARS_PATH = _REPO_DEFAULT.parent / "custom_characters.json"   # 运营新建的角色（全 spec）
DELETED_CHARS_PATH = _REPO_DEFAULT.parent / "deleted_characters.json"  # 被隐藏/删除的角色 id
OFFLINE_CHARS_PATH = _REPO_DEFAULT.parent / "offline_characters.json"  # 被「下架」的角色 id（仍在后台、不对用户展示）
CLONED_VOICES_PATH = _REPO_DEFAULT.parent / "cloned_voices.json"      # 克隆出的自定义音色清单（音色管理页据此展示）
DEFAULT_CHAR_PATH = _REPO_DEFAULT.parent / "default_character.json"   # 运营设定的默认角色 id（用户端进来先选它）
CHAR_ORDER_PATH = _REPO_DEFAULT.parent / "character_order.json"       # 运营自定义的角色显示顺序（id 列表，用户端发现列表+后台列表都按此排）
AVATARS_DIR = _REPO_DEFAULT.parent / "avatars"                        # 后台生成的角色头像（{cid}.png），/api/avatar 下发

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


# ── 克隆音色清单：克隆成功时记一条，音色管理页据此展示（系统库之外的自定义 voice_id）──
def load_cloned_voices() -> list[dict]:
    d = _load_json_file(CLONED_VOICES_PATH, [])
    return d if isinstance(d, list) else []


def add_cloned_voice(voice_id: str, name: str = "", char: str = "") -> None:
    vid = (voice_id or "").strip()
    if not vid:
        return
    voices = [v for v in load_cloned_voices() if v.get("voice_id") != vid]   # 同 id 覆盖（重克隆更新名）
    voices.append({"voice_id": vid, "name": (name or vid).strip(), "char": char or ""})
    _save_json_file(CLONED_VOICES_PATH, voices)


def remove_cloned_voice(voice_id: str) -> bool:
    vid = (voice_id or "").strip()
    voices = load_cloned_voices()
    kept = [v for v in voices if v.get("voice_id") != vid]
    if len(kept) == len(voices):
        return False
    _save_json_file(CLONED_VOICES_PATH, kept)
    return True


def load_deleted() -> set:
    d = _load_json_file(DELETED_CHARS_PATH, [])
    return set(d) if isinstance(d, list) else set()


def load_offline() -> set:
    """被「下架」的角色 id 集合：仍在后台可管理，但不对用户端展示（区别于「删除」）。"""
    d = _load_json_file(OFFLINE_CHARS_PATH, [])
    return set(d) if isinstance(d, list) else set()


def set_character_offline(cid: str, offline: bool) -> bool:
    """下架/上架某角色：只允许操作「生效中」（出厂/新建、未删除）的角色。下架=进集合、上架=出集合。"""
    cid = str(cid or "").strip()
    if cid not in effective_specs():
        return False
    off = load_offline()
    if offline:
        off.add(cid)
    else:
        off.discard(cid)
    _save_json_file(OFFLINE_CHARS_PATH, sorted(off))
    return True


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


# ── 角色「初始近况」预置（§4.1 自主状态的开局值）──
# 新角色上线时还没真打过电话、离线推进也没跑过，状态面板会空着。spec 里写一条 autonomous_seed
# 作为「出厂初始状态」：真实通话后由慢脑推进的 DB 状态一旦生成，就以 DB 为准、不再用种子。
def autonomous_seed(cid: str) -> dict | None:
    """取角色 spec 里的初始近况种子（mood/recent_experience/energy/anticipating）。无 → None。"""
    seed = (effective_specs().get(cid, {}) or {}).get("autonomous_seed")
    return seed if isinstance(seed, dict) and any(seed.values()) else None


def reset_autonomous_state(repo, cid: str) -> bool:
    """清掉某角色在 DB 里【已生长】的自主状态（心情/近况/精力/期待），回落到出厂『开局近况』(autonomous_seed)。
    用途：角色被重定位（如把『沈渡·电台主播』改名成『安杰·AI 战略官』）后，旧的 DB 近况还赖着、每通被注入
    （典型症状：新角色老提起前一个设定里的事，如『歌单』）。后台『重置自主状态』即调它。返回是否成功。"""
    cid = str(cid or "").strip()
    if not cid or cid not in effective_specs():
        return False
    try:
        repo.save_autonomous(cid, AutonomousState())   # 存空态 → effective_autonomous 下次回落到 spec 的 autonomous_seed
        return True
    except Exception:
        return False


def effective_autonomous(repo, cid: str) -> AutonomousState:
    """生效中的自主状态：DB 有（真实通话后由慢脑推进的）→ 用 DB；否则回退 spec 的出厂种子。"""
    st = repo.get_autonomous(cid)
    if st.mood or st.recent_experience or st.energy or st.anticipating:
        return st
    seed = autonomous_seed(cid)
    if seed:
        return AutonomousState(**{k: str(seed.get(k, "")) for k in AutonomousState.__dataclass_fields__})
    return st


# ── 后台读：把可编辑字段摊平成扁平 dict（列表 join 成串）──
def read_characters_for_admin() -> list[dict]:
    out: list[dict] = []
    offline = load_offline()
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
            # 角色级旋钮（runtime_overrides，空=走全局默认）：话长 / 记忆召回深度。出厂 spec 里这俩常为 null，
            # coerce 成 "" 便于后台空着显示「走全局默认」。
            "reply_max_tokens": ro.get("reply_max_tokens") or "",
            "memory_depth": ro.get("memory_depth") or "",
            # 富化维度：身份(职业/现居/MBTI) + 人设(性子/兴趣/口头禅/小习惯/软肋)。列表 join 成可编辑串。
            "occupation": ident.get("occupation", ""), "residence": ident.get("residence", ""),
            "mbti": ident.get("mbti", ""), "summary": persona.get("summary", ""),
            # 内核/spine：角色之所以是 TA 的那个组织原则（最在乎/最怕失去 + 软处）。运营可在后台细调。
            "core": persona.get("core", ""),
            "hobbies": _join(persona.get("hobbies")), "catchphrases": _join(persona.get("catchphrases")),
            "quirks": _join(persona.get("quirks")), "soft_spot": persona.get("soft_spot", ""),
            "has_avatar": avatar_file(cid).exists(),   # 后台据此决定编辑时是否预显已有头像
            "avatar_rev": avatar_rev(cid),             # 头像内容版本号：后台列表 URL 带 &v=rev → 内容不变走缓存、重生才换 URL
            "status": "下架" if cid in offline else "上线",
        })
    return _apply_char_order(out)   # 后台列表也按运营自定义顺序展示（运营在此上移/下移即所见）


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

    def cap(v, limit: int) -> str:
        # 文本字段上限：防超大文本撑爆系统提示词（撑高每轮 token、拖慢/拉高成本，甚至越界）。
        return s(v)[:limit]

    def num(v):
        """年龄/身高/体重：纯数字存成数字（_identity_line 才好用），非数字（空/"abc"）→ None 跳过，
        绝不把非数字串落进 identity（否则提示词里出现「年龄abc」）。"""
        t = s(v)
        if t == "":
            return None
        try:
            return int(float(t))
        except ValueError:
            return None

    if "name" in p:            ident["name"] = cap(p["name"], 60)
    if "tagline" in p:         ident["tagline"] = cap(p["tagline"], 200)
    # 基础资料：身份字段写回 identity（profile 子块放身高/体重/生日/种族），让后台改的年龄等真正进通话提示词。
    if "gender" in p:          ident["gender"] = cap(p["gender"], 20)
    if "age" in p and num(p["age"]) is not None:        ident["age"] = num(p["age"])
    if "nationality" in p:     ident["nationality"] = cap(p["nationality"], 60)
    if "appearance" in p:      ident["appearance"] = cap(p["appearance"], 1000)
    if any(k in p for k in ("height", "weight", "birthday", "race")):
        prof = ident.setdefault("profile", {})
        if "height" in p and num(p["height"]) is not None:  prof["height_cm"] = num(p["height"])
        if "weight" in p and num(p["weight"]) is not None:  prof["weight_kg"] = num(p["weight"])
        if "birthday" in p:    prof["birthday"] = cap(p["birthday"], 60)
        if "race" in p:        prof["race"] = cap(p["race"], 60)
    if "traits" in p:          persona["core_traits"] = _split(p["traits"])[:30]
    if "speaking_style" in p:  persona["speaking_style"] = cap(p["speaking_style"], 1000)
    if "background_story" in p: persona["background_story"] = cap(p["background_story"], 4000)
    if "hidden_layer" in p:    persona["hidden_layer"] = cap(p["hidden_layer"], 2000)
    if "values" in p:          persona["values_and_boundaries"] = cap(p["values"], 2000)
    if "likes" in p:           persona["likes"] = _split(p["likes"])[:30]
    if "dislikes" in p:        persona["dislikes"] = _split(p["dislikes"])[:30]
    if "voice_id" in p:        voice["voice_id"] = cap(p["voice_id"], 200)
    if "prompt_extra" in p:    ro["realtime_prompt_extra"] = cap(p["prompt_extra"], 2000)
    # 角色级旋钮：空字符串=清空覆盖、回退全局默认；有效数字=按角色生效（话长上限 4096、记忆深度上限 50）。
    if "reply_max_tokens" in p:
        v = num(p["reply_max_tokens"])
        if v is not None and v > 0:   ro["reply_max_tokens"] = min(4096, v)
        elif s(p["reply_max_tokens"]) == "": ro.pop("reply_max_tokens", None)
    if "memory_depth" in p:
        v = num(p["memory_depth"])
        if v is not None and v >= 0:  ro["memory_depth"] = min(50, v)
        elif s(p["memory_depth"]) == "": ro.pop("memory_depth", None)
    # 富化维度
    if "occupation" in p:      ident["occupation"] = cap(p["occupation"], 100)
    if "residence" in p:       ident["residence"] = cap(p["residence"], 100)
    if "mbti" in p:            ident["mbti"] = cap(p["mbti"], 20)
    if "summary" in p:         persona["summary"] = cap(p["summary"], 500)
    if "core" in p:            persona["core"] = cap(p["core"], 2000)   # 内核/spine，运营可细调
    if "hobbies" in p:         persona["hobbies"] = _split(p["hobbies"])[:30]
    if "catchphrases" in p:    persona["catchphrases"] = _split(p["catchphrases"])[:30]
    if "quirks" in p:          persona["quirks"] = _split(p["quirks"])[:30]
    if "soft_spot" in p:       persona["soft_spot"] = cap(p["soft_spot"], 2000)

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
            return ""   # 非数字 → 空（不把 "abc" 落进数值字段）

    prof = {k: v for k, v in (
        ("height_cm", n(p.get("height"))), ("weight_kg", n(p.get("weight"))),
        ("birthday", s(p.get("birthday"))), ("race", s(p.get("race"))),
    ) if v != ""}
    return {
        "identity": {"character_id": cid, "name": s(p.get("name")) or "新角色",
                     "tagline": s(p.get("tagline")), "gender": s(p.get("gender")), "age": n(p.get("age")),
                     "nationality": s(p.get("nationality")), "appearance": s(p.get("appearance")),
                     "occupation": s(p.get("occupation")), "residence": s(p.get("residence")), "mbti": s(p.get("mbti")),
                     **({"profile": prof} if prof else {}),
                     "version": "1"},
        "persona": {"core": s(p.get("core")),
                    "core_traits": _split(p.get("traits", "")), "summary": s(p.get("summary")),
                    "speaking_style": s(p.get("speaking_style")),
                    "background_story": s(p.get("background_story")),
                    "hidden_layer": s(p.get("hidden_layer")),
                    "values_and_boundaries": s(p.get("values")),
                    "hobbies": _split(p.get("hobbies", "")), "catchphrases": _split(p.get("catchphrases", "")),
                    "quirks": _split(p.get("quirks", "")), "soft_spot": s(p.get("soft_spot")),
                    "likes": _split(p.get("likes", "")), "dislikes": _split(p.get("dislikes", ""))},
        "voice": {"voice_id": s(p.get("voice_id"))},
        "runtime_overrides": {"realtime_prompt_extra": s(p.get("prompt_extra")),
                              **({"reply_max_tokens": n(p.get("reply_max_tokens"))} if n(p.get("reply_max_tokens")) != "" else {}),
                              **({"memory_depth": n(p.get("memory_depth"))} if n(p.get("memory_depth")) != "" else {})},
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
    """运营设定的默认角色 id；未设或已失效（被删/改名/下架/不存在）→ 回退第一个**在架**角色。"""
    offline = load_offline()
    specs = {cid: s for cid, s in effective_specs().items() if cid not in offline}  # 默认角色不能是下架的
    if not specs:
        return ""
    d = _load_json_file(DEFAULT_CHAR_PATH, {})
    cid = d.get("id") if isinstance(d, dict) else ""
    if cid and cid in specs:
        return cid
    return next(iter(specs.keys()))  # 未设/已失效：回退第一个在架角色（spec 按 character_id 排序，flagship 命名靠前即为主角）


def set_default_character(cid: str) -> bool:
    """设默认角色：只允许设成「生效中」的角色（出厂/运营新建、未被删除）。"""
    cid = str(cid or "").strip()
    if cid not in effective_specs():
        return False
    _save_json_file(DEFAULT_CHAR_PATH, {"id": cid})
    return True


def load_character_order() -> list[str]:
    """运营自定义的角色显示顺序（id 列表）。未设/非列表 → 空 → 回退自然序（出厂按 character_id、默认置顶）。"""
    d = _load_json_file(CHAR_ORDER_PATH, [])
    return [str(x) for x in d] if isinstance(d, list) else []


def set_character_order(ids) -> bool:
    """保存角色显示顺序：只保留生效中的角色 id、去重保序。非列表/空 → 不动返回 False。
    用户端「发现」列表与后台「角色管理」列表都按此排；未列入的角色排在后面、保持自然序。"""
    if not isinstance(ids, list):
        return False
    valid = set(effective_specs().keys())
    seen: set = set()
    kept: list[str] = []
    for x in ids:
        cid = str(x or "").strip()
        if cid in valid and cid not in seen:
            seen.add(cid)
            kept.append(cid)
    if not kept:
        return False
    _save_json_file(CHAR_ORDER_PATH, kept)
    return True


def _apply_char_order(items: list[dict]) -> list[dict]:
    """把一组带 id 的角色 dict 按运营自定义顺序重排（stable：未列入的保持原相对序、排在后面）。
    无自定义顺序 → 原样返回（由调用方各自决定默认排法）。"""
    order = load_character_order()
    if not order:
        return items
    rank = {cid: i for i, cid in enumerate(order)}
    big = len(order)
    return sorted(items, key=lambda d: rank.get(d.get("id"), big))


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
        "likes(喜欢，顿号分隔)、dislikes(不喜欢，顿号分隔)、values(价值观与边界一句话)、"
        # 内核/spine：让生成的角色一出生就是个有内核的人，而不是属性表。
        "core(内核2-4句，第二人称『你…』：这个人最在乎/最怕失去的那一个东西 + 守着的软处，"
        "并让上面的性格/来历/好恶像因果一样从这里长出来；show-not-tell，别贴标签、别报星座/MBTI)。不要任何解释。"
    )
    buf = ""
    async for tok in llm.stream([{"role": "system", "content": sys},
                                 {"role": "user", "content": prompt or "生成一个温柔治愈的角色"}],
                                max_tokens=1000, response_format={"type": "json_object"}):
        buf += tok
    m = re.search(r"\{.*\}", buf, re.S)
    if not m:
        raise ValueError("生成失败，未返回有效内容")
    data = json.loads(m.group())
    return {k: data.get(k, "") for k in
            ("name", "tagline", "gender", "age", "traits", "speaking_style", "background_story",
             "likes", "dislikes", "values", "core")}


async def generate_core(fields: dict, llm) -> str:
    """按角色【现有】维度提炼一段内核/spine（不新增设定、保人格）。供后台「AI 生成内核」一键填充。
    fields 是后台编辑态的扁平字段（name/traits/summary/background_story/hidden_layer/values/
    soft_spot/likes/dislikes/speaking_style/catchphrases/quirks/hobbies/occupation… 任意子集）。"""
    f = fields or {}
    label = {
        "name": "名字", "tagline": "一句话简介", "occupation": "职业", "summary": "性子",
        "traits": "性格", "speaking_style": "说话风格", "background_story": "来历",
        "hidden_layer": "未明说的内里", "values": "价值观与边界", "soft_spot": "软肋",
        "likes": "喜欢", "dislikes": "不喜欢", "catchphrases": "口头禅", "quirks": "小习惯", "hobbies": "兴趣",
    }
    digest = "\n".join(f"{label[k]}：{str(f.get(k)).strip()}" for k in label
                       if str(f.get(k, "")).strip())
    if not digest.strip():
        raise ValueError("角色维度为空，先填一些性格/来历/软肋再生成内核")
    sys = (
        "你是角色塑造专家。下面给你一个角色【现有】的各项维度，请提炼出 TA 的『内核 / spine』——"
        "这个人之所以是 TA 的那个点。规则："
        "① 只挑最深的【一个】：TA 最在乎/最想要/最怕失去的那件事，外加 TA 守着、怕被碰的那道软处。"
        "② 让现有维度像因果一样从这里长出来（价值观从来历来、软肋被戳到时会怎样、口头禅小习惯只是表层流露），"
        "织 2-3 个进去但要自然，别写成『因为…所以…』清单。"
        "③ 严格只用下面给的材料，绝不新增任何事实/事件/经历/设定；保人格不变（毒舌别写温柔、高冷别写热情）。"
        "④ 第二人称『你…』，2-4 句，show-not-tell，不贴标签、不报星座/MBTI/『你是个…型的人』。"
        "只输出 JSON：{\"core\":\"…\"}，不要任何解释。"
    )
    buf = ""
    async for tok in llm.stream([{"role": "system", "content": sys},
                                 {"role": "user", "content": digest}],
                                max_tokens=600, response_format={"type": "json_object"}):
        buf += tok
    m = re.search(r"\{.*\}", buf, re.S)
    if m:
        try:
            core = str(json.loads(m.group()).get("core", "")).strip()
            if core:
                return core
        except (ValueError, TypeError):
            pass
    # 兜底：模型没给合法 JSON 时，退回取纯文本（去掉可能的代码围栏/引号）
    txt = re.sub(r"^```\w*|```$", "", buf.strip()).strip().strip('"').strip()
    if not txt:
        raise ValueError("生成失败，未返回有效内容")
    return txt[:2000]


# ── 用户端公开角色列表（GET /api/characters）──
def avatar_file(cid: str):
    """该角色头像文件路径（可能不存在）。"""
    return AVATARS_DIR / f"{(cid or '').strip()}.png"


def _shrink_avatar(data: bytes, max_side: int = 640, quality: int = 85) -> bytes:
    """把生成的大图（常是 1024px PNG、1–3MB）缩到 ≤640px 并转 JPEG（~50–80KB）。
    圆圈展示（大球 288 / 列表 ≤96）绰绰有余，体积却降 ~30× → 加载快、且不再和通话音频抢带宽
    （弱网下大图下载会挤占 WS 音频，是通话卡顿的元凶之一）。无 Pillow 时原样返回，不阻断功能。"""
    try:
        import io

        from PIL import Image
    except Exception:
        return data
    try:
        im = Image.open(io.BytesIO(data)).convert("RGB")   # 转 RGB：JPEG 无 alpha，头像本就不透明
        w, h = im.size
        if max(w, h) > max_side:
            s = max_side / float(max(w, h))
            im = im.resize((max(1, round(w * s)), max(1, round(h * s))), Image.LANCZOS)
        out = io.BytesIO()
        im.save(out, format="JPEG", quality=quality, optimize=True)
        return out.getvalue()
    except Exception:
        return data   # 坏图/解码失败：原样存，绝不因压缩崩掉生成流程


def save_avatar(cid: str, data: bytes) -> None:
    """保存生成的头像：先缩小+转 JPEG（见 _shrink_avatar），再存为 {cid}.png（下发按魔数嗅探真实类型）。"""
    AVATARS_DIR.mkdir(parents=True, exist_ok=True)
    avatar_file(cid).write_bytes(_shrink_avatar(data))


def load_avatar(cid: str) -> bytes | None:
    """读取该角色头像字节；无则 None。存量大图（压缩功能上线前生成的 1–3MB PNG）首次取用时
    懒压缩并回写，之后即小图——无需重新生成即可享受加载提速。"""
    p = avatar_file(cid)
    try:
        if not p.exists():
            return None
        data = p.read_bytes()
    except OSError:
        return None
    if len(data) > 200_000:   # 仅对大图触发；压缩成功且确实更小才回写（只发生一次）
        small = _shrink_avatar(data)
        if 0 < len(small) < len(data):
            try:
                p.write_bytes(small)
            except OSError:
                pass
            return small
    return data


def avatar_rev(cid: str) -> int:
    """头像文件的内容版本号（mtime 取整）；无头像则 0。前后台都用它做「内容变了才换 URL」的缓存键。"""
    p = avatar_file(cid)
    if not p.exists():
        return 0
    try:
        return int(p.stat().st_mtime)
    except OSError:
        return 0


def avatar_url(cid: str) -> str:
    """该角色头像的下发 URL（带 mtime 版本号做缓存刷新）；无头像则空串。"""
    v = avatar_rev(cid)
    if not v:
        return ""
    return f"/api/avatar?c={cid}&v={v}"


def public_characters() -> list[dict]:
    """给用户端 App 的角色卡列表（剔除已删除，含运营新建）。hue 由前端按 id 配色。
    标注并把「默认角色」排到第一位——用户端进来先选它（运营在后台「角色管理」可改默认）。"""
    out: list[dict] = []
    default_id = load_default_character()
    offline = load_offline()
    for cid, s in effective_specs().items():
        if cid in offline:
            continue                         # 下架角色：不对用户端展示（仍在后台可上架）
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
            "occupation": ident.get("occupation", ""), "residence": ident.get("residence", ""),
            "mbti": ident.get("mbti", ""),
            "height": prof.get("height_cm", ""), "weight": prof.get("weight_kg", ""),
            "birthday": prof.get("birthday", ""), "race": prof.get("race", ""),
            # 富化维度（展示层）：性子一句话 / 兴趣 / 口头禅 / 小习惯。说话风格/价值观/内里/软肋属「幕后」不外吐。
            "summary": persona.get("summary", ""),
            "hobbies": persona.get("hobbies", []) or [], "catchphrases": persona.get("catchphrases", []) or [],
            "quirks": persona.get("quirks", []) or [],
            "likes": persona.get("likes", []) or [], "dislikes": persona.get("dislikes", []) or [],
            "avatar": avatar_url(cid),   # 后台生成的头像下发 URL（无则空串 → 前端回退渐变球）
            "default": cid == default_id,
        })
    if load_character_order():
        return _apply_char_order(out)            # 运营自定义了顺序 → 完全按其排（默认角色仍带 default 标，前端据此预选）
    out.sort(key=lambda c: 0 if c.get("default") else 1)  # 未自定义：默认排首位，其余保持原序
    return out
