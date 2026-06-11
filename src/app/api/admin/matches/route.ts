/** 赛事与内容:免费场/隐藏 + 联赛开关 + 公告(全部写审计) */
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/server/db";
import { audit, canWrite, currentAdmin } from "@/server/admin/auth";
import { fixturesBetween, kvGet } from "@/server/af/store";
import { cfgLeagues, cfgSet, cfgUnlockPrice } from "@/server/platform/config";
import { dailyFreeFixtureIds } from "@/server/platform/wallet";
import { runAfEndpoint } from "@/server/af/catalog";
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
  const freeSet = new Set(dailyFreeFixtureIds(day8()));
  const rows = fixturesBetween(t0, t0 + 2 * 86_400_000).map((f) => ({
    id: f.fixture_id,
    m: `${f.home_name} vs ${f.away_name}`,
    lg: leagueZh(f.league_id, f.league_name),
    t: hhmm(f.kickoff_utc, "UTC+8"),
    free: freeSet.has(f.fixture_id),
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
    // 多场免费:逐场追加,不再互相覆盖
    d.prepare("INSERT OR IGNORE INTO free_fixtures (date, fixture_id) VALUES (?,?)").run(day8(), Number(b.fixtureId));
    audit(admin.email, "设为今日免费场", String(b.fixtureId));
  } else if (b.action === "unfree") {
    d.prepare("DELETE FROM free_fixtures WHERE date=? AND fixture_id=?").run(day8(), Number(b.fixtureId));
    audit(admin.email, "取消免费场", String(b.fixtureId));
  } else if (b.action === "hide") {
    d.prepare("INSERT OR IGNORE INTO hidden_fixtures (fixture_id) VALUES (?)").run(Number(b.fixtureId));
    audit(admin.email, "隐藏场次", String(b.fixtureId));
  } else if (b.action === "show") {
    d.prepare("DELETE FROM hidden_fixtures WHERE fixture_id=?").run(Number(b.fixtureId));
    audit(admin.email, "恢复展示场次", String(b.fixtureId));
  } else if (b.action === "league_up" || b.action === "league_down") {
    // 联赛排序:数组顺序即用户端 chips 顺序
    const ls = cfgLeagues();
    const i = ls.findIndex((l) => l.id === Number(b.id));
    const j = b.action === "league_up" ? i - 1 : i + 1;
    if (i >= 0 && j >= 0 && j < ls.length) {
      [ls[i], ls[j]] = [ls[j], ls[i]];
      cfgSet("leagues", ls);
      audit(admin.email, "联赛排序", `${ls[j].zh} ${b.action === "league_up" ? "上移" : "下移"}`);
    }
  } else if (b.action === "league_search") {
    // /leagues 端点:按名搜索可添加的联赛(当季有赔率覆盖优先展示)
    try {
      const r = await runAfEndpoint("leagues", { search: String(b.text ?? "").trim() });
      const list = (Array.isArray(r.response) ? r.response : []).slice(0, 10).map((it) => {
        const lg = (it as { league?: { id?: number; name?: string; type?: string }; country?: { name?: string } });
        return { id: lg.league?.id, name: lg.league?.name, type: lg.league?.type, country: lg.country?.name };
      });
      return NextResponse.json({ ok: true, list });
    } catch (e) {
      return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "搜索失败" }, { status: 502 });
    }
  } else if (b.action === "league_add") {
    const id = Number(b.id);
    const name = String(b.text ?? "").trim();
    if (!id || !name) return NextResponse.json({ ok: false, error: "联赛 id/名称缺失" }, { status: 400 });
    const ls = cfgLeagues();
    if (!ls.some((l) => l.id === id)) {
      const palette = ["#8e6cf0", "#f2a13b", "#d4524f", "#3f8cff", "#38bdd4", "#e98049", "#7aa7ff", "#4ad1a0", "#c66fd1", "#6fd1a8"];
      ls.push({ id, zh: name, color: palette[id % palette.length], on: true });
      cfgSet("leagues", ls);
      audit(admin.email, "添加联赛", `${name}(${id})`);
    }
    return NextResponse.json({ ok: true });
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
