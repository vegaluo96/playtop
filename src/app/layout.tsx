import type { Metadata, Viewport } from "next";
import "./globals.css";
import { AppProvider } from "@/components/app-context";
import { AppShell } from "@/components/app-shell";
import { SITE_HOST } from "@/lib/site";

export const metadata: Metadata = {
  metadataBase: new URL(`https://${SITE_HOST}`),
  title: "足球终端 · play.top",
  description: "亚盘 · 大小球 · 胜平负 · 专业盘口数据终端",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#0a0b0f",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600;700&display=swap"
          rel="stylesheet"
        />
        {/* 首绘前应用主题/涨跌色偏好,杜绝刷新时黑白闪切(FOUC);与 app-context 的 localStorage key 同源 */}
        <script
          dangerouslySetInnerHTML={{
            __html: `try{var p=JSON.parse(localStorage.getItem("playtop.prefs")||"{}");var d=document.documentElement;d.dataset.theme=p.theme==="浅色"?"light":"dark";d.dataset.scheme=p.scheme==="绿升红降"?"gr":"rg";}catch(e){}`,
          }}
        />
      </head>
      <body
        className="antialiased"
        style={{ fontFamily: "-apple-system,'PingFang SC','Hiragino Sans GB','Microsoft YaHei',sans-serif" }}
      >
        <AppProvider>
          <AppShell>{children}</AppShell>
        </AppProvider>
      </body>
    </html>
  );
}
