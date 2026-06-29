// Render smoke test (no browser) for the Admin console: render the real DC
// renderer + ported logic to static markup and assert each of the 11 tabs and
// the detail drawers come through without throwing.
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const dom = new JSDOM("<!doctype html><html><head></head><body></body></html>", {
  url: "http://localhost/",
});
const g = globalThis as any;
g.window = dom.window;
g.document = dom.window.document;
g.DOMParser = dom.window.DOMParser;
g.Node = dom.window.Node;

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { DcView } = await import("../src/dc/DcView.tsx");
const { AdminLogic } = await import("../src/logic/AdminLogic.ts");

const here = dirname(fileURLToPath(import.meta.url));
const template = readFileSync(join(here, "../src/app.template.html"), "utf8");

function render(mutate?: (l: any) => void): string {
  const logic = new AdminLogic();
  if (mutate) mutate(logic);
  return renderToStaticMarkup(createElement(DcView, { template, vals: logic.renderVals() }));
}

let failures = 0;
function check(label: string, html: string, needles: string[]) {
  const missing = needles.filter((n) => !html.includes(n));
  if (missing.length) {
    failures++;
    console.error(`✗ ${label}`); console.error("   missing:", missing);
  } else {
    console.log(`✓ ${label}`);
  }
}

// Sidebar nav is always present.
check("shell + nav", render(), ["载思", "数据概览", "用户管理", "角色管理", "场景管理", "通话记录", "工单反馈", "订单充值", "邀请裂变", "接口配置", "成本与限流", "权限管理"]);

// Each of the 11 sections renders representative content.
const sections: [string, string, string[]][] = [
  ["dashboard", "dashboard", ["总用户", "12,847", "今日通话", "近 7 日通话量"]],
  ["users", "users", ["陈思远", "siyuan.c@gmail.com", "畅聊会员"]],
  ["characters", "characters", ["林晚", "温柔的深夜倾听者", "角色"]],
  ["scenarios", "scenarios", ["随便聊聊", "心情树洞", "推荐"]],
  ["calls", "calls", ["心情树洞", "12:08"]],
  ["tickets", "tickets", ["功能异常", "建议反馈"]],
  ["orders", "orders", ["MC20260618A", "已支付"]],
  ["invites", "invites", ["累计邀请", "邀请奖励", "周岚"]],
  ["api", "接口配置", ["ASR · 语音识别", "LLM · 快脑（通话中）", "TTS · 语音合成", "Embedding · 记忆检索", "快链路", "慢链路"]],
  ["cost", "成本与限流", ["今日总成本", "本月总成本", "LLM 快脑", "TTS 语音合成", "每日 30 分钟"]],
  ["admins", "权限管理", ["张运营", "超级管理员", "admin@micall.ai"]],
];
for (const [sec, label, needles] of sections) {
  check("section: " + label, render((l) => { l.state.section = sec; }), needles);
}

// Detail drawers.
check("user detail", render((l) => { l.state.section = "users"; l.open("user", "u1"); }), ["用户详情", "陈思远", "封禁该用户"]);
check("char detail", render((l) => { l.state.section = "characters"; l.open("char", "c1"); }), ["角色编辑", "林晚"]);
check("call detail", render((l) => { l.state.section = "calls"; l.open("call", "k1"); }), ["通话详情", "心情树洞"]);
check("ticket detail", render((l) => { l.state.section = "tickets"; l.open("ticket", "t1"); }), ["工单详情", "功能异常"]);

// Character sub-tabs (角色/音色/表情) + import/export drawer.
check("char voice tab", render((l) => { l.state.section = "characters"; l.state.charTab = "voice"; }), ["火山引擎", "MiniMax"]);
// expr tab list mode shows each character + enabled/total expression count
check("char expr tab (list)", render((l) => { l.state.section = "characters"; l.state.charTab = "expr"; }), ["林晚", "已启用"]);
// expr tab detail mode (a character opened) shows the 12 expression names
check("char expr tab (detail)", render((l) => { l.state.section = "characters"; l.state.charTab = "expr"; l.state.exprOpen = "c1"; }), ["默认待机", "挂断告别", "思考中"]);
check("import/export", render((l) => { l.state.section = "characters"; l.state.ioOpen = true; }), ["micall_characters.json", "__expr__"]);

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll Admin render smoke checks passed.");
