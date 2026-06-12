/** 数据与模型监控:端点健康/快照归档/抓取频率(可编辑)/急变事件/AI 报告服务 */
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/server/db";
import { audit, canWrite, currentAdmin } from "@/server/admin/auth";
import { TIERS } from "@/server/af/schedule";
import { cfgEmergencyThrottle, cfgSet, cfgTierIntervals } from "@/server/platform/config";
import { recentMovements, kvGet } from "@/server/af/store";
import { llmStats } from "@/server/llm/report";
import { hhmm } from "@/lib/format";
import { ahText, ouText, f2 } from "@/lib/format";
import { latestOddsRaw, fixturesBetween } from "@/server/af/store";
import { parseExtraMarkets } from "@/server/af/markets";

export async function GET() {
  if (!(await currentAdmin())) return NextResponse.json({ ok: false }, { status: 401 });
  const d = db();
  const t0 = Math.floor((Date.now() + 8 * 3_600_000) / 86_400_000) * 86_400_000 - 8 * 3_600_000;
  const eps = d.prepare("SELECT k, tier, last_at, ms, status FROM endpoint_metrics ORDER BY last_at DESC").all();
  const cnt = (sql: string) => (d.prepare(sql).get(t0) as { n: number }).n;
  const snaps = [
    { k: "odds 快照", n: cnt("SELECT COUNT(*) n FROM odds_snapshots WHERE captured_at>=?") },
    { k: "predictions 快照", n: cnt("SELECT COUNT(*) n FROM predictions_snapshots WHERE captured_at>=?") },
    { k: "异动事件", n: cnt("SELECT COUNT(*) n FROM movements WHERE t1>=?") },
  ];
  const lastSnap = (d.prepare("SELECT MAX(captured_at) m FROM odds_snapshots").get() as { m: number | null }).m;
  const gap = lastSnap != null && Date.now() - lastSnap > 30 * 60_000;
  const alerts = recentMovements(10).filter((m) => m.sev && m.t1 >= Date.now() - 3_600_000).map((m) => ({
    t: hhmm(m.t1, "UTC+8"),
    x: `${m.home_name} vs ${m.away_name} · ${m.market === "ah" ? "亚盘" : "大小"} ${m.market === "ah" ? ahText(m.from_line) : ouText(m.from_line)}→${m.market === "ah" ? ahText(m.to_line) : ouText(m.to_line)}`,
    d: `${m.to_line - m.from_line >= 0 ? "+" : ""}${f2(m.to_line - m.from_line)}`,
    up: m.to_line >= m.from_line,
  }));
  // 扩展玩法解析可见性:最近一场未完场赛事的最新原始帧能解析出多少种玩法
  let extraMarkets: { fixture: string; kinds: string[] } | null = null;
  const nowMs = Date.now();
  const probe = fixturesBetween(nowMs - 2 * 3_600_000, nowMs + 48 * 3_600_000).filter(
    (f) => !["FT", "AET", "PEN", "AWD", "WO"].includes(f.status),
  )[0];
  if (probe) {
    const raw = latestOddsRaw(probe.fixture_id);
    if (raw) extraMarkets = { fixture: `${probe.home_name} vs ${probe.away_name}`, kinds: parseExtraMarkets(raw).map((m) => m.name) };
  }

  return NextResponse.json({
    ok: true, eps, snaps, snapGap: gap, extraMarkets,
    intervals: TIERS.map((t, i) => ({ label: t.label, ms: cfgTierIntervals()[i] })),
    emergency: cfgEmergencyThrottle(),
    af: JSON.parse(kvGet("af_status") || "null"),
    llm: { ...llmStats(), balance: (JSON.parse(kvGet("llm_balance") || "null") as { usd: number } | null)?.usd ?? null },
    alerts,
  });
}

export async function POST(req: NextRequest) {
  const admin = await currentAdmin();
  if (!admin) return NextResponse.json({ ok: false }, { status: 401 });
  if (!canWrite(admin, "*") && admin.role !== "超级管理员" && admin.role !== "运营")
    return NextResponse.json({ ok: false, error: "无权限" }, { status: 403 });
  const b = (await req.json().catch(() => ({}))) as { action?: string; values?: number[]; on?: boolean };
  if (b.action === "intervals") {
    const v = (b.values ?? []).map((x, i) => Math.max(i >= TIERS.length - 2 ? 5_000 : 60_000, Math.trunc(Number(x)))); // 滚球两档可至 5s
    if (v.length !== TIERS.length) return NextResponse.json({ ok: false, error: "档位数量不符" }, { status: 400 });
    cfgSet("tier_intervals", v);
    audit(admin.email, "抓取频率配置", v.map((ms) => (ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60_000)}m`)).join("/"));
  } else if (b.action === "emergency") {
    cfgSet("emergency_throttle", b.on ? 1 : 0);
    audit(admin.email, "紧急降频", b.on ? "开" : "关");
  } else return NextResponse.json({ ok: false, error: "未知操作" }, { status: 400 });
  return NextResponse.json({ ok: true });
}
