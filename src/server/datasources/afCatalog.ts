import { afGetRaw, afHasErrors, type AfRawResponse } from "./apiFootball";

/**
 * API-Football v3 端点全目录（套壳数据中心地基）：
 * 把官方文档（documentation-v3）每一个数据端点登记为可调用条目——一个不能少。
 * 各端点同构（GET + query 参数 + 统一响应信封），故用一张目录 + 一个通用调用器覆盖全部，
 * 而非为每个端点手写解析器（专用解析器仅给引擎/采集用的少数维度保留，见 apiFootball.ts）。
 */

export interface AfParamSpec {
  name: string;
  required?: boolean;
  /** 录入提示（示例值/含义） */
  hint?: string;
}

export interface AfEndpoint {
  /** 唯一调用键（路径去斜杠：fixtures/statistics → fixtures.statistics） */
  key: string;
  /** 分组（中文，UI 归类） */
  group: string;
  /** 中文名 */
  label: string;
  /** v3 路径（base 之后部分，含前导斜杠） */
  path: string;
  /** 该端点允许的 query 参数白名单 */
  params: AfParamSpec[];
  /** 一句话说明 */
  doc: string;
}

/** 通用分页参数（多数列表端点支持） */
const PAGE: AfParamSpec = { name: "page", hint: "页码，默认 1" };
const TZ: AfParamSpec = { name: "timezone", hint: "时区，如 UTC / Asia/Shanghai" };

export const AF_ENDPOINTS: AfEndpoint[] = [
  // ── 账户 ──
  { key: "status", group: "账户", label: "账户与配额", path: "/status", params: [], doc: "订阅套餐、今日已用/上限请求数、可用功能。" },

  // ── 基础维度 ──
  { key: "timezone", group: "基础维度", label: "时区列表", path: "/timezone", params: [], doc: "所有可用时区（赛程时间参数用）。" },
  { key: "countries", group: "基础维度", label: "国家", path: "/countries", params: [{ name: "name" }, { name: "code", hint: "如 GB / FR" }, { name: "search", hint: "≥3 字" }], doc: "所有覆盖国家及其代码/旗帜。" },
  { key: "venues", group: "基础维度", label: "球场", path: "/venues", params: [{ name: "id" }, { name: "name" }, { name: "city" }, { name: "country" }, { name: "search", hint: "≥3 字" }], doc: "球场信息（容量、城市、地址、图片）。" },
  { key: "leagues", group: "基础维度", label: "联赛/杯赛", path: "/leagues", params: [{ name: "id" }, { name: "name" }, { name: "country" }, { name: "code", hint: "如 GB / FR" }, { name: "season", hint: "如 2023" }, { name: "team" }, { name: "type", hint: "league / cup" }, { name: "current", hint: "true / false" }, { name: "search" }, { name: "last" }], doc: "联赛/杯赛及其各赛季覆盖范围。" },
  { key: "leagues.seasons", group: "基础维度", label: "可用赛季", path: "/leagues/seasons", params: [], doc: "全部可查询的赛季年份列表。" },

  // ── 球队 ──
  { key: "teams", group: "球队", label: "球队信息", path: "/teams", params: [{ name: "id" }, { name: "name" }, { name: "league" }, { name: "season", hint: "如 2023" }, { name: "country" }, { name: "code" }, { name: "venue" }, { name: "search", hint: "≥3 字" }], doc: "球队基础资料（成立年份、主场、国家、logo）。" },
  { key: "teams.statistics", group: "球队", label: "球队赛季统计", path: "/teams/statistics", params: [{ name: "league", required: true }, { name: "season", required: true, hint: "如 2023" }, { name: "team", required: true }, { name: "date", hint: "YYYY-MM-DD，截至该日" }], doc: "进失球均值/主客分布/连胜/零封/点球/最大胜/常用阵型等深度统计。" },
  { key: "teams.seasons", group: "球队", label: "球队参赛赛季", path: "/teams/seasons", params: [{ name: "team", required: true }], doc: "某队有数据覆盖的全部赛季。" },
  { key: "teams.countries", group: "球队", label: "球队所属国家", path: "/teams/countries", params: [], doc: "有球队数据的国家清单。" },

  // ── 积分榜 ──
  { key: "standings", group: "积分榜", label: "积分榜", path: "/standings", params: [{ name: "season", required: true, hint: "如 2023" }, { name: "league" }, { name: "team" }], doc: "联赛/小组积分榜（含主客分项、近况、排名变化）。" },

  // ── 赛事 ──
  { key: "fixtures", group: "赛事", label: "赛程/赛果", path: "/fixtures", params: [{ name: "id" }, { name: "ids", hint: "多场，如 1-2-3" }, { name: "live", hint: "all 或 联赛id-…" }, { name: "date", hint: "YYYY-MM-DD" }, { name: "league" }, { name: "season", hint: "如 2023" }, { name: "team" }, { name: "last", hint: "近 N 场" }, { name: "next", hint: "未来 N 场" }, { name: "from", hint: "YYYY-MM-DD" }, { name: "to", hint: "YYYY-MM-DD" }, { name: "round" }, { name: "status", hint: "如 NS / FT / LIVE" }, { name: "venue" }, TZ], doc: "赛程、即时比分、赛果（含状态、场馆、裁判、比分细分）。" },
  { key: "fixtures.rounds", group: "赛事", label: "赛事轮次", path: "/fixtures/rounds", params: [{ name: "league", required: true }, { name: "season", required: true, hint: "如 2023" }, { name: "current", hint: "true / false" }, { name: "dates", hint: "true 附日期" }], doc: "某联赛某赛季的所有轮次名称。" },
  { key: "fixtures.headtohead", group: "赛事", label: "历史交锋 H2H", path: "/fixtures/headtohead", params: [{ name: "h2h", required: true, hint: "队id-队id，如 33-34" }, { name: "date" }, { name: "league" }, { name: "season" }, { name: "last", hint: "近 N 场" }, { name: "next" }, { name: "from" }, { name: "to" }, { name: "status" }, { name: "venue" }, TZ], doc: "两队历史交锋全部赛果。" },
  { key: "fixtures.statistics", group: "赛事", label: "单场技术统计", path: "/fixtures/statistics", params: [{ name: "fixture", required: true }, { name: "team" }, { name: "type", hint: "如 Total Shots / expected_goals" }], doc: "单场两队射门/射正/控球/角球/xG 等技术统计。" },
  { key: "fixtures.events", group: "赛事", label: "单场事件", path: "/fixtures/events", params: [{ name: "fixture", required: true }, { name: "team" }, { name: "player" }, { name: "type", hint: "Goal / Card / subst" }], doc: "进球/红黄牌/换人/VAR 等时间线事件。" },
  { key: "fixtures.lineups", group: "赛事", label: "首发与阵型", path: "/fixtures/lineups", params: [{ name: "fixture", required: true }, { name: "team" }, { name: "player" }, { name: "type" }], doc: "官方首发 11 人、替补、阵型、教练、球衣颜色。" },
  { key: "fixtures.players", group: "赛事", label: "单场球员数据", path: "/fixtures/players", params: [{ name: "fixture", required: true }, { name: "team" }], doc: "单场每名球员评分/射门/传球/过人等表现数据。" },

  // ── 伤停与预测 ──
  { key: "injuries", group: "伤停与预测", label: "伤停名单", path: "/injuries", params: [{ name: "league" }, { name: "season", hint: "如 2023" }, { name: "fixture" }, { name: "team" }, { name: "player" }, { name: "date", hint: "YYYY-MM-DD" }, { name: "ids" }, TZ], doc: "因伤/停赛缺阵球员（按赛事/球队/球员/日期查询）。" },
  { key: "predictions", group: "伤停与预测", label: "蒸馏预测", path: "/predictions", params: [{ name: "fixture", required: true }], doc: "AF 全量库蒸馏的 1X2 概率、期望进球、建议、对比数据（引擎主源）。" },
  { key: "sidelined", group: "伤停与预测", label: "长期缺阵史", path: "/sidelined", params: [{ name: "player" }, { name: "coach" }], doc: "球员/教练历史长期缺阵（伤病/停赛）记录。" },

  // ── 教练 ──
  { key: "coachs", group: "教练", label: "教练", path: "/coachs", params: [{ name: "id" }, { name: "team" }, { name: "search", hint: "≥3 字" }], doc: "主教练资料与执教生涯轨迹。" },

  // ── 球员 ──
  { key: "players", group: "球员", label: "球员赛季统计", path: "/players", params: [{ name: "id" }, { name: "team" }, { name: "league" }, { name: "season", hint: "如 2023" }, { name: "search", hint: "≥4 字" }, PAGE], doc: "球员某赛季在某队/联赛的出场/进球/助攻/评分等统计。" },
  { key: "players.seasons", group: "球员", label: "球员有数据赛季", path: "/players/seasons", params: [{ name: "player" }], doc: "球员有统计覆盖的全部赛季。" },
  { key: "players.profiles", group: "球员", label: "球员档案", path: "/players/profiles", params: [{ name: "player" }, { name: "search", hint: "姓氏" }, PAGE], doc: "球员基本档案（国籍、身高、体重、位置、照片）。" },
  { key: "players.squads", group: "球员", label: "球队名单", path: "/players/squads", params: [{ name: "team" }, { name: "player" }], doc: "球队当前阵容名单（号码、位置、年龄）。" },
  { key: "players.teams", group: "球员", label: "球员效力球队", path: "/players/teams", params: [{ name: "player", required: true }], doc: "某球员效力过的全部球队与赛季。" },
  { key: "players.topscorers", group: "球员", label: "射手榜", path: "/players/topscorers", params: [{ name: "league", required: true }, { name: "season", required: true, hint: "如 2023" }], doc: "联赛进球榜前 20。" },
  { key: "players.topassists", group: "球员", label: "助攻榜", path: "/players/topassists", params: [{ name: "league", required: true }, { name: "season", required: true }], doc: "联赛助攻榜前 20。" },
  { key: "players.topyellowcards", group: "球员", label: "黄牌榜", path: "/players/topyellowcards", params: [{ name: "league", required: true }, { name: "season", required: true }], doc: "联赛黄牌榜前 20。" },
  { key: "players.topredcards", group: "球员", label: "红牌榜", path: "/players/topredcards", params: [{ name: "league", required: true }, { name: "season", required: true }], doc: "联赛红牌榜前 20。" },

  // ── 转会与荣誉 ──
  { key: "transfers", group: "转会与荣誉", label: "转会", path: "/transfers", params: [{ name: "player" }, { name: "team" }], doc: "球员转会记录（日期、转出/转入、类型）。" },
  { key: "trophies", group: "转会与荣誉", label: "荣誉", path: "/trophies", params: [{ name: "player" }, { name: "coach" }], doc: "球员/教练获得的冠军与荣誉。" },

  // ── 赔率（赛前） ──
  { key: "odds", group: "赔率（赛前）", label: "赛前赔率", path: "/odds", params: [{ name: "fixture" }, { name: "league" }, { name: "season", hint: "如 2023" }, { name: "date", hint: "YYYY-MM-DD" }, { name: "bookmaker" }, { name: "bet", hint: "玩法 id" }, PAGE, TZ], doc: "多书商赛前盘口（1X2/亚盘/大小/波胆等全玩法）。" },
  { key: "odds.mapping", group: "赔率（赛前）", label: "赔率覆盖映射", path: "/odds/mapping", params: [PAGE], doc: "有赔率覆盖的赛事/联赛/赛季映射表。" },
  { key: "odds.bookmakers", group: "赔率（赛前）", label: "书商列表", path: "/odds/bookmakers", params: [{ name: "id" }, { name: "search" }], doc: "全部书商及其 id（bet/bookmaker 参数查表用）。" },
  { key: "odds.bets", group: "赔率（赛前）", label: "玩法列表", path: "/odds/bets", params: [{ name: "id" }, { name: "search" }], doc: "全部玩法（bet）及其 id。" },

  // ── 赔率（滚球） ──
  { key: "odds.live", group: "赔率（滚球）", label: "滚球赔率", path: "/odds/live", params: [{ name: "fixture" }, { name: "league" }, { name: "bet", hint: "玩法 id" }], doc: "进行中赛事的实时滚球赔率。" },
  { key: "odds.live.bets", group: "赔率（滚球）", label: "滚球玩法列表", path: "/odds/live/bets", params: [{ name: "id" }, { name: "search" }], doc: "全部滚球玩法及其 id。" },
];

/** 按 key 取端点定义 */
export function afEndpointByKey(key: string): AfEndpoint | undefined {
  return AF_ENDPOINTS.find((e) => e.key === key);
}

/** 目录（按分组聚合，供 UI 渲染） */
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

export interface AfQueryResult {
  key: string;
  path: string;
  url: string;
  ok: boolean;
  results: number;
  paging: { current: number; total: number };
  errors: unknown;
  response: unknown;
}

/** 构造 query 串：仅放行该端点白名单内、有值的参数（防注入额外参数） */
function buildPath(ep: AfEndpoint, params: Record<string, string>): string {
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

/**
 * 通用端点调用（套壳数据中心后端）：按 key 找端点 → 白名单组装参数 → 调 AF →
 * 返回完整信封（含 errors，不抛 AF 业务错，交前端呈现）。必填参数缺失即本地拦截。
 */
export async function runAfEndpoint(key: string, params: Record<string, string>, force = true): Promise<AfQueryResult> {
  const ep = afEndpointByKey(key);
  if (!ep) throw new Error(`未知端点：${key}`);
  const missing = ep.params.filter((p) => p.required && !(params[p.name] ?? "").toString().trim()).map((p) => p.name);
  if (missing.length > 0) throw new Error(`端点「${ep.label}」缺少必填参数：${missing.join("、")}`);
  const path = buildPath(ep, params);
  const raw: AfRawResponse = await afGetRaw(path, force);
  return {
    key,
    path,
    url: path,
    ok: !afHasErrors(raw),
    results: typeof raw.results === "number" ? raw.results : Array.isArray(raw.response) ? raw.response.length : raw.response ? 1 : 0,
    paging: { current: raw.paging?.current ?? 1, total: raw.paging?.total ?? 1 },
    errors: raw.errors ?? null,
    response: raw.response ?? null,
  };
}
