import { NextResponse } from "next/server";
import { currentUser } from "@/server/platform/session";

export async function GET() {
  const u = await currentUser();
  if (!u) return NextResponse.json({ loggedIn: false, pts: 0 });
  return NextResponse.json({
    loggedIn: true,
    email: u.email,
    pts: u.pts,
    giftPending: !u.gift_claimed,
    inviteCode: u.invite_code,
  });
}
