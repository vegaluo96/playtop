import { NextResponse } from "next/server";
import { ZodError } from "zod";

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export function jsonOk<T>(data: T, init?: ResponseInit): NextResponse {
  return NextResponse.json({ ok: true, data }, init);
}

export function jsonErr(status: number, error: string): NextResponse {
  return NextResponse.json({ ok: false, error }, { status });
}

/** 路由统一错误处理：HttpError → 业务错误码；Zod → 400；其余 → 500 */
export async function handleRoute(fn: () => Promise<NextResponse>): Promise<NextResponse> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof HttpError) return jsonErr(e.status, e.message);
    if (e instanceof ZodError) {
      const msg = e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
      return jsonErr(400, `参数错误：${msg}`);
    }
    console.error("[api] 未处理异常:", e);
    return jsonErr(500, "服务器内部错误");
  }
}
