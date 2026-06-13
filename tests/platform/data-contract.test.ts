/**
 * 数据契约机器核查(静态,无需服务):
 *  1) AF 源完整 —— catalog 每个端点都在 registry 分类内,且 registry 无僵尸 key;
 *  2) 覆盖键完整 —— registry/AF 用到的 coverage 都是合法 SourceCoverageKey,且每个 key 有归属;
 *  3) 路由完整 —— src/app/api 下每个用户端 GET 路由都被契约显式归类(漏登记即漂移);
 *  4) F1 —— 前端不得直读 AF 源模块。
 * 任一漂移 → 测试 fail,把"人工对比"变成 CI 闸门。
 */
import { readdirSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { AF_ENDPOINTS } from "../../src/server/af/catalog";
import {
  AF_ENDPOINT_ROLE,
  CONTRACTED_ROUTES,
  NON_AF_SOURCES,
  NON_FITTED_USER_ROUTES,
  USER_ROUTE_CONTRACT,
} from "../../src/server/contract/registry";

const ALL_COVERAGE_KEYS = new Set([
  "afPredictions", "polymarket", "prematchOdds", "liveOdds", "lineups",
  "injuries", "standings", "recentForm", "statistics", "events", "weather",
]);

describe("数据契约 · AF 源完整", () => {
  it("catalog 每个端点都在 registry 分类内", () => {
    const missing = AF_ENDPOINTS.map((e) => e.key).filter((k) => !(k in AF_ENDPOINT_ROLE));
    expect(missing, `新增 AF 端点未在 registry 分类:${missing.join(", ")}`).toEqual([]);
  });

  it("registry 无僵尸端点(都还在 catalog 里)", () => {
    const known = new Set(AF_ENDPOINTS.map((e) => e.key));
    const stale = Object.keys(AF_ENDPOINT_ROLE).filter((k) => !known.has(k));
    expect(stale, `registry 残留已删端点:${stale.join(", ")}`).toEqual([]);
  });

  it("端点数与 catalog 一致(39)", () => {
    expect(Object.keys(AF_ENDPOINT_ROLE).length).toBe(AF_ENDPOINTS.length);
  });
});

describe("数据契约 · 覆盖键完整", () => {
  it("registry 用到的 coverage 都是合法 SourceCoverageKey", () => {
    const bad = Object.values(AF_ENDPOINT_ROLE)
      .map((s) => s.coverage as string | null)
      .filter((c): c is string => c != null && !ALL_COVERAGE_KEYS.has(c));
    expect(bad, `非法覆盖键:${bad.join(", ")}`).toEqual([]);
  });

  it("每个 SourceCoverageKey 都有归属(AF 端点或 NON_AF 外部源)", () => {
    const fromAf = new Set(Object.values(AF_ENDPOINT_ROLE).map((s) => s.coverage).filter(Boolean) as string[]);
    const fromExternal = new Set<string>(NON_AF_SOURCES.map((s) => s.key));
    const orphan = [...ALL_COVERAGE_KEYS].filter((k) => !fromAf.has(k) && !fromExternal.has(k));
    expect(orphan, `覆盖键无来源归属:${orphan.join(", ")}`).toEqual([]);
  });
});

/** 递归列出 src/app/api 下所有 route.ts,映射成 "/xxx" 路由 key */
function listApiRoutes(dir: string, base = ""): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...listApiRoutes(full, `${base}/${name}`));
    else if (name === "route.ts") out.push(base || "/");
  }
  return out;
}

describe("数据契约 · 路由完整", () => {
  const apiDir = join(process.cwd(), "src/app/api");
  const routes = listApiRoutes(apiDir).filter((r) => !r.startsWith("/admin"));

  it("每个用户端路由都被契约显式归类(契约 / 非拟合 二者之一)", () => {
    const unclassified = routes.filter((r) => !CONTRACTED_ROUTES.has(r) && !NON_FITTED_USER_ROUTES.has(r));
    expect(unclassified, `新增路由未归类(补 USER_ROUTE_CONTRACT 或 NON_FITTED_USER_ROUTES):${unclassified.join(", ")}`).toEqual([]);
  });

  it("契约登记的路由都真实存在", () => {
    const actual = new Set(routes);
    const ghost = USER_ROUTE_CONTRACT.map((r) => r.route).filter((r) => !actual.has(r));
    expect(ghost, `契约登记了不存在的路由:${ghost.join(", ")}`).toEqual([]);
  });

  it("每个拟合路由都声明了视图模型(F3:不得自挑主盘/重算)", () => {
    const noVm = USER_ROUTE_CONTRACT.filter((r) => r.fitted.length > 0 && r.viewModels.length === 0).map((r) => r.route);
    expect(noVm, `拟合路由缺 viewModels:${noVm.join(", ")}`).toEqual([]);
  });
});

/** 递归收集 .tsx 文件 */
function listTsx(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...listTsx(full));
    else if (name.endsWith(".tsx")) out.push(full);
  }
  return out;
}

describe("数据契约 · F1 前端不读 AF 源", () => {
  it("前端组件/页面不得 import AF 客户端或目录模块", () => {
    const files = [
      ...listTsx(join(process.cwd(), "src/app")),
      ...listTsx(join(process.cwd(), "src/components")),
    ];
    const offenders = files.filter((f) => {
      const src = readFileSync(f, "utf8");
      return /from\s+["']@\/server\/af\/(client|catalog|store|live-store|normalize|odds-quality)["']/.test(src);
    });
    expect(offenders, `前端直读 AF 源模块(应只消费 /api 视图模型):\n${offenders.join("\n")}`).toEqual([]);
  });
});
