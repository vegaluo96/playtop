/**
 * 平台数据库:node:sqlite(Node ≥ 22,零外部依赖),WAL,单例。
 * 路径:env PLAYTOP_DB(默认 data/playtop.db;测试用 :memory:)。
 * 表分两域:平台账务(users/ledger/unlocks…)与数据层归档(fixtures_cache/odds_*…)。
 */
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  pass_hash TEXT NOT NULL,
  pts INTEGER NOT NULL DEFAULT 0,
  invite_code TEXT NOT NULL UNIQUE,
  invited_by INTEGER,
  gift_claimed INTEGER NOT NULL DEFAULT 0,
  first_recharged INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  delta INTEGER NOT NULL,
  balance INTEGER NOT NULL,
  note TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ledger_user ON ledger(user_id, id DESC);
CREATE TABLE IF NOT EXISTS unlocks (
  user_id INTEGER NOT NULL,
  fixture_id INTEGER NOT NULL,
  price INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, fixture_id)
);
CREATE TABLE IF NOT EXISTS redeem_codes (
  code TEXT PRIMARY KEY,
  points INTEGER NOT NULL,
  max_uses INTEGER NOT NULL DEFAULT 1,
  used_count INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER
);
CREATE TABLE IF NOT EXISTS redemptions (
  code TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (code, user_id)
);
CREATE TABLE IF NOT EXISTS invites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  inviter_id INTEGER NOT NULL,
  invitee_id INTEGER NOT NULL UNIQUE,
  credited INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_invites_inviter ON invites(inviter_id, created_at);
CREATE TABLE IF NOT EXISTS tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  type TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT '处理中',
  created_at INTEGER NOT NULL
);

-- ── 数据层归档(AF 快照;赛前 odds 仅 1–14 天窗口,必须持续落库)──
CREATE TABLE IF NOT EXISTS fixtures_cache (
  fixture_id INTEGER PRIMARY KEY,
  league_id INTEGER NOT NULL,
  season INTEGER NOT NULL,
  league_name TEXT NOT NULL DEFAULT '',
  round TEXT NOT NULL DEFAULT '',
  kickoff_utc INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'NS',
  elapsed INTEGER,
  home_id INTEGER, home_name TEXT NOT NULL DEFAULT '',
  away_id INTEGER, away_name TEXT NOT NULL DEFAULT '',
  goals_home INTEGER, goals_away INTEGER,
  payload TEXT NOT NULL DEFAULT '{}',
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fixtures_kickoff ON fixtures_cache(kickoff_utc);
CREATE TABLE IF NOT EXISTS odds_raw (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fixture_id INTEGER NOT NULL,
  payload TEXT NOT NULL,
  captured_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_odds_raw_fixture ON odds_raw(fixture_id, captured_at);
CREATE TABLE IF NOT EXISTS af_raw_payloads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL DEFAULT 'API_FOOTBALL',
  endpoint TEXT NOT NULL,
  request_params TEXT NOT NULL DEFAULT '{}',
  response_status INTEGER,
  fixture_id INTEGER,
  bookmaker_id INTEGER,
  bet_id INTEGER,
  parser_version TEXT NOT NULL DEFAULT '',
  payload TEXT NOT NULL,
  fetched_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_af_raw_fixture ON af_raw_payloads(fixture_id, endpoint, fetched_at);
CREATE INDEX IF NOT EXISTS idx_af_raw_endpoint ON af_raw_payloads(endpoint, fetched_at DESC);
CREATE TABLE IF NOT EXISTS odds_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fixture_id INTEGER NOT NULL,
  bookmaker_id INTEGER NOT NULL,
  bookmaker TEXT NOT NULL,
  market TEXT NOT NULL,          -- 'ah' 亚盘 | 'ou' 大小 | 'eu' 胜平负
  line REAL,                     -- ah/ou 盘口;eu 为 NULL
  h REAL, a REAL, d REAL,        -- ah:主/客水 ou:大/小水 eu:主/客/平
  captured_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_odds_snap ON odds_snapshots(fixture_id, market, bookmaker_id, captured_at);
CREATE INDEX IF NOT EXISTS idx_odds_snap_timeline ON odds_snapshots(fixture_id, market, captured_at);
CREATE TABLE IF NOT EXISTS movements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fixture_id INTEGER NOT NULL,
  market TEXT NOT NULL,
  bookmaker TEXT NOT NULL,
  type TEXT NOT NULL,            -- 升盘 | 降盘 | 水位
  from_line REAL, to_line REAL,
  from_h REAL, to_h REAL, from_a REAL, to_a REAL,
  sev INTEGER NOT NULL DEFAULT 0,
  t0 INTEGER NOT NULL,
  t1 INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_movements_time ON movements(t1 DESC);
CREATE INDEX IF NOT EXISTS idx_movements_fixture_time ON movements(fixture_id, t1 DESC);
CREATE TABLE IF NOT EXISTS predictions_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fixture_id INTEGER NOT NULL,
  payload TEXT NOT NULL,
  captured_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pred_snap ON predictions_snapshots(fixture_id, captured_at);
CREATE TABLE IF NOT EXISTS model_records (
  fixture_id INTEGER PRIMARY KEY,
  date TEXT NOT NULL,
  match_name TEXT NOT NULL DEFAULT '',
  pick TEXT NOT NULL DEFAULT '',
  score TEXT,
  hit INTEGER,
  settled_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_model_records_date ON model_records(date);
CREATE TABLE IF NOT EXISTS daily_free (
  date TEXT PRIMARY KEY,
  fixture_id INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS free_fixtures (
  date TEXT NOT NULL,
  fixture_id INTEGER NOT NULL,
  PRIMARY KEY (date, fixture_id)
);
-- 滚球实时帧归档(/odds/live 无书商维度;仅变化帧落库 + 心跳帧)
CREATE TABLE IF NOT EXISTS live_odds_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fixture_id INTEGER NOT NULL,
  market TEXT NOT NULL,          -- 'ah' | 'ou' | 'eu'
  line REAL,
  h REAL, a REAL, d REAL,
  suspended INTEGER NOT NULL DEFAULT 0,
  captured_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_live_odds ON live_odds_snapshots(fixture_id, market, captured_at);
CREATE INDEX IF NOT EXISTS idx_live_odds_market_time ON live_odds_snapshots(market, fixture_id, captured_at DESC);
-- 外部盘口校准样本(百度/足球财富/其它公开源人工或 adapter 导入;不参与业务展示)
CREATE TABLE IF NOT EXISTS odds_external_samples (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fixture_id INTEGER NOT NULL,
  source TEXT NOT NULL,
  market TEXT NOT NULL,          -- 'ah' | 'ou' | 'eu'
  line REAL,
  h REAL, a REAL, d REAL,
  captured_at INTEGER NOT NULL,
  raw TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  UNIQUE (fixture_id, source, market, captured_at)
);
CREATE INDEX IF NOT EXISTS idx_external_odds ON odds_external_samples(fixture_id, market, captured_at);
CREATE TABLE IF NOT EXISTS diagnostic_issues (
  issue_id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  fixture_id INTEGER,
  bookmaker_id INTEGER,
  bet_id INTEGER,
  raw_value TEXT NOT NULL DEFAULT '',
  parsed_value TEXT NOT NULL DEFAULT '',
  error_type TEXT NOT NULL,
  error_reason TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'warn',
  parser_version TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  dedup TEXT NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS idx_diag_created ON diagnostic_issues(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_diag_fixture ON diagnostic_issues(fixture_id, created_at DESC);
-- AI 报告版本历史(report_cache 仍是「最新版」指针)
CREATE TABLE IF NOT EXISTS report_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fixture_id INTEGER NOT NULL,
  ver INTEGER NOT NULL,
  fingerprint TEXT NOT NULL,
  content TEXT NOT NULL,
  model TEXT NOT NULL DEFAULT '',
  tokens INTEGER NOT NULL DEFAULT 0,
  gen_at INTEGER NOT NULL,
  changed TEXT NOT NULL DEFAULT '[]',
  UNIQUE (fixture_id, ver)
);
-- 名称汉化缓存(词典 → 本表 → 原名;DB 永远存原名)
CREATE TABLE IF NOT EXISTS name_zh (
  raw TEXT PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT '',
  zh TEXT NOT NULL,
  src TEXT NOT NULL DEFAULT 'llm',
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS kv (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);

-- ── 管理后台 ──
CREATE TABLE IF NOT EXISTS admins (
  email TEXT PRIMARY KEY,
  role TEXT NOT NULL DEFAULT '运营',      -- 超级管理员 | 运营 | 客服 | 风控
  status TEXT NOT NULL DEFAULT '启用',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(at DESC);
CREATE TABLE IF NOT EXISTS announcements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT '上线中',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS hidden_fixtures (
  fixture_id INTEGER PRIMARY KEY
);
CREATE TABLE IF NOT EXISTS watchlist (             -- legacy:收藏功能已停用,保留表避免旧库迁移破坏
  user_id INTEGER NOT NULL,
  fixture_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, fixture_id)
);
CREATE TABLE IF NOT EXISTS metrics_daily (
  date TEXT NOT NULL,
  k TEXT NOT NULL,
  n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (date, k)
);
CREATE TABLE IF NOT EXISTS endpoint_metrics (
  k TEXT PRIMARY KEY,
  tier TEXT NOT NULL DEFAULT '',
  last_at INTEGER,
  ms INTEGER,
  status TEXT NOT NULL DEFAULT '—'
);
CREATE TABLE IF NOT EXISTS risk_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  type TEXT NOT NULL,
  score INTEGER NOT NULL,
  detail TEXT NOT NULL,
  dedup TEXT NOT NULL UNIQUE,
  user_email TEXT,
  status TEXT NOT NULL DEFAULT '待裁决', -- 待裁决 | 拦截 | 放行
  decided_by TEXT,
  decided_at INTEGER
);
CREATE TABLE IF NOT EXISTS report_cache (
  fixture_id INTEGER PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  content TEXT NOT NULL,
  model TEXT NOT NULL DEFAULT '',
  tokens INTEGER NOT NULL DEFAULT 0,
  gen_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS llm_usage (
  date TEXT PRIMARY KEY,
  tokens INTEGER NOT NULL DEFAULT 0,
  count INTEGER NOT NULL DEFAULT 0,
  hits INTEGER NOT NULL DEFAULT 0,
  fails INTEGER NOT NULL DEFAULT 0
);
`;

/* 已存在库的增量列(无则加,有则忽略) */
const COLUMN_MIGRATIONS: [string, string][] = [
  ["users", "status TEXT NOT NULL DEFAULT '正常'"],
  ["users", "last_seen INTEGER"],
  ["users", "reg_ip TEXT"],
  ["tickets", "reply TEXT"],
  ["tickets", "replied_at INTEGER"],
  ["tickets", "replied_by TEXT"],
  ["ledger", "rmb REAL"],
  ["invites", "ip TEXT"],
  ["redemptions", "ip TEXT"],
  ["movements", "phase TEXT NOT NULL DEFAULT '盘前'"],
  ["model_records", "basis_at INTEGER"],
  ["model_records", "ah_pick TEXT"],
  ["model_records", "ah_hit INTEGER"],
  ["model_records", "ou_pick TEXT"],
  ["model_records", "ou_hit INTEGER"],
];

/* 一次性数据迁移(幂等):daily_free(单场/日)→ free_fixtures(多场/日) */
function dataMigrations(d: DatabaseSync): void {
  d.exec("INSERT OR IGNORE INTO free_fixtures (date, fixture_id) SELECT date, fixture_id FROM daily_free");
}

let _db: DatabaseSync | null = null;

function resolveDbPath(rawPath: string): string {
  if (rawPath === ":memory:" || isAbsolute(rawPath)) return rawPath;
  const cwd = process.cwd();
  const cwdNorm = cwd.replace(/\\/g, "/");
  const candidates: string[] = [];
  const pwd = process.env.PWD;

  if (pwd && pwd !== cwd && !pwd.replace(/\\/g, "/").endsWith("/.next/standalone")) {
    candidates.push(resolve(pwd, rawPath));
  }
  if (cwdNorm.endsWith("/.next/standalone")) {
    candidates.push(resolve(cwd, "..", "..", rawPath));
  }
  candidates.push(resolve(cwd, rawPath));

  return candidates.find((p) => existsSync(p)) ?? candidates[0] ?? rawPath;
}

export function db(): DatabaseSync {
  if (_db) return _db;
  const path = resolveDbPath(process.env.PLAYTOP_DB || "data/playtop.db");
  if (path !== ":memory:") {
    try {
      mkdirSync(dirname(path), { recursive: true });
    } catch {
      /* 已存在 */
    }
  }
  _db = new DatabaseSync(path);
  if (path !== ":memory:") _db.exec("PRAGMA journal_mode = WAL;");
  _db.exec("PRAGMA busy_timeout = 8000;"); // CLI(renorm/体检)与 worker 并发写时等锁而非报 database is locked
  _db.exec(SCHEMA);
  for (const [table, col] of COLUMN_MIGRATIONS) {
    try {
      _db.exec(`ALTER TABLE ${table} ADD COLUMN ${col}`);
    } catch {
      /* 列已存在 */
    }
  }
  dataMigrations(_db);
  return _db;
}

/** 事务包装(node:sqlite 无内置 helper) */
export function tx<T>(fn: () => T): T {
  const d = db();
  d.exec("BEGIN IMMEDIATE");
  try {
    const r = fn();
    d.exec("COMMIT");
    return r;
  } catch (e) {
    d.exec("ROLLBACK");
    throw e;
  }
}

/** 仅测试用:关闭并重置单例(配合 PLAYTOP_DB=:memory:) */
export function _resetDbForTest(): void {
  try {
    _db?.close();
  } catch {
    /* ignore */
  }
  _db = null;
}
