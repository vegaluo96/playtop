/**
 * 自选关注:GET 返回当前用户关注的 fixture ids;POST {id, on} 增删。
 * 游客不落库(客户端 localStorage 自管),登录后客户端把本地关注合并上来。
 */
import { NextRequest, NextResponse } from "next/server";
import { currentUser } from "@/server/platform/session";
import { db } from "@/server/db";
import { requireSameOrigin } from "@/server/platform/rate-limit";

export async function GET() {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: true, ids: [], loggedIn: false });
  const rows = db().prepare("SELECT fixture_id FROM watchlist WHERE user_id = ? ORDER BY created_at DESC LIMIT 200").all(u.id) as unknown as { fixture_id: number }[];
  return NextResponse.json({ ok: true, ids: rows.map((r) => r.fixture_id), loggedIn: true });
}

export async function POST(req: NextRequest) {
  const originError = requireSameOrigin(req);
  if (originError) return originError;
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false, error: "请先登录" }, { status: 401 });
  let body: { id?: number; on?: boolean; ids?: number[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "无效请求" }, { status: 400 });
  }
  const d = db();
  // 批量合并(登录时同步游客本地关注)
  if (Array.isArray(body.ids)) {
    const ins = d.prepare("INSERT OR IGNORE INTO watchlist (user_id, fixture_id, created_at) VALUES (?,?,?)");
    for (const id of body.ids.slice(0, 100)) if (Number(id)) ins.run(u.id, Number(id), Date.now());
    return NextResponse.json({ ok: true });
  }
  const id = Number(body.id);
  if (!id) return NextResponse.json({ ok: false, error: "无效的比赛 id" }, { status: 400 });
  if (body.on) d.prepare("INSERT OR IGNORE INTO watchlist (user_id, fixture_id, created_at) VALUES (?,?,?)").run(u.id, id, Date.now());
  else d.prepare("DELETE FROM watchlist WHERE user_id = ? AND fixture_id = ?").run(u.id, id);
  return NextResponse.json({ ok: true });
}
