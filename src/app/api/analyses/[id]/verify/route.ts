import { handleRoute, jsonOk } from "@/server/lib/api";
import { verifyAnalysis } from "@/server/services/publish";

/** 公开接口：任何人可验证报告未被篡改（内容哈希 + 链式前驱） */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handleRoute(async () => {
    const { id } = await params;
    return jsonOk(verifyAnalysis(Number(id)));
  });
}
