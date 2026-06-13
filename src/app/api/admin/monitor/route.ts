/** 数据与模型监控:端点健康/快照归档/抓取频率(可编辑)/急变事件/AI 报告服务 */
import { NextRequest, NextResponse } from "next/server";
import { db, tx } from "@/server/db";
import { audit, canWrite, currentAdmin } from "@/server/admin/auth";
import { requireSameOrigin } from "@/server/platform/rate-limit";
import { isFinished, tierFor, TIERS } from "@/server/af/schedule";
import { cfgEffectiveTierIntervals, cfgEmergencyThrottle, cfgEmergencyThrottleState, cfgSet, cfgTierIntervals } from "@/server/platform/config";
import { recentMovements, kvGet, mainOddsDecision } from "@/server/af/store";
import { llmStats } from "@/server/llm/report";
import { hhmm } from "@/lib/format";
import { ahText, ouText, f2 } from "@/lib/format";
import { latestOddsRaw, fixturesBetween } from "@/server/af/store";
import { parseExtraMarkets } from "@/server/af/markets";
import { readLlmBalance } from "@/server/llm/client";
import { diagnosticIssueSummary, recentDiagnosticIssues } from "@/server/af/diagnostics";
import { probeExternalEndpoints } from "@/server/admin/external-endpoints";

export async function GET() {
  if (!(await currentAdmin())) return NextResponse.json({ ok: false }, { status: 401 });
  const d = db();
  const nowMs = Date.now();
  const t0 = Math.floor((nowMs + 8 * 3_600_000) / 86_400_000) * 86_400_000 - 8 * 3_600_000;
  const eps = d.prepare("SELECT k, tier, last_at, ms, status FROM endpoint_metrics ORDER BY last_at DESC").all();
  const cnt = (sql: string, ...args: unknown[]) => (d.prepare(sql).get(...((args.length ? args : [t0]) as [])) as { n: number }).n;
  const last = (sql: string, ...args: unknown[]) =>
    (d.prepare(sql).get(...((args.length ? args : [t0]) as [])) as { m: number | null } | undefined)?.m ?? null;
  const rawAudit = d
    .prepare(
      `SELECT endpoint, COUNT(*) n, MAX(fetched_at) lastAt
       FROM af_raw_payloads
       WHERE fetched_at >= ?
       GROUP BY endpoint
       ORDER BY lastAt DESC`,
    )
    .all(t0) as { endpoint: string; n: number; lastAt: number }[];

  const af = (() => {
    try {
      return JSON.parse(kvGet("af_status") || "null");
    } catch {
      return null;
    }
  })();
  const baseIntervals = cfgTierIntervals();
  const effectiveIntervals = cfgEffectiveTierIntervals(af);
  const emergencyState = cfgEmergencyThrottleState(af);

  const watchedFixtures = fixturesBetween(nowMs - 4 * 3_600_000, nowMs + 14 * 86_400_000).filter((f) => !isFinished(f.status));
  const expectedMs = watchedFixtures.length
    ? Math.min(...watchedFixtures.map((f) => {
        const t = tierFor(f.kickoff_utc, nowMs, f.status);
        return effectiveIntervals[t.idx] ?? TIERS[t.idx]?.intervalMs ?? 60_000;
      }))
    : null;
  const streamGraceMs = expectedMs == null ? null : Math.max(30 * 60_000, Math.ceil(expectedMs * 2.5));
  const streamExpected = watchedFixtures.length > 0;
  const streamStatus = (lastAt: number | null): "连续" | "断档" | "待命" => {
    if (!streamExpected) return "待命";
    if (streamGraceMs != null && (lastAt == null || nowMs - lastAt > streamGraceMs)) return "断档";
    return "连续";
  };
  const rawStatus = (lastAt: number | null): "连续" | "断档" | "待命" => {
    if (lastAt == null) return streamExpected ? "断档" : "待命";
    if (!streamExpected) return nowMs - lastAt <= 60 * 60_000 ? "连续" : "待命";
    return streamStatus(lastAt);
  };

  const rawLast = last("SELECT MAX(fetched_at) m FROM af_raw_payloads WHERE fetched_at>=?");
  const oddsLast = last(
    `SELECT MAX(m) m FROM (
      SELECT MAX(captured_at) m FROM odds_snapshots WHERE captured_at>=?
      UNION ALL
      SELECT MAX(captured_at) m FROM live_odds_snapshots WHERE captured_at>=?
    )`,
    t0,
    t0,
  );
  const predLast = last("SELECT MAX(captured_at) m FROM predictions_snapshots WHERE captured_at>=?");
  const moveLast = last("SELECT MAX(t1) m FROM movements WHERE t1>=?");
  const graceText = streamGraceMs == null ? "当前无应抓赛事" : `当前档位宽限约 ${Math.round(streamGraceMs / 60_000)} 分钟`;
  const snaps = [
    {
      k: "AF raw 信封",
      n: cnt("SELECT COUNT(*) n FROM af_raw_payloads WHERE fetched_at>=?"),
      lastAt: rawLast,
      status: rawStatus(rawLast),
      note: `AF 原始响应归档;${graceText}`,
    },
    {
      k: "odds 快照",
      n: cnt(
        `SELECT (
          (SELECT COUNT(*) FROM odds_snapshots WHERE captured_at>=?) +
          (SELECT COUNT(*) FROM live_odds_snapshots WHERE captured_at>=?)
        ) n`,
        t0,
        t0,
      ),
      lastAt: oddsLast,
      status: streamStatus(oddsLast),
      note: `赛前 odds 与滚球 live odds 快照连续性;${graceText}`,
    },
    {
      k: "predictions 快照",
      n: cnt("SELECT COUNT(*) n FROM predictions_snapshots WHERE captured_at>=?"),
      lastAt: predLast,
      status: predLast ? "有记录" : "待命",
      note: "预测快照按入窗、每日与开赛前复抓生成,不是连续流",
    },
    {
      k: "异动事件",
      n: cnt("SELECT COUNT(*) n FROM movements WHERE t1>=?"),
      lastAt: moveLast,
      status: moveLast ? "有记录" : "待命",
      note: "只有盘口或水位发生变化才生成事件,无变化不代表断档",
    },
  ];
  const gap = snaps.some((s) => s.status === "断档");
  const alerts = recentMovements(10).filter((m) => m.sev && m.t1 >= Date.now() - 3_600_000).map((m) => ({
    t: hhmm(m.t1, "UTC+8"),
    x: `${m.home_name} vs ${m.away_name} · ${m.market === "ah" ? "让球" : "大小"} ${m.market === "ah" ? ahText(m.from_line) : ouText(m.from_line)}→${m.market === "ah" ? ahText(m.to_line) : ouText(m.to_line)}`,
    d: `${m.to_line - m.from_line >= 0 ? "+" : ""}${f2(m.to_line - m.from_line)}`,
    up: m.to_line >= m.from_line,
  }));
  // 扩展玩法解析可见性:最近一场未完场赛事的最新原始帧能解析出多少种玩法
  let extraMarkets: { fixture: string; kinds: string[] } | null = null;
  let marketDecision: {
    market: string;
    qualityScore: number;
    books: number;
    selectedBooks: number;
    primaryBooks: number;
    reason: string;
    warnings: string[];
  }[] = [];
  const probe = fixturesBetween(nowMs - 2 * 3_600_000, nowMs + 48 * 3_600_000).filter(
    (f) => !["FT", "AET", "PEN", "AWD", "WO"].includes(f.status),
  )[0];
  if (probe) {
    const raw = latestOddsRaw(probe.fixture_id);
    if (raw) extraMarkets = { fixture: `${probe.home_name} vs ${probe.away_name}`, kinds: parseExtraMarkets(raw).map((m) => m.name) };
    marketDecision = (["ah", "ou", "eu"] as const).map((market) => {
      const d = mainOddsDecision(probe.fixture_id, market);
      return {
        market,
        qualityScore: d.qualityScore,
        books: d.books,
        selectedBooks: d.selectedBooks,
        primaryBooks: d.primaryBooks,
        reason: d.reason,
        warnings: d.warnings,
      };
    });
  }

  return NextResponse.json({
    ok: true, eps, externalEndpoints: await probeExternalEndpoints(), snaps, rawAudit, snapGap: gap, extraMarkets, marketDecision,
    intervals: TIERS.map((t, i) => ({ label: t.label, ms: baseIntervals[i], effectiveMs: effectiveIntervals[i] })),
    emergency: cfgEmergencyThrottle(),
    emergencyState,
    af,
    llm: { ...llmStats(), balance: readLlmBalance()?.usd ?? null },
    diagnostics: recentDiagnosticIssues(12),
    diagnosticSummary: diagnosticIssueSummary(),
    alerts,
  });
}

export async function POST(req: NextRequest) {
  const originError = requireSameOrigin(req);
  if (originError) return originError;
  const admin = await currentAdmin();
  if (!admin) return NextResponse.json({ ok: false }, { status: 401 });
  if (!canWrite(admin, "*") && admin.role !== "超级管理员" && admin.role !== "运营")
    return NextResponse.json({ ok: false, error: "无权限" }, { status: 403 });
  const b = (await req.json().catch(() => ({}))) as { action?: string; values?: number[]; on?: boolean };
  if (b.action === "intervals") {
    const v = (b.values ?? []).map((x, i) => Math.max(i >= TIERS.length - 2 ? 5_000 : 60_000, Math.trunc(Number(x)))); // 滚球两档可至 5s
    if (v.length !== TIERS.length) return NextResponse.json({ ok: false, error: "档位数量不符" }, { status: 400 });
    tx(() => {
      cfgSet("tier_intervals", v);
      audit(admin.email, "抓取频率配置", v.map((ms) => (ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60_000)}m`)).join("/"));
    });
  } else if (b.action === "emergency") {
    tx(() => {
      cfgSet("emergency_throttle", b.on ? 1 : 0);
      audit(admin.email, "紧急降频", b.on ? "开" : "关");
    });
  } else return NextResponse.json({ ok: false, error: "未知操作" }, { status: 400 });
  return NextResponse.json({ ok: true });
}
