/** 赛事与内容:免费场/隐藏 + 联赛开关 + 公告(全部写审计) */
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/server/db";
import { audit, canWrite, currentAdmin } from "@/server/admin/auth";
import { fixturesBetween, kvGet } from "@/server/af/store";
import { cfgLeagues, cfgSet, cfgUnlockPrice } from "@/server/platform/config";
import { dailyFreeFixture } from "@/server/platform/wallet";
import { hhmm } from "@/lib/format";
import { leagueZh } from "@/lib/leagues";
import { isFinished, isLive } from "@/server/af/schedule";

const TZ8 = 8 * 3_600_000;
const day8 = () => new Date(Date.now() + TZ8).toISOString().slice(0, 10);

export async function GET() {
  if (!(await currentAdmin())) return NextResponse.json({ ok: false }, { status: 401 });
  const d = db();
  const t0 = Math.floor((Date.now() + TZ8) / 86_400_000) * 86_400_000 - TZ8;
  const hidden = new Set((d.prepare("SELECT fixture_id FROM hidden_fixtures").all() as unknown as { fixture_id: number }[]).map((r) => r.fixture_id));
  const freeFid = dailyFreeFixture(day8());
  const rows = fixturesBetween(t0, t0 + 2 * 86_400_000).map((f) => ({
    id: f.fixture_id,
    m: `${f.home_name} vs ${f.away_name}`,
    lg: leagueZh(f.league_id, f.league_name),
    t: hhmm(f.kickoff_utc, "UTC+8"),
    free: f.fixture_id === freeFid,
    price: isLive(f.status) || isFinished(f.status) || Date.now() >= f.kickoff_utc ? `滚球 ${cfgUnlockPrice(f.kickoff_utc, Date.now())}` : `赛前 ${cfgUnlockPrice(f.kickoff_utc, Date.now())}`,
    st: hidden.has(f.fixture_id) ? "隐藏" : isLive(f.status) ? "滚球" : isFinished(f.status) ? "完场" : "开盘",
  }));
  const anns = d.prepare("SELECT id, text, status FROM announcements ORDER BY id DESC LIMIT 20").all();
  void kvGet;
  return NextResponse.json({ ok: true, rows, leagues: cfgLeagues(), anns });
}

export async function POST(req: NextRequest) {
  const admin = await currentAdmin();
  if (!admin) return NextResponse.json({ ok: false }, { status: 401 });
  if (!canWrite(admin, "match")) return NextResponse.json({ ok: false, error: "无权限" }, { status: 403 });
  const b = (await req.json().catch(() => ({}))) as { action?: string; fixtureId?: number; id?: number; on?: boolean; text?: string };
  const d = db();
  if (b.action === "free") {
    d.prepare("INSERT OR REPLACE INTO daily_free (date, fixture_id) VALUES (?,?)").run(day8(), Number(b.fixtureId));
    audit(admin.email, "设为今日免费场", String(b.fixtureId));
  } else if (b.action === "unfree") {
    d.prepare("DELETE FROM daily_free WHERE date=? AND fixture_id=?").run(day8(), Number(b.fixtureId));
    audit(admin.email, "取消免费场", String(b.fixtureId));
  } else if (b.action === "hide") {
    d.prepare("INSERT OR IGNORE INTO hidden_fixtures (fixture_id) VALUES (?)").run(Number(b.fixtureId));
    audit(admin.email, "隐藏场次", String(b.fixtureId));
  } else if (b.action === "show") {
    d.prepare("DELETE FROM hidden_fixtures WHERE fixture_id=?").run(Number(b.fixtureId));
    audit(admin.email, "恢复展示场次", String(b.fixtureId));
  } else if (b.action === "league") {
    const ls = cfgLeagues().map((l) => (l.id === Number(b.id) ? { ...l, on: !!b.on } : l));
    cfgSet("leagues", ls);
    audit(admin.email, "联赛开关", `${leagueZh(Number(b.id))} → ${b.on ? "开" : "关"}`);
  } else if (b.action === "ann_create") {
    const text = (b.text ?? "").trim().slice(0, 200);
    if (!text) return NextResponse.json({ ok: false, error: "公告内容为空" }, { status: 400 });
    d.prepare("INSERT INTO announcements (text, status, created_at) VALUES (?,?,?)").run(text, "上线中", Date.now());
    audit(admin.email, "新建公告", text);
  } else if (b.action === "ann_toggle") {
    const a = d.prepare("SELECT status FROM announcements WHERE id=?").get(Number(b.id)) as { status: string } | undefined;
    if (a) {
      d.prepare("UPDATE announcements SET status=? WHERE id=?").run(a.status === "上线中" ? "已下线" : "上线中", Number(b.id));
      audit(admin.email, "公告上下线", String(b.id));
    }
  } else return NextResponse.json({ ok: false, error: "未知操作" }, { status: 400 });
  return NextResponse.json({ ok: true });
}
