/** 用户管理:搜索/筛选/调额度/封禁(RBAC:客服调额度 ≤100,封禁需超管或风控) */
import { NextRequest, NextResponse } from "next/server";
import { db, tx } from "@/server/db";
import { audit, canWrite, currentAdmin } from "@/server/admin/auth";
import { adjustPoints } from "@/server/platform/wallet";
import { requireSameOrigin } from "@/server/platform/rate-limit";

export async function GET(req: NextRequest) {
  if (!(await currentAdmin())) return NextResponse.json({ ok: false }, { status: 401 });
  const q = (req.nextUrl.searchParams.get("q") ?? "").trim();
  const f = req.nextUrl.searchParams.get("f") ?? "全部";
  const d = db();
  let rows = d.prepare(
    `SELECT u.id, u.email, u.created_at, u.pts, u.status,
       (SELECT COALESCE(SUM(rmb),0) FROM ledger WHERE user_id=u.id AND kind='recharge') pay,
       (SELECT COUNT(*) FROM unlocks WHERE user_id=u.id) un,
       (SELECT COUNT(*) FROM invites WHERE inviter_id=u.id) iv
     FROM users u ${q ? "WHERE u.email LIKE ? OR CAST(u.id AS TEXT)=?" : ""} ORDER BY u.id DESC LIMIT 200`,
  ).all(...(q ? [`%${q}%`, q] : [])) as unknown as { id: number; email: string; created_at: number; pts: number; status: string; pay: number; un: number; iv: number }[];
  if (f !== "全部") rows = rows.filter((r) => (f === "付费" ? r.pay > 0 && r.status === "正常" : f === "免费" ? r.pay === 0 && r.status === "正常" : r.status === f));
  const total = (d.prepare("SELECT COUNT(*) n FROM users").get() as { n: number }).n;
  return NextResponse.json({ ok: true, rows, total });
}

export async function POST(req: NextRequest) {
  const originError = requireSameOrigin(req);
  if (originError) return originError;
  const admin = await currentAdmin();
  if (!admin) return NextResponse.json({ ok: false }, { status: 401 });
  const { action, userId, delta, reason } = (await req.json().catch(() => ({}))) as { action?: string; userId?: number; delta?: number; reason?: string };
  const d = db();
  const u = d.prepare("SELECT email FROM users WHERE id=?").get(Number(userId)) as { email: string } | undefined;
  if (!u) return NextResponse.json({ ok: false, error: "用户不存在" }, { status: 404 });
  if (action === "adjust") {
    const dv = Math.trunc(Number(delta) || 0);
    if (!dv) return NextResponse.json({ ok: false, error: "调整值无效" }, { status: 400 });
    if (admin.role === "客服" && Math.abs(dv) > 100) return NextResponse.json({ ok: false, error: "客服补偿上限 100 分,需超级管理员复核" }, { status: 403 });
    if (!canWrite(admin, "ticket") && !canWrite(admin, "user")) return NextResponse.json({ ok: false, error: "无权限" }, { status: 403 });
    const r = adjustPoints(Number(userId), dv, `后台${dv > 0 ? "补偿" : "扣减"}:${reason || "未注明"}`, () => {
      audit(admin.email, "调额度", `${u.email} ${dv > 0 ? "+" : ""}${dv}(${reason || "未注明"})`);
    });
    return NextResponse.json(r);
  }
  if (action === "ban" || action === "unban") {
    if (!(admin.role === "超级管理员" || admin.role === "风控")) return NextResponse.json({ ok: false, error: "封禁需超级管理员或风控" }, { status: 403 });
    tx(() => {
      d.prepare("UPDATE users SET status=? WHERE id=?").run(action === "ban" ? "已封禁" : "正常", Number(userId));
      if (action === "ban") d.prepare("DELETE FROM sessions WHERE user_id=?").run(Number(userId));
      audit(admin.email, action === "ban" ? "封禁用户" : "解封用户", u.email);
    });
    return NextResponse.json({ ok: true });
  }
  return NextResponse.json({ ok: false, error: "未知操作" }, { status: 400 });
}
