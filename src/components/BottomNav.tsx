"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/", label: "赛事", icon: "◉" },
  { href: "/record", label: "战绩", icon: "▦" },
  { href: "/me", label: "我的", icon: "◈" },
];

export default function BottomNav() {
  const pathname = usePathname();
  return (
    <nav className="fixed inset-x-0 bottom-0 z-40 mx-auto max-w-md border-t border-hairline bg-surface/95 backdrop-blur md:hidden">
      <div className="grid grid-cols-3">
        {TABS.map((t) => {
          const active = t.href === "/" ? pathname === "/" || pathname.startsWith("/matches") : pathname.startsWith(t.href);
          return (
            <Link
              key={t.href}
              href={t.href}
              className={`flex flex-col items-center gap-0.5 py-2.5 text-[11px] tracking-wider ${
                active ? "text-gold-bright" : "text-faint"
              }`}
            >
              <span className="text-base leading-none">{t.icon}</span>
              {t.label}
            </Link>
          );
        })}
      </div>
      <div className="h-[env(safe-area-inset-bottom)]" />
    </nav>
  );
}
