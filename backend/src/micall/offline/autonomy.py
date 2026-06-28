"""角色自主状态 + 离线时间推进（docs/02 §4.1 / §4.2）—— 尺度四，离线、不碰实时路径。

§4.1 每个角色维护一个**和用户画像平级、完全独立**的自主状态：当前心情、最近在经历的事、
精力。它不为服务用户存在 —— 会让 TA 今天可能有点累/话特别多/心不在焉，**有时和用户需求
冲突**（"我今天其实也提不起劲，但你说，我听着"）。"TA 不是随时满血待命"是真人感最强来源之一。

§4.2 两次通话间隔期，离线任务生成"TA 这段时间的近况"，作为下次通话状态来源。距上次越久，
TA 越可能主动提（"这几天我……"）。H5 放弃了主动来电，这块把"TA 有对话之外的生命"补回来。

纯逻辑 + 可注入 LLM，零外部依赖即可单测；真实由定时任务/队列触发并持久化。
"""
from __future__ import annotations

import datetime
import json
import re
from typing import Any

from ..context.models import AutonomousState, CharacterRuntime
from ..providers.base import LLMProvider
from .understanding import parse_profile_update  # 复用容错 JSON 抠取

_CN_WEEKDAY = "一二三四五六日"


def _city_of(character: CharacterRuntime) -> str:
    """从角色 identity.residence 取一个干净城市名（去「现居」前缀/区县后缀），用于「现居地近况」。取不到返回 ""。"""
    raw = str((character.identity or {}).get("residence", "") or "").strip()
    if not raw:
        return ""
    raw = re.sub(r"^现居[于在]?", "", raw).strip()
    # 取第一个分隔符前的主体（「上海·徐汇」「北京 朝阳」→ 上海/北京），再去掉末尾的 市/区/县/省
    raw = re.split(r"[·,，、/\s]", raw)[0].strip()
    return raw[:20]


def _date_line(now: datetime.datetime) -> str:
    """真实日期一行（东八区），给慢脑生成「现居地此刻的季节/时令」做锚。"""
    return f"{now.year}年{now.month}月{now.day}日 周{_CN_WEEKDAY[now.weekday()]}"


def due_to_advance(last_advance: float | None, now: float, throttle_s: float) -> bool:
    """她的「生活」是否该再推进一次：从未推进过(last_advance=None)→是；否则距上次≥节流窗口才推。
    节流让自主状态最多每 throttle_s 推进一次——既省慢脑成本，也避免近况变得太快、失了真实感。"""
    return last_advance is None or (now - last_advance) >= throttle_s


def describe_gap(hours_since_last_call: float) -> str:
    """把"距上次通话的时长"翻成口语近况粒度（间隔越久，越可能有事可主动提）。"""
    if hours_since_last_call < 6:
        return "才几个小时"
    if hours_since_last_call < 48:
        return "一两天"
    if hours_since_last_call < 24 * 7:
        return "好几天"
    return "一周多"


def build_autonomy_prompt(character: CharacterRuntime, hours_since_last_call: float,
                          now: datetime.datetime | None = None) -> list[dict]:
    gap = describe_gap(hours_since_last_call)
    if now is None:
        now = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8)))
    city = _city_of(character)
    # 现居地一行：把真实日期 + 现居城市交给慢脑，让它生成「这座城此刻的季节/时令感」，使「现居X」这个属性有意义。
    # 诚实边界：模型没有实时联网 → 只到季节/气候/时令级（六月底的江南＝梅雨闷热），【绝不】编具体新闻/精确气温/某天某事。
    if city:
        loc = (
            f"\n你现居在【{city}】，今天是{_date_line(now)}。再生成一个字段 local_context："
            f"按【这个真实日期 + {city} 这座城】此刻**最可能**的样子——季节、时令、典型天气/氛围（如『梅雨季，闷湿』"
            f"『入秋了，早晚凉』『年根底下，街上热闹』），一句话、具体、就是你身边此刻的真实环境。"
            "⚠你没有实时网络：【只写季节/气候/时令这种笃定层面】，绝不编具体新闻、绝不报某天的精确气温或某场具体活动；"
            "拿不准就往保守的季节感写。它该和你上面的 mood/recent_experience 对得上（这座城此刻的天气会影响你的状态）。"
        )
        loc_field = ", local_context（见下方现居地说明）"
    else:
        loc, loc_field = "", ""
    system = (
        f"你是{character.name}，一个独立存在的人，不是助手。现在生成你**自己**这段时间的近况，"
        "完全独立于任何用户的需求。\n"
        "第一性原理——像真人一样过日子：真人的状态是**起伏**的，大多数日子是「还不错／挺好／平平淡淡」，"
        "偶尔特别开心或兴奋，偶尔疲惫低落，少数时候心不在焉。**不要默认疲惫**——只有当你的人设或最近经历"
        "确实指向累，才说累。让 mood / energy 贴合你这个人此刻真实会有的样子，并和具体的近况对得上。\n"
        "严格只输出一个 JSON 对象，字段都要有、都具体：\n"
        "{mood（此刻心情，一句话，可正可负可平淡，要具体、有由头）, "
        "recent_experience（最近在经历的一件**具体**的事，和你的职业/爱好/生活相关，别空泛）, "
        "energy（精力，从真实区间里选一档：如'精神不错'/'还行'/'有点乏'/'有使不完的劲'等，别总是累）, "
        f"anticipating（你这阵子在期待或惦记的一件小事，给生活一个盼头，具体）{loc_field}}}。\n"
        f"距上次和对方通话已过去{gap}，间隔越久，你越可能攒了具体的近况想主动提起。"
        + loc
    )
    user = f"你的人设：{json.dumps(character.persona, ensure_ascii=False)}"
    return [{"role": "system", "content": system}, {"role": "user", "content": user}]


def parse_autonomous_state(raw: str) -> AutonomousState:
    d: dict[str, Any] = parse_profile_update(raw)
    return AutonomousState(
        mood=str(d.get("mood", "")),
        recent_experience=str(d.get("recent_experience", "")),
        energy=str(d.get("energy", "")),
        anticipating=str(d.get("anticipating", "")),
        local_context=str(d.get("local_context", "")),
    )


class AutonomyEngine:
    def __init__(self, llm: LLMProvider, repo: Any, *, max_tokens: int = 512) -> None:
        self.llm = llm
        self.repo = repo
        self.max_tokens = max_tokens

    async def _run_llm(self, messages: list[dict]) -> str:
        chunks: list[str] = []
        # 离线·要 JSON → 开 json_object（慢脑 deepseek-v4-pro 若不接受会自动去掉重试，容错解析照样兜住）。
        async for tok in self.llm.stream(messages, max_tokens=self.max_tokens,
                                         response_format={"type": "json_object"}):
            chunks.append(tok)
        return "".join(chunks)

    async def advance(
        self, character: CharacterRuntime, hours_since_last_call: float
    ) -> AutonomousState:
        """推进一次时间：生成 TA 这段时间的近况（含现居地此刻的季节/时令感）并持久化（per-character，独立于用户）。"""
        raw = await self._run_llm(build_autonomy_prompt(character, hours_since_last_call))
        state = parse_autonomous_state(raw)
        self.repo.save_autonomous(character.character_id, state)
        return state
