/**
 * 指数文本与涨跌格式化(从设计稿逻辑类原样移植,全站唯一来源)。
 */

export const AH_TEXT: Record<string, string> = {
  "0": "平手", "0.25": "平半", "0.5": "半球", "0.75": "半一", "1": "一球",
  "1.25": "一/球半", "1.5": "球半", "1.75": "球半/两", "2": "两球",
  "2.25": "两/两半", "2.5": "两球半", "2.75": "两半/三", "3": "三球",
};
export const OU_TEXT: Record<string, string> = {
  "1.5": "球半", "1.75": "球半/两", "2": "两球", "2.25": "两/两半", "2.5": "两球半",
  "2.75": "两半/三", "3": "三球", "3.25": "三/三半", "3.5": "三球半",
  "3.75": "三半/四", "4": "四球", "4.25": "四/四半", "4.5": "四球半",
};

/** 让球盘口 → 数字(标准化:正=主让,负=受让,0=平手;全站统一用数字,不再中文盘口名) */
export function ahText(line: number): string {
  return String(Math.round(line * 100) / 100);
}

/** 大小盘口 → 数字(标准化:与角球/罚牌等「更多」玩法一致,统一数字) */
export function ouText(line: number): string {
  return String(Math.round(line * 100) / 100);
}

export function f2(v: number): string {
  return v.toFixed(2);
}

/** 涨跌箭头(d>0 ▲ 用 --up,d<0 ▼ 用 --down) */
export function arrow(d: number): { ch: string; cls: "up" | "down" | "none" } {
  return d > 0 ? { ch: "▲", cls: "up" } : d < 0 ? { ch: "▼", cls: "down" } : { ch: "", cls: "none" };
}

/** UTC 时间戳 → 用户时区 HH:mm(tz 形如 "UTC+8") */
export function hhmm(utcMs: number, tz: string): string {
  const off = parseTzOffset(tz);
  const d = new Date(utcMs + off * 3_600_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

export function dateStr(utcMs: number, tz: string): string {
  const off = parseTzOffset(tz);
  const d = new Date(utcMs + off * 3_600_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

/** 书商名打码:前台不显示全称但保留辨识度(Bet365→Be***5,平博→平*);后台不打码 */
export function maskBookmaker(name: string): string {
  const n = name.trim();
  if (!n) return n;
  if (/[一-鿿]/.test(n)) return n.length <= 1 ? n : `${n[0]}${"*".repeat(Math.max(1, n.length - 1))}`;
  if (n.length <= 3) return `${n[0]}**`;
  return `${n.slice(0, 2)}***${n.slice(-1)}`;
}

/** 用户时区口径的「M月D日」(顶栏日期与所标时区必须同源,不能用浏览器本地时间) */
export function mdLabel(utcMs: number, tz: string): string {
  const d = new Date(utcMs + parseTzOffset(tz) * 3_600_000);
  return `${d.getUTCMonth() + 1}月${d.getUTCDate()}日`;
}

/** 开球日前缀:今日 / 明日 / 昨日 / MM-DD(用户时区口径) */
export function dayLabel(utcMs: number, tz: string, nowMs = Date.now()): string {
  const off = parseTzOffset(tz);
  const dayN = (ms: number) => Math.floor((ms + off * 3_600_000) / 86_400_000);
  const diff = dayN(utcMs) - dayN(nowMs);
  if (diff === 0) return "今日";
  if (diff === 1) return "明日";
  if (diff === -1) return "昨日";
  const d = new Date(utcMs + off * 3_600_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

export function parseTzOffset(tz: string): number {
  const m = /^UTC([+-]\d+(?:\.\d+)?)$/.exec(tz.trim());
  return m ? Number(m[1]) : 8;
}

export function nowStr(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
