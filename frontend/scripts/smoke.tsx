// Render smoke test (no browser): set up a jsdom DOM, then render the real DC
// renderer + ported logic to static markup and assert that key prototype text,
// per-state bindings and SVG markup come through. This exercises the actual
// runtime template parsing / sc-if / sc-for / style / pseudo-class paths.
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
g.localStorage = dom.window.localStorage;

// Imported AFTER globals exist (these modules touch document at call time).
const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { DcView } = await import("../src/dc/DcView.tsx");
const { MiCallLogic } = await import("../src/logic/MiCallLogic.ts");

const here = dirname(fileURLToPath(import.meta.url));
const template = readFileSync(join(here, "../src/app.template.html"), "utf8");

function render(mutate?: (logic: any) => void): string {
  const logic = new MiCallLogic({ theme: "light", orbColor: "#AAB8FF", aiName: "VEGAluo" });
  if (mutate) mutate(logic);
  return renderToStaticMarkup(createElement(DcView, { template, vals: logic.renderVals() }));
}

let failures = 0;
function check(label: string, html: string, needles: string[], absent: string[] = []) {
  const missing = needles.filter((n) => !html.includes(n));
  const present = absent.filter((n) => html.includes(n));
  if (missing.length || present.length) {
    failures++;
    console.error(`✗ ${label}`);
    if (missing.length) console.error("   missing:", missing);
    if (present.length) console.error("   unexpectedly present:", present);
  } else {
    console.log(`✓ ${label}`);
  }
}

// 1) Idle screen: brand, current character, tagline, controls, copy.
const idle = render();
check("idle screen", idle, [
  "载思",
  "林晚", "温柔的深夜倾听者",
  "viewBox", "stroke-linecap", // SVGs survived with correct attribute names
  "orbStill", // per-state orb animation name reached the inline style
]);

// 2) Idle must NOT show in-call chrome or the ended-state copy.
check("idle excludes call/ended chrome", idle, [], ["挂断", "这次聊得怎么样？", "正在聆听"]);

// 3) In-call (speaking) state, as driven by server signaling.
const speaking = render((l) => {
  l.state.phase = "speaking";
  l.state.seconds = 12;
  l.state.subtitle = "今天过得怎么样？";
  l.state.lines = ["嗯，我在听。", "今天过得怎么样？"];
});
check("speaking state", speaking, ["今天过得怎么样？", "静音", "文字", "更多", "00:12"], ["换个角色"]);

// 4) Ended state shows rating + the signature copy.
const ended = render((l) => { l.state.phase = "ended"; });
check("ended state", ended, ["通话结束", "这次聊得怎么样？"]);

// 5) A sheet (character picker) renders its list when opened.
const charSheet = render((l) => { l.state.charOpen = true; });
check("character sheet", charSheet, ["选择角色", "推荐", "热门", "收藏", "搜索角色"]);

// 6) Dark theme flips the data-theme attribute that drives CSS variables —
// including the two desktop side panels (so dark mode reaches them).
const dark = render((l) => { l.state.theme = "dark"; });
check("dark theme attribute", dark, ['data-theme="dark"']);
check("desksides carry the theme", dark, ['class="deskside" data-theme="dark"']);

// 7) Every sheet renders its sc-for lists without throwing.
const sheets: [string, (l: any) => void, string[]][] = [
  ["menu", (l) => { l.state.menuOpen = true; }, ["账单", "邀请好友", "深色模式", "语言", "dcx-drawer-left"]],
  ["history drawer", (l) => { l.state.historyOpen = true; }, ["通话记录", "dcx-drawer-right"]],
  ["scenario list", (l) => { l.state.scenarioOpen = true; }, ["选择场景", "随便聊聊", "心情树洞"]],
  ["scenario custom", (l) => { l.state.scenarioOpen = true; l.state.sceneTab = "custom"; }, ["应用场景", "试试这些"]],
  ["bills", (l) => { l.state.billsOpen = true; }, ["畅聊会员", "交易记录", "分钟剩余"]],
  ["recharge", (l) => { l.state.rechargeOpen = true; }, ["选择会员", "轻享会员", "畅聊会员", "无限会员", "最受欢迎"]],
  ["invite", (l) => { l.state.inviteOpen = true; }, ["邀请好友", "MICALL-7K2F", "邀请记录"]],
  ["history", (l) => { l.state.historyOpen = true; }, ["通话记录"]],
  ["settings", (l) => { l.state.settingsOpen = true; }, ["修改密码", "取消订阅", "隐私政策", "用户协议"]],
  ["language", (l) => { l.state.langOpen = true; }, ["English", "日本語", "한국어"]],
  ["contact", (l) => { l.state.contactOpen = true; }, ["联系我们", "建议反馈", "提交工单"]],
  ["auth register", (l) => { l.state.authOpen = true; }, ["登录 / 注册"]],
  ["char detail", (l) => { l.state.charDetailOpen = true; }, ["音色", "原本音色", "背景故事", "性格"]],
  ["perm dialog", (l) => { l.state.permOpen = true; }, ["允许使用麦克风", "允许"]],
  ["call failed", (l) => { l.state.callFailed = true; }, ["接通失败", "重试"]],
  ["out of minutes", (l) => { l.state.outOfMins = true; }, ["通话时长已用完", "去充值"]],
];
for (const [label, mutate, needles] of sheets) {
  check("sheet: " + label, render(mutate), needles);
}

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll render smoke checks passed.");
