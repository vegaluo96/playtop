/**
 * 公共配置出口(免登录):联赛(含顺序)、上线中公告、版本号、充值维护状态。
 * 用户端 chips/公告条/版本显示统一从这里取,后台改动即时生效。
 */
import { NextResponse } from "next/server";
import { db } from "@/server/db";
import { cfgLeagues, cfgRechargeMaintenance } from "@/server/platform/config";
import { APP_VERSION } from "@/lib/version";

export async function GET() {
  const announcements = db()
    .prepare("SELECT id, text FROM announcements WHERE status='上线中' ORDER BY id DESC LIMIT 5")
    .all();
  return NextResponse.json({
    ok: true,
    leagues: cfgLeagues().filter((l) => l.on),
    announcements,
    version: APP_VERSION,
    rechargeMaintenance: cfgRechargeMaintenance(),
  });
}
