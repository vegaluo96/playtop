// 触摸手势层（产品方变更 b/c：侧栏滑动手势 + 交互优化）。
//
// 纯行为增强：监听 document 的 touchstart/touchend，在 *松手后* 判定一次滑动手势并调用
// MiCallLogic 的开/关方法。不改 DOM、不改任何 inline 样式、不 preventDefault —— 因此对
// 原生滚动零干扰，对像素级复刻零影响。手势与既有点击完全等价，只是多了一种触发方式。
//
// 覆盖：
//   • 左边缘右滑 → 开菜单；右边缘左滑 → 开历史（仅在无任何弹窗时）。
//   • 菜单已开时左滑 → 关菜单；历史已开时右滑 → 关历史。
//   • 底部弹窗已开时下滑 → 关弹窗（仅当起手处的滚动列表已在顶部，避免与列表滚动打架）。
//
// 说明：iOS Safari 标签页的「屏幕最边缘滑动」是浏览器前进/后退手势，可能与边缘开侧栏冲突；
// 加主屏/PWA（standalone）下无此冲突。起手判定带 EDGE 余量，尽量与原生手势错开。
import { useEffect } from "react";
import type { MiCallLogic } from "./MiCallLogic";

export function useGestures(logic: MiCallLogic): void {
  useEffect(() => {
    let sx = 0; // 起手 X
    let sy = 0; // 起手 Y
    let st = 0; // 起手时间
    let tracking = false;
    let startScrollTop = 0; // 起手处所在滚动列表的 scrollTop

    const EDGE = 30; // 边缘起手判定带宽(px)
    const H_THRESH = 56; // 水平触发位移阈值
    const V_THRESH = 80; // 垂直(下滑关弹窗)触发位移阈值
    const MAX_MS = 700; // 超过则视为「慢拖/犹豫」，不当作滑动手势

    // 起手点所在最近的滚动列表(.nobar)，用于判断下滑关闭是否应让位给列表滚动。
    const nearestScroller = (el: EventTarget | null): Element | null => {
      let n = el instanceof Element ? el : null;
      for (; n; n = n.parentElement) {
        if (n.classList && n.classList.contains("nobar")) return n;
      }
      return null;
    };

    const onStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) { tracking = false; return; }
      const t = e.touches[0];
      sx = t.clientX; sy = t.clientY; st = Date.now(); tracking = true;
      const sc = nearestScroller(e.target);
      startScrollTop = sc ? sc.scrollTop : 0;
    };

    const onEnd = (e: TouchEvent) => {
      if (!tracking) return;
      tracking = false;
      const t = e.changedTouches[0];
      if (!t) return;
      const dx = t.clientX - sx;
      const dy = t.clientY - sy;
      const adx = Math.abs(dx);
      const ady = Math.abs(dy);
      if (Date.now() - st > MAX_MS) return;

      const snap = logic.gestureSnapshot();
      if (snap.modal) return; // 模态对话框时不接管

      // 水平手势（侧栏滑入/滑出）优先。
      if (adx > H_THRESH && adx > ady * 1.4) {
        if (snap.menuOpen) { if (dx < 0) logic.closeMenu(); return; }
        if (snap.historyOpen) { if (dx > 0) logic.closeHistory(); return; }
        if (!snap.sheetOpen) {
          if (dx > 0 && sx <= EDGE) logic.openMenu();
          else if (dx < 0 && sx >= window.innerWidth - EDGE) logic.openHistory();
        }
        return;
      }

      // 垂直下滑关闭底部弹窗（仅当起手处滚动列表已在顶部，避免与滚动打架）。
      if (dy > V_THRESH && ady > adx * 1.4 && snap.sheetOpen && startScrollTop <= 0) {
        logic.closeTopSheet();
      }
    };

    document.addEventListener("touchstart", onStart, { passive: true });
    document.addEventListener("touchend", onEnd, { passive: true });
    return () => {
      document.removeEventListener("touchstart", onStart);
      document.removeEventListener("touchend", onEnd);
    };
  }, [logic]);
}
