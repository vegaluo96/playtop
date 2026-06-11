/**
 * 抓取分层调度(设计稿对接注释,逐字实现):
 *   >12h: 低频巡检(3h) | 12–6h: 每60min | 6–1h: 每30min
 *   1h–30m: 每10min | 30–5m: 每5min | 5m–开球: 每1min | 滚球: 每1min
 * 纯函数,worker 与前端「数据刷新规则」弹层共用同一张表。
 */

export interface Tier {
  idx: number;
  label: string;
  freq: string;
  intervalMs: number;
}

const H = 3_600_000;
const M = 60_000;

export const TIERS: Tier[] = [
  { idx: 0, label: "赛前 12 小时以上", freq: "低频巡检", intervalMs: 3 * H },
  { idx: 1, label: "赛前 12 – 6 小时", freq: "每 60 分钟", intervalMs: 60 * M },
  { idx: 2, label: "赛前 6 – 1 小时", freq: "每 30 分钟", intervalMs: 30 * M },
  { idx: 3, label: "赛前 1 小时 – 30 分钟", freq: "每 10 分钟", intervalMs: 10 * M },
  { idx: 4, label: "赛前 30 – 5 分钟", freq: "每 5 分钟", intervalMs: 5 * M },
  { idx: 5, label: "赛前 5 分钟 – 开球", freq: "每 1 分钟", intervalMs: 1 * M },
  { idx: 6, label: "滚球进行中", freq: "每 1 分钟 · 接口最高频率", intervalMs: 1 * M },
];

/** 间隔毫秒 → 人话频率(后台「数据与模型监控」可调档,用户端展示必须与实际生效值同源) */
export function fmtFreq(ms: number): string {
  if (ms < M) return `每 ${Math.round(ms / 1000)} 秒`;
  if (ms < H) return `每 ${Math.round(ms / M)} 分钟`;
  const h = Math.round((ms / H) * 10) / 10;
  return `每 ${h % 1 === 0 ? h.toFixed(0) : h} 小时`;
}

/** 「数据刷新规则」表里某档的频率文案(移动端弹层与桌面弹窗共用) */
export function tierFreqText(idx: number, ms: number): string {
  if (idx === 0) return `低频巡检 · ${fmtFreq(ms)}`;
  if (idx === 6) return `${fmtFreq(ms)} · 接口最高频率`;
  return fmtFreq(ms);
}

export const LIVE_STATUSES = new Set(["1H", "HT", "2H", "ET", "BT", "P", "INT", "LIVE"]);
export const FINISHED_STATUSES = new Set(["FT", "AET", "PEN", "AWD", "WO"]);

export function isLive(status: string): boolean {
  return LIVE_STATUSES.has(status);
}
export function isFinished(status: string): boolean {
  return FINISHED_STATUSES.has(status);
}

/** 比赛当前所处档位 */
export function tierFor(kickoffUtcMs: number, nowMs: number, status: string): Tier {
  if (isLive(status)) return TIERS[6];
  if (isFinished(status)) return TIERS[0];
  const mins = (kickoffUtcMs - nowMs) / M;
  if (mins <= 0) return TIERS[6]; // 名义已开球但状态未翻转,按滚球频率盯
  if (mins > 720) return TIERS[0];
  if (mins > 360) return TIERS[1];
  if (mins > 60) return TIERS[2];
  if (mins > 30) return TIERS[3];
  if (mins > 5) return TIERS[4];
  return TIERS[5];
}

/** 详情页提示行:把当前档位翻译给用户(设计稿 freshFor)。intervals 传后台实际生效档位(cfgTierIntervals),不传则用静态默认 */
export function freshLine(kickoffUtcMs: number, nowMs: number, status: string, intervals?: number[]): { idx: number; line: string; freq: string } {
  const iv = (i: number) => intervals?.[i] ?? TIERS[i].intervalMs;
  if (isLive(status)) return { idx: 6, line: `滚球数据 · ${fmtFreq(iv(6))}刷新`, freq: fmtFreq(iv(6)) };
  if (isFinished(status)) return { idx: 0, line: "已完场 · 数据已固化", freq: "—" };
  const t = tierFor(kickoffUtcMs, nowMs, status);
  const mins = Math.max(0, Math.round((kickoffUtcMs - nowMs) / M));
  const label = mins >= 60 ? `${Math.round(mins / 6) / 10} 小时` : `${mins} 分钟`;
  return {
    idx: t.idx,
    line: `距开赛约 ${label}` + (t.idx === 0 ? ` · 低频巡检中(${fmtFreq(iv(0))})` : ` · ${fmtFreq(iv(t.idx))}刷新`),
    freq: fmtFreq(iv(t.idx)),
  };
}

/** 滚球与 T-30min 内链路必须 force=true 绕过 client 的 10min TTL 缓存 */
export function mustForce(kickoffUtcMs: number, nowMs: number, status: string): boolean {
  return tierFor(kickoffUtcMs, nowMs, status).idx >= 4;
}
