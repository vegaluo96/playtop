import { NextRequest, NextResponse } from "next/server";

export function middleware(req: NextRequest) {
  const host = req.headers.get("host") ?? "";
  // URL 规范化:www → 裸域 301(canonical 唯一入口)
  if (host.startsWith("www.")) {
    const url = req.nextUrl.clone();
    url.host = host.slice(4);
    return NextResponse.redirect(url, 301);
  }
  if (host.startsWith("admin.") && !req.nextUrl.pathname.startsWith("/admin") && !req.nextUrl.pathname.startsWith("/api") && !req.nextUrl.pathname.startsWith("/_next")) {
    const url = req.nextUrl.clone();
    url.pathname = "/admin";
    return NextResponse.rewrite(url);
  }
  return NextResponse.next();
}
