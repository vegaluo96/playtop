import { NextRequest, NextResponse } from "next/server";
import { loginOrRegister } from "@/server/platform/auth";
import { REF_COOKIE, SESSION_COOKIE, sessionCookieOptions } from "@/server/platform/session";

export async function POST(req: NextRequest) {
  const { email, password } = (await req.json().catch(() => ({}))) as { email?: string; password?: string };
  if (!email || !password) return NextResponse.json({ ok: false, error: "请输入邮箱与密码" }, { status: 400 });
  const ref = req.cookies.get(REF_COOKIE)?.value ?? null;
  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || null;
  const r = loginOrRegister(email, password, ref, ip);
  if (!r.ok) return NextResponse.json(r, { status: 401 });
  const res = NextResponse.json({ ok: true, created: r.created });
  res.cookies.set(SESSION_COOKIE, r.token, sessionCookieOptions());
  if (r.created && ref) res.cookies.delete(REF_COOKIE);
  return res;
}
