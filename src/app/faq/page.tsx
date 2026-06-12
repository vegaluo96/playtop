"use client";

/** 常见问题(我的页入口):积分/解锁/数据口径/刷新频率/综合指数 */
import { useState } from "react";
import { useRouter } from "next/navigation";

const FAQ: { q: string; a: string }[] = [
  {
    q: "积分是什么?可以提现吗?",
    a: "积分用于解锁平台内的模型预测与 AI 深度报告,1 元 = 10 积分起,充值档位越高加赠越多。积分不具备货币属性,不可提现、不可转让。",
  },
  {
    q: "哪些内容收费?哪些免费?",
    a: "全站唯一收费项是「赛事预测(含 AI 深度报告)」:赛前 38 积分/场,开赛后 58 积分/场,解锁后永久可见。盘口走势、百家对比、异动流、技术统计、阵容情报等注册后完整可见。每天另有平台指定的免费分析场次。",
  },
  {
    q: "数据多久刷新一次?",
    a: "按「距开赛时间」分 8 档自动加密:赛前 14 天起接入(每 12 小时),临近开赛逐级加快,滚球期为接口允许的最高频率(最快 5 秒)。任意页面点「数据刷新规则」可查看当前实际生效的档位表。",
  },
  {
    q: "综合指数是什么?",
    a: "综合指数是本站对多家数据源的聚合计价:取各家主盘的盘口中位数为「共识盘口」,再取该盘口下各家净水的中位数作为指数值;滚球段为实时盘直读。它是本站计算值,不代表任何单一公司报价,计算方法在每张图下方完整公开。",
  },
  {
    q: "为什么有的比赛没有预测方向?",
    a: "预测来自平台数据模型。当模型样本不足时,会改用当前盘口推导方向并明确标注「盘口推导」;两者都不可用时如实显示暂无,绝不编造。",
  },
  {
    q: "AI 报告会更新吗?",
    a: "会。赛前盘口或阵容发生实质变化时自动生成新版本(可在报告页切换历史版本、查看每版变化);开赛后报告锁定为临场版,不再变动。",
  },
  {
    q: "盘口走势图为什么开赛前点比较稀疏?",
    a: "走势图只记录真实变化:书商不调盘时曲线就是平的,平台绝不伪造跳动。开赛后接入滚球实时帧,变化会密集得多。",
  },
  {
    q: "遇到问题怎么反馈?",
    a: "「我 · 系统工单」提交问题,客服回复后我的页会出现红点提醒。充值类问题请附充值时间与档位。",
  },
];

export default function FaqPage() {
  const router = useRouter();
  const [open, setOpen] = useState<number | null>(0);
  return (
    <div style={{ flex: 1, overflowY: "auto", minHeight: 0, maxWidth: 720, margin: "0 auto", width: "100%" }}>
      <div style={{ display: "flex", alignItems: "center", padding: "10px 12px 6px" }}>
        <div onClick={() => router.back()} style={{ width: 34, height: 34, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", color: "var(--fg-2)", fontSize: 22, lineHeight: 1 }}>‹</div>
        <div style={{ flex: 1, textAlign: "center", fontSize: 15, fontWeight: 800 }}>常见问题</div>
        <div style={{ width: 34 }} />
      </div>
      <div style={{ padding: "4px 16px 24px" }}>
        {FAQ.map((f, i) => (
          <div key={i} onClick={() => setOpen(open === i ? null : i)} style={{ background: "var(--card)", border: "1px solid var(--line)", borderRadius: 12, padding: "12px 14px", marginTop: 8, cursor: "pointer" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ flex: 1, fontSize: 13, fontWeight: 700 }}>{f.q}</span>
              <span style={{ fontSize: 12, color: "var(--fg-3)" }}>{open === i ? "−" : "+"}</span>
            </div>
            {open === i && <div style={{ fontSize: 12, color: "var(--fg-mid)", lineHeight: 1.8, marginTop: 8 }}>{f.a}</div>}
          </div>
        ))}
      </div>
    </div>
  );
}
