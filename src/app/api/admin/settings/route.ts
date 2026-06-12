/** 系统设置:密钥(后台管理,掩码回显)/selftest/LLM 测试/成员 RBAC(密钥与成员仅超管) */
import { NextRequest, NextResponse } from "next/server";
import { db, tx } from "@/server/db";
import { audit, currentAdmin, ROLES } from "@/server/admin/auth";
import { requireSameOrigin } from "@/server/platform/rate-limit";
import { cfgAfKey, cfgGetRaw, cfgLlmBalanceKey, cfgLlmBase, cfgLlmDailyBudget, cfgLlmKey, cfgLlmModel, cfgSet, maskKey } from "@/server/platform/config";
import { afGet } from "@/server/af/client";
import { runSelftest } from "@/server/af/selftest";
import { chatComplete, fetchLlmBalance, readLlmBalance } from "@/server/llm/client";
import { kvGet, kvSet } from "@/server/af/store";
import { checkApi, checkReadonly, formatReport, summarize } from "@/server/selfcheck";
import { llmStats } from "@/server/llm/report";

export async function GET() {
  const admin = await currentAdmin();
  if (!admin) return NextResponse.json({ ok: false }, { status: 401 });
  const members = db().prepare("SELECT email, role, status FROM admins ORDER BY created_at").all();
  const llmBalance = readLlmBalance();
  const lastSelftestRaw = JSON.parse(kvGet("last_selftest") || "null") as
    | { at?: number; ok?: number; empty?: number; error?: number; skipped?: number; total?: number; reachable?: number }
    | null;
  const lastSelftest = lastSelftestRaw
    ? (() => {
        const ok = Number(lastSelftestRaw.ok) || 0;
        const total = Number(lastSelftestRaw.total) || 0;
        const error = Number(lastSelftestRaw.error) || 0;
        const skipped = Number(lastSelftestRaw.skipped) || 0;
        const empty = lastSelftestRaw.empty ?? Math.max(0, total - ok - error - skipped);
        return { ...lastSelftestRaw, ok, total, error, skipped, empty, reachable: lastSelftestRaw.reachable ?? ok + empty };
      })()
    : null;
  return NextResponse.json({
    ok: true,
    role: admin.role,
    af: { masked: maskKey(cfgAfKey()), connected: !!cfgAfKey(), status: JSON.parse(kvGet("af_status") || "null"), lastSelftest },
    llm: {
      keyMasked: maskKey(cfgLlmKey()), balanceKeyMasked: maskKey(cfgLlmBalanceKey()),
      base: cfgLlmBase(), model: cfgLlmModel(), budget: cfgLlmDailyBudget(),
      balance: llmBalance?.usd ?? null,
      balanceDetail: llmBalance,
      usage: llmStats(), customKey: !!cfgGetRaw("llm_key"),
    },
    members,
  });
}

export async function POST(req: NextRequest) {
  const originError = requireSameOrigin(req);
  if (originError) return originError;
  const admin = await currentAdmin();
  if (!admin) return NextResponse.json({ ok: false }, { status: 401 });
  const b = (await req.json().catch(() => ({}))) as Record<string, string | number>;
  const superOnly = () => admin.role === "超级管理员";

  if (b.action === "set_key") {
    if (!superOnly()) return NextResponse.json({ ok: false, error: "密钥更换需超级管理员" }, { status: 403 });
    const which = String(b.which);
    const value = String(b.value ?? "").trim();
    const allow: Record<string, string> = { af_key: "AF 密钥", llm_key: "LLM 调用密钥", llm_balance_key: "LLM 余额查询密钥", llm_model: "报告模型", llm_base: "LLM 网关地址" };
    if (!allow[which]) return NextResponse.json({ ok: false, error: "未知配置项" }, { status: 400 });
    if (!value) return NextResponse.json({ ok: false, error: "值为空" }, { status: 400 });
    tx(() => {
      cfgSet(which, value);
      audit(admin.email, "更换密钥/配置", `${allow[which]}(${maskKey(value)})`);
    });
    return NextResponse.json({ ok: true, masked: maskKey(value) });
  }
  if (b.action === "set_budget") {
    if (!superOnly()) return NextResponse.json({ ok: false, error: "需超级管理员" }, { status: 403 });
    const v = Math.trunc(Number(b.value));
    if (!(v > 0)) return NextResponse.json({ ok: false, error: "预算无效" }, { status: 400 });
    tx(() => {
      cfgSet("llm_daily_budget", v);
      audit(admin.email, "LLM 日预算", `${v} tokens`);
    });
    return NextResponse.json({ ok: true });
  }
  if (b.action === "platform_check") {
    audit(admin.email, "运行平台体检", "");
    const rows = await checkReadonly();
    const base = `http://127.0.0.1:${process.env.PORT || 3000}`;
    rows.push(...(await checkApi(base)));
    const rep = summarize(rows);
    kvSet("last_platform_check", JSON.stringify({ at: rep.at, ...rep.summary }));
    return NextResponse.json({ ok: true, text: formatReport(rep), summary: rep.summary });
  }
  if (b.action === "selftest") {
    audit(admin.email, "运行 selftest", "");
    const rep = await runSelftest({ delayMs: Number(b.delay) || 300 });
    kvSet("last_selftest", JSON.stringify({ at: Date.now(), ...rep.summary, reachable: rep.summary.ok + rep.summary.empty }));
    return NextResponse.json({ ok: true, summary: rep.summary, account: rep.account });
  }
  if (b.action === "af_ping") {
    try {
      const env = await afGet("/status", { force: true });
      const r = (env.response ?? {}) as { subscription?: { plan?: string }; requests?: { current?: number; limit_day?: number } };
      kvSet("af_status", JSON.stringify({ plan: r.subscription?.plan, current: r.requests?.current, limit: r.requests?.limit_day, at: Date.now() }));
      return NextResponse.json({ ok: true, status: r });
    } catch (e) {
      return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "连接失败" }, { status: 502 });
    }
  }
  if (b.action === "llm_test") {
    try {
      const r = await chatComplete("只回答两个字:正常", "连通性测试", 16);
      await fetchLlmBalance();
      return NextResponse.json({ ok: true, text: r.text.slice(0, 50), tokens: r.tokens });
    } catch (e) {
      return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "测试失败" }, { status: 502 });
    }
  }
  if (b.action === "member_add" || b.action === "member_set") {
    if (!superOnly()) return NextResponse.json({ ok: false, error: "成员管理需超级管理员" }, { status: 403 });
    const email = String(b.email ?? "").trim().toLowerCase();
    const role = String(b.role ?? "运营");
    if (!ROLES.includes(role as never)) return NextResponse.json({ ok: false, error: "角色无效" }, { status: 400 });
    if (b.action === "member_add") {
      tx(() => {
        db().prepare("INSERT INTO admins (email, role, status, created_at) VALUES (?,?,'启用',?) ON CONFLICT(email) DO UPDATE SET role=excluded.role, status='启用'").run(email, role, Date.now());
        audit(admin.email, "邀请成员", `${email}(${role})`);
      });
    } else {
      const status = String(b.status ?? "");
      if (email === admin.email) return NextResponse.json({ ok: false, error: "不能修改自己" }, { status: 400 });
      tx(() => {
        if (status) db().prepare("UPDATE admins SET status=? WHERE email=?").run(status, email);
        else db().prepare("UPDATE admins SET role=? WHERE email=?").run(role, email);
        audit(admin.email, "成员变更", `${email} → ${status || role}`);
      });
    }
    return NextResponse.json({ ok: true });
  }
  return NextResponse.json({ ok: false, error: "未知操作" }, { status: 400 });
}
