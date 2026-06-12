/** 营销配置:购买额度档位/解锁定价/新人邀请规则(改动二次确认在前端,落库即审计) */
import { NextRequest, NextResponse } from "next/server";
import { audit, canWrite, currentAdmin } from "@/server/admin/auth";
import { requireSameOrigin } from "@/server/platform/rate-limit";
import { tx } from "@/server/db";
import {
  cfgFirstBonusOn, cfgGiftPoints, cfgInviteCaps, cfgInvitePoints, cfgPriceLive, cfgPricePre, cfgRechargeMaintenance, cfgRechargeTiers, cfgSet,
} from "@/server/platform/config";

export async function GET() {
  if (!(await currentAdmin())) return NextResponse.json({ ok: false }, { status: 401 });
  return NextResponse.json({
    ok: true,
    tiers: cfgRechargeTiers(),
    pricePre: cfgPricePre(),
    priceLive: cfgPriceLive(),
    gift: cfgGiftPoints(),
    invitePoints: cfgInvitePoints(),
    caps: cfgInviteCaps(),
    firstBonusOn: cfgFirstBonusOn(),
    rechargeMaintenance: cfgRechargeMaintenance(),
  });
}

export async function POST(req: NextRequest) {
  const originError = requireSameOrigin(req);
  if (originError) return originError;
  const admin = await currentAdmin();
  if (!admin) return NextResponse.json({ ok: false }, { status: 401 });
  if (!canWrite(admin, "mkt")) return NextResponse.json({ ok: false, error: "无权限" }, { status: 403 });
  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const setNum = (key: string, label: string, min = 0) => {
    const v = Math.trunc(Number(b[key]));
    if (!Number.isFinite(v) || v < min) throw new Error(`${label} 无效`);
    cfgSet(key, v);
    audit(admin.email, "营销配置", `${label} → ${v}`);
  };
  try {
    if (b.action === "prices") {
      tx(() => {
        setNum("price_pre", "赛前价", 1);
        setNum("price_live", "滚球价", 1);
      });
    } else if (b.action === "rules") {
      tx(() => {
        setNum("gift_points", "基础报告额度", 0);
        setNum("invite_points", "邀请额度", 0);
        const caps = b.caps as { day: number; week: number; month: number };
        if (!caps || [caps.day, caps.week, caps.month].some((v) => !Number.isFinite(Number(v)) || Number(v) < 0)) throw new Error("邀请上限无效");
        cfgSet("invite_caps", { day: Math.trunc(caps.day), week: Math.trunc(caps.week), month: Math.trunc(caps.month) });
        cfgSet("first_bonus_on", b.firstBonusOn ? 1 : 0);
        audit(admin.email, "营销配置", `邀请上限 ${caps.day}/${caps.week}/${caps.month} · 首购加赠 ${b.firstBonusOn ? "开" : "关"}`);
      });
    } else if (b.action === "tiers") {
      const tiers = b.tiers as { rmb: number; pts: number; tag?: string; hot?: boolean }[];
      if (!Array.isArray(tiers) || tiers.length === 0 || tiers.some((t) => !(t.rmb > 0) || !(t.pts > 0))) throw new Error("档位无效");
      tx(() => {
        cfgSet("recharge_tiers", tiers);
        audit(admin.email, "营销配置", `购买额度档位 ${tiers.map((t) => `¥${t.rmb}/${t.pts}`).join(" ")}`);
      });
    } else if (b.action === "recharge_maintenance") {
      tx(() => {
        cfgSet("recharge_maintenance", b.on ? 1 : 0);
        audit(admin.email, "营销配置", `购买额度维护 → ${b.on ? "开启(用户端暂停购买额度)" : "关闭"}`);
      });
    } else return NextResponse.json({ ok: false, error: "未知操作" }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "参数错误" }, { status: 400 });
  }
  return NextResponse.json({ ok: true });
}
