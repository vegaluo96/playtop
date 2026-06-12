/** 比赛详情:GET /api/match/<fixtureId>?tz=UTC+8&deep=1 */
import { NextRequest, NextResponse } from "next/server";
import { matchPanorama } from "@/server/af/panorama";
import { detailView } from "@/server/views/detail";
import { currentUser } from "@/server/platform/session";
import { isUnlocked } from "@/server/platform/wallet";
import { cfgUnlockPrice } from "@/server/platform/config";

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const fid = Number(id);
  if (!fid) return NextResponse.json({ ok: false, error: "无效的比赛 id" }, { status: 400 });
  const q = req.nextUrl.searchParams;
  const deep = q.get("deep") === "1";
  const tz = q.get("tz") || "UTC+8";
  const userPromise = currentUser();
  const p = await matchPanorama(fid, { deep });
  if (!p) return NextResponse.json({ ok: false, error: "比赛不存在或数据未就绪" }, { status: 404 });
  const view = await detailView(p, tz, { deep });
  const user = await userPromise;
  const today = new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10);
  return NextResponse.json({
    ok: true,
    ...view,
    loggedIn: !!user,
    unlocked: user ? isUnlocked(user.id, fid, today) : false,
    price: cfgUnlockPrice(p.fixture.kickoff_utc, Date.now()),
  });
}
