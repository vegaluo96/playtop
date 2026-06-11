"use client";

/** 用户管理 / 订单与积分 / 赛事与内容 / 营销配置(四个运营模块) */
import { useCallback, useEffect, useState } from "react";
import { ABtn, ACard, AChip, AGrid, AInput, Th, confirm2, fmtT, post, val } from "./ui";

/* eslint-disable @typescript-eslint/no-explicit-any */
type V = any;

const ST_COLOR: Record<string, string> = { 正常: "#959ba6", 付费: "#e9b949", 免费: "#959ba6", 风控: "#f0434f", 已封禁: "#5c626e" };

export function UsersView() {
  const [data, setData] = useState<V | null>(null);
  const [q, setQ] = useState("");
  const [f, setF] = useState("全部");
  const load = useCallback(
    () => fetch(`/api/admin/users?q=${encodeURIComponent(q)}&f=${encodeURIComponent(f)}`).then((r) => r.json()).then((j) => j.ok && setData(j)),
    [q, f],
  );
  useEffect(() => {
    void load();
  }, [load]);

  const act = async (action: string, userId: number, extra: Record<string, unknown> = {}) => {
    const j = await post("/api/admin/users", { action, userId, ...extra });
    if (!j.ok) alert(j.error);
    void load();
  };

  return (
    <>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
        <span style={{ fontSize: 15, fontWeight: 800 }}>用户管理</span>
        <input
          placeholder="搜索邮箱 / UID"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          style={{ width: 220, background: "var(--card)", border: "1px solid var(--line)", borderRadius: 8, padding: "7px 12px", fontSize: 11, color: "var(--fg)", outline: "none" }}
        />
        <span style={{ flex: 1 }} />
        {["全部", "付费", "免费", "风控", "已封禁"].map((l) => (
          <AChip key={l} label={l} active={f === l} onClick={() => setF(l)} />
        ))}
      </div>
      <ACard pad={false}>
        <AGrid cols="1.6fr 70px 90px 90px 60px 60px 70px 150px" head>
          <Th t="用户" /><Th t="注册" /><Th t="积分余额" right /><Th t="累计充值" right /><Th t="解锁" right /><Th t="邀请" right /><Th t="状态" center /><Th t="操作" right />
        </AGrid>
        {(data?.rows ?? []).map((u: V) => {
          const st = u.status === "正常" ? (u.pay > 0 ? "付费" : "免费") : u.status;
          return (
            <AGrid key={u.id} cols="1.6fr 70px 90px 90px 60px 60px 70px 150px">
              <span className="mono" style={{ fontSize: 11, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{u.email}</span>
              <span className="mono" style={{ fontSize: 10.5, color: "var(--fg-2)" }}>{fmtT(u.created_at).slice(0, 5)}</span>
              <span className="mono" style={{ fontSize: 11, fontWeight: 700, textAlign: "right", color: "var(--gold)" }}>{u.pts.toLocaleString()}</span>
              <span className="mono" style={{ fontSize: 11, textAlign: "right", color: "var(--fg-2)" }}>¥{u.pay.toLocaleString()}</span>
              <span className="mono" style={{ fontSize: 11, textAlign: "right", color: "var(--fg-2)" }}>{u.un}</span>
              <span className="mono" style={{ fontSize: 11, textAlign: "right", color: "var(--fg-2)" }}>{u.iv}</span>
              <span style={{ fontSize: 10, fontWeight: 800, textAlign: "center", color: ST_COLOR[st] ?? "#959ba6" }}>{st}</span>
              <span style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
                <ABtn small kind="line" label="调积分" onClick={() => {
                  const dv = prompt(`为 ${u.email} 调整积分(正补偿/负扣减):`);
                  if (dv == null || !Number(dv)) return;
                  const reason = prompt("原因(写入流水与审计):") ?? "";
                  void act("adjust", u.id, { delta: Number(dv), reason });
                }} />
                {u.status === "已封禁" ? (
                  <ABtn small kind="green" label="解封" onClick={() => void act("unban", u.id)} />
                ) : (
                  <ABtn small kind="red" label="封禁" onClick={() => confirm2(`封禁 ${u.email}?将立即踢下线`) && void act("ban", u.id)} />
                )}
              </span>
            </AGrid>
          );
        })}
        <div style={{ padding: "9px 14px", fontSize: 10, color: "var(--fg-3)" }}>共 {data?.total ?? 0} 名用户 · 显示最近 200</div>
      </ACard>
    </>
  );
}

export function OrdersView() {
  const [data, setData] = useState<V | null>(null);
  const [f, setF] = useState("全部");
  const load = useCallback(() => fetch(`/api/admin/orders?f=${encodeURIComponent(f)}`).then((r) => r.json()).then((j) => j.ok && setData(j)), [f]);
  const [codes, setCodes] = useState<V[]>([]);
  const loadCodes = useCallback(() => fetch("/api/admin/codes").then((r) => r.json()).then((j) => j.ok && setCodes(j.rows)), []);
  useEffect(() => {
    void load();
    void loadCodes();
  }, [load, loadCodes]);
  const TAGC: Record<string, string> = { 充值: "#2ecc8a", 解锁: "#e9b949", 兑换: "#5b9dff", 邀请: "#959ba6", 礼包: "#e9b949", 调整: "#f0434f" };

  return (
    <>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
        <span style={{ fontSize: 15, fontWeight: 800 }}>订单与积分</span>
        <span style={{ flex: 1 }} />
        {["全部", "充值", "解锁", "兑换", "邀请"].map((l) => (
          <AChip key={l} label={l} active={f === l} onClick={() => setF(l)} />
        ))}
      </div>
      <ACard pad={false} style={{ marginBottom: 14 }}>
        <AGrid cols="110px 150px 70px 1fr 80px 80px 70px" head>
          <Th t="时间" /><Th t="用户" /><Th t="类型" /><Th t="明细" /><Th t="金额" right /><Th t="积分" right /><Th t="状态" center />
        </AGrid>
        {(data?.rows ?? []).map((o: V, i: number) => (
          <AGrid key={i} cols="110px 150px 70px 1fr 80px 80px 70px">
            <span className="mono" style={{ fontSize: 10.5, color: "var(--fg-2)" }}>{fmtT(o.t)}</span>
            <span className="mono" style={{ fontSize: 11, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{o.u}</span>
            <span><span style={{ fontSize: 9, fontWeight: 800, borderRadius: 4, padding: "2px 7px", background: "var(--inset)", color: TAGC[o.tag] ?? "#959ba6" }}>{o.tag}</span></span>
            <span style={{ fontSize: 11, color: "var(--fg-mid)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{o.x}</span>
            <span className="mono" style={{ fontSize: 11, textAlign: "right", color: "var(--fg-2)" }}>{o.rmb}</span>
            <span className="mono" style={{ fontSize: 11, fontWeight: 700, textAlign: "right", color: o.pts.startsWith("+") ? "#2ecc8a" : o.pts.startsWith("-") ? "#f0434f" : "var(--fg-3)" }}>{o.pts}</span>
            <span style={{ fontSize: 10, fontWeight: 700, textAlign: "center", color: o.st === "成功" ? "#2ecc8a" : "var(--gold)" }}>{o.st}</span>
          </AGrid>
        ))}
      </ACard>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
        <ACard
          title="兑换码批次"
          right={<ABtn small kind="line" label="+ 生成批次" onClick={async () => {
            const code = prompt("码(4-16 位字母数字,如 WC2026):")?.toUpperCase();
            if (!code) return;
            const points = Number(prompt("面值(积分):") ?? 0);
            const maxUses = Number(prompt("可领次数(批次容量):") ?? 0);
            if (!confirm2(`生成 ${code}:+${points} 分 × ${maxUses} 次`)) return;
            const j = await post("/api/admin/codes", { code, points, maxUses });
            if (!j.ok) alert(j.error);
            void loadCodes();
          }} />}
        >
          {codes.length === 0 && <div style={{ fontSize: 10.5, color: "var(--fg-3)" }}>暂无兑换码批次</div>}
          {codes.map((c: V) => (
            <div key={c.code} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 0", borderBottom: "1px solid var(--line-soft)" }}>
              <span className="mono" style={{ fontSize: 11, fontWeight: 700, color: "var(--gold)" }}>{c.code}</span>
              <span style={{ fontSize: 10, color: "var(--fg-2)" }}>+{c.points} 分 · 限 1 次/人</span>
              <span style={{ flex: 1 }} />
              <span className="mono" style={{ fontSize: 10, color: "var(--fg-2)" }}>{c.used_count.toLocaleString()} / {c.max_uses.toLocaleString()}</span>
              <span style={{ fontSize: 10, fontWeight: 700, color: c.st === "生效中" ? "#2ecc8a" : c.st === "即将售罄" ? "var(--gold)" : "var(--fg-3)" }}>{c.st}</span>
            </div>
          ))}
        </ACard>
        <ACard title="邀请结算(今日)">
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginBottom: 10 }}>
            {[[data?.invite?.ok ?? 0, "有效邀请", undefined], [`+${data?.invite?.pts ?? 0}`, "发放积分", "var(--gold)"], [data?.invite?.blocked ?? 0, "触限拦截", "#f0434f"]].map(([v, label, c]) => (
              <div key={label as string} style={{ background: "var(--inset)", borderRadius: 8, padding: "9px 0", textAlign: "center" }}>
                <div className="mono" style={{ fontSize: 15, fontWeight: 800, color: c as string | undefined }}>{v as string}</div>
                <div style={{ fontSize: 9, color: "var(--fg-3)" }}>{label as string}</div>
              </div>
            ))}
          </div>
          <div style={{ fontSize: 10, color: "var(--fg-3)", lineHeight: 1.7 }}>结算口径:好友注册即计;超出 日/周/月 上限自动拦截;疑似自邀(同 IP)进风控队列。</div>
        </ACard>
      </div>
    </>
  );
}

export function MatchesView() {
  const [data, setData] = useState<V | null>(null);
  const load = useCallback(() => fetch("/api/admin/matches").then((r) => r.json()).then((j) => j.ok && setData(j)), []);
  useEffect(() => {
    void load();
  }, [load]);
  const act = async (body: Record<string, unknown>) => {
    const j = await post("/api/admin/matches", body);
    if (!j.ok) alert(j.error);
    void load();
  };

  return (
    <>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
        <span style={{ fontSize: 15, fontWeight: 800 }}>赛事与内容</span>
        <span style={{ flex: 1 }} />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1.5fr 1fr", gap: 14, alignItems: "start" }}>
        <ACard pad={false}>
          <AGrid cols="1.4fr 70px 60px 100px 90px 60px 110px" head>
            <Th t="比赛" /><Th t="联赛" /><Th t="开赛" /><Th t="免费场" center /><Th t="预测定价" right /><Th t="状态" center /><Th t="操作" right />
          </AGrid>
          {(data?.rows ?? []).map((m: V) => (
            <AGrid key={m.id} cols="1.4fr 70px 60px 100px 90px 60px 110px">
              <span style={{ fontSize: 11.5, fontWeight: 700, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{m.m}</span>
              <span style={{ fontSize: 10.5, color: "var(--fg-2)" }}>{m.lg}</span>
              <span className="mono" style={{ fontSize: 10.5, color: "var(--fg-2)" }}>{m.t}</span>
              <span style={{ fontSize: 10, fontWeight: 700, textAlign: "center", color: m.free ? "#2ecc8a" : "var(--fg-3)" }}>{m.free ? "今日免费场" : "—"}</span>
              <span className="mono" style={{ fontSize: 10.5, textAlign: "right", color: "var(--fg-2)" }}>{m.price}</span>
              <span style={{ fontSize: 10, fontWeight: 800, textAlign: "center", color: m.st === "隐藏" ? "#f0434f" : m.st === "滚球" ? "var(--gold)" : "#2ecc8a" }}>{m.st}</span>
              <span style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                <ABtn small kind="line" label={m.free ? "取消免费" : "设为免费"} onClick={() => void act({ action: m.free ? "unfree" : "free", fixtureId: m.id })} />
                <ABtn small kind={m.st === "隐藏" ? "green" : "red"} label={m.st === "隐藏" ? "恢复" : "隐藏"} onClick={() => void act({ action: m.st === "隐藏" ? "show" : "hide", fixtureId: m.id })} />
              </span>
            </AGrid>
          ))}
          <div style={{ padding: "9px 14px", fontSize: 10, color: "var(--fg-3)" }}>免费场策略:每日 1 场(worker 自动选,可在此覆盖);隐藏=列表不展示(数据仍归档)</div>
        </ACard>
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <ACard title="联赛开关">
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {(data?.leagues ?? []).map((l: V) => (
                <span
                  key={l.id}
                  onClick={() => void act({ action: "league", id: l.id, on: !l.on })}
                  style={{
                    padding: "4px 11px", borderRadius: 999, fontSize: 10.5, fontWeight: l.on ? 700 : 600, cursor: "pointer",
                    background: l.on ? "rgba(233,185,73,.14)" : "var(--card)", color: l.on ? "var(--gold)" : "var(--fg-3)",
                    border: `1px solid ${l.on ? "rgba(233,185,73,.45)" : "var(--line)"}`,
                  }}
                >
                  {l.zh} {l.on ? "✓" : ""}{l.wc && l.on ? " 置顶" : ""}
                </span>
              ))}
            </div>
            <div style={{ fontSize: 10, color: "var(--fg-3)", marginTop: 10 }}>开关决定抓取与展示范围;worker 下一轮自动套用分层调度</div>
          </ACard>
          <ACard title="公告 / Banner" right={<ABtn small kind="line" label="+ 新建公告" onClick={async () => {
            const text = prompt("公告内容:");
            if (text) {
              await post("/api/admin/matches", { action: "ann_create", text });
              void load();
            }
          }} />}>
            {(data?.anns ?? []).length === 0 && <div style={{ fontSize: 10.5, color: "var(--fg-3)" }}>暂无公告</div>}
            {(data?.anns ?? []).map((a: V) => (
              <div key={a.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 0", borderBottom: "1px solid var(--line-soft)" }}>
                <span style={{ flex: 1, fontSize: 11, color: "var(--fg-mid)" }}>{a.text}</span>
                <span
                  onClick={() => void act({ action: "ann_toggle", id: a.id })}
                  style={{ fontSize: 10, fontWeight: 700, cursor: "pointer", color: a.status === "上线中" ? "#2ecc8a" : "var(--fg-3)" }}
                >
                  {a.status}
                </span>
              </div>
            ))}
          </ACard>
        </div>
      </div>
    </>
  );
}

export function MktView() {
  const [v, setV] = useState<V | null>(null);
  const load = useCallback(() => fetch("/api/admin/marketing").then((r) => r.json()).then((j) => j.ok && setV(j)), []);
  useEffect(() => {
    void load();
  }, [load]);
  if (!v) return <div style={{ color: "var(--fg-3)", fontSize: 12, padding: 40, textAlign: "center" }}>加载中…</div>;

  const save = async (body: Record<string, unknown>, label: string) => {
    if (!confirm2(label)) return;
    const j = await post("/api/admin/marketing", body);
    if (!j.ok) alert(j.error);
    void load();
  };

  return (
    <>
      <div style={{ fontSize: 15, fontWeight: 800, marginBottom: 12 }}>
        营销配置 <span style={{ fontSize: 10, color: "var(--fg-3)", fontWeight: 400 }}>· 改动需二次确认并写入审计日志</span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, alignItems: "start" }}>
        <ACard title="充值档位">
          <AGrid cols="70px 1fr 70px 70px" head>
            <Th t="金额" /><Th t="到账积分" /><Th t="加赠" right /><Th t="标签" center />
          </AGrid>
          {v.tiers.map((t: V, i: number) => (
            <AGrid key={i} cols="70px 1fr 70px 70px">
              <span className="mono" style={{ fontSize: 11 }}>¥{t.rmb}</span>
              <span className="mono" style={{ fontSize: 11, color: "var(--gold)" }}>{t.pts.toLocaleString()}</span>
              <span style={{ fontSize: 10, textAlign: "right", color: t.tag ? "#2ecc8a" : "var(--fg-2)" }}>{t.tag ?? "—"}</span>
              <span style={{ fontSize: 10, textAlign: "center", color: t.hot ? "var(--gold)" : "var(--fg-3)" }}>{t.hot ? "最划算" : "—"}</span>
            </AGrid>
          ))}
          <div style={{ display: "flex", gap: 8, marginTop: 10, alignItems: "center" }}>
            <ABtn small kind="line" label="编辑档位(JSON)" onClick={() => {
              const cur = JSON.stringify(v.tiers);
              const next = prompt("档位 JSON([{rmb,pts,tag?,hot?},…]):", cur);
              if (next && next !== cur) {
                try {
                  void save({ action: "tiers", tiers: JSON.parse(next) }, "更新充值档位");
                } catch {
                  alert("JSON 无效");
                }
              }
            }} />
            <span style={{ fontSize: 10, color: "var(--fg-3)" }}>首充加赠 50%(开关在右侧规则卡)</span>
          </div>
        </ACard>
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <ACard title="解锁定价">
            <div style={{ display: "flex", gap: 10, marginBottom: 8 }}>
              {[["赛前价", "mk-pre", v.pricePre], ["滚球价", "mk-live", v.priceLive]].map(([label, id, value]) => (
                <div key={id as string} style={{ flex: 1, background: "var(--inset)", borderRadius: 8, padding: "9px 12px" }}>
                  <div style={{ fontSize: 9, color: "var(--fg-3)", marginBottom: 4 }}>{label as string}(积分)</div>
                  <AInput id={id as string} mono defaultValue={String(value)} />
                </div>
              ))}
            </div>
            <ABtn small kind="line" label="保存定价" onClick={() => void save({ action: "prices", price_pre: Number(val("mk-pre")), price_live: Number(val("mk-live")) }, `解锁定价 → 赛前 ${val("mk-pre")} / 滚球 ${val("mk-live")}`)} />
            <div style={{ fontSize: 10, color: "var(--fg-3)", marginTop: 8 }}>开赛自动切换滚球价 · 已解锁用户不受影响</div>
          </ACard>
          <ACard title="新人与邀请">
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 8 }}>
              {[["新人礼包", "mk-gift", v.gift], ["每次邀请", "mk-iv", v.invitePoints], ["日上限", "mk-d", v.caps.day], ["周上限", "mk-w", v.caps.week], ["月上限", "mk-m", v.caps.month]].map(([label, id, value]) => (
                <div key={id as string}>
                  <div style={{ fontSize: 9, color: "var(--fg-3)", marginBottom: 4 }}>{label as string}</div>
                  <AInput id={id as string} mono defaultValue={String(value)} />
                </div>
              ))}
              <div>
                <div style={{ fontSize: 9, color: "var(--fg-3)", marginBottom: 4 }}>首充加赠 50%</div>
                <select id="mk-fb" defaultValue={v.firstBonusOn ? "1" : "0"} style={{ width: "100%", background: "var(--inset)", border: "1px solid var(--line)", borderRadius: 8, padding: "8px 12px", fontSize: 11.5, color: "var(--fg)", outline: "none" }}>
                  <option value="1">开</option>
                  <option value="0">关</option>
                </select>
              </div>
            </div>
            <ABtn small kind="line" label="保存规则" onClick={() => void save({
              action: "rules", gift_points: Number(val("mk-gift")), invite_points: Number(val("mk-iv")),
              caps: { day: Number(val("mk-d")), week: Number(val("mk-w")), month: Number(val("mk-m")) },
              firstBonusOn: (document.getElementById("mk-fb") as HTMLSelectElement).value === "1",
            }, "更新新人与邀请规则")} />
          </ACard>
        </div>
      </div>
    </>
  );
}
