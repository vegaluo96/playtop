/** 路由层会话:cookie pt_sess ←→ sessions 表 */
import { cookies } from "next/headers";
import { userByToken, type UserRow } from "./auth";

export const SESSION_COOKIE = "pt_sess";
export const REF_COOKIE = "pt_ref";

export async function currentUser(): Promise<UserRow | null> {
  const jar = await cookies();
  return userByToken(jar.get(SESSION_COOKIE)?.value);
}

export function sessionCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 90 * 86_400,
  };
}
