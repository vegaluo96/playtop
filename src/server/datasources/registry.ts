import { getConfig, type DatasourcesConfig } from "../lib/config";
import { probeApiFootball } from "./apiFootball";
import { politeFetchText } from "./httpCache";
import { fetchSporttery } from "./sporttery";
import { parsePolymarketSearch } from "./polymarket";
import { fetchEspnScoreboard } from "./espn";
import { fetchClubElo, fetchEloRatings } from "./externalRatings";
import { parseManifoldSearch } from "./predictionMarkets";
import { fetchUnderstatXg } from "./understat";
import { parseGoalscorers } from "./githubIntl";

/**
 * 数据源因子注册表：后台因子表与「数据源体检」的单一事实来源。
 * 每源：标识、名称、注释（喂什么维度）、配置开关键、模型权重说明、probe（真实拉取+解析样例）。
 * 健康账本（source_health）记录每源成败；连败达阈值自动停用（采集跳过），体检成功复活。
 */

const UA = {
  "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126.0",
  accept: "application/json",
};

export interface SourceEntry {
  /** 健康账本主键，与 SnapshotSource 对齐 */
  key: string;
  label: string;
  /** 注释：这个因子喂什么维度、怎么进模型 */
  note: string;
  /** 权重说明：进引擎的写权重（书商权重/集成成员），展示维度写"展示/事实" */
  weightNote: string;
  configKey: keyof DatasourcesConfig | null;
  probe: () => Promise<string>;
}

export const SOURCE_REGISTRY: SourceEntry[] = [
  {
    key: "api_football",
    label: "API-Football（付费主源）",
    note: "大书商盘口（bet365/Pinnacle/威廉希尔等，1X2/亚盘/大小/波胆）+ 官方首发 + 伤停 + 权威赛果；key 由服务器 env API_FOOTBALL_KEY 提供",
    weightNote: "书商权重按各家名称走 bookWeights（bet365 1.2 / Pinnacle 1.3 / 威廉希尔 1.1）；赛果权威级",
    configKey: "apiFootballEnabled",
    probe: () => probeApiFootball(),
  },
  {
    key: "football_data_couk",
    label: "football-data.co.uk",
    note: "联赛历史赛果+收盘赔率+射门统计（模型训练底座）；赛程与即时盘口（书商维度）；联赛赛果权威结算",
    weightNote: "书商权重 1.0；历史数据直接喂 DC/Elo",
    configKey: null,
    probe: async () => {
      const cfg = getConfig("datasources");
      const { body } = await politeFetchText(`${cfg.csvBase}/fixtures.csv`, true);
      return `fixtures.csv ${body.split("\n").length} 行`;
    },
  },
  {
    key: "sporttery",
    label: "中国竞彩（官方）",
    note: "胜平负/让球/总进球/波胆四玩法盘口（书商维度+比分市场对照）",
    weightNote: "书商权重 0.9（官方彩票水位较高）",
    configKey: "sportteryEnabled",
    probe: async () => {
      const rows = await fetchSporttery();
      return `在售 ${rows.length} 场，世界杯 ${rows.filter((r) => /世界杯/.test(r.league)).length} 场，波胆 ${rows.filter((r) => r.correctScores.length > 0).length} 场`;
    },
  },
  {
    key: "polymarket",
    label: "Polymarket（预测市场）",
    note: "真实资金预测市场三向价格（≈无水概率，书商维度）",
    weightNote: "书商权重 0.9",
    configKey: "polymarketEnabled",
    probe: async () => {
      const { body } = await politeFetchText("https://gamma-api.polymarket.com/public-search?q=world%20cup&limit_per_type=10", true, UA);
      return `解析到 ${parsePolymarketSearch(body).length} 个市场`;
    },
  },
  {
    key: "espn",
    label: "ESPN（隐藏 API）",
    note: "权威赛果（FT 分钟级，直接结算）+ 赛程核对 + ESPN BET 盘口（书商维度）",
    weightNote: "赛果权威级（等同官方 CSV）；书商权重 1.0",
    configKey: "espnEnabled",
    probe: async () => {
      const events = await fetchEspnScoreboard("fifa.world", undefined, true);
      return `世界杯 scoreboard ${events.length} 场（含赔率 ${events.filter((e) => e.odds).length} 场）`;
    },
  },
  {
    key: "eloratings",
    label: "eloratings.net（国家队 Elo）",
    note: "国家队外部 Elo 评级 → 外部评级维度（研报事实+工作台对照，不进集成）",
    weightNote: "展示/事实维度（独立第三方评级，与自有 Elo 互证）",
    configKey: "eloRatingsEnabled",
    probe: async () => `解析到 ${(await fetchEloRatings(true)).length} 队`,
  },
  {
    key: "clubelo",
    label: "ClubElo（俱乐部 Elo）",
    note: "俱乐部外部 Elo 评级 → 外部评级维度（联赛场次）",
    weightNote: "展示/事实维度",
    configKey: "clubEloEnabled",
    probe: async () => `解析到 ${(await fetchClubElo(new Date().toISOString().slice(0, 10), true)).length} 队`,
  },
  {
    key: "manifold",
    label: "Manifold（模拟盘预测市场）",
    note: "模拟资金预测市场三向价格（书商维度，标参考盘）",
    weightNote: "书商权重 0.3；不进最优价/价值/Kelly 口径",
    configKey: "manifoldEnabled",
    probe: async () => {
      const { body } = await politeFetchText("https://api.manifold.markets/v0/search-markets?term=world%20cup&limit=10", true, UA);
      return `解析到 ${parseManifoldSearch(body).length} 个市场`;
    },
  },
  {
    key: "smarkets",
    label: "Smarkets（交易所）",
    note: "交易所撮合锐价三向盘口（书商维度，低水位真实盘）",
    weightNote: "书商权重 1.3（锐价基准）",
    configKey: "smarketsEnabled",
    probe: async () => {
      const { body } = await politeFetchText(
        "https://api.smarkets.com/v3/events/?state=upcoming&type_domain=football&limit=10&sort=start_datetime",
        true,
        UA,
      );
      const n = ((JSON.parse(body) as { events?: unknown[] }).events ?? []).length;
      return `即将开赛事件 ${n} 个`;
    },
  },
  {
    key: "understat",
    label: "Understat（xG）",
    note: "五大联赛球队赛季 xG/xGA → 外部评级维度",
    weightNote: "展示/事实维度",
    configKey: "understatEnabled",
    probe: async () => `EPL 解析到 ${(await fetchUnderstatXg("E0", true)).length} 队 xG`,
  },
  {
    key: "github",
    label: "martj42 数据集（GitHub）",
    note: "国际赛射手榜/点球主罚/点球大战史 → 球员数据维度（研报事实）",
    weightNote: "展示/事实维度",
    configKey: "githubIntlEnabled",
    probe: async () => {
      const { body } = await politeFetchText(
        "https://raw.githubusercontent.com/martj42/international_results/master/goalscorers.csv",
        true,
      );
      return `射手记录 ${parseGoalscorers(body).length} 条`;
    },
  },
  {
    key: "open_meteo",
    label: "open-meteo（天气）",
    note: "场馆地理编码 + 开球时段天气 → 天气维度（进情境修正系数）",
    weightNote: "情境修正因子（确定性系数表）",
    configKey: null,
    probe: async () => {
      const { body } = await politeFetchText("https://geocoding-api.open-meteo.com/v1/search?name=Wembley&count=1", true, UA);
      return ((JSON.parse(body) as { results?: unknown[] }).results ?? []).length > 0 ? "地理编码正常" : "无结果";
    },
  },
];
