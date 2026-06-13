/** 数据中心:积分榜/射手榜/助攻榜/赛程。用户端只读整理后的平台数据。 */
import { NextRequest, NextResponse } from "next/server";
import { dataCenterView } from "@/server/views/data-center";

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  const leagueId = Number(q.get("league")) || null;
  const tz = q.get("tz") || "UTC+8";
  const view = await dataCenterView({ leagueId, tz });
  return NextResponse.json(view);
}
