import Link from "next/link";
import { redirect } from "next/navigation";
import { currentUser } from "@/server/auth/guards";

const NAV = [
  { href: "/admin", label: "运营看板" },
  { href: "/admin/matches", label: "比赛管理" },
  { href: "/admin/users", label: "用户与积分" },
  { href: "/admin/settings", label: "系统设置" },
];

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const user = await currentUser();
  if (!user || user.role !== "admin") redirect("/login");
  return (
    <div className="mx-auto flex min-h-screen max-w-6xl flex-col md:flex-row">
      {/* 后台同样是在线网页（/admin），手机与桌面自适应 */}
      <aside className="shrink-0 border-b border-hairline px-4 py-3 md:w-48 md:border-r md:border-b-0 md:py-6">
        <div className="flex items-center justify-between md:block">
          <div>
            <Link href="/" className="font-display block text-base tracking-[0.25em] text-gold-bright">
              PLAYTOP
            </Link>
            <div className="mt-0.5 text-[10px] tracking-[0.3em] text-faint">管理后台</div>
          </div>
          <div className="text-[11px] text-faint md:hidden">{user.username}</div>
        </div>
        <nav className="mt-3 flex gap-1 overflow-x-auto md:mt-8 md:flex-col md:gap-0 md:space-y-1">
          {NAV.map((n) => (
            <Link
              key={n.href}
              href={n.href}
              className="shrink-0 rounded px-3 py-2 text-[13px] whitespace-nowrap text-muted hover:bg-overlay hover:text-ink"
            >
              {n.label}
            </Link>
          ))}
        </nav>
        <div className="mt-10 hidden border-t border-hairline pt-4 text-[11px] text-faint md:block">
          {user.username}
          <br />
          <Link href="/" className="text-muted underline underline-offset-4">
            返回前台
          </Link>
        </div>
      </aside>
      <main className="min-w-0 flex-1 px-4 py-4 md:px-6 md:py-6">{children}</main>
    </div>
  );
}
