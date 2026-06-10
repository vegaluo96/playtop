"use client";

import { useRouter } from "next/navigation";

export default function LogoutButton() {
  const router = useRouter();
  return (
    <button
      onClick={async () => {
        await fetch("/api/auth/logout", { method: "POST" });
        router.push("/");
        router.refresh();
      }}
      className="w-full rounded border border-hairline py-2.5 text-[12px] tracking-widest text-faint hover:text-muted"
    >
      退出登录
    </button>
  );
}
