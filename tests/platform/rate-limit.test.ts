/** 限速与登录锁定:令牌桶 / 5 次失败锁 15 分钟 / 同源断言 / 风控入列 */
import { beforeEach, describe, expect, it } from "vitest";
import type { NextRequest } from "next/server";

process.env.PLAYTOP_DB = ":memory:";

import { db, _resetDbForTest } from "../../src/server/db";
import {
  _resetRateLimitForTest,
  clearLoginFails,
  loginLocked,
  rateLimit,
  recordLoginFail,
  sameOrigin,
} from "../../src/server/platform/rate-limit";

const req = (headers: Record<string, string> = {}) =>
  ({ headers: { get: (k: string) => headers[k.toLowerCase()] ?? null } }) as unknown as NextRequest;

beforeEach(() => {
  _resetDbForTest();
  db();
  _resetRateLimitForTest();
});

describe("rateLimit(令牌桶)", () => {
  it("窗口内放行 n 次,第 n+1 次拒绝并写风控", () => {
    const r = req({ "x-forwarded-for": "1.2.3.4" });
    for (let i = 0; i < 5; i++) expect(rateLimit(r, "t", 5, 60_000)).toBe(true);
    expect(rateLimit(r, "t", 5, 60_000)).toBe(false);
    const risk = db().prepare("SELECT type FROM risk_queue").all() as { type: string }[];
    expect(risk.some((x) => x.type.includes("限速"))).toBe(true);
  });

  it("不同 IP 互不影响", () => {
    for (let i = 0; i < 5; i++) rateLimit(req({ "x-forwarded-for": "1.1.1.1" }), "t", 5, 60_000);
    expect(rateLimit(req({ "x-forwarded-for": "2.2.2.2" }), "t", 5, 60_000)).toBe(true);
  });
});

describe("登录锁定", () => {
  it("15 分钟内 5 次失败 → 锁定;成功后清零", () => {
    for (let i = 0; i < 4; i++) recordLoginFail("a@b.com", "1.1.1.1");
    expect(loginLocked("a@b.com", "1.1.1.1")).toBe(false);
    recordLoginFail("a@b.com", "1.1.1.1");
    expect(loginLocked("a@b.com", "1.1.1.1")).toBe(true);
    expect(loginLocked("a@b.com", "9.9.9.9")).toBe(false); // 其他 IP 不连坐
    clearLoginFails("a@b.com", "1.1.1.1");
    expect(loginLocked("a@b.com", "1.1.1.1")).toBe(false);
    const risk = db().prepare("SELECT type FROM risk_queue").all() as { type: string }[];
    expect(risk.some((x) => x.type === "登录锁定")).toBe(true);
  });
});

describe("sameOrigin", () => {
  it("本站/admin/www/localhost 放行,外站拒绝,无头放行", () => {
    expect(sameOrigin(req({ origin: "https://play.top" }), "play.top")).toBe(true);
    expect(sameOrigin(req({ origin: "https://admin.play.top" }), "play.top")).toBe(true);
    expect(sameOrigin(req({ referer: "http://localhost:3000/x" }), "play.top")).toBe(true);
    expect(sameOrigin(req({ origin: "https://evil.com" }), "play.top")).toBe(false);
    expect(sameOrigin(req(), "play.top")).toBe(true);
  });
});
