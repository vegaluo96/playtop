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

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  const type = q.get("type") || "全部";
  const tz = q.get("tz") || "UTC+8";
  const user = await currentUser();
  const list = recentMovements(60, type);

  const rows = list.map((m, i) => {
    const masked = !user && i >= GUEST_VISIBLE_ROWS;
    const isAh = m.market === "ah";
    const isEu = m.market === "eu";
    const liveMove = m.phase === "滚球";
    const text = (line: number) => (isAh ? ahText(line) : ouText(line));
    const lineDelta = (m.to_line ?? 0) - (m.from_line ?? 0);
    const hDelta = m.to_h - m.from_h;
    const sideZh = isEu ? "主胜" : isAh ? "主" : "大";
    const fromS = isEu || m.type === "水位" ? `${sideZh} ${f2(m.from_h)}` : text(m.from_line);
    const toS = isEu || m.type === "水位" ? `${sideZh} ${f2(m.to_h)}` : text(m.to_line);
    const water = isEu
      ? `${f2(m.from_h)} → ${f2(m.to_h)}`
      : m.type === "水位"
        ? `盘口维持 ${text(m.to_line)}`
        : `${f2(m.from_h)} → ${f2(m.to_h)}`;
    const note = isEu
      ? `滚球赔率 · 主胜 ${hDelta >= 0 ? "+" : ""}${f2(hDelta)}`
      : m.type === "水位"
        ? `盘口不变 · ${sideZh}水 ${hDelta >= 0 ? "+" : ""}${f2(hDelta)}`
        : `盘口 ${lineDelta >= 0 ? "+" : ""}${f2(lineDelta)} · ${sideZh}水 ${hDelta >= 0 ? "+" : ""}${f2(hDelta)}`;
    return {
      id: m.id,
      fixtureId: m.fixture_id,
      t: hhmm(m.t1, tz),
      t0: hhmm(m.t0, tz),
      match: `${nameZh(m.home_name)} vs ${nameZh(m.away_name)}`,
      league: leagueZh(m.league_id, m.league_name),
      leagueId: m.league_id,
      mk: isEu ? "胜平负" : isAh ? "亚盘" : "大小",
      mkFull: isEu ? "胜平负(滚球)" : isAh ? "亚洲让球盘" : "大小球(进球数)",
      live: liveMove,
      bk: liveMove ? m.bookmaker : maskBookmaker(m.bookmaker),
      type: m.type,
      sev: !masked && !!m.sev,
      masked,
      from: masked ? "●●●" : fromS,
      to: masked ? "●●●" : toS,
      water: masked ? "●.●● → ●.●●" : water,
      note: masked ? "注册后免费查看全部异动" : note,
      rows: masked
        ? []
        : isEu
          ? [
              { k: "主胜赔", a: f2(m.from_h), b: f2(m.to_h), chg: m.from_h !== m.to_h },
              { k: "客胜赔", a: f2(m.from_a), b: f2(m.to_a) },
            ]
          : [
              { k: "盘口", a: text(m.from_line), b: text(m.to_line), chg: lineDelta !== 0 },
              { k: isAh ? "主队水位" : "大球水位", a: f2(m.from_h), b: f2(m.to_h) },
              { k: isAh ? "客队水位" : "小球水位", a: f2(m.from_a), b: f2(m.to_a) },
            ],
    };
  });

  return NextResponse.json({ ok: true, rows, loggedIn: !!user });
}
