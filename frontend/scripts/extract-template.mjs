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

// 角色详情：把头部（头像/名字/标签）+ 其下分隔线做成固定头部，下方资料区独立滚动
// （用户：这部分固定住、带上下面那条线一起固定）。把头部 column 从滚动列表 .nobar 内提到
// 其外、当 flex:none 固定块；原属第一段（试听）的上分隔线提成固定头部下、随头部固定的一条
// 内缩线（与下方各分组线左右对齐），第一段不再自带上分隔线/上外边距，避免双线与大空隙。
// 收藏 ♥ 仍绝对定位贴在弹窗右上、正好落在固定头部上，与滚动区里的「生成」分属固定层/滚动层，
// 从此不再打架。移出 .nobar 后头部补回左右内边距。生产专属修正，不动设计源原型。
template = template.replace(
  /(<div onClick="\{\{ charDetail\.favToggle \}\}"[\s\S]*?<\/div>)\s*(<div class="nobar" style="flex:1;min-height:0;overflow-y:auto;-webkit-overflow-scrolling:touch;padding:6px 20px 28px;">)\s*([\s\S]*?)\s*<div style="border-top:1px solid var\(--line\);margin-top:18px;padding-top:16px;">/,
  (_m, heart, nobarOpen, headerCol) => {
    const fixedHeader = headerCol.replace(
      '<div style="display:flex;flex-direction:column;align-items:center;gap:12px;">',
      '<div style="flex:none;padding:0 20px 14px;display:flex;flex-direction:column;align-items:center;gap:12px;">',
    );
    const fixedLine = '<div style="flex:none;height:1px;background:var(--line);margin:0 20px;"></div>';
    return `${fixedHeader}\n          ${fixedLine}\n          ${heart}\n          ${nobarOpen}\n            <div style="padding-top:10px;">`;
  },
);

// 性能：边缘光（旋转锥形渐变 + blur(34px) + mix-blend）在 idle/ended（应用最常驻态）
// edgeOpacity 为 0、本就不可见，却始终挂载并持续旋转，白白占用 GPU 合成。用 sc-if 按
// edgeVisible 挂载——常驻态彻底不渲染这层，仅通话各阶段才出现。零可见变化（不可见态移除）。
template = template.replace(
  /<div style="position:absolute;inset:0;overflow:hidden;pointer-events:none;mix-blend-mode:\{\{ edgeBlend \}\};opacity:\{\{ edgeOpacity \}\};transition:opacity \.9s ease;">[\s\S]*?<\/div>\s*<\/div>/,
  (m) => `<sc-if value="{{ edgeVisible }}">\n      ${m}\n      </sc-if>`,
);

// 性能：中间球的 4 个色斑（blur(15-16px) + mix-blend-mode:screen）原本各自做 scale/translate
// 持续动画 —— 尺寸变化让模糊每帧重新 rasterize，是球里最贵的一档 GPU 开销。停掉各色斑自身
// 动画（保留静态色斑 + 整体缓慢旋转 fieldAnim + 中心辉光/光晕/calling 波纹），球仍是缓转的
// 彩色发光球，开销大降。角色视频上线后这整块会被视频取代。
template = template.replace(/animation:blob[A-D] [\d.]+s ease-in-out infinite;/g, "");
// 停用后 blobA–D 的 keyframes 成为死 CSS，一并删除（各为单行）。
template = template
  .replace(/\s*@keyframes blobA\{[^\n]*\}/, "")
  .replace(/\s*@keyframes blobB\{[^\n]*\}/, "")
  .replace(/\s*@keyframes blobC\{[^\n]*\}/, "")
  .replace(/\s*@keyframes blobD\{[^\n]*\}/, "");

writeFileSync(OUT, template, "utf8");
console.log(`Wrote ${OUT} (${template.split("\n").length} lines) from prototype.`);
