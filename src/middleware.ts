import { NextRequest, NextResponse } from "next/server";

export function middleware(req: NextRequest) {
  const host = req.headers.get("host") ?? "";
  if (host.startsWith("admin.") && !req.nextUrl.pathname.startsWith("/admin") && !req.nextUrl.pathname.startsWith("/api") && !req.nextUrl.pathname.startsWith("/_next")) {
    const url = req.nextUrl.clone();
    url.pathname = "/admin";
    return NextResponse.rewrite(url);
  }
  return NextResponse.next();
}
