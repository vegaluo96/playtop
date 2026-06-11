/** 运营看板:KPI/7日图/构成/流水/漏斗/热门/告警(全部真实 SQL 口径,见行内注释) */
import { NextResponse } from "next/server";
import { db } from "@/server/db";
import { currentAdmin } from "@/server/admin/auth";
import { day8, metric, topMetrics } from "@/server/admin/metrics";
import { dailyFreeFixture } from "@/server/platform/wallet";
import { kvGet } from "@/server/af/store";
import { llmStats } from "@/server/llm/report";

const TZ8 = 8 * 3_600_000;
const dayStartMs = (offset = 0) => Math.floor((Date.now() + TZ8) / 86_400_000 - offset) * 86_400_000 - TZ8;

export async function GET() {
  if (!(await currentAdmin())) return NextResponse.json({ ok: false }, { status: 401 });
  const d = db();
  const t0 = dayStartMs(0), y0 = dayStartMs(1);
  const one = (sql: string, ...args: unknown[]) => (d.prepare(sql).get(...(args as [])) as Record<string, number> | undefined) ?? {};

  // 收入 = ledger.rmb(kind=recharge);演示支付期口径一致
  const revenue = (from: number, to: number) => one("SELECT COALESCE(SUM(rmb),0) v FROM ledger WHERE kind='recharge' AND created_at>=? AND created_at<?", from, to).v ?? 0;
  const ordersN = (from: number, to: number) => one("SELECT COUNT(*) v FROM ledger WHERE kind='recharge' AND created_at>=? AND created_at<?", from, to).v ?? 0;
  const payers = (from: number, to: number) => one("SELECT COUNT(DISTINCT user_id) v FROM ledger WHERE kind='recharge' AND created_at>=? AND created_at<?", from, to).v ?? 0;
  const regs = (from: number, to: number) => one("SELECT COUNT(*) v FROM users WHERE created_at>=? AND created_at<?", from, to).v ?? 0;

  const revToday = revenue(t0, t0 + 86_400_000), revYday = revenue(y0, t0);
  const payersToday = payers(t0, t0 + 86_400_000);
  const dau = one("SELECT COUNT(*) v FROM users WHERE last_seen>=?", t0).v ?? 0;
  const regsToday = regs(t0, t0 + 86_400_000), regsYday = regs(y0, t0);
  const regsInvited = one("SELECT COUNT(*) v FROM users WHERE created_at>=? AND invited_by IS NOT NULL", t0).v ?? 0;
  const unlocksToday = one("SELECT COUNT(*) v FROM unlocks WHERE created_at>=?", t0).v ?? 0;
  const unlockUsersToday = one("SELECT COUNT(DISTINCT user_id) v FROM unlocks WHERE created_at>=?", t0).v ?? 0;
  const rebuyBase = one("SELECT COUNT(DISTINCT user_id) v FROM unlocks").v ?? 0;
  const rebuyMulti = one("SELECT COUNT(*) v FROM (SELECT user_id FROM unlocks GROUP BY user_id HAVING COUNT(*)>=2)").v ?? 0;
  const debt = one("SELECT COALESCE(SUM(pts),0) v FROM users").v ?? 0;
  const openTickets = one("SELECT COUNT(*) v FROM tickets WHERE status='处理中'").v ?? 0;
  // 次日留存 = 昨日注册且今日活跃 / 昨日注册
  const yReg = regs(y0, t0);
  const yRegActive = one("SELECT COUNT(*) v FROM users WHERE created_at>=? AND created_at<? AND last_seen>=?", y0, t0, t0).v ?? 0;

  const visits = metric("visits");
  const pct = (a: number, b: number) => (b > 0 ? `${Math.round((a / b) * 1000) / 10}%` : "—");
  const deltaPct = (cur: number, prev: number) => (prev > 0 ? `${cur >= prev ? "↑" : "↓"} ${Math.abs(Math.round(((cur - prev) / prev) * 100))}% vs 昨日` : "—");

  const week = Array.from({ length: 7 }, (_, i) => {
    const off = 6 - i;
    const from = dayStartMs(off);
    return { d: day8(off).slice(8), rev: revenue(from, from + 86_400_000), reg: regs(from, from + 86_400_000) };
  });

  // 收入构成(按档位)
  const revmix = (d.prepare("SELECT rmb k, COALESCE(SUM(rmb),0) v, COUNT(*) n FROM ledger WHERE kind='recharge' AND created_at>=? GROUP BY rmb ORDER BY v DESC").all(t0) as unknown as { k: number; v: number; n: number }[]);

  // 积分流水
  const grant = one("SELECT COALESCE(SUM(delta),0) v FROM ledger WHERE delta>0 AND created_at>=?", t0).v ?? 0;
  const grantMix = d.prepare("SELECT kind, COALESCE(SUM(delta),0) v FROM ledger WHERE delta>0 AND created_at>=? GROUP BY kind").all(t0) as unknown as { kind: string; v: number }[];
  const consume = one("SELECT COALESCE(SUM(-delta),0) v FROM ledger WHERE kind='unlock' AND created_at>=?", t0).v ?? 0;

  // 热门场次 Top5(浏览来自埋点 mv:<fid>)
  const freeFid = dailyFreeFixture(day8());
  const hot = topMetrics("mv:", 5).map((m) => {
    const fid = Number(m.k.slice(3));
    const fx = d.prepare("SELECT home_name, away_name, league_name, league_id FROM fixtures_cache WHERE fixture_id=?").get(fid) as { home_name: string; away_name: string; league_id: number } | undefined;
    const un = one("SELECT COUNT(*) v FROM unlocks WHERE fixture_id=? AND created_at>=?", fid, t0).v ?? 0;
    return fx && { m: `${fx.home_name} vs ${fx.away_name}`, leagueId: fx.league_id, pv: m.n, un, free: fid === freeFid, rate: fid === freeFid ? "免费场" : pct(un, m.n) };
  }).filter(Boolean);

  // 告警条
  const alerts: string[] = [];
  const slowEps = d.prepare("SELECT k, ms FROM endpoint_metrics WHERE status IN ('慢','异常')").all() as unknown as { k: string; ms: number }[];
  for (const e of slowEps.slice(0, 2)) alerts.push(`${e.k} 端点${e.ms > 0 ? `响应慢(${e.ms}ms)` : "异常"}`);
  const lowCodes = d.prepare("SELECT code, used_count, max_uses FROM redeem_codes WHERE max_uses>1 AND used_count >= max_uses*0.9 AND used_count < max_uses").all() as unknown as { code: string; used_count: number; max_uses: number }[];
  for (const c of lowCodes.slice(0, 2)) alerts.push(`${c.code} 兑换码即将售罄(${c.used_count} / ${c.max_uses})`);
  const beat = Number(kvGet("worker_heartbeat") ?? 0);
  if (!beat || Date.now() - beat > 3 * 60_000) alerts.push("worker 心跳超时,数据抓取可能已停止");
  const bal = JSON.parse(kvGet("llm_balance") || "null") as { usd: number } | null;
  if (bal && bal.usd < 100) alerts.push(`大模型余额不足($${bal.usd})`);

  const af = JSON.parse(kvGet("af_status") || "null");
  const snapsToday = one("SELECT COUNT(*) v FROM odds_snapshots WHERE captured_at>=?", t0).v ?? 0;

  return NextResponse.json({
    ok: true,
    date: day8(),
    alerts,
    kpis: [
      { label: "今日收入", v: `¥${revToday.toLocaleString()}`, c: "gold", delta: deltaPct(revToday, revYday) },
      { label: "充值订单", v: String(ordersN(t0, t0 + 86_400_000)), delta: "演示支付 · 无失败" },
      { label: "付费用户", v: String(payersToday), delta: deltaPct(payersToday, payers(y0, t0)) },
      { label: "ARPPU", v: payersToday > 0 ? `¥${Math.round((revToday / payersToday) * 10) / 10}` : "—", c: "gold", delta: "" },
      { label: "付费转化率", v: pct(payersToday, dau), delta: `DAU ${dau}` },
      { label: "新注册", v: String(regsToday), delta: `${deltaPct(regsToday, regsYday)} · 邀请占 ${pct(regsInvited, regsToday)}` },
      { label: "DAU / 次日留存", v: `${dau} · ${pct(yRegActive, yReg)}`, delta: "" },
      { label: "预测解锁", v: String(unlocksToday), c: "gold", delta: `复购率 ${pct(rebuyMulti, rebuyBase)}` },
      { label: "积分负债(未消耗)", v: `${debt.toLocaleString()}`, c: "red", delta: `≈ ¥${Math.round(debt / 10).toLocaleString()}` },
      { label: "待处理工单", v: String(openTickets), delta: "" },
    ],
    week,
    revmix: revmix.map((r) => ({ k: `¥${r.k}`, v: `¥${r.v.toLocaleString()}`, w: revToday > 0 ? `${Math.round((r.v / revToday) * 100)}%` : "0%" })),
    flow: { grant, grantMix, consume, net: grant - consume, debt },
    funnel: [
      { label: "访客", v: visits, pct: "100%" },
      { label: "注册", v: regsToday, pct: pct(regsToday, visits) },
      { label: "解锁预测", v: unlockUsersToday, pct: pct(unlockUsersToday, visits) },
      { label: "充值", v: payersToday, pct: pct(payersToday, visits) },
    ],
    hot,
    af,
    snapsToday,
    llm: { ...llmStats(), balance: bal?.usd ?? null },
    workerAt: beat || null,
  });
}
