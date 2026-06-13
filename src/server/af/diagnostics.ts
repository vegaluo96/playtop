import { db } from "../db";

export const ODDS_PARSER_VERSION = "odds-adapter-2026-06-13";

export type DiagnosticSeverity = "info" | "warn" | "error";

export interface DiagnosticIssueInput {
  endpoint: "odds" | "odds.live" | "odds.extra" | "predictions";
  fixtureId?: number | null;
  bookmakerId?: number | null;
  betId?: number | null;
  rawValue?: unknown;
  parsedValue?: unknown;
  errorType: string;
  errorReason: string;
  severity?: DiagnosticSeverity;
}

function compact(value: unknown): string {
  if (value == null) return "";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > 700 ? `${text.slice(0, 700)}...` : text;
}

export function recordDiagnosticIssue(issue: DiagnosticIssueInput): void {
  const now = Date.now();
  const dedup = [
    issue.endpoint,
    issue.fixtureId ?? "",
    issue.bookmakerId ?? "",
    issue.betId ?? "",
    issue.errorType,
    compact(issue.rawValue).slice(0, 160),
  ].join("|");
  db()
    .prepare(
      `INSERT OR IGNORE INTO diagnostic_issues
        (source, endpoint, fixture_id, bookmaker_id, bet_id, raw_value, parsed_value, error_type, error_reason, severity, parser_version, created_at, dedup)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      "API_FOOTBALL",
      issue.endpoint,
      issue.fixtureId ?? null,
      issue.bookmakerId ?? null,
      issue.betId ?? null,
      compact(issue.rawValue),
      compact(issue.parsedValue),
      issue.errorType,
      issue.errorReason,
      issue.severity ?? "warn",
      ODDS_PARSER_VERSION,
      now,
      dedup,
    );
}

export function recentDiagnosticIssues(limit = 40): {
  issue_id: number;
  endpoint: string;
  fixture_id: number | null;
  bookmaker_id: number | null;
  bet_id: number | null;
  error_type: string;
  error_reason: string;
  severity: string;
  created_at: number;
  raw_value: string;
  parsed_value: string;
}[] {
  return db()
    .prepare(
      `SELECT issue_id, endpoint, fixture_id, bookmaker_id, bet_id, error_type, error_reason, severity, created_at, raw_value, parsed_value
       FROM diagnostic_issues ORDER BY created_at DESC LIMIT ?`,
    )
    .all(limit) as {
      issue_id: number;
      endpoint: string;
      fixture_id: number | null;
      bookmaker_id: number | null;
      bet_id: number | null;
      error_type: string;
      error_reason: string;
      severity: string;
      created_at: number;
      raw_value: string;
      parsed_value: string;
    }[];
}

export function diagnosticIssueSummary(since = Date.now() - 24 * 3_600_000): {
  byType: { error_type: string; severity: string; n: number; last_at: number }[];
  byFixture: { fixture_id: number | null; n: number; last_at: number }[];
  total: number;
} {
  const d = db();
  const total = (d.prepare("SELECT COUNT(*) n FROM diagnostic_issues WHERE created_at >= ?").get(since) as { n: number } | undefined)?.n ?? 0;
  const byType = d
    .prepare(
      `SELECT error_type, severity, COUNT(*) n, MAX(created_at) last_at
       FROM diagnostic_issues
       WHERE created_at >= ?
       GROUP BY error_type, severity
       ORDER BY n DESC, last_at DESC
       LIMIT 8`,
    )
    .all(since) as { error_type: string; severity: string; n: number; last_at: number }[];
  const byFixture = d
    .prepare(
      `SELECT fixture_id, COUNT(*) n, MAX(created_at) last_at
       FROM diagnostic_issues
       WHERE created_at >= ?
       GROUP BY fixture_id
       ORDER BY n DESC, last_at DESC
       LIMIT 8`,
    )
    .all(since) as { fixture_id: number | null; n: number; last_at: number }[];
  return { byType, byFixture, total };
}
