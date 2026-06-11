/** 盯盘心跳:worker 最近一次循环时间(kv worker_heartbeat)+ 当前生效的抓取档位(后台可调,用户端「数据刷新规则」同源展示) */
import { NextResponse } from "next/server";
import { kvGet } from "@/server/af/store";
import { cfgTierIntervals } from "@/server/platform/config";

export async function GET() {
  const raw = kvGet("worker_heartbeat");
  return NextResponse.json({
    ok: true,
    now: Date.now(),
    workerAt: raw ? Number(raw) : null,
    intervals: cfgTierIntervals(),
  });
}
