import { NextResponse } from "next/server";
import { db } from "@/server/db";
import { currentUser } from "@/server/platform/session";

export async function GET() {
  const u = await currentUser();
  if (!u) return NextResponse.json({ loggedIn: false, pts: 0 });
  db().prepare("UPDATE users SET last_seen = ? WHERE id = ?").run(Date.now(), u.id); // DAU 口径

  return NextResponse.json({
    loggedIn: true,
    email: u.email,
    pts: u.pts,
    giftPending: !u.gift_claimed,
    inviteCode: u.invite_code,
  });
}
