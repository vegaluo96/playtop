"use client";

import { usePathname, useRouter } from "next/navigation";
import { t } from "@/lib/i18n";
import { useApp } from "./app-context";
import { useIsDesktop } from "./use-viewport";
import { ConsentBar } from "./consent-bar";

/** 5 个 Tab 根路由显示底部导航;详情/报告/登录/二级页隐藏 */
const TABS = [
  { path: "/", label: () => t("navMatches"), icon: <path d="M3 5h14M3 10h14M3 15h8" /> },
  {
    path: "/data",
    label: () => t("navData"),
    icon: (
      <>
        <path d="M4 16V9" />
        <path d="M10 16V4" />
        <path d="M16 16v-6" />
        <path d="M3 16h14" />
      </>
    ),
  },
  { path: "/moves", label: () => t("navMoves"), icon: <path d="M2 11h3l2.5-6 4 11 2.5-6H18" /> },
  {
    path: "/predictions",
    label: () => t("navPred"),
    icon: (
      <>
        <circle cx="10" cy="10" r="7" />
        <circle cx="10" cy="10" r="2.6" />
      </>
    ),
  },
  {
    path: "/me",
    label: () => t("navMine"),
    icon: (
      <>
        <circle cx="10" cy="6.5" r="3" />
        <path d="M3.5 17c1.3-3.2 3.7-4.8 6.5-4.8s5.2 1.6 6.5 4.8" />
      </>
    ),
  },
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { prefs } = useApp();
  const isDesktop = useIsDesktop();
  const showNav = TABS.some((tab) => tab.path === pathname);
  void prefs;

  // 桌面(≥1080):去掉移动壳与底部导航,页面自行渲染三栏终端
  if (isDesktop) {
    return (
      <div className="app-shell desktop-root" style={{ width: "100%", height: "100%", background: "var(--bg)", color: "var(--fg)", overflow: "hidden" }}>
        {children}
        <ConsentBar />
      </div>
    );
  }

  return (
    <div
      className="app-shell"
      style={{
        position: "relative",
        maxWidth: 430,
        margin: "0 auto",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        background: "var(--bg)",
        color: "var(--fg)",
        overflow: "hidden",
      }}
    >
      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minHeight: 0 }}>
        {children}
      </div>
      <ConsentBar />
      {showNav && (
        <div
          style={{
            flexShrink: 0,
            display: "grid",
            gridTemplateColumns: "repeat(5, 1fr)",
            borderTop: "1px solid var(--line)",
            background: "var(--card)",
            paddingBottom: "max(6px, env(safe-area-inset-bottom))",
          }}
        >
          {TABS.map((tab) => {
            const active = pathname === tab.path;
            return (
              <div
                key={tab.path}
                onClick={() => router.push(tab.path)}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  gap: 4,
                  padding: "8px 0 5px",
                  cursor: "pointer",
                  color: active ? "var(--gold)" : "var(--fg-3)",
                }}
              >
                <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                  {tab.icon}
                </svg>
                <span style={{ fontSize: 11.5, fontWeight: 750 }}>{tab.label()}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
