import { handleRoute, jsonOk } from "@/server/lib/api";
import { requireAdmin } from "@/server/auth/guards";
import { SOURCE_REGISTRY } from "@/server/datasources/registry";
import { getConfig } from "@/server/lib/config";
import { listSourceHealth, reportSourceFail, reportSourceOk } from "@/server/services/sourceHealth";
import { recordProviderHealth } from "@/server/v2/providers";

export const maxDuration = 120;

/**
 * 数据源体检：并发真实拉取全部源并解析样例，逐源记入健康账本
 * （成功即复活被自动停用的源）。后台因子表的数据来源。
 */
export async function POST() {
  return handleRoute(async () => {
    await requireAdmin();
    const ds = getConfig("datasources") as unknown as Record<string, unknown>;
    const results = await Promise.all(
      SOURCE_REGISTRY.map(async (s) => {
        const enabled = s.configKey ? ds[s.configKey] !== false : true;
        if (!enabled) return { 源: s.label, 状态: "已关闭", 结果: "—" };
        const start = Date.now();
        try {
          const summary = await Promise.race([
            s.probe(),
            new Promise<never>((_, rej) => setTimeout(() => rej(new Error("超时(25s)")), 25_000)),
          ]);
          reportSourceOk(s.key);
          recordProviderHealth({ providerName: s.key, latencyMs: Date.now() - start, ok: true });
          return { 源: s.label, 状态: "✓ 正常", 耗时ms: Date.now() - start, 结果: summary };
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          reportSourceFail(s.key, msg);
          recordProviderHealth({ providerName: s.key, latencyMs: Date.now() - start, ok: false, details: { error: msg.slice(0, 200) } });
          return { 源: s.label, 状态: "✗ 失败", 耗时ms: Date.now() - start, 结果: msg.slice(0, 160) };
        }
      }),
    );
    const health = Object.fromEntries(listSourceHealth().map((h) => [h.source, h.consecutiveFails]));
    return jsonOk({ 体检: results, 连败计数: health });
  });
}
