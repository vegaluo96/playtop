/**
 * 管理后台鉴权:复用用户会话,仅 admins 表成员可进。
 * 首个超管由 env ADMIN_EMAIL / ADMIN_PASSWORD 种子(账号不存在则创建)。
 * 所有后台写操作经 audit() 强制留痕(append-only)。
 */
import { db } from "../db";
import { upsertSystemUser, type UserRow } from "../platform/auth";
import { currentUser } from "../platform/session";

export interface AdminRow {
  email: string;
  role: string;
  status: string;
}

export const ROLES = ["超级管理员", "运营", "客服", "风控"] as const;

/** 角色 → 可写模块(RBAC;读全开,写按表) */
const ROLE_SCOPES: Record<string, string[]> = {
  超级管理员: ["*"],
  运营: ["dash", "match", "mkt", "ticket", "order"],
  客服: ["ticket"],
  风控: ["risk", "user"],
};

export function canWrite(admin: AdminRow, scope: string): boolean {
  const scopes = ROLE_SCOPES[admin.role] ?? [];
  return scopes.includes("*") || scopes.includes(scope);
}

let seeded = false;
export function ensureAdminSeed(): void {
  if (seeded) return;
  const email = (process.env.ADMIN_EMAIL || "").trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD || "";
  if (!email || !password) return;
  const d = db();
  if (!upsertSystemUser(email, password)) return; // 保留账号由 seed 路径创建/重置,防止抢注后提权
  d.prepare(
    "INSERT INTO admins (email, role, status, created_at) VALUES (?, '超级管理员', '启用', ?) ON CONFLICT(email) DO UPDATE SET role='超级管理员', status='启用'",
  ).run(email, Date.now());
  seeded = true;
}

export async function currentAdmin(): Promise<(AdminRow & { user: UserRow }) | null> {
  ensureAdminSeed();
  const user = await currentUser();
  if (!user) return null;
  const row = db().prepare("SELECT email, role, status FROM admins WHERE email = ? AND status = '启用'").get(user.email) as
    | AdminRow
    | undefined;
  return row ? { ...row, user } : null;
}

/** 审计:所有后台写操作强制留痕,不可删除 */
export function audit(actor: string, action: string, detail = ""): void {
  db().prepare("INSERT INTO audit_log (at, actor, action, detail) VALUES (?,?,?,?)").run(Date.now(), actor, action, detail.slice(0, 500));
}

export function listAudit(limit = 100): { at: number; actor: string; action: string; detail: string }[] {
  return db().prepare("SELECT at, actor, action, detail FROM audit_log ORDER BY id DESC LIMIT ?").all(limit) as unknown as {
    at: number;
    actor: string;
    action: string;
    detail: string;
  }[];
}
