import { beforeAll, describe, expect, it } from "vitest";
import { count, desc } from "drizzle-orm";

import { db } from "@/server/db";
import { runMigrations } from "@/server/db/migrate";
import { providers, rawApiPayloads } from "@/server/db/schema";
import { providerForUrl, recordRawPayload, seedProviders } from "@/server/services/rawArchive";

beforeAll(() => {
  runMigrations();
  seedProviders();
});

describe("原始响应留档（合规铁律）", () => {
  it("seedProviders 幂等", () => {
    const n1 = db.select({ n: count() }).from(providers).get()!.n;
    seedProviders();
    expect(db.select({ n: count() }).from(providers).get()!.n).toBe(n1);
    expect(n1).toBeGreaterThanOrEqual(10);
  });

  it("URL→provider 归属判定", () => {
    expect(providerForUrl("https://v3.football.api-sports.io/odds?fixture=1")).toBe("api_football");
    expect(providerForUrl("https://site.api.espn.com/apis/x")).toBe("espn");
    expect(providerForUrl("https://webapi.sporttery.cn/x")).toBe("sporttery");
    expect(providerForUrl("https://unknown.example.com")).toBeNull();
  });

  it("大正文截断 + 失败响应留错误信息", () => {
    recordRawPayload({ endpoint: "https://api.clubelo.com/2026-06-11", httpStatus: 200, body: "x".repeat(600 * 1024) });
    const row = db.select().from(rawApiPayloads).orderBy(desc(rawApiPayloads.id)).limit(1).get()!;
    expect(row.responseJson).toContain("[truncated");
    expect(row.responseHash).toBeTruthy();
    recordRawPayload({ endpoint: "https://api.clubelo.com/err", httpStatus: 403, body: null, errorMessage: "HTTP 403" });
    const err = db.select().from(rawApiPayloads).orderBy(desc(rawApiPayloads.id)).limit(1).get()!;
    expect(err.errorMessage).toBe("HTTP 403");
  });
});
