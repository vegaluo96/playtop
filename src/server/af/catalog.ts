import { afGet, afHasErrors, type AfEnvelope } from "./client";

/**
 * API-Football v3 端点全目录：官方文档（documentation-v3）每个数据端点登记一条，
 * 一个不能少。所有端点同构（GET + query + 统一信封），用目录 + 通用调用器全覆盖；
 * 产品级的专用解析/聚合等新设计定稿后再叠加在这层之上。
 */

export interface AfParamSpec {
  name: string;
  required?: boolean;
  hint?: string;
}

export interface AfEndpoint {
  /** 唯一键（路径斜杠转点：fixtures/statistics → fixtures.statistics） */
  key: string;
  group: string;
  label: string;
  path: string;
  params: AfParamSpec[];
  doc: string;
}

const PAGE: AfParamSpec = { name: "page", hint: "页码，默认 1" };
const TZ: AfParamSpec = { name: "timezone", hint: "如 UTC / Asia/Shanghai" };

export const AF_ENDPOINTS: AfEndpoint[] = [
  // ── 账户 ──
  { key: "status", group: "账户", label: "账户与配额", path: "/status", params: [], doc: "订阅套餐、今日已用/上限请求数。" },

  // ── 基础维度 ──
  { key: "timezone", group: "基础维度", label: "时区列表", path: "/timezone", params: [], doc: "所有可用时区（赛程时间参数用）。" },
  { key: "countries", group: "基础维度", label: "国家", path: "/countries", params: [{ name: "name" }, { name: "code", hint: "如 GB / FR" }, { name: "search", hint: "≥3 字" }], doc: "覆盖国家及代码/旗帜。" },
  { key: "venues", group: "基础维度", label: "球场", path: "/venues", params: [{ name: "id" }, { name: "name" }, { name: "city" }, { name: "country" }, { name: "search", hint: "≥3 字" }], doc: "球场容量/城市/地址/图片。" },
  { key: "leagues", group: "基础维度", label: "联赛/杯赛", path: "/leagues", params: [{ name: "id" }, { name: "name" }, { name: "country" }, { name: "code" }, { name: "season", hint: "如 2025" }, { name: "team" }, { name: "type", hint: "league / cup" }, { name: "current", hint: "true / false" }, { name: "search" }, { name: "last" }], doc: "联赛/杯赛及各赛季数据覆盖范围。" },
  { key: "leagues.seasons", group: "基础维度", label: "可用赛季", path: "/leagues/seasons", params: [], doc: "全部可查询赛季年份。" },

  // ── 球队 ──
  { key: "teams", group: "球队", label: "球队信息", path: "/teams", params: [{ name: "id" }, { name: "name" }, { name: "league" }, { name: "season" }, { name: "country" }, { name: "code" }, { name: "venue" }, { name: "search", hint: "≥3 字" }], doc: "球队资料（成立/主场/国家/logo）。" },
  { key: "teams.statistics", group: "球队", label: "球队赛季统计", path: "/teams/statistics", params: [{ name: "league", required: true }, { name: "season", required: true }, { name: "team", required: true }, { name: "date", hint: "YYYY-MM-DD 截至该日" }], doc: "进失球/主客分布/连胜/零封/点球/阵型等深度统计。" },
  { key: "teams.seasons", group: "球队", label: "球队参赛赛季", path: "/teams/seasons", params: [{ name: "team", required: true }], doc: "某队有数据覆盖的赛季。" },
  { key: "teams.countries", group: "球队", label: "球队所属国家", path: "/teams/countries", params: [], doc: "有球队数据的国家清单。" },

  // ── 积分榜 ──
  { key: "standings", group: "积分榜", label: "积分榜", path: "/standings", params: [{ name: "season", required: true }, { name: "league" }, { name: "team" }], doc: "联赛/小组积分榜（主客分项/近况/排名）。" },

  // ── 赛事 ──
  { key: "fixtures", group: "赛事", label: "赛程/赛果", path: "/fixtures", params: [{ name: "id" }, { name: "ids", hint: "1-2-3 多场" }, { name: "live", hint: "all 或 联赛id-…" }, { name: "date", hint: "YYYY-MM-DD" }, { name: "league" }, { name: "season" }, { name: "team" }, { name: "last", hint: "近 N 场" }, { name: "next", hint: "未来 N 场" }, { name: "from" }, { name: "to" }, { name: "round" }, { name: "status", hint: "NS / FT / LIVE…" }, { name: "venue" }, TZ], doc: "赛程、即时比分、赛果（状态/场馆/裁判/比分细分）。" },
  { key: "fixtures.rounds", group: "赛事", label: "赛事轮次", path: "/fixtures/rounds", params: [{ name: "league", required: true }, { name: "season", required: true }, { name: "current", hint: "true / false" }, { name: "dates", hint: "true 附日期" }], doc: "某联赛某赛季全部轮次。" },
  { key: "fixtures.headtohead", group: "赛事", label: "历史交锋 H2H", path: "/fixtures/headtohead", params: [{ name: "h2h", required: true, hint: "队id-队id" }, { name: "date" }, { name: "league" }, { name: "season" }, { name: "last" }, { name: "next" }, { name: "from" }, { name: "to" }, { name: "status" }, { name: "venue" }, TZ], doc: "两队历史交锋赛果。" },
  { key: "fixtures.statistics", group: "赛事", label: "单场技术统计", path: "/fixtures/statistics", params: [{ name: "fixture", required: true }, { name: "team" }, { name: "type", hint: "如 Total Shots / expected_goals" }], doc: "射门/射正/控球/角球/xG 等单场统计。" },
  { key: "fixtures.events", group: "赛事", label: "单场事件", path: "/fixtures/events", params: [{ name: "fixture", required: true }, { name: "team" }, { name: "player" }, { name: "type", hint: "Goal / Card / subst" }], doc: "进球/红黄牌/换人/VAR 时间线。" },
  { key: "fixtures.lineups", group: "赛事", label: "首发与阵型", path: "/fixtures/lineups", params: [{ name: "fixture", required: true }, { name: "team" }, { name: "player" }, { name: "type" }], doc: "首发 11 人/替补/阵型/教练/球衣色。" },
  { key: "fixtures.players", group: "赛事", label: "单场球员数据", path: "/fixtures/players", params: [{ name: "fixture", required: true }, { name: "team" }], doc: "单场每名球员评分/射门/传球/过人。" },

  // ── 伤停与预测 ──
  { key: "injuries", group: "伤停与预测", label: "伤停名单", path: "/injuries", params: [{ name: "league" }, { name: "season" }, { name: "fixture" }, { name: "team" }, { name: "player" }, { name: "date" }, { name: "ids" }, TZ], doc: "伤停缺阵球员（按赛事/球队/球员/日期）。" },
  { key: "predictions", group: "伤停与预测", label: "蒸馏预测", path: "/predictions", params: [{ name: "fixture", required: true }], doc: "AF 全量库蒸馏：1X2 概率/期望进球/建议/对比。" },
  { key: "sidelined", group: "伤停与预测", label: "长期缺阵史", path: "/sidelined", params: [{ name: "player" }, { name: "coach" }], doc: "球员/教练历史缺阵记录。" },

  // ── 教练 ──
  { key: "coachs", group: "教练", label: "教练", path: "/coachs", params: [{ name: "id" }, { name: "team" }, { name: "search", hint: "≥3 字" }], doc: "主教练资料与执教轨迹。" },

  // ── 球员 ──
  { key: "players", group: "球员", label: "球员赛季统计", path: "/players", params: [{ name: "id" }, { name: "team" }, { name: "league" }, { name: "season" }, { name: "search", hint: "≥4 字" }, PAGE], doc: "球员赛季出场/进球/助攻/评分统计。" },
  { key: "players.seasons", group: "球员", label: "球员有数据赛季", path: "/players/seasons", params: [{ name: "player" }], doc: "球员有统计覆盖的赛季。" },
  { key: "players.profiles", group: "球员", label: "球员档案", path: "/players/profiles", params: [{ name: "player" }, { name: "search", hint: "姓氏" }, PAGE], doc: "国籍/身高/体重/位置/照片。" },
  { key: "players.squads", group: "球员", label: "球队名单", path: "/players/squads", params: [{ name: "team" }, { name: "player" }], doc: "当前阵容名单（号码/位置/年龄）。" },
  { key: "players.teams", group: "球员", label: "球员效力球队", path: "/players/teams", params: [{ name: "player", required: true }], doc: "效力过的球队与赛季。" },
  { key: "players.topscorers", group: "球员", label: "射手榜", path: "/players/topscorers", params: [{ name: "league", required: true }, { name: "season", required: true }], doc: "联赛进球榜前 20。" },
  { key: "players.topassists", group: "球员", label: "助攻榜", path: "/players/topassists", params: [{ name: "league", required: true }, { name: "season", required: true }], doc: "联赛助攻榜前 20。" },
  { key: "players.topyellowcards", group: "球员", label: "黄牌榜", path: "/players/topyellowcards", params: [{ name: "league", required: true }, { name: "season", required: true }], doc: "联赛黄牌榜前 20。" },
  { key: "players.topredcards", group: "球员", label: "红牌榜", path: "/players/topredcards", params: [{ name: "league", required: true }, { name: "season", required: true }], doc: "联赛红牌榜前 20。" },

  // ── 转会与荣誉 ──
  { key: "transfers", group: "转会与荣誉", label: "转会", path: "/transfers", params: [{ name: "player" }, { name: "team" }], doc: "转会记录（日期/双方/类型）。" },
  { key: "trophies", group: "转会与荣誉", label: "荣誉", path: "/trophies", params: [{ name: "player" }, { name: "coach" }], doc: "球员/教练冠军荣誉。" },

  // ── 赔率（赛前） ──
  { key: "odds", group: "赔率（赛前）", label: "赛前赔率", path: "/odds", params: [{ name: "fixture" }, { name: "league" }, { name: "season" }, { name: "date" }, { name: "bookmaker" }, { name: "bet", hint: "玩法 id" }, PAGE, TZ], doc: "多书商赛前盘口（1X2/亚盘/大小/波胆全玩法）。" },
  { key: "odds.mapping", group: "赔率（赛前）", label: "赔率覆盖映射", path: "/odds/mapping", params: [PAGE], doc: "有赔率覆盖的赛事映射表。" },
  { key: "odds.bookmakers", group: "赔率（赛前）", label: "书商列表", path: "/odds/bookmakers", params: [{ name: "id" }, { name: "search" }], doc: "全部书商及 id。" },
  { key: "odds.bets", group: "赔率（赛前）", label: "玩法列表", path: "/odds/bets", params: [{ name: "id" }, { name: "search" }], doc: "全部玩法（bet）及 id。" },

  // ── 赔率（滚球） ──
  { key: "odds.live", group: "赔率（滚球）", label: "滚球赔率", path: "/odds/live", params: [{ name: "fixture" }, { name: "league" }, { name: "bet", hint: "玩法 id" }], doc: "进行中赛事实时滚球赔率。" },
  { key: "odds.live.bets", group: "赔率（滚球）", label: "滚球玩法列表", path: "/odds/live/bets", params: [{ name: "id" }, { name: "search" }], doc: "全部滚球玩法及 id。" },
];

export function afEndpointByKey(key: string): AfEndpoint | undefined {
  return AF_ENDPOINTS.find((e) => e.key === key);
}

/** 按分组聚合（UI/CLI 目录渲染用） */
export function afCatalogGrouped(): { group: string; endpoints: Omit<AfEndpoint, "group">[] }[] {
  const order: string[] = [];
  const map = new Map<string, Omit<AfEndpoint, "group">[]>();
  for (const e of AF_ENDPOINTS) {
    if (!map.has(e.group)) {
      map.set(e.group, []);
      order.push(e.group);
    }
    const { group: _g, ...rest } = e;
    map.get(e.group)!.push(rest);
  }
  return order.map((group) => ({ group, endpoints: map.get(group)! }));
}

/** 白名单组装 query：仅放行该端点声明过、且有值的参数 */
export function buildAfPath(ep: AfEndpoint, params: Record<string, string>): string {
  const allowed = new Set(ep.params.map((p) => p.name));
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    const val = (v ?? "").toString().trim();
    if (!val || !allowed.has(k)) continue;
    usp.set(k, val);
  }
  const qs = usp.toString();
  return qs ? `${ep.path}?${qs}` : ep.path;
}

export interface AfQueryResult {
  key: string;
  path: string;
  ok: boolean;
  results: number;
  paging: { current: number; total: number };
  errors: unknown;
  response: unknown;
}

/**
 * 通用端点调用：按 key 查目录 → 必填本地拦截 → 白名单组参 → 调 AF →
 * 返回完整信封（不吞 errors，交调用方/界面呈现）。
 */
export async function runAfEndpoint(key: string, params: Record<string, string>, force = true): Promise<AfQueryResult> {
  const ep = afEndpointByKey(key);
  if (!ep) throw new Error(`未知端点：${key}`);
  const missing = ep.params.filter((p) => p.required && !(params[p.name] ?? "").toString().trim()).map((p) => p.name);
  if (missing.length > 0) throw new Error(`端点「${ep.label}」缺少必填参数：${missing.join("、")}`);
  const path = buildAfPath(ep, params);
  const env: AfEnvelope = await afGet(path, { force });
  return {
    key,
    path,
    ok: !afHasErrors(env),
    results: typeof env.results === "number" ? env.results : Array.isArray(env.response) ? env.response.length : env.response ? 1 : 0,
    paging: { current: env.paging?.current ?? 1, total: env.paging?.total ?? 1 },
    errors: env.errors ?? null,
    response: env.response ?? null,
  };
}
