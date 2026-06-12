/** 工单处理:列表/回复/补偿(客服 ≤100 分,超额需超管) */
import { NextRequest, NextResponse } from "next/server";
import { db, tx } from "@/server/db";
import { audit, canWrite, currentAdmin } from "@/server/admin/auth";
import { adjustPoints } from "@/server/platform/wallet";
import { requireSameOrigin } from "@/server/platform/rate-limit";

export async function GET(req: NextRequest) {
  if (!(await currentAdmin())) return NextResponse.json({ ok: false }, { status: 401 });
  const f = req.nextUrl.searchParams.get("f") ?? "处理中";
  const rows = db().prepare(
    `SELECT t.id, t.type, t.body, t.status, t.reply, t.created_at, u.email FROM tickets t JOIN users u ON u.id=t.user_id
     ${f === "全部" ? "" : "WHERE t.status = ?"} ORDER BY t.id DESC LIMIT 100`,
  ).all(...(f === "全部" ? [] : [f === "已回复" ? "已回复" : "处理中"]));
  return NextResponse.json({ ok: true, rows });
}

export async function POST(req: NextRequest) {
  const originError = requireSameOrigin(req);
  if (originError) return originError;
  const admin = await currentAdmin();
  if (!admin) return NextResponse.json({ ok: false }, { status: 401 });
  if (!canWrite(admin, "ticket")) return NextResponse.json({ ok: false, error: "无权限" }, { status: 403 });
  const b = (await req.json().catch(() => ({}))) as { action?: string; id?: number; text?: string; points?: number; reason?: string };
  const d = db();
  const t = d.prepare("SELECT t.id, t.user_id, u.email FROM tickets t JOIN users u ON u.id=t.user_id WHERE t.id=?").get(Number(b.id)) as
    | { id: number; user_id: number; email: string } | undefined;
  if (!t) return NextResponse.json({ ok: false, error: "工单不存在" }, { status: 404 });
  if (b.action === "reply") {
    const text = (b.text ?? "").trim().slice(0, 2000);
    if (!text) return NextResponse.json({ ok: false, error: "回复内容为空" }, { status: 400 });
    tx(() => {
      d.prepare("UPDATE tickets SET reply=?, status='已回复', replied_at=?, replied_by=? WHERE id=?").run(text, Date.now(), admin.email, t.id);
      audit(admin.email, "回复工单", `T${t.id}(${t.email})`);
    });
    return NextResponse.json({ ok: true });
  }
  if (b.action === "compensate") {
    const pts = Math.trunc(Number(b.points) || 0);
    if (pts <= 0) return NextResponse.json({ ok: false, error: "补偿分无效" }, { status: 400 });
    if (admin.role === "客服" && pts > 100) return NextResponse.json({ ok: false, error: "客服补偿上限 100 分,需超级管理员复核" }, { status: 403 });
    const r = adjustPoints(t.user_id, pts, `工单补偿 T${t.id}:${b.reason || "未注明"}`, () => {
      audit(admin.email, "工单补偿", `T${t.id} ${t.email} +${pts}`);
    });
    return NextResponse.json(r);
  }
  return NextResponse.json({ ok: false, error: "未知操作" }, { status: 400 });
}
