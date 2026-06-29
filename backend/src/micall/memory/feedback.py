"""通话评价 → 校准句：把用户挂断后打的星级 + 反馈标签，翻译成一句【下一通注入给 AI 的校准】。

闭环：前端「评分弹层」(星 1–5 + 标签) → /api/rate-call → repo.record_call_feedback → 写进
UserProfile.reply_calibration → 下一通 assembler._profile_block 注入 → AI 据此校准对这个用户的表现。
纯函数、无副作用，便于测试。措辞要短、可执行、像「自己的复盘」而非「系统指标」。"""
from __future__ import annotations

# 前端目前提供的 4 个反馈标签（见 MiCallLogic.feedbackChips）。映射成「角色复盘口吻」的短语；
# 未知标签忽略（前端日后增减标签，这里多一条少一条都不炸）。
_POSITIVE = {
    "很温暖": "TA 觉得你温暖",
    "聊得开心": "TA 跟你聊得开心",
}
_NEGATIVE = {
    "答非所问": "没接住 TA 的话/答非所问",
    "反应慢": "接话偏慢、不够跟手",
}


def calibration_from_feedback(rating: int, feedback: list[str] | None) -> str:
    """星级(1–5) + 标签 → 一句校准。空/非法 rating 返回空串（不写、不注入）。"""
    try:
        r = int(rating)
    except (TypeError, ValueError):
        return ""
    if not (1 <= r <= 5):
        return ""
    tags = [t for t in (feedback or []) if isinstance(t, str)]
    pos = [v for k, v in _POSITIVE.items() if k in tags]
    neg = [v for k, v in _NEGATIVE.items() if k in tags]

    if r >= 4:
        s = "上次 TA 对你这次的陪伴挺满意"
        if pos:
            s += "（" + "、".join(pos) + "）"
        s += "——保持这个状态，别为了变而变。"
        if neg:  # 高分仍勾了负面（少见）：提一句别忽略
            s += "唯一可再留意的：" + "、".join(neg) + "。"
        return s
    if r <= 2:
        s = "上次 TA 对你这次的陪伴不太满意"
        if neg:
            s += "（嫌你" + "、".join(neg) + "）"
        s += "——这次更用心：贴着 TA 的话走、接话干脆些、少绕少说教。"
        return s
    # r == 3：中评
    s = "上次 TA 觉得一般"
    if neg:
        s += "（主要是" + "、".join(neg) + "）"
    if pos:
        s += "（不过" + "、".join(pos) + "）"
    s += "——这次更贴 TA 一点，对的地方保持、欠的地方补上。"
    return s
