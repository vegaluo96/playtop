import { NextRequest, NextResponse } from "next/server";
import { currentUser } from "@/server/platform/session";
import { db } from "@/server/db";

export async function GET() {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false, error: "未登录" }, { status: 401 });
  const rows = db()
    .prepare("SELECT id, type, body, status, created_at FROM tickets WHERE user_id = ? ORDER BY id DESC LIMIT 50")
    .all(u.id);
  return NextResponse.json({ ok: true, tickets: rows });
}

export async function POST(req: NextRequest) {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false, error: "未登录" }, { status: 401 });
  const { type, body } = (await req.json().catch(() => ({}))) as { type?: string; body?: string };
  const text = (body ?? "").trim();
  if (!text) return NextResponse.json({ ok: false, error: "请先填写问题描述" }, { status: 400 });
  db()
    .prepare("INSERT INTO tickets (user_id, type, body, created_at) VALUES (?,?,?,?)")
    .run(u.id, type || "其他", text.slice(0, 2000), Date.now());
  return NextResponse.json({ ok: true });
}
