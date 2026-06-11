import { NextResponse } from "next/server";
import { db } from "@/server/db";
import { currentUser } from "@/server/platform/session";
import { inviteStats } from "@/server/platform/wallet";
import { INVITE_CAPS, maskEmail } from "@/server/platform/rules";

export async function GET() {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false, error: "未登录" }, { status: 401 });
  const s = inviteStats(u.id);
  const fmtT = (ms: number) => {
    const d = new Date(ms + 8 * 3_600_000);
    const p = (n: number) => String(n).padStart(2, "0");
    return `${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
  };
  const log = (
    db()
      .prepare(
        "SELECT i.credited, i.created_at, u2.email FROM invites i JOIN users u2 ON u2.id = i.invitee_id WHERE i.inviter_id = ? ORDER BY i.created_at DESC LIMIT 100",
      )
      .all(u.id) as unknown as { credited: number; created_at: number; email: string }[]
  ).map((r) => ({ u: `用户 ${maskEmail(r.email)}`, t: fmtT(r.created_at), credited: r.credited }));
  return NextResponse.json({
    ok: true,
    code: u.invite_code,
    url: `www.play.top/i/${u.invite_code}`,
    caps: INVITE_CAPS,
    log,
    ...s,
  });
}
