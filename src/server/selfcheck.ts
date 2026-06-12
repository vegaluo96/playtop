/**
 * 平台闭环体检(区别于 af/selftest 的"39 端点连通"):
 * L0 环境 → L1 抓取 → L2 衍生 → L3 API → L4 商业闭环 → L5 后台 → L6 LLM。
 * 原则:不伪造数据——查不到如实 ✗ 并给修复提示;依赖真实赛况的项条件不满足时 skip 并注明。
 */
import { db, tx } from "./db";
import { afGet } from "./af/client";
import { archiveOdds, fixturesBetween, hasPrediction, kvGet, kvSet, latestPrediction, mainOddsSnapshot } from "./af/store";
import { normalizeOddsItem, pairMargin } from "./af/normalize";
import { tierFor } from "./af/schedule";
import { cfgAfKey, cfgFirstBonusOn, cfgLlmKey, cfgRechargeMaintenance, cfgRechargeTiers, cfgTierIntervals, cfgUnlockPrice } from "./platform/config";
import { audit, ensureAdminSeed, listAudit } from "./admin/auth";
import { chatComplete } from "./llm/client";
import { demoRechargeEnabled } from "./platform/wallet";

export interface CheckRow {
  layer: string;
  key: string;
  status: "ok" | "fail" | "skip";
  note?: string;
}

export interface CheckReport {
  at: number;
  rows: CheckRow[];
  summary: { ok: number; fail: number; skip: number };
  chain: string;
}

const TZ8 = 8 * 3_600_000;
const todayStartMs = (now = Date.now()) => Math.floor((now + TZ8) / 86_400_000) * 86_400_000 - TZ8;

function row(layer: string, key: string, status: CheckRow["status"], note?: string): CheckRow {
  return { layer, key, status, note };
}

function dig(obj: unknown, ...path: (string | number)[]): unknown {
  let cur = obj;
  for (const k of path) {
    if (cur && typeof cur === "object") cur = (cur as Record<string, unknown>)[k as string];
    else return undefined;
  }
  return cur;
}

/* ── L0–L2:只读层(worker 每日自检 / 后台按钮 / CLI 共用)── */
export async function checkReadonly(opts: { skipNetwork?: boolean; now?: number } = {}): Promise<CheckRow[]> {
  const now = opts.now ?? Date.now();
  const d = db();
  const rows: CheckRow[] = [];

  // L0 环境
  const [maj, min] = process.versions.node.split(".").map(Number);
  rows.push(row("L0 环境", "Node ≥ 22.5", maj > 22 || (maj === 22 && min >= 5) ? "ok" : "fail", `v${process.versions.node}`));
  try {
    d.prepare("INSERT INTO kv (k, v) VALUES ('selfcheck_probe','1') ON CONFLICT(k) DO UPDATE SET v='1'").run();
    d.prepare("DELETE FROM kv WHERE k='selfcheck_probe'").run();
    rows.push(row("L0 环境", "DB 可写", "ok"));
  } catch (e) {
    rows.push(row("L0 环境", "DB 可写", "fail", e instanceof Error ? e.message : String(e)));
  }
  rows.push(row("L0 环境", "AF 密钥已配置", cfgAfKey() ? "ok" : "fail", cfgAfKey() ? undefined : "后台系统设置或 env API_FOOTBALL_KEY"));
  ensureAdminSeed(); // 与后台同一种子逻辑,避免检查顺序依赖
  const superAdmin = d.prepare("SELECT 1 FROM admins WHERE role='超级管理员' AND status='启用' LIMIT 1").get();
  rows.push(row("L0 环境", "超级管理员已种子", superAdmin ? "ok" : "fail", superAdmin ? undefined : "env ADMIN_EMAIL/ADMIN_PASSWORD 后访问一次后台"));

  // L1 抓取
  if (opts.skipNetwork) {
    rows.push(row("L1 抓取", "/status 鉴权", "skip", "skipNetwork"));
  } else {
    try {
      const env = await afGet("/status", { force: true });
      const r = (env.response ?? {}) as { subscription?: { plan?: string }; requests?: { current?: number; limit_day?: number } };
      const cur = r.requests?.current ?? 0;
      const lim = r.requests?.limit_day ?? 0;
      rows.push(row("L1 抓取", "/status 鉴权", lim > 0 && cur < lim ? "ok" : "fail", `${r.subscription?.plan ?? "?"} · ${cur}/${lim}`));
    } catch (e) {
      rows.push(row("L1 抓取", "/status 鉴权", "fail", e instanceof Error ? e.message : String(e)));
    }
  }
  const beat = Number(kvGet("worker_heartbeat") ?? 0);
  rows.push(row("L1 抓取", "worker 心跳 <3min", beat && now - beat < 3 * 60_000 ? "ok" : "fail", beat ? `${Math.round((now - beat) / 1000)}s 前` : "无心跳:pm2 logs playtop-worker"));

  const t0 = todayStartMs(now);
  const todays = fixturesBetween(t0, t0 + 86_400_000);
  const lastUpd = todays.reduce((m, f) => Math.max(m, f.updated_at), 0);
  rows.push(
    row("L1 抓取", "今日赛程已入库", todays.length > 0 && now - lastUpd < 6 * 3_600_000 ? "ok" : todays.length > 0 ? "fail" : "fail",
      todays.length > 0 ? `${todays.length} 场 · 最近更新 ${Math.round((now - lastUpd) / 60_000)}m 前` : "0 场:检查联赛开关与 worker 日表抓取"),
  );

  // 指数快照新鲜度:有未完场场次时,最新快照不得晚于 2×当前最密档间隔(下限 15min)
  const pending = todays.filter((f) => !["FT", "AET", "PEN", "AWD", "WO"].includes(f.status));
  if (pending.length === 0) {
    rows.push(row("L1 抓取", "指数快照新鲜度", "skip", "今日无在售场次"));
  } else {
    const densest = Math.min(...pending.map((f) => cfgTierIntervals()[tierFor(f.kickoff_utc, now, f.status).idx]));
    const lastSnap = (d.prepare("SELECT MAX(captured_at) m FROM odds_snapshots").get() as { m: number | null }).m ?? 0;
    const limit = Math.max(2 * densest, 15 * 60_000);
    rows.push(
      row("L1 抓取", "指数快照新鲜度", lastSnap && now - lastSnap < limit ? "ok" : "fail",
        lastSnap ? `最新 ${Math.round((now - lastSnap) / 60_000)}m 前(阈值 ${Math.round(limit / 60_000)}m)` : "从未有快照:AF 对该场次可能无指数覆盖,或 odds 抓取失败"),
    );
  }

  const predCovered = todays.filter((f) => hasPrediction(f.fixture_id)).length;
  rows.push(
    row("L1 抓取", "概率快照覆盖", todays.length === 0 ? "skip" : predCovered > 0 ? "ok" : "fail",
      todays.length > 0 ? `${predCovered}/${todays.length} 场` : "今日无场次"),
  );

  const badEps = d.prepare("SELECT k FROM endpoint_metrics WHERE status='异常'").all() as unknown as { k: string }[];
  rows.push(row("L1 抓取", "端点无异常", badEps.length === 0 ? "ok" : "fail", badEps.map((e) => e.k).join("、") || undefined));

  // L2 衍生
  // 异动:抽样验证「确有变盘的序列必有 movement」
  const changed = d
    .prepare(
      `SELECT fixture_id, bookmaker_id, market, COUNT(DISTINCT line) lines, COUNT(*) n
       FROM odds_snapshots WHERE market IN ('ah','ou') GROUP BY fixture_id, bookmaker_id, market
       HAVING n >= 2 AND lines >= 2 LIMIT 1`,
    )
    .get() as { fixture_id: number; market: string } | undefined;
  if (!changed) {
    rows.push(row("L2 衍生", "异动生成", "skip", "库内暂无真实变盘(diff 逻辑已由单测覆盖)"));
  } else {
    const mv = d.prepare("SELECT 1 FROM movements WHERE fixture_id=? AND market=? LIMIT 1").get(changed.fixture_id, changed.market);
    rows.push(row("L2 衍生", "异动生成", mv ? "ok" : "fail", `样本 fixture=${changed.fixture_id} ${changed.market}`));
  }

  const today8 = new Date(now + TZ8).toISOString().slice(0, 10);
  const free = d.prepare("SELECT fixture_id FROM free_fixtures WHERE date=?").get(today8) as { fixture_id: number } | undefined;
  const freeHidden = free && d.prepare("SELECT 1 FROM hidden_fixtures WHERE fixture_id=?").get(free.fixture_id);
  rows.push(
    row("L2 衍生", "每日免费场", todays.length === 0 ? "skip" : free && !freeHidden ? "ok" : "fail",
      todays.length === 0 ? "今日无场次" : free ? (freeHidden ? "免费场被隐藏,需在后台改选" : `fixture=${free.fixture_id}`) : "未设定:worker 应自动选定"),
  );

  // 指数配对合理性:满水率(两腿隐含概率和)必须落在 1.00–1.18,配错腿/坏数据立刻露馅
  const latestPairs = d
    .prepare(
      `SELECT fixture_id, bookmaker, market, line, h, a FROM odds_snapshots
       WHERE market IN ('ah','ou')
         AND captured_at = (SELECT MAX(captured_at) FROM odds_snapshots s2
                            WHERE s2.fixture_id=odds_snapshots.fixture_id AND s2.bookmaker=odds_snapshots.bookmaker AND s2.market=odds_snapshots.market)
       LIMIT 200`,
    )
    .all() as unknown as { fixture_id: number; bookmaker: string; market: string; line: number; h: number; a: number }[];
  if (latestPairs.length === 0) {
    rows.push(row("L2 衍生", "指数配对合理性", "skip", "暂无指数快照"));
  } else {
    const bad = latestPairs.filter((s2) => {
      const m = pairMargin(s2.h + 1, s2.a + 1);
      return m < 1.0 || m > 1.18;
    });
    rows.push(
      row("L2 衍生", "指数配对合理性", bad.length === 0 ? "ok" : "fail",
        bad.length === 0
          ? `${latestPairs.length} 组满水率均在 1.00–1.18`
          : `${bad.length}/${latestPairs.length} 组异常,如 fixture=${bad[0].fixture_id} ${bad[0].market} ${bad[0].h}/${bad[0].a}(疑似错腿配对,跑 renorm 重算)`),
    );
  }

  const settleableRows = d
    .prepare(
      `SELECT f.fixture_id FROM fixtures_cache f
       WHERE f.status IN ('FT','AET','PEN') AND f.goals_home IS NOT NULL
         AND EXISTS (SELECT 1 FROM predictions_snapshots p WHERE p.fixture_id=f.fixture_id)
       ORDER BY f.kickoff_utc DESC LIMIT 20`,
    )
    .all() as unknown as { fixture_id: number }[];
  const settleable = settleableRows.find((r) => Number(dig(latestPrediction(r.fixture_id), "predictions", "winner", "id")));
  if (!settleable) {
    rows.push(row("L2 衍生", "战绩结算", "skip", "暂无「完场且概率含 winner」的场次"));
  } else {
    const rec = d.prepare("SELECT 1 FROM model_records WHERE fixture_id=?").get(settleable.fixture_id);
    rows.push(row("L2 衍生", "战绩结算", rec ? "ok" : "fail", `样本 fixture=${settleable.fixture_id}`));
  }
  return rows;
}

/* ── L3:API 层(HTTP 打本机)── */
export async function checkApi(base: string): Promise<CheckRow[]> {
  const rows: CheckRow[] = [];
  const get = async (path: string) => {
    const r = await fetch(`${base}${path}`, { cache: "no-store" });
    return { status: r.status, json: (await r.json().catch(() => null)) as Record<string, unknown> | null };
  };
  try {
    const h = await get("/api/health");
    rows.push(row("L3 API", "/api/health", h.json?.ok === true ? "ok" : "fail", h.json ? undefined : `HTTP ${h.status}(可能仍是旧构建)`));
  } catch (e) {
    rows.push(row("L3 API", "/api/health", "fail", `无法连接 ${base}:${e instanceof Error ? e.message : e}`));
    return rows; // 服务都打不通,后续 API 项没有意义
  }

  const m = await get("/api/matches?day=today");
  const list = (m.json?.rows ?? []) as Record<string, unknown>[];
  const dbCount = fixturesBetween(todayStartMs(), todayStartMs() + 86_400_000).filter(
    (f) => !db().prepare("SELECT 1 FROM hidden_fixtures WHERE fixture_id=?").get(f.fixture_id),
  ).length;
  rows.push(
    row("L3 API", "/api/matches 口径一致", m.json?.ok === true && list.length === dbCount ? "ok" : "fail",
      `API ${list.length} / DB ${dbCount}` + (list.length !== dbCount ? "(不一致:Web 与本 CLI 可能指向不同 PLAYTOP_DB,检查 pm2 env)" : "")),
  );

  // 游客打码边界:非直播第 4 行起 masked 且数值置空
  const nonLive = list.filter((r) => !r.live);
  if (nonLive.length <= 3) {
    rows.push(row("L3 API", "游客打码边界", "skip", `非直播仅 ${nonLive.length} 场,未触发打码`));
  } else {
    const overflow = nonLive.slice(3);
    const okMask = overflow.every((r) => r.masked === true && r.ah == null && r.eu == null);
    const okOpen = nonLive.slice(0, 3).every((r) => r.masked === false);
    rows.push(row("L3 API", "游客打码边界", okMask && okOpen ? "ok" : "fail", `前3完整+第4起打码:${okOpen}/${okMask}`));
  }

  const fid = (list.find((r) => !r.masked)?.id ?? list[0]?.id) as number | undefined;
  if (fid) {
    const dtl = await get(`/api/match/${fid}`);
    const shape = dtl.json?.ok === true && dtl.json.header != null && dtl.json.odds != null && dtl.json.tech != null && dtl.json.lineups != null;
    rows.push(row("L3 API", "/api/match 结构", shape ? "ok" : "fail", `fixture=${fid}`));
    const rep = await get(`/api/report/${fid}`);
    const lockedOk = rep.json?.ok === true && rep.json.locked === true && Array.isArray(rep.json.sections) && (rep.json.sections as unknown[]).length === 0;
    rows.push(row("L3 API", "付费墙不漏内容", lockedOk ? "ok" : "fail", "游客 report 必须 locked 且 sections 空"));
  } else {
    rows.push(row("L3 API", "/api/match 结构", "skip", "今日无场次"));
  }

  for (const path of ["/api/moves", "/api/predictions"]) {
    const r2 = await get(path);
    rows.push(row("L3 API", path, r2.json?.ok === true ? "ok" : "fail"));
  }
  const adm = await fetch(`${base}/api/admin/me`, { cache: "no-store" });
  rows.push(row("L3 API", "后台无凭据 401", adm.status === 401 ? "ok" : "fail", `HTTP ${adm.status}`));
  return rows;
}

/* ── L4:商业闭环(真实 API 走一遍,事务清理)── */
export async function checkBusiness(base: string): Promise<CheckRow[]> {
  const rows: CheckRow[] = [];
  const ts = Date.now();
  const emailA = `selfcheck+${ts}a@check.internal`;
  const emailB = `selfcheck+${ts}b@check.internal`;
  const code = `SELFCHK${String(ts).slice(-6)}`;
  const d = db();

  const jar: Record<string, string> = {};
  const call = async (path: string, init: RequestInit = {}, useJar = true) => {
    const headers = new Headers(init.headers);
    if (init.body) headers.set("content-type", "application/json");
    if (useJar && Object.keys(jar).length > 0) headers.set("cookie", Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; "));
    const r = await fetch(`${base}${path}`, { ...init, headers, redirect: "manual" });
    for (const sc of r.headers.getSetCookie?.() ?? []) {
      const [pair] = sc.split(";");
      const i = pair.indexOf("=");
      jar[pair.slice(0, i).trim()] = pair.slice(i + 1);
    }
    return { status: r.status, json: (await r.json().catch(() => null)) as Record<string, unknown> | null };
  };

  try {
    // 注册 → 礼包 → 首购
    const reg = await call("/api/auth/login", { method: "POST", body: JSON.stringify({ email: emailA, password: "Selfcheck66" }) });
    rows.push(row("L4 闭环", "注册自动建号", reg.json?.ok === true ? "ok" : "fail", reg.json?.error as string | undefined));
    const me1 = await call("/api/me");
    rows.push(row("L4 闭环", "新人礼包待领", me1.json?.giftPending === true ? "ok" : "fail"));
    const gift = await call("/api/wallet", { method: "POST", body: JSON.stringify({ action: "gift" }) });
    rows.push(row("L4 闭环", "礼包到账", gift.json?.pts === 58 ? "ok" : "fail", `pts=${gift.json?.pts}`));
    if (cfgRechargeMaintenance() || !demoRechargeEnabled()) {
      rows.push(row("L4 闭环", "首购加赠", "skip", "购买通道维护中;不执行演示充值断言"));
    } else {
      const tier0 = cfgRechargeTiers()[0];
      const expCredit = cfgFirstBonusOn() ? tier0.pts + Math.floor(tier0.pts * 0.5) : tier0.pts;
      const re = await call("/api/wallet", { method: "POST", body: JSON.stringify({ action: "recharge", tier: 0 }) });
      rows.push(row("L4 闭环", "首购加赠", re.json?.pts === 58 + expCredit ? "ok" : "fail", `期望 ${58 + expCredit},实际 ${re.json?.pts}`));
    }

    // 解锁(选今日非免费场)
    const t0 = todayStartMs();
    const today8 = new Date(Date.now() + TZ8).toISOString().slice(0, 10);
    const freeIds = new Set(
      (d.prepare("SELECT fixture_id FROM free_fixtures WHERE date=?").all(today8) as unknown as { fixture_id: number }[]).map((r) => r.fixture_id),
    );
    const target = fixturesBetween(t0, t0 + 86_400_000).find((f) => !freeIds.has(f.fixture_id));
    if (!target) {
      rows.push(row("L4 闭环", "解锁与付费墙", "skip", "今日无可解锁场次"));
    } else {
      const expPrice = cfgUnlockPrice(target.kickoff_utc, Date.now());
      const before = (await call("/api/me")).json?.pts as number;
      const un = await call("/api/unlock", { method: "POST", body: JSON.stringify({ fixtureId: target.fixture_id }) });
      const after = un.json?.pts as number;
      rows.push(row("L4 闭环", "解锁按价扣费", un.json?.ok === true && before - after === expPrice ? "ok" : "fail", `价 ${expPrice} · ${before}→${after}`));
      const rep = await call(`/api/report/${target.fixture_id}`);
      const opened = rep.json?.locked === false && Array.isArray(rep.json?.sections) && (rep.json.sections as unknown[]).length > 0;
      rows.push(row("L4 闭环", "解锁后报告可读", opened ? "ok" : "fail", `genBy=${rep.json?.genBy}`));
    }

    // 流水对账
    const w = await call("/api/wallet");
    const ledger = (w.json?.ledger ?? []) as { delta: number }[];
    const sum = ledger.reduce((s, l) => s + l.delta, 0);
    rows.push(row("L4 闭环", "流水可对账", sum === w.json?.pts ? "ok" : "fail", `Σdelta=${sum} vs 余额=${w.json?.pts}(${ledger.length} 笔)`));

    // 邀请闭环
    const inv = await call("/api/invite");
    const invCode = inv.json?.code as string;
    const jarA = { ...jar };
    delete jar.pt_sess; // B 是新会话
    await call(`/i/${invCode}`, {}, true); // 拿 pt_ref
    await call("/api/auth/login", { method: "POST", body: JSON.stringify({ email: emailB, password: "Selfcheck66" }) });
    Object.assign(jar, jarA); // 回到 A
    const inv2 = await call("/api/invite");
    const got = (inv2.json?.log as { credited: number }[] | undefined)?.filter((l) => l.credited > 0).length ?? 0;
    rows.push(row("L4 闭环", "邀请归因 +1", got >= 1 ? "ok" : "fail", `A 的邀请记录 ${got} 条`));

    // 兑换闭环
    d.prepare("INSERT INTO redeem_codes (code, points, max_uses) VALUES (?, 9, 10)").run(code);
    const rd1 = await call("/api/wallet", { method: "POST", body: JSON.stringify({ action: "redeem", code }) });
    const rd2 = await call("/api/wallet", { method: "POST", body: JSON.stringify({ action: "redeem", code }) });
    rows.push(row("L4 闭环", "兑换一次性", rd1.json?.ok === true && rd2.json?.ok === false ? "ok" : "fail", `${rd1.json?.ok}/${rd2.json?.error}`));
  } catch (e) {
    rows.push(row("L4 闭环", "执行异常", "fail", e instanceof Error ? e.message : String(e)));
  } finally {
    const residue = cleanupSelfcheckData();
    rows.push(row("L4 闭环", "测试数据清理", residue === 0 ? "ok" : "fail", residue === 0 ? "KPI 无残留" : `残留 ${residue} 行`));
  }
  return rows;
}

/** 清理 @check.internal 测试账号与 SELFCHK 兑换码;返回残留行数(0=干净) */
export function cleanupSelfcheckData(): number {
  const d = db();
  tx(() => {
    const ids = (d.prepare("SELECT id FROM users WHERE email LIKE '%@check.internal'").all() as unknown as { id: number }[]).map((r) => r.id);
    for (const id of ids) {
      d.prepare("DELETE FROM sessions WHERE user_id=?").run(id);
      d.prepare("DELETE FROM ledger WHERE user_id=?").run(id);
      d.prepare("DELETE FROM unlocks WHERE user_id=?").run(id);
      d.prepare("DELETE FROM invites WHERE inviter_id=? OR invitee_id=?").run(id, id);
      d.prepare("DELETE FROM redemptions WHERE user_id=?").run(id);
      d.prepare("DELETE FROM tickets WHERE user_id=?").run(id);
      d.prepare("DELETE FROM users WHERE id=?").run(id);
    }
    d.prepare("DELETE FROM redeem_codes WHERE code LIKE 'SELFCHK%'").run();
  });
  return (db().prepare("SELECT COUNT(*) n FROM users WHERE email LIKE '%@check.internal'").get() as { n: number }).n;
}

/* ── L5:后台闭环 ── */
export async function checkAdmin(base: string): Promise<CheckRow[]> {
  const rows: CheckRow[] = [];
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !password) return [row("L5 后台", "管理员链路", "skip", "未提供 ADMIN_EMAIL/ADMIN_PASSWORD")];
  let cookie = "";
  const login = await fetch(`${base}/api/auth/login`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }),
  });
  for (const sc of login.headers.getSetCookie?.() ?? []) if (sc.startsWith("pt_sess=")) cookie = sc.split(";")[0];
  const get = (p: string) => fetch(`${base}${p}`, { headers: { cookie }, cache: "no-store" }).then(async (r) => ({ status: r.status, json: (await r.json().catch(() => null)) as Record<string, unknown> | null }));

  const meR = await get("/api/admin/me");
  rows.push(row("L5 后台", "管理员登录", meR.status === 200 ? "ok" : "fail", `HTTP ${meR.status}`));
  if (meR.status !== 200) return rows;
  const ov = await get("/api/admin/overview");
  const kpisOk = ov.json?.ok === true && Array.isArray(ov.json.kpis) && (ov.json.kpis as unknown[]).length === 10;
  rows.push(row("L5 后台", "看板 KPI 可算", kpisOk ? "ok" : "fail"));
  const rk = await get("/api/admin/risk");
  rows.push(row("L5 后台", "风控扫描", rk.json?.ok === true ? "ok" : "fail"));
  audit("selfcheck", "运行平台体检");
  const audited = listAudit(5).some((a) => a.action === "运行平台体检");
  rows.push(row("L5 后台", "审计留痕", audited ? "ok" : "fail"));
  return rows;
}

/* ── L6:LLM(可选)── */
export async function checkLlm(): Promise<CheckRow[]> {
  if (!cfgLlmKey()) return [row("L6 LLM", "网关", "skip", "未配置(模板模式)")];
  try {
    const r = await chatComplete("只回答两个字:正常", "连通性测试", 16);
    return [row("L6 LLM", "网关连通", r.text.length > 0 ? "ok" : "fail", `${r.tokens} tokens`)];
  } catch (e) {
    return [row("L6 LLM", "网关连通", "fail", e instanceof Error ? e.message : String(e))];
  }
}

/* ── 汇总与渲染 ── */
export function summarize(rows: CheckRow[]): CheckReport {
  const summary = {
    ok: rows.filter((r) => r.status === "ok").length,
    fail: rows.filter((r) => r.status === "fail").length,
    skip: rows.filter((r) => r.status === "skip").length,
  };
  const layers = ["L1 抓取", "L2 衍生", "L3 API", "L4 闭环", "L5 后台", "L6 LLM"];
  const mark = (layer: string) => {
    const ls = rows.filter((r) => r.layer === layer);
    if (ls.length === 0) return "·";
    if (ls.some((r) => r.status === "fail")) return "✗";
    if (ls.every((r) => r.status === "skip")) return "skip";
    return "✓";
  };
  const chain = `抓取 ${mark(layers[0])} → 衍生 ${mark(layers[1])} → API ${mark(layers[2])} → 商业闭环 ${mark(layers[3])} → 后台 ${mark(layers[4])} → LLM ${mark(layers[5])}`;
  return { at: Date.now(), rows, summary, chain };
}

export function formatReport(rep: CheckReport): string {
  const lines: string[] = [];
  const icon = { ok: "✓", fail: "✗", skip: "—" } as const;
  let lastLayer = "";
  const kw = Math.max(...rep.rows.map((r) => r.key.length));
  for (const r of rep.rows) {
    if (r.layer !== lastLayer) {
      lines.push(`■ ${r.layer}`);
      lastLayer = r.layer;
    }
    lines.push(`  ${icon[r.status]} ${r.key.padEnd(kw + 2)}${r.note ? ` «${r.note}»` : ""}`);
  }
  lines.push("");
  lines.push(`合计:✓ ${rep.summary.ok} · ✗ ${rep.summary.fail} · —skip ${rep.summary.skip}`);
  lines.push(`闭环:${rep.chain}`);
  return lines.join("\n");
}

/** worker 每日只读体检(06:00 UTC+8 后第一轮),结果落 kv 给看板 */
export async function dailyReadonlyCheck(now = Date.now()): Promise<void> {
  const today8 = new Date(now + TZ8).toISOString().slice(0, 10);
  const hour8 = new Date(now + TZ8).getUTCHours();
  if (hour8 < 6 || kvGet(`platform_check:${today8}`)) return;
  kvSet(`platform_check:${today8}`, "1");
  const rep = summarize(await checkReadonly({ now }));
  kvSet("last_platform_check", JSON.stringify({ at: rep.at, ...rep.summary }));
}

/** 重放 odds_raw 重建快照与异动(归一化逻辑修正后修复历史数据;原始数据不动) */
export function renormalizeOdds(fixtureId?: number): { fixtures: number; raws: number; moves: number } {
  const d = db();
  const fids = fixtureId
    ? (d.prepare("SELECT 1 FROM odds_raw WHERE fixture_id = ? LIMIT 1").get(fixtureId) ? [fixtureId] : [])
    : (d.prepare("SELECT DISTINCT fixture_id FROM odds_raw ORDER BY fixture_id").all() as { fixture_id: number }[]).map((r) => r.fixture_id);
  let moves = 0;
  let rawsCount = 0;
  for (const fid of fids) {
    const raws = d
      .prepare("SELECT payload, captured_at FROM odds_raw WHERE fixture_id = ? ORDER BY captured_at")
      .all(fid) as unknown as { payload: string; captured_at: number }[];
    rawsCount += raws.length;
    tx(() => {
      d.prepare("DELETE FROM odds_snapshots WHERE fixture_id = ?").run(fid);
      d.prepare("DELETE FROM movements WHERE fixture_id = ?").run(fid);
    });
    for (const r of raws) {
      try {
        moves += archiveOdds(fid, JSON.parse(r.payload), r.captured_at, { persistRaw: false });
      } catch {
        /* 单条坏 payload 跳过 */
      }
    }
  }
  return { fixtures: fids.length, raws: rawsCount, moves };
}

/* ── 指数保真度审计:AF 原始 → 归一化 → 落库 → 显示,四层对照 ── */
/**
 * 批量指数校验:未来 48h 内全部未完场赛事,逐场对照「AF 源共识指数线 vs 我方落库主指数线」,
 * 程序自动判定:✓ 一致 ｜ △ 水位偏差(同线,|Δ|>0.05,多为书商基准差) ｜ ✗ 指数线不一致(真问题)。
 * 每场消耗 1 次 AF 请求,默认上限 20 场。
 */
export async function verifyOdds(maxN = 20): Promise<string> {
  const d = db();
  const now = Date.now();
  const fixtures = fixturesBetween(now - 2 * 3_600_000, now + 48 * 3_600_000)
    .filter((f) => !["FT", "AET", "PEN", "AWD", "WO"].includes(f.status))
    .sort((a, b) => a.kickoff_utc - b.kickoff_utc)
    .slice(0, maxN);
  if (fixtures.length === 0) return "未来 48h 无未完场赛事。";

  const median = (xs: number[]) => {
    const s = [...xs].sort((p, q) => p - q);
    return s.length ? s[Math.floor((s.length - 1) / 2)] : null;
  };
  const lines: string[] = [`■ 批量指数校验 · ${fixtures.length} 场(未来 48h)· 判定口径:指数线不一致=✗ / 同线水位差>0.05=△ / 否则 ✓`];
  let ok = 0, warn = 0, bad = 0, skip = 0;

  for (const f of fixtures) {
    let raw: unknown = null;
    try {
      const env = await afGet(`/odds?fixture=${f.fixture_id}`, { force: true });
      raw = Array.isArray(env.response) ? env.response[0] : null;
    } catch {
      /* 单场失败不阻断 */
    }
    const name = `${f.home_name} vs ${f.away_name}`.slice(0, 30);
    if (!raw) {
      lines.push(`  ⊘ ${name} · fixture=${f.fixture_id}:AF 暂无指数(未开盘或拉取失败)`);
      skip++;
      continue;
    }
    const books = normalizeOddsItem(raw);
    for (const mk of ["ah", "ou"] as const) {
      const ms = books.flatMap((b) => b.markets.filter((m) => m.market === mk));
      if (ms.length === 0) continue;
      const cLine = median(ms.map((m) => m.line ?? 0));
      const at = ms.filter((m) => (m.line ?? 0) === cLine);
      const cH = median(at.map((m) => m.h))!;
      const cA = median(at.map((m) => m.a))!;
      const mine = mainOddsSnapshot(f.fixture_id, mk);
      if (!mine) {
        lines.push(`  ⊘ ${name} ${mk}:库内无快照(待 worker 抓取)`);
        skip++;
        continue;
      }
      if (mine.line !== cLine) {
        lines.push(`  ✗ ${name} ${mk}:线不一致!AF共识 ${cLine} vs 我方 ${mine.line}(${mine.bookmaker})← 需排查`);
        bad++;
      } else if (Math.abs(mine.h - cH) > 0.05 || Math.abs(mine.a - cA) > 0.05) {
        lines.push(`  △ ${name} ${mk}:同线 ${cLine},水位差 AF ${cH}/${cA} vs 我方 ${mine.h}/${mine.a}(${mine.bookmaker},书商基准差)`);
        warn++;
      } else {
        ok++;
      }
    }
  }
  lines.push(`  汇总:✓ ${ok} 项一致 · △ ${warn} 项水位小差 · ✗ ${bad} 项线不一致 · ⊘ ${skip} 项无数据`);
  lines.push(
    bad > 0
      ? "  结论:存在线不一致项,需逐场 audit 排查!"
      : ok > 0
        ? "  结论:全部指数线与 AF 源一致,数据无错。"
        : "  结论:本轮无可判定项(均无数据)。",
  );
  return lines.join("\n");
}

export async function auditOdds(fixtureId: number, base?: string): Promise<string> {
  const d = db();
  const lines: string[] = [`■ 指数保真度审计 · fixture=${fixtureId}`];
  const fx = d.prepare("SELECT home_name, away_name, status, kickoff_utc, payload FROM fixtures_cache WHERE fixture_id=?").get(fixtureId) as
    | { home_name: string; away_name: string; status: string; kickoff_utc: number; payload: string } | undefined;
  if (!fx) return `fixture ${fixtureId} 不在库中`;
  lines.push(`  ${fx.home_name} vs ${fx.away_name} · 状态 ${fx.status} · 开球 ${new Date(fx.kickoff_utc + 8 * 3_600_000).toISOString().slice(0, 16).replace("T", " ")}(UTC+8)`);

  // ① AF 赛前赔率原始(1 req)。不要和 /odds/live 滚球赔率混用。
  let prematchRaw: unknown = null;
  try {
    const env = await afGet(`/odds?fixture=${fixtureId}`, { force: true });
    prematchRaw = Array.isArray(env.response) ? env.response[0] : null;
  } catch (e) {
    lines.push(`  ① AF 赛前赔率拉取失败:${e instanceof Error ? e.message : e}`);
  }
  // 主盘速览:AF 源共识盘(各书商中位数)对照我方落库与前端,3 行看齐
  if (prematchRaw) {
    const books = normalizeOddsItem(prematchRaw);
    const median = (xs: number[]) => {
      const s = [...xs].sort((p, q) => p - q);
      return s.length ? s[Math.floor((s.length - 1) / 2)] : null;
    };
    const consensus = (mk: "ah" | "ou") => {
      const ms = books.flatMap((b) => b.markets.filter((m) => m.market === mk));
      if (ms.length === 0) return null;
      const line = median(ms.map((m) => m.line ?? 0));
      const at = ms.filter((m) => (m.line ?? 0) === line);
      return { line, h: median(at.map((m) => m.h))!, a: median(at.map((m) => m.a))!, n: at.length, tot: ms.length };
    };
    const dbMain = (mk: "ah" | "ou") => mainOddsSnapshot(fixtureId, mk);
    const fmt = (x: { line: number | null; h: number; a: number } | null | undefined) =>
      x ? `line=${x.line} 水=${x.h}/${x.a}` : "—";
    lines.push("  ★ 主盘速览(AF 源共识 vs 我方落库):");
    for (const mk of ["ah", "ou"] as const) {
      const c = consensus(mk);
      const m = dbMain(mk);
      lines.push(`     ${mk}  AF共识 ${fmt(c)}${c ? `(${c.n}/${c.tot}家)` : ""}  ｜  我方 ${fmt(m)}${m ? `(${m.bookmaker})` : ""}`);
    }
  }
  if (prematchRaw) {
    lines.push("  ① AF 赛前赔率原始(胜平负)→ 归一化(让球/大小为净水=欧赔-1,line 正=主让):");
    for (const bm of normalizeOddsItem(prematchRaw).slice(0, 25)) {
      for (const mk of bm.markets) {
        lines.push(`     ${bm.bookmaker.padEnd(12)} ${mk.market} line=${mk.line ?? "—"} h=${mk.h} a=${mk.a}${mk.d != null ? ` d=${mk.d}` : ""}`);
      }
    }
  }

  // ② 库内最新快照
  lines.push("  ② 库内最新快照(odds_snapshots):");
  const snaps = d
    .prepare(
      `SELECT bookmaker, market, line, h, a, d, captured_at FROM odds_snapshots WHERE fixture_id=?
       AND captured_at = (SELECT MAX(captured_at) FROM odds_snapshots s2 WHERE s2.fixture_id=odds_snapshots.fixture_id AND s2.bookmaker=odds_snapshots.bookmaker AND s2.market=odds_snapshots.market)
       ORDER BY bookmaker, market`,
    )
    .all(fixtureId) as unknown as { bookmaker: string; market: string; line: number | null; h: number; a: number; d: number | null; captured_at: number }[];
  if (snaps.length === 0) lines.push("     (空:该场尚无快照)");
  for (const s of snaps.slice(0, 60)) {
    const margin = s.market === "eu" ? null : pairMargin(s.h + 1, s.a + 1);
    const flag = margin != null && (margin < 1.0 || margin > 1.18) ? " ⚠配对异常" : "";
    lines.push(
      `     ${s.bookmaker.padEnd(12)} ${s.market} line=${s.line ?? "—"} h=${s.h} a=${s.a}${s.d != null ? ` d=${s.d}` : ""}` +
        (margin != null ? ` · 满水率 ${margin.toFixed(3)}${flag}` : "") +
        ` · ${Math.round((Date.now() - s.captured_at) / 60_000)}m 前`,
    );
  }

  // ③ 前端显示值(API)
  if (base) {
    try {
      const j = (await fetch(`${base}/api/match/${fixtureId}`, { cache: "no-store" }).then((r) => r.json())) as Record<string, never>;
      const sum = j["summary"] as { ah?: { text: string; w: string }; ou?: { text: string; w: string }; eu?: { w: string } } | undefined;
      lines.push(`  ③ 前端显示:让球「${sum?.ah?.text ?? "—"} ${sum?.ah?.w ?? ""}」 大小「${sum?.ou?.text ?? "—"} ${sum?.ou?.w ?? ""}」 胜平负「${sum?.eu?.w ?? "—"}」`);
    } catch {
      lines.push("  ③ 前端显示:API 不可达");
    }
  }
  // ④ AF 实时阵容 vs 库内阵容(身份对照:首发前 3 人)
  const namesOf = (payload: unknown, homeId?: number) => {
    const lus = ((payload as { lineups?: unknown[] })?.lineups ?? []) as Record<string, never>[];
    return lus.map((lu) => {
      const team = (lu as Record<string, { id?: number; name?: string }>)["team"];
      const xi = ((lu as Record<string, unknown>)["startXI"] as { player?: { name?: string } }[] | undefined) ?? [];
      void homeId;
      return `${team?.name ?? "?"}(id=${team?.id}):${xi.slice(0, 3).map((x) => x.player?.name).join("、")}…`;
    });
  };
  try {
    const dbLineups = namesOf(JSON.parse(fx.payload));
    lines.push("  ④ 库内阵容(bundle):" + (dbLineups.length > 0 ? "" : "未公布/未抓到"));
    for (const l of dbLineups) lines.push(`     ${l}`);
  } catch {
    lines.push("  ④ 库内阵容:payload 解析失败");
  }
  try {
    const env = await afGet(`/fixtures?id=${fixtureId}`, { force: true });
    const raw = Array.isArray(env.response) ? env.response[0] : null;
    const okId = raw && Number((raw as { fixture?: { id?: number } }).fixture?.id) === fixtureId;
    lines.push(`  ⑤ AF 实时阵容:${okId ? "" : "(⚠ 返回体 fixture.id 与请求不符!)"}`);
    for (const l of namesOf(raw)) lines.push(`     ${l}`);
    const teams = (raw as { teams?: { home?: { name?: string }; away?: { name?: string } } })?.teams;
    if (teams && (teams.home?.name !== fx.home_name || teams.away?.name !== fx.away_name)) {
      lines.push(`     ⚠ 队名不一致:AF=${teams.home?.name} vs ${teams.away?.name},库内=${fx.home_name} vs ${fx.away_name}`);
    }
  } catch (e) {
    lines.push(`  ⑤ AF 实时阵容拉取失败:${e instanceof Error ? e.message : e}`);
  }
  lines.push("  口径说明:平台水位为净水(港盘),= 书商欧赔 − 1;主指数线 = 两侧净水最均衡的指数线;各市场独立取最新书商,不强制同一书商。");
  return lines.join("\n");
}
