/**
 * 异动流:GET /api/moves?type=全部|升盘|降盘|水位&tz=
 * 免注册:前 3 条完整,其余纯数值打码 + 注册 CTA(服务端执行)。
 */
import { NextRequest, NextResponse } from "next/server";
import { ahText, f2, hhmm, maskBookmaker, ouText } from "@/lib/format";
import { leagueZh } from "@/lib/leagues";
import { recentMovements } from "@/server/af/store";
import { nameZh } from "@/server/views/names";
import { currentUser } from "@/server/platform/session";
import { GUEST_VISIBLE_ROWS } from "@/server/platform/rules";

function deltaText(v: number): string {
  return `${v >= 0 ? "+" : ""}${f2(v)}`;
}

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  const type = q.get("type") || "全部";
  const tz = q.get("tz") || "UTC+8";
  const userPromise = currentUser();
  const list = recentMovements(60, type);
  const user = await userPromise;

  const rows = list.map((m, i) => {
    const masked = !user && i >= GUEST_VISIBLE_ROWS;
    const isAh = m.market === "ah";
    const isEu = m.market === "eu";
    const liveMove = m.phase === "滚球";
    const text = (line: number) => (isAh ? ahText(line) : ouText(line));
    const lineDelta = m.from_line == null || m.to_line == null ? 0 : m.to_line - m.from_line;
    const hDelta = m.to_h - m.from_h;
    const aDelta = m.to_a - m.from_a;
    const primarySide = isEu ? (Math.abs(hDelta) >= Math.abs(aDelta) ? "主胜" : "客胜") : isAh ? (Math.abs(hDelta) >= Math.abs(aDelta) ? "主" : "客") : (Math.abs(hDelta) >= Math.abs(aDelta) ? "大" : "小");
    const primaryFrom = Math.abs(hDelta) >= Math.abs(aDelta) ? m.from_h : m.from_a;
    const primaryTo = Math.abs(hDelta) >= Math.abs(aDelta) ? m.to_h : m.to_a;
    const waterDelta = primaryTo - primaryFrom;
    const waterDirection = waterDelta > 0 ? "up" : waterDelta < 0 ? "down" : "flat";
    const direction = m.type === "升盘" ? "up" : m.type === "降盘" ? "down" : waterDelta > 0 ? "up" : waterDelta < 0 ? "down" : "flat";
    const sideZh = isEu ? primarySide : isAh ? "主" : "大";
    const valueSide = m.type === "水位" || isEu ? primarySide : sideZh;
    const fromS = isEu || m.type === "水位" ? `${valueSide} ${f2(primaryFrom)}` : text(m.from_line);
    const toS = isEu || m.type === "水位" ? `${valueSide} ${f2(primaryTo)}` : text(m.to_line);
    const waterLabel = isEu ? `${primarySide}赔` : `${primarySide}水`;
    const water = `${waterLabel} ${f2(primaryFrom)} → ${f2(primaryTo)}`;
    const note = isEu
      ? `滚球指数 · ${waterLabel} ${deltaText(waterDelta)}`
      : m.type === "水位"
        ? `指数不变 · ${waterLabel} ${deltaText(waterDelta)}`
        : `指数 ${deltaText(lineDelta)} · ${waterLabel} ${deltaText(waterDelta)}`;
    return {
      id: m.id,
      fixtureId: m.fixture_id,
      t: hhmm(m.t1, tz),
      t0: hhmm(m.t0, tz),
      match: `${nameZh(m.home_name)} vs ${nameZh(m.away_name)}`,
      league: leagueZh(m.league_id, m.league_name),
      leagueId: m.league_id,
      mk: isEu ? "胜平负" : isAh ? "让球" : "大小",
      mkFull: isEu ? "胜平负(滚球)" : isAh ? "让球指数" : "大小指数(进球数)",
      live: liveMove,
      bk: liveMove ? m.bookmaker : maskBookmaker(m.bookmaker),
      type: m.type,
      direction,
      lineDelta,
      waterDelta,
      waterDirection,
      homeWaterDelta: hDelta,
      awayWaterDelta: aDelta,
      waterLabel,
      sev: !masked && !!m.sev,
      masked,
      from: masked ? "●●●" : fromS,
      to: masked ? "●●●" : toS,
      water: masked ? "●.●● → ●.●●" : water,
      note: masked ? "登录后查看完整异动流" : note,
      rows: masked
        ? []
        : isEu
          ? [
              { k: "主胜赔", a: f2(m.from_h), b: f2(m.to_h), chg: m.from_h !== m.to_h, delta: hDelta },
              { k: "客胜赔", a: f2(m.from_a), b: f2(m.to_a), chg: m.from_a !== m.to_a, delta: aDelta },
            ]
          : [
              { k: "指数", a: text(m.from_line), b: text(m.to_line), chg: lineDelta !== 0, delta: lineDelta },
              { k: isAh ? "主队水位" : "大球水位", a: f2(m.from_h), b: f2(m.to_h), chg: m.from_h !== m.to_h, delta: hDelta },
              { k: isAh ? "客队水位" : "小球水位", a: f2(m.from_a), b: f2(m.to_a), chg: m.from_a !== m.to_a, delta: aDelta },
            ],
    };
  });

  return NextResponse.json({ ok: true, rows, loggedIn: !!user });
}
