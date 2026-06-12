/** 兑换码批次:列表 + 生成(写审计) */
import { NextRequest, NextResponse } from "next/server";
import { db, tx } from "@/server/db";
import { audit, canWrite, currentAdmin } from "@/server/admin/auth";
import { requireSameOrigin } from "@/server/platform/rate-limit";

export async function GET() {
  if (!(await currentAdmin())) return NextResponse.json({ ok: false }, { status: 401 });
  const rows = (db().prepare("SELECT code, points, max_uses, used_count, expires_at FROM redeem_codes ORDER BY rowid DESC LIMIT 50").all() as unknown as
    { code: string; points: number; max_uses: number; used_count: number; expires_at: number | null }[]).map((c) => ({
    ...c,
    st: c.used_count >= c.max_uses ? "已结束" : c.used_count >= c.max_uses * 0.9 ? "即将售罄" : "生效中",
  }));
  return NextResponse.json({ ok: true, rows });
}

export async function POST(req: NextRequest) {
  const originError = requireSameOrigin(req);
  if (originError) return originError;
  const admin = await currentAdmin();
  if (!admin) return NextResponse.json({ ok: false }, { status: 401 });
  if (!canWrite(admin, "mkt") && !canWrite(admin, "order")) return NextResponse.json({ ok: false, error: "无权限" }, { status: 403 });
  const { code, points, maxUses } = (await req.json().catch(() => ({}))) as { code?: string; points?: number; maxUses?: number };
  const c = (code ?? "").trim().toUpperCase();
  if (!/^[A-Z0-9]{4,16}$/.test(c)) return NextResponse.json({ ok: false, error: "码格式:4-16 位字母数字" }, { status: 400 });
  const p = Math.trunc(Number(points) || 0), m = Math.trunc(Number(maxUses) || 0);
  if (p <= 0 || m <= 0) return NextResponse.json({ ok: false, error: "面值与数量必须为正" }, { status: 400 });
  try {
    tx(() => {
      db().prepare("INSERT INTO redeem_codes (code, points, max_uses) VALUES (?,?,?)").run(c, p, m);
      audit(admin.email, "生成兑换码批次", `${c}(${m} 个,+${p} 分)`);
    });
  } catch {
    return NextResponse.json({ ok: false, error: "兑换码已存在" }, { status: 400 });
  }
  return NextResponse.json({ ok: true });
}
