// Regenerate src/app.template.html from the frozen DC prototype.
//
// The prototype (prototype/AI Call.dc.html) is the design source of truth.
// The production app renders the *inner* of its <x-dc>…</x-dc> verbatim, so
// this script keeps src/app.template.html provably in sync — no hand editing.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, "../../prototype/AI Call.dc.html");
const OUT = join(here, "../src/app.template.html");

const html = readFileSync(SRC, "utf8");
const open = html.match(/<x-dc(?:\s[^>]*)?>/);
if (!open) throw new Error("no <x-dc> open tag found");
const start = open.index + open[0].length;
const end = html.lastIndexOf("</x-dc>");
if (end < 0 || end < start) throw new Error("no </x-dc> close tag found");

let template = html.slice(start, end).replace(/^\n/, "");

// Production-only hooks (product-directed responsive change): tag the two side
// drawers so app-level CSS can square their phone-frame corners on real devices.
// Pure class injection — no visual change vs. the prototype on its own.
template = template.replace(
  '<div style="position:absolute;top:0;bottom:0;left:0;width:74%;z-index:9;',
  '<div class="dcx-drawer-left" style="position:absolute;top:0;bottom:0;left:0;width:74%;z-index:9;',
);
template = template.replace(
  '<div style="position:absolute;top:0;bottom:0;right:0;width:74%;z-index:11;',
  '<div class="dcx-drawer-right" style="position:absolute;top:0;bottom:0;right:0;width:74%;z-index:11;',
);
// Tag the desktop side panels with the theme so dark mode reaches them
// (they live outside the themed .phone/.screen and otherwise stay light).
template = template.replaceAll(
  '<div class="deskside" style="zoom:{{ rootZoom }};--fz:{{ rootZoom }};">',
  '<div class="deskside" data-theme="{{ theme }}" style="zoom:{{ rootZoom }};--fz:{{ rootZoom }};">',
);

// 弹窗底部「白条」根治（产品方变更）：给所有底部弹窗（贴底的 sheet）打一个统一钩子
// 类 dcx-sheet，让 app 级 CSS 能在真机上统一处理 home-indicator 安全区 —— 容器底部
// 留白、滚动列表留白、安全区三者原本叠加成一条死的近白色横条，统一后只由一处负责一次。
// 纯类注入，相对原型零视觉变化（桌面预览无安全区时 env()=0）。
template = template.replaceAll(
  '<div style="position:absolute;left:0;right:0;bottom:0;',
  '<div class="dcx-sheet" style="position:absolute;left:0;right:0;bottom:0;',
);

// 角色详情：把头部（头像/名字/标签）做成固定头部，下方资料区独立滚动（用户：这部分固定住）。
// 把头部 column 从滚动列表 .nobar 内提到其外、当 flex:none 固定块；收藏 ♥ 仍绝对定位贴在
// 弹窗右上，正好落在固定头部上，且与滚动区里的「生成」分属固定层/滚动层，从此不再打架。
// 移出 .nobar 后头部失去其左右内边距，这里补回 padding:0 20px 4px。生产专属修正，不动原型。
template = template.replace(
  /(<div onClick="\{\{ charDetail\.favToggle \}\}"[\s\S]*?<\/div>)\s*(<div class="nobar" style="flex:1;min-height:0;overflow-y:auto;-webkit-overflow-scrolling:touch;padding:6px 20px 28px;">)\s*([\s\S]*?)(?=\s*<div style="border-top:1px solid var\(--line\);margin-top:18px;padding-top:16px;">)/,
  (_m, heart, nobarOpen, headerCol) => {
    const fixedHeader = headerCol.replace(
      '<div style="display:flex;flex-direction:column;align-items:center;gap:12px;">',
      '<div style="flex:none;padding:0 20px 4px;display:flex;flex-direction:column;align-items:center;gap:12px;">',
    );
    return `${fixedHeader}\n          ${heart}\n          ${nobarOpen}\n            `;
  },
);

writeFileSync(OUT, template, "utf8");
console.log(`Wrote ${OUT} (${template.split("\n").length} lines) from prototype.`);
