import { NextRequest, NextResponse } from "next/server";
import { destroySession } from "@/server/platform/auth";
import { SESSION_COOKIE } from "@/server/platform/session";

export async function POST(req: NextRequest) {
  destroySession(req.cookies.get(SESSION_COOKIE)?.value);
  const res = NextResponse.json({ ok: true });
  res.cookies.delete(SESSION_COOKIE);
  return res;
}
