/**
 * 盘口文本与涨跌格式化(从设计稿逻辑类原样移植,全站唯一来源)。
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

/** 亚盘盘口 → 中文(负让球加「受」前缀) */
export function ahText(line: number): string {
  const t = AH_TEXT[String(Math.abs(line))] ?? String(Math.abs(line));
  return (line < 0 ? "受" : "") + t;
}

/** 大小球盘口 → 中文 */
export function ouText(line: number): string {
  return OU_TEXT[String(line)] ?? String(line);
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

export function parseTzOffset(tz: string): number {
  const m = /^UTC([+-]\d+(?:\.\d+)?)$/.exec(tz.trim());
  return m ? Number(m[1]) : 8;
}

export function nowStr(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
