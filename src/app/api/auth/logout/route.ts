import { NextRequest, NextResponse } from "next/server";
import { destroySession } from "@/server/platform/auth";
import { SESSION_COOKIE } from "@/server/platform/session";
import { requireSameOrigin } from "@/server/platform/rate-limit";

export async function POST(req: NextRequest) {
  const originError = requireSameOrigin(req);
  if (originError) return originError;
  destroySession(req.cookies.get(SESSION_COOKIE)?.value);
  const res = NextResponse.json({ ok: true });
  res.cookies.delete(SESSION_COOKIE);
  return res;
}
