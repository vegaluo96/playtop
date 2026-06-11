/**
 * 账户:邮箱+密码(无邮箱验证;未注册邮箱自动建号)。
 * scrypt 哈希(node:crypto),会话 token 落库,cookie 由路由层种。
 */
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { db, tx } from "../db";
import { genInviteCode } from "./rules";
import { creditInvite } from "./wallet";

const SESSION_DAYS = 90;

export interface UserRow {
  id: number;
  email: string;
  pts: number;
  invite_code: string;
  invited_by: number | null;
  gift_claimed: number;
  first_recharged: number;
}

function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 32).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const got = scryptSync(password, salt, 32);
  const want = Buffer.from(hash, "hex");
  return got.length === want.length && timingSafeEqual(got, want);
}

export type LoginResult =
  | { ok: true; user: UserRow; token: string; created: boolean }
  | { ok: false; error: string };

/** 登录;邮箱不存在则注册(可带邀请码归因) */
export function loginOrRegister(email: string, password: string, refCode?: string | null, ip: string | null = null): LoginResult {
  const mail = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) return { ok: false, error: "邮箱格式不正确" };
  if (password.length < 6) return { ok: false, error: "密码至少 6 位" };
  const d = db();
  const existing = d.prepare("SELECT * FROM users WHERE email = ?").get(mail) as unknown as (UserRow & { pass_hash: string }) | undefined;
  if (existing) {
    if (!verifyPassword(password, existing.pass_hash)) return { ok: false, error: "密码错误" };
    if ((existing as unknown as { status?: string }).status === "已封禁") return { ok: false, error: "账号已被封禁,请联系客服" };
    return { ok: true, user: existing, token: createSession(existing.id), created: false };
  }
  const user = tx(() => {
    let code = genInviteCode();
    while (d.prepare("SELECT 1 FROM users WHERE invite_code = ?").get(code)) code = genInviteCode();
    const inviter = refCode
      ? (d.prepare("SELECT id FROM users WHERE invite_code = ?").get(refCode.trim().toUpperCase()) as { id: number } | undefined)
      : undefined;
    const r = d
      .prepare("INSERT INTO users (email, pass_hash, invite_code, invited_by, created_at, reg_ip) VALUES (?,?,?,?,?,?)")
      .run(mail, hashPassword(password), code, inviter?.id ?? null, Date.now(), ip);
    const u = d.prepare("SELECT * FROM users WHERE id = ?").get(Number(r.lastInsertRowid)) as unknown as UserRow;
    if (inviter && inviter.id !== u.id) creditInvite(inviter.id, u.id, ip);
    return u;
  });
  return { ok: true, user, token: createSession(user.id), created: true };
}

function createSession(userId: number): string {
  const token = randomBytes(32).toString("hex");
  db()
    .prepare("INSERT INTO sessions (token, user_id, expires_at) VALUES (?,?,?)")
    .run(token, userId, Date.now() + SESSION_DAYS * 86_400_000);
  return token;
}

export function userByToken(token: string | undefined | null): UserRow | null {
  if (!token) return null;
  const row = db()
    .prepare(
      "SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.expires_at > ?",
    )
    .get(token, Date.now()) as unknown as UserRow | undefined;
  return row ?? null;
}

export function destroySession(token: string | undefined | null): void {
  if (token) db().prepare("DELETE FROM sessions WHERE token = ?").run(token);
}
