/** 风控与审计:三规则扫描入队 + 裁决(拦截=标记风控/封禁线索,放行=关闭) */
import { NextRequest, NextResponse } from "next/server";
import { db, tx } from "@/server/db";
import { audit, currentAdmin, listAudit } from "@/server/admin/auth";
import { requireSameOrigin } from "@/server/platform/rate-limit";

/** 扫描近 3 日数据,命中规则去重入队(dedup 唯一键) */
function scan(): void {
  const d = db();
  const since = Date.now() - 3 * 86_400_000;
  const put = (type: string, score: number, detail: string, dedup: string, email: string | null) => {
    try {
      d.prepare("INSERT INTO risk_queue (at, type, score, detail, dedup, user_email) VALUES (?,?,?,?,?,?)").run(Date.now(), type, score, detail, dedup, email);
    } catch { /* 已在队列 */ }
  };
  // 1) 自邀嫌疑:被邀人同 IP 聚集(≥3)
  for (const r of d.prepare(
    `SELECT u.email, i.ip, COUNT(*) n FROM invites i JOIN users u ON u.id=i.inviter_id
     WHERE i.created_at>=? AND i.ip IS NOT NULL GROUP BY i.inviter_id, i.ip HAVING n>=3`,
  ).all(since) as unknown as { email: string; ip: string; n: number }[]) {
    put("自邀嫌疑", Math.min(95, 60 + r.n * 8), `${r.email} · 近 3 日 ${r.n} 次邀请来自同 IP(${r.ip})`, `inv:${r.email}:${r.ip}`, r.email);
  }
  // 2) 异常充值:注册 30 分钟内充值 ≥¥328
  for (const r of d.prepare(
    `SELECT u.email, l.rmb, l.created_at - u.created_at gap FROM ledger l JOIN users u ON u.id=l.user_id
     WHERE l.kind='recharge' AND l.rmb>=328 AND l.created_at>=? AND l.created_at - u.created_at <= 1800000`,
  ).all(since) as unknown as { email: string; rmb: number; gap: number }[]) {
    put("异常充值", 71, `${r.email} · 注册 ${Math.round(r.gap / 60000)} 分钟内充值 ¥${r.rmb}`, `pay:${r.email}:${r.rmb}`, r.email);
  }
  // 3) 多账号领码:同 IP ≥3 账号领同一兑换码
  for (const r of d.prepare(
    `SELECT code, ip, COUNT(*) n FROM redemptions WHERE created_at>=? AND ip IS NOT NULL GROUP BY code, ip HAVING n>=3`,
  ).all(since) as unknown as { code: string; ip: string; n: number }[]) {
    put("多账号", 68, `同 IP(${r.ip})${r.n} 个账号领取 ${r.code} 兑换码`, `code:${r.code}:${r.ip}`, null);
  }
}

export async function GET() {
  if (!(await currentAdmin())) return NextResponse.json({ ok: false }, { status: 401 });
  scan();
  const queue = db().prepare("SELECT id, at, type, score, detail, user_email, status FROM risk_queue WHERE status='待裁决' ORDER BY score DESC, id DESC LIMIT 30").all();
  return NextResponse.json({ ok: true, queue, audits: listAudit(60) });
}

export async function POST(req: NextRequest) {
  const originError = requireSameOrigin(req);
  if (originError) return originError;
  const admin = await currentAdmin();
  if (!admin) return NextResponse.json({ ok: false }, { status: 401 });
  if (!(admin.role === "超级管理员" || admin.role === "风控")) return NextResponse.json({ ok: false, error: "裁决需超级管理员或风控" }, { status: 403 });
  const { id, decision } = (await req.json().catch(() => ({}))) as { id?: number; decision?: string };
  const d = db();
  const item = d.prepare("SELECT id, detail, user_email FROM risk_queue WHERE id=? AND status='待裁决'").get(Number(id)) as
    | { id: number; detail: string; user_email: string | null } | undefined;
  if (!item) return NextResponse.json({ ok: false, error: "条目不存在或已裁决" }, { status: 404 });
  if (decision !== "拦截" && decision !== "放行") return NextResponse.json({ ok: false, error: "裁决无效" }, { status: 400 });
  tx(() => {
    d.prepare("UPDATE risk_queue SET status=?, decided_by=?, decided_at=? WHERE id=?").run(decision, admin.email, Date.now(), item.id);
    if (decision === "拦截" && item.user_email) {
      d.prepare("UPDATE users SET status='风控' WHERE email=? AND status='正常'").run(item.user_email);
    }
    audit(admin.email, `风控裁决 · ${decision}`, item.detail);
  });
  return NextResponse.json({ ok: true });
}
