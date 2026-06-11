import { NextRequest, NextResponse } from "next/server";
import { loginOrRegister } from "@/server/platform/auth";
import { REF_COOKIE, SESSION_COOKIE, sessionCookieOptions } from "@/server/platform/session";
import { clearLoginFails, clientIp, loginLocked, rateLimit, recordLoginFail, sameOrigin } from "@/server/platform/rate-limit";
import { SITE_HOST } from "@/lib/site";

export async function POST(req: NextRequest) {
  if (!sameOrigin(req, SITE_HOST)) return NextResponse.json({ ok: false, error: "请求来源异常" }, { status: 403 });
  if (!rateLimit(req, "login", 10, 60_000))
    return NextResponse.json({ ok: false, error: "操作过于频繁,请稍后再试" }, { status: 429 });
  const { email, password } = (await req.json().catch(() => ({}))) as { email?: string; password?: string };
  if (!email || !password) return NextResponse.json({ ok: false, error: "请输入邮箱与密码" }, { status: 400 });
  const ip = clientIp(req);
  if (loginLocked(email, ip))
    return NextResponse.json({ ok: false, error: "密码错误次数过多,账号已临时锁定,请 15 分钟后再试" }, { status: 423 });
  const ref = req.cookies.get(REF_COOKIE)?.value ?? null;
  const r = loginOrRegister(email, password, ref, ip === "local" ? null : ip);
  if (!r.ok) {
    recordLoginFail(email, ip);
    return NextResponse.json(r, { status: 401 });
  }
  clearLoginFails(email, ip);
  const res = NextResponse.json({ ok: true, created: r.created });
  res.cookies.set(SESSION_COOKIE, r.token, sessionCookieOptions());
  if (r.created && ref) res.cookies.delete(REF_COOKIE);
  return res;
}
