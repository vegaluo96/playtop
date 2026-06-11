/** 轻量自有埋点(看板用):visit / match_view;不引第三方统计 */
import { NextRequest, NextResponse } from "next/server";
import { bump } from "@/server/admin/metrics";

export async function POST(req: NextRequest) {
  const { k, id } = (await req.json().catch(() => ({}))) as { k?: string; id?: number };
  if (k === "visit") bump("visits");
  else if (k === "match_view" && id) {
    bump("match_views");
    bump(`mv:${Number(id)}`);
  } else return NextResponse.json({ ok: false }, { status: 400 });
  return NextResponse.json({ ok: true });
}
