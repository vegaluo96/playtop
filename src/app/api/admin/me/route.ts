import { NextResponse } from "next/server";
import { currentAdmin } from "@/server/admin/auth";

export async function GET() {
  const a = await currentAdmin();
  if (!a) return NextResponse.json({ ok: false }, { status: 401 });
  return NextResponse.json({ ok: true, email: a.email, role: a.role });
}
