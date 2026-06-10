import { cookies } from "next/headers";
import { HttpError } from "../lib/api";
import { SESSION_COOKIE, getSessionUser, type SessionUser } from "./session";

export async function currentUser(): Promise<SessionUser | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  return getSessionUser(token);
}

export async function requireUser(): Promise<SessionUser> {
  const user = await currentUser();
  if (!user) throw new HttpError(401, "请先登录");
  if (user.status === "banned") throw new HttpError(403, "账号已被禁用，请联系管理员");
  return user;
}

export async function requireAdmin(): Promise<SessionUser> {
  const user = await requireUser();
  if (user.role !== "admin") throw new HttpError(403, "需要管理员权限");
  return user;
}
