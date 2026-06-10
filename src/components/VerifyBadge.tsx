"use client";

import { useState } from "react";

export default function VerifyBadge({ analysisId, contentHash }: { analysisId: number; contentHash: string | null }) {
  const [state, setState] = useState<"idle" | "loading" | "ok" | "fail">("idle");
  const [detail, setDetail] = useState("");

  async function verify() {
    setState("loading");
    try {
      const res = await fetch(`/api/analyses/${analysisId}/verify`);
      const data = await res.json();
      if (data.ok && data.data.valid) {
        setState("ok");
        setDetail(data.data.detail);
      } else {
        setState("fail");
        setDetail(data.data?.detail ?? data.error ?? "校验失败");
      }
    } catch {
      setState("fail");
      setDetail("网络错误");
    }
  }

  return (
    <div className="card mt-4 px-3 py-2.5">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[10px] tracking-wider text-faint">内容哈希存证（SHA-256 链式）</div>
          <div className="tabular truncate text-[10px] text-muted">{contentHash ?? "—"}</div>
        </div>
        <button
          onClick={verify}
          className="shrink-0 rounded border border-hairline px-2.5 py-1.5 text-[11px] text-muted hover:border-gold/50 hover:text-gold-bright"
        >
          {state === "loading" ? "校验中…" : "立即校验"}
        </button>
      </div>
      {state === "ok" && <p className="mt-2 text-[11px] text-up">✓ {detail}</p>}
      {state === "fail" && <p className="mt-2 text-[11px] text-down">✗ {detail}</p>}
    </div>
  );
}
