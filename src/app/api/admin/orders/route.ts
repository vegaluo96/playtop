/** 订单与积分:全局流水(含邀请触限拦截行) */
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/server/db";
import { currentAdmin } from "@/server/admin/auth";

const TAG: Record<string, string> = { recharge: "充值", unlock: "解锁", redeem: "兑换", invite: "邀请", gift: "礼包", adjust: "调整" };

export async function GET(req: NextRequest) {
  if (!(await currentAdmin())) return NextResponse.json({ ok: false }, { status: 401 });
  const f = req.nextUrl.searchParams.get("f") ?? "全部";
  const d = db();
  const ledger = (d.prepare(
    "SELECT l.created_at t, u.email u, l.kind, l.delta, l.note, l.rmb FROM ledger l JOIN users u ON u.id=l.user_id ORDER BY l.id DESC LIMIT 120",
  ).all() as unknown as { t: number; u: string; kind: string; delta: number; note: string; rmb: number | null }[]).map((r) => ({
    t: r.t, u: r.u, tag: TAG[r.kind] ?? r.kind, x: r.note, rmb: r.rmb != null ? `¥${r.rmb}` : "—",
    pts: r.delta > 0 ? `+${r.delta}` : String(r.delta), st: "成功",
  }));
  const blocked = (d.prepare(
    "SELECT i.created_at t, u.email u FROM invites i JOIN users u ON u.id=i.inviter_id WHERE i.credited=0 ORDER BY i.id DESC LIMIT 30",
  ).all() as unknown as { t: number; u: string }[]).map((r) => ({ t: r.t, u: r.u, tag: "邀请", x: "邀请注册 · 触达上限,未发放", rmb: "—", pts: "0", st: "拦截" }));
  let rows = [...ledger, ...blocked].sort((a, b) => b.t - a.t).slice(0, 120);
  if (f !== "全部") rows = rows.filter((r) => r.tag === f);
  // 邀请结算(今日)
  const t0 = Math.floor((Date.now() + 8 * 3_600_000) / 86_400_000) * 86_400_000 - 8 * 3_600_000;
  const iv = d.prepare("SELECT COALESCE(SUM(CASE WHEN credited>0 THEN 1 ELSE 0 END),0) ok, COALESCE(SUM(credited),0) pts, COALESCE(SUM(CASE WHEN credited=0 THEN 1 ELSE 0 END),0) blocked FROM invites WHERE created_at>=?").get(t0);
  return NextResponse.json({ ok: true, rows, invite: iv });
}
