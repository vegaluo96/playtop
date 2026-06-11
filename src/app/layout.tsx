import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://play.top"),
  title: { default: "PlayTop 量化球研 · play.top", template: "%s · PlayTop" },
  description:
    "PlayTop（play.top）亚盘优先的足球赛事量化研究：API-Football 全量库蒸馏预测为主源、Shin 多书商盘口去水共识做对照、期望进球经泊松比分矩阵展开派生亚盘与大小球，给出价格边界线，全部战绩链上可验。",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#f4f6f8",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <body className="min-h-screen antialiased">
        {/* 首屏主题恢复（解析阻塞内联脚本，避免闪烁）；缺省浅色 */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              '(function(){try{if(localStorage.getItem("theme")==="dark")document.documentElement.setAttribute("data-theme","dark")}catch(e){}})()',
          }}
        />
        {children}
      </body>
    </html>
  );
}
