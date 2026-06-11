import { NextResponse } from "next/server";
import { currentAdmin, listAudit } from "@/server/admin/auth";

export async function GET() {
  if (!(await currentAdmin())) return NextResponse.json({ ok: false }, { status: 401 });
  return NextResponse.json({ ok: true, rows: listAudit(120) });
}
