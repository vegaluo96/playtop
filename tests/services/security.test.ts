import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { runMigrations } from "@/server/db/migrate";
import { _resetRateLimitForTest, clientIp, rateLimitClear, rateLimitHit } from "@/server/lib/rateLimit";

beforeAll(() => {
  process.env.FAKE_NOW = String(Date.UTC(2026, 5, 12, 0, 0));
  runMigrations();
});
afterEach(() => {
  _resetRateLimitForTest();
  delete process.env.FAKE_NOW;
  process.env.FAKE_NOW = String(Date.UTC(2026, 5, 12, 0, 0));
});

describe("登录限速令牌桶", () => {
  it("窗口内第 6 次失败被拒，成功清零后重新计数", () => {
    const key = "login:1.2.3.4:admin";
    for (let i = 0; i < 5; i++) expect(rateLimitHit(key, 5, 60_000).ok).toBe(true);
    const sixth = rateLimitHit(key, 5, 60_000);
    expect(sixth.ok).toBe(false);
    expect(sixth.retryAfterSec).toBeGreaterThan(0);
    rateLimitClear(key); // 登录成功
    expect(rateLimitHit(key, 5, 60_000).ok).toBe(true); // 计数已重置
  });

  it("不同 key（IP/用户名）互不影响", () => {
    for (let i = 0; i < 6; i++) rateLimitHit("login:a:u1", 5, 60_000);
    expect(rateLimitHit("login:a:u1", 5, 60_000).ok).toBe(false);
    expect(rateLimitHit("login:b:u1", 5, 60_000).ok).toBe(true);
    expect(rateLimitHit("login:a:u2", 5, 60_000).ok).toBe(true);
  });

  it("窗口过期后重置（FAKE_NOW 推进）", () => {
    const t0 = Date.UTC(2026, 5, 12, 0, 0);
    for (let i = 0; i < 6; i++) rateLimitHit("login:a:u", 5, 60_000);
    expect(rateLimitHit("login:a:u", 5, 60_000).ok).toBe(false);
    process.env.FAKE_NOW = String(t0 + 61_000);
    expect(rateLimitHit("login:a:u", 5, 60_000).ok).toBe(true);
  });

  it("clientIp 取 x-forwarded-for 第一跳", () => {
    const req = new Request("http://x", { headers: { "x-forwarded-for": "9.9.9.9, 10.0.0.1" } });
    expect(clientIp(req)).toBe("9.9.9.9");
    expect(clientIp(new Request("http://x"))).toBe("unknown");
  });
});

describe("verifyAnalysis 仅对已发布版本开放", () => {
  it("未发布草稿按不存在处理（防 ID 遍历枚举）", async () => {
    const { createManualMatch, transitionMatch } = await import("@/server/services/matchesService");
    const { insertSnapshot } = await import("@/server/services/snapshots");
    const { analyzeMatch, latestAnalysis } = await import("@/server/services/analyze");
    const { verifyAnalysis, publishAnalysisRow } = await import("@/server/services/publish");

    const id = createManualMatch({ leagueCode: "WC2026", homeName: "Spain", awayName: "Japan", kickoffAt: Date.now() + 6 * 3_600_000, neutral: true });
    insertSnapshot(id, "odds", "manual", { bookmaker: "bet365", oneXTwo: { home: 1.8, draw: 3.6, away: 4.6 }, ou: [], ah: [], capturedAt: Date.now() });
    transitionMatch(id, "collecting");
    transitionMatch(id, "ready");
    await analyzeMatch(id);
    const a = latestAnalysis(id)!;
    // 草稿（未发布）→ 抛 404
    expect(() => verifyAnalysis(a.id)).toThrow();
    // 发布后 → 正常返回校验结果
    publishAnalysisRow(a.id, {});
    const r = verifyAnalysis(a.id);
    expect(r.analysisId).toBe(a.id);
    expect(r.valid).toBe(true);
  });
});
