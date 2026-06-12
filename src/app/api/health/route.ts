/**
 * 盯盘心跳:worker 最近一次循环时间(kv worker_heartbeat)+ 当前生效的抓取档位
 * (后台可调,用户端「数据刷新规则」同源展示)+ 当前滚球场次数(liveNow,
 * 四个一级菜单的统一轮询节奏由它驱动:有滚球 3s,无滚球 10s)。
 */
import { NextResponse } from "next/server";
import { fixturesBetween, kvGet } from "@/server/af/store";
import { isLive } from "@/server/af/schedule";
import { cfgTierIntervals } from "@/server/platform/config";

export async function GET() {
  const raw = kvGet("worker_heartbeat");
  const now = Date.now();
  const liveNow = fixturesBetween(now - 4 * 3_600_000, now).filter((f) => isLive(f.status)).length;
  return NextResponse.json({
    ok: true,
    now,
    workerAt: raw ? Number(raw) : null,
    liveNow,
    intervals: cfgTierIntervals(),
  });
}
