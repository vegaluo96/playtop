"use client";

/** 分享弹层 + canvas 海报(设计稿 genShareImg 移植;渠道按钮统一走复制链接) */
import { useState } from "react";
import { GoldBtn, Sheet } from "./ui";
import { SITE_HOST } from "@/lib/site";

export interface ShareData {
  title: string;
  sub: string;
  v1: string;
  v2: string;
  v3: string;
  url: string;
  inviteCode?: string;
}

export function ShareSheet({ open, onClose, data }: { open: boolean; onClose: () => void; data: ShareData | null }) {
  const [copied, setCopied] = useState(false);
  if (!data) return null;
  const copy = () => {
    try {
      void navigator.clipboard.writeText(`https://${data.url}`);
    } catch {
      /* 剪贴板不可用时静默 */
    }
    setCopied(true);
  };
  const genImg = () => {
    const cv = document.createElement("canvas");
    cv.width = 640;
    cv.height = 760;
    const x = cv.getContext("2d")!;
    x.fillStyle = "#0b0f0d";
    x.fillRect(0, 0, 640, 760);
    x.strokeStyle = "rgba(0,200,5,.5)";
    x.lineWidth = 3;
    x.strokeRect(14, 14, 612, 732);
    x.textAlign = "center";
    x.fillStyle = "#eceef2";
    x.font = "800 44px sans-serif";
    x.fillText("足球终端", 320, 110);
    x.fillStyle = "#829087";
    x.font = "22px monospace";
    x.fillText(SITE_HOST, 320, 150);
    x.fillStyle = "#eceef2";
    x.font = "800 40px sans-serif";
    x.fillText(data.title, 320, 270);
    x.fillStyle = "#829087";
    x.font = "24px sans-serif";
    x.fillText(data.sub, 320, 315);
    const rows: [string, string][] = [["让球", data.v1], ["大小", data.v2], ["胜平负", data.v3]];
    rows.forEach((r, i) => {
      const y = 380 + i * 90;
      x.fillStyle = "#171d19";
      x.fillRect(60, y, 520, 68);
      x.fillStyle = "#829087";
      x.font = "20px sans-serif";
      x.textAlign = "left";
      x.fillText(r[0], 84, y + 42);
      x.fillStyle = "#00c805";
      x.font = "700 26px monospace";
      x.textAlign = "right";
      x.fillText(r[1], 556, y + 44);
      x.textAlign = "center";
    });
    x.fillStyle = "#5e6b63";
    x.font = "20px sans-serif";
	    x.fillText("登录查看完整指数与报告", 320, 690);
    if (data.inviteCode) {
      x.fillStyle = "#00c805";
      x.font = "700 22px monospace";
      x.fillText(`邀请码 ${data.inviteCode}`, 320, 722);
    }
    const a = document.createElement("a");
    a.href = cv.toDataURL("image/png");
    a.download = "playtop-share.png";
    a.click();
  };

  return (
    <Sheet open={open} onClose={onClose}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 10 }}>
        <span style={{ fontSize: 15, fontWeight: 800 }}>分享</span>
	        <span style={{ fontSize: 11.5, color: "var(--fg-3)" }}>好友经邀请链接进入,你 +1 额度</span>
      </div>
      <div style={{ background: "var(--inset)", border: "1px solid rgba(0,200,5,.45)", borderRadius: 12, padding: 14, marginBottom: 10 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
          <span style={{ fontSize: 13, fontWeight: 800 }}>
            足球<span style={{ color: "var(--gold)" }}>终端</span>
          </span>
	          <span className="mono" style={{ fontSize: 11.5, color: "var(--fg-3)" }}>{SITE_HOST}</span>
        </div>
        <div style={{ textAlign: "center", fontSize: 16, fontWeight: 800, margin: "12px 0 3px" }}>{data.title}</div>
	        <div style={{ textAlign: "center", fontSize: 11.5, color: "var(--fg-2)", marginBottom: 10 }}>{data.sub}</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 10 }}>
          {[["让球", data.v1], ["大小", data.v2], ["胜平负", data.v3]].map(([k, v]) => (
            <div key={k} style={{ background: "var(--card)", borderRadius: 8, padding: "7px 2px", textAlign: "center" }}>
	              <div style={{ fontSize: 11.5, color: "var(--fg-3)", marginBottom: 2 }}>{k}</div>
	              <div style={{ fontSize: 12, fontWeight: 750, color: "var(--gold)" }}>{v}</div>
            </div>
          ))}
        </div>
        {data.inviteCode && (
	          <div style={{ textAlign: "center", fontSize: 11.5, color: "var(--fg-3)" }}>
            登录查看完整指数与报告 · 邀请码 <span className="mono" style={{ color: "var(--gold)", fontWeight: 700 }}>{data.inviteCode}</span>
          </div>
        )}
      </div>
      <GoldBtn label="生成并保存分享图" onClick={genImg} style={{ marginBottom: 12 }} />
      <div style={{ display: "flex", alignItems: "center", gap: 8, background: "var(--inset)", border: "1px solid var(--line)", borderRadius: 10, padding: "11px 12px", marginBottom: 6 }}>
        <span className="mono" style={{ flex: 1, fontSize: 12, fontWeight: 700, color: "var(--gold)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {data.url}
        </span>
	        <div onClick={copy} style={{ flexShrink: 0, border: "1px solid rgba(0,200,5,.5)", color: "var(--gold)", borderRadius: 8, padding: "6px 14px", fontSize: 12, fontWeight: 800, cursor: "pointer" }}>
          复制
        </div>
      </div>
	      {copied && <div style={{ fontSize: 11, color: "var(--up)" }}>链接已复制</div>}
    </Sheet>
  );
}
