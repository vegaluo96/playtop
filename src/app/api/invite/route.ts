import { NextResponse } from "next/server";
import { currentUser } from "@/server/platform/session";
import { inviteStats } from "@/server/platform/wallet";
import { INVITE_CAPS } from "@/server/platform/rules";

export async function GET() {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false, error: "未登录" }, { status: 401 });
  const s = inviteStats(u.id);
  return NextResponse.json({
    ok: true,
    code: u.invite_code,
    url: `www.play.top/i/${u.invite_code}`,
    caps: INVITE_CAPS,
    ...s,
  });
}
