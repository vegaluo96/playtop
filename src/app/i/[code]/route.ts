/** 邀请落地:/i/<邀请码> → 种 pt_ref cookie(30 天)→ 登录页 */
import { NextRequest, NextResponse } from "next/server";
import { REF_COOKIE } from "@/server/platform/session";

export async function GET(req: NextRequest, ctx: { params: Promise<{ code: string }> }) {
  const { code } = await ctx.params;
  const res = NextResponse.redirect(new URL("/login", req.url));
  res.cookies.set(REF_COOKIE, code.toUpperCase().slice(0, 16), {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 30 * 86_400,
  });
  return res;
}
