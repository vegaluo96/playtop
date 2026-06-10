import Link from "next/link";
import BottomNav from "@/components/BottomNav";
import ThemeToggle from "@/components/ThemeToggle";
import { LiveBadge } from "@/components/ui";
import { currentUser } from "@/server/auth/guards";

export default async function UserLayout({ children }: { children: React.ReactNode }) {
  const user = await currentUser();
  return (
    <div className="mx-auto min-h-screen max-w-md pb-20">
      <header className="sticky top-0 z-30 border-b border-hairline bg-bg/90 backdrop-blur">
        <div className="flex items-center justify-between px-4 py-3">
          <Link href="/" className="flex items-baseline gap-2">
            <span className="font-display text-lg tracking-wider text-gold-bright">PLAYTOP</span>
            <span className="text-[10px] tracking-wider text-muted">量化球研</span>
          </Link>
          <div className="flex items-center gap-2">
            <ThemeToggle />
            <LiveBadge />
            {user ? (
              <Link href="/me" className="tabular rounded border border-gold/40 px-2 py-1 text-[11px] text-gold-bright">
                {user.points} 分
              </Link>
            ) : (
              <Link href="/login" className="rounded border border-hairline px-2 py-1 text-[11px] text-muted">
                登录
              </Link>
            )}
          </div>
        </div>
      </header>
      <main className="px-4">{children}</main>
      <BottomNav />
    </div>
  );
}
