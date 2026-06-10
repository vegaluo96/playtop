import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://play.top"),
  title: { default: "PlayTop 量化球研 · play.top", template: "%s · PlayTop" },
  description:
    "PlayTop（play.top）机构级足球赛事量化研究：Dixon-Coles 双泊松、进球差调整 Elo、Shin 盘口去水、多源数据实时采集，投行级研报呈现，全部战绩链上可验。",
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
