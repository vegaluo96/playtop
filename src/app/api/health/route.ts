/** 盯盘心跳:worker 最近一次循环时间(kv worker_heartbeat) */
import { NextResponse } from "next/server";
import { kvGet } from "@/server/af/store";

export async function GET() {
  const raw = kvGet("worker_heartbeat");
  return NextResponse.json({ ok: true, now: Date.now(), workerAt: raw ? Number(raw) : null });
}
