/** 解锁预测:POST {fixtureId}(价格由服务端按开球时间定,永久可见) */
import { NextRequest, NextResponse } from "next/server";
import { fixtureById } from "@/server/af/store";
import { currentUser } from "@/server/platform/session";
import { unlock } from "@/server/platform/wallet";
import { rateLimit, requireSameOrigin } from "@/server/platform/rate-limit";

export async function POST(req: NextRequest) {
  const originError = requireSameOrigin(req);
  if (originError) return originError;
  if (!rateLimit(req, "unlock", 30, 60_000)) return NextResponse.json({ ok: false, error: "操作过于频繁,请稍后再试" }, { status: 429 });
  const user = await currentUser();
  if (!user) return NextResponse.json({ ok: false, error: "未登录" }, { status: 401 });
  const { fixtureId } = (await req.json().catch(() => ({}))) as { fixtureId?: number };
  const fx = fixtureId ? fixtureById(Number(fixtureId)) : null;
  if (!fx) return NextResponse.json({ ok: false, error: "比赛不存在" }, { status: 404 });
  const today = new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10);
  const r = unlock(user.id, fx.fixture_id, fx.kickoff_utc, `${fx.home_name} vs ${fx.away_name}`, today);
  return NextResponse.json(r, { status: r.ok ? 200 : 400 });
}
