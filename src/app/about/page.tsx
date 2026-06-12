"use client";

/** 关于与合规:平台性质声明 / 免责声明 / 数据来源 / 隐私与 Cookie 说明 */
import { useRouter } from "next/navigation";
import { APP_VERSION } from "@/lib/version";
import { SITE_BRAND, SITE_CN_NAME, SITE_HOST } from "@/lib/site";

const SECTIONS: { h: string; ps: string[] }[] = [
  {
    h: "平台性质",
    ps: [
      `${SITE_CN_NAME}(${SITE_BRAND})是一个体育数据资讯与分析平台,向用户提供足球赛事的赛程、指数数据走势、技术统计与模型分析内容。`,
      "本平台不提供任何形式的投注、博彩或资金对赌服务,不接受投注委托,不与任何博彩机构存在合作或资金往来。平台内全部数据与分析仅供信息参考与学习研究使用。",
    ],
  },
  {
    h: "免责声明",
    ps: [
      "平台展示的指数数据、综合指数与 AI 概率报告均基于公开数据源自动计算生成,不构成任何形式的投注建议或收益承诺。",
      "用户应遵守所在国家或地区的法律法规。任何因使用本平台信息而产生的直接或间接损失,平台不承担责任。",
      "账户额度仅用于解锁平台内 AI 概率报告,不具备货币属性,不可兑换现金,不可转让。",
    ],
  },
  {
    h: "数据来源",
    ps: [
      "赛事指数、阵容与统计数据来自官方数据接口;平台按公开频率自动抓取并归档,展示延迟与刷新频率在「数据刷新规则」中向用户完整披露。",
      "综合指数为本平台基于多家数据源的计算值,计算方法在图表下方公开说明,不冒充任何单一机构报价。",
    ],
  },
  {
    h: "隐私与 Cookie",
    ps: [
      "平台仅使用必要的会话 Cookie 维持登录状态,使用浏览器本地存储记忆界面偏好(主题/语言/时区),不做跨站追踪。",
      "注册邮箱仅用于账户识别与登录,不会向第三方披露。如需删除账户数据,可通过「我 · 系统工单」提交申请。",
    ],
  },
];

export default function AboutPage() {
  const router = useRouter();
  return (
    <div style={{ flex: 1, overflowY: "auto", minHeight: 0, maxWidth: 720, margin: "0 auto", width: "100%" }}>
      <div style={{ display: "flex", alignItems: "center", padding: "10px 12px 6px" }}>
        <div onClick={() => router.back()} style={{ width: 34, height: 34, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", color: "var(--fg-2)", fontSize: 22, lineHeight: 1 }}>‹</div>
        <div style={{ flex: 1, textAlign: "center", fontSize: 15, fontWeight: 800 }}>关于{SITE_CN_NAME}</div>
        <div style={{ width: 34 }} />
      </div>
      <div style={{ padding: "4px 16px 24px" }}>
        {SECTIONS.map((s) => (
          <div key={s.h} style={{ background: "var(--card)", border: "1px solid var(--line)", borderRadius: 14, padding: "13px 14px", marginTop: 10 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
              <span style={{ width: 3, height: 13, borderRadius: 2, background: "var(--gold)" }} />
              <span style={{ fontSize: 13, fontWeight: 800 }}>{s.h}</span>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {s.ps.map((x, i) => (
                <div key={i} style={{ fontSize: 12, color: "var(--fg-mid)", lineHeight: 1.8 }}>{x}</div>
              ))}
            </div>
          </div>
        ))}
        <div className="mono" style={{ textAlign: "center", fontSize: 11.5, color: "var(--fg-3)", padding: "16px 0 4px" }}>
          {SITE_CN_NAME} v{APP_VERSION} · {SITE_HOST}
        </div>
      </div>
    </div>
  );
}
