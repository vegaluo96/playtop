/**
 * 钱包统一入口:POST { action: gift|recharge|redeem, ... } / GET → 流水。
 */
import { NextRequest, NextResponse } from "next/server";
import { currentUser } from "@/server/platform/session";
import { claimGift, ledgerOf, recharge, redeem } from "@/server/platform/wallet";
import { cfgRechargeMaintenance, cfgRechargeTiers } from "@/server/platform/config";

export async function GET() {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false, error: "未登录" }, { status: 401 });
  // 档位必须读后台生效配置(此前返回静态表 → 后台改档位用户端永远看不到)
  return NextResponse.json({ ok: true, pts: u.pts, ledger: ledgerOf(u.id), tiers: cfgRechargeTiers(), maintenance: cfgRechargeMaintenance() });
}

export async function POST(req: NextRequest) {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false, error: "未登录" }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as { action?: string; tier?: number; code?: string };
  const r =
    body.action === "gift"
      ? claimGift(u.id)
      : body.action === "recharge"
        ? cfgRechargeMaintenance()
          ? ({ ok: false, error: "充值通道维护中,请稍后再试" } as const)
          : recharge(u.id, Number(body.tier))
        : body.action === "redeem"
          ? redeem(u.id, String(body.code ?? ""), (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || null)
          : ({ ok: false, error: "未知操作" } as const);
  return NextResponse.json(r, { status: r.ok ? 200 : 400 });
}
