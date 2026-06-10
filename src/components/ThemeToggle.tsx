"use client";

import { useEffect, useState } from "react";

/** 深/浅主题切换：写 html[data-theme] + localStorage（layout 内联脚本负责首屏无闪烁恢复） */
export default function ThemeToggle() {
  const [dark, setDark] = useState(false);
  useEffect(() => {
    setDark(document.documentElement.getAttribute("data-theme") === "dark");
  }, []);
  const toggle = () => {
    const next = !dark;
    setDark(next);
    document.documentElement.setAttribute("data-theme", next ? "dark" : "light");
    try {
      localStorage.setItem("theme", next ? "dark" : "light");
    } catch {
      /* 隐私模式下忽略 */
    }
  };
  return (
    <button
      onClick={toggle}
      title="切换深/浅色主题"
      className="rounded border border-hairline px-2 py-1 text-[11px] text-muted hover:text-ink"
    >
      {dark ? "◐" : "◑"}
    </button>
  );
}
