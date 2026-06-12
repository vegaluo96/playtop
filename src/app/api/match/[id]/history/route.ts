/** 历史报价:GET /api/match/<fixtureId>/history?mk=ah|ou|eu&tz=UTC+8(自归档起全部快照帧) */
import { NextRequest, NextResponse } from "next/server";
import { quoteHistory } from "@/server/views/history";

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const fid = Number(id);
  if (!fid) return NextResponse.json({ ok: false, error: "无效的比赛 id" }, { status: 400 });
  const q = req.nextUrl.searchParams;
  const mk = (q.get("mk") || "ah") as "ah" | "ou" | "eu";
  if (!["ah", "ou", "eu"].includes(mk)) return NextResponse.json({ ok: false, error: "无效的市场" }, { status: 400 });
  const bk = Number(q.get("bk")) || undefined; // 指定书商(对比行点入)
  const view = quoteHistory(fid, mk, q.get("tz") || "UTC+8", bk);
  if (!view) return NextResponse.json({ ok: false, error: "比赛不存在" }, { status: 404 });
  return NextResponse.json({ ok: true, ...view });
}
