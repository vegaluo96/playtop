"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/**
 * 实时自动更新：定期 router.refresh() 重取服务端数据（页面均为 force-dynamic）。
 * 页面不可见时暂停（省电省请求），回到前台立即刷一次。
 */
export default function AutoRefresh({ seconds = 60 }: { seconds?: number }) {
  const router = useRouter();
  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === "visible") router.refresh();
    };
    const timer = setInterval(tick, seconds * 1000);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [router, seconds]);
  return null;
}
