"use client";

/**
 * 断点策略(HANDOFF §4.5 + KICKOFF 约束1 的合并解释):
 *   ≥1080px → 三栏终端(1080–1239 区间左右栏压至最小宽,CSS minmax 自然收缩)
 *   <1080px → 移动单列
 * 首帧返回 null(SSR 不可知),由调用方先渲染骨架避免水合错位。
 */
import { useEffect, useState } from "react";

export const DESKTOP_QUERY = "(min-width: 1080px)";

export function useIsDesktop(): boolean | null {
  const [isDesktop, setIsDesktop] = useState<boolean | null>(null);
  useEffect(() => {
    const mq = window.matchMedia(DESKTOP_QUERY);
    const update = () => setIsDesktop(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  return isDesktop;
}
