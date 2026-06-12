"use client";

/** Cookie 同意条:首访底部出现,同意后 localStorage 记忆;链接到 /about 隐私说明 */
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

const KEY = "playtop.consent";

export function ConsentBar() {
  const [show, setShow] = useState(false);
  const router = useRouter();
  useEffect(() => {
    try {
      if (!localStorage.getItem(KEY)) setShow(true);
    } catch {
      /* 无 localStorage 环境不展示 */
    }
  }, []);
  if (!show) return null;
  return (
    <div
      style={{
        position: "fixed", left: 0, right: 0, bottom: 0, zIndex: 90,
        minHeight: "calc(52px + max(6px, env(safe-area-inset-bottom)))",
        boxSizing: "border-box",
        display: "flex", alignItems: "center", gap: 12, padding: "8px 14px max(8px, env(safe-area-inset-bottom))",
        background: "var(--card)", borderTop: "1px solid var(--line)", backdropFilter: "blur(8px)",
      }}
    >
      <span style={{ flex: 1, fontSize: 12, color: "var(--fg-2)", lineHeight: 1.55 }}>
        本站仅使用必要的会话 Cookie 维持登录,并以本地存储记忆界面偏好;继续使用即表示同意。
        <span onClick={() => router.push("/about")} style={{ color: "var(--gold)", cursor: "pointer", marginLeft: 4 }}>了解详情 ›</span>
      </span>
      <span
        onClick={() => {
          localStorage.setItem(KEY, String(Date.now()));
          setShow(false);
        }}
        style={{ flexShrink: 0, minHeight: 38, display: "inline-flex", alignItems: "center", justifyContent: "center", background: "var(--cta)", color: "var(--on-cta)", borderRadius: 9, padding: "0 18px", fontSize: 12.5, fontWeight: 850, cursor: "pointer" }}
      >
        同意
      </span>
    </div>
  );
}

/** 全站页脚风险提示(运营规范:明确非博彩平台定位) */
export function RiskFooter({ pad = true }: { pad?: boolean }) {
  const router = useRouter();
  return (
    <div style={{ textAlign: "center", fontSize: 11.5, color: "var(--fg-3)", lineHeight: 1.7, padding: pad ? "10px 24px 14px" : "6px 24px" }}>
      本平台仅提供体育数据资讯与分析,不提供任何形式的投注或博彩服务;内容仅供参考,请遵守当地法律法规。
      <span onClick={() => router.push("/about")} style={{ color: "var(--gold)", cursor: "pointer", marginLeft: 4 }}>免责声明 ›</span>
    </div>
  );
}
