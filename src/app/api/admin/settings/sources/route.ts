import { handleRoute, jsonOk } from "@/server/lib/api";
import { requireAdmin } from "@/server/auth/guards";
import { SOURCE_REGISTRY } from "@/server/datasources/registry";
import { getConfig } from "@/server/lib/config";
import { listSourceHealth } from "@/server/services/sourceHealth";

/** 数据源因子表：注册表（注释/权重说明）× 健康账本（成败/连败/自动停用）× 开关状态 */
export async function GET() {
  return handleRoute(async () => {
    await requireAdmin();
    const ds = getConfig("datasources");
    const threshold = ds.sourceAutoDisableAfter;
    const health = new Map(listSourceHealth().map((h) => [h.source, h]));
    const dsRec = ds as unknown as Record<string, unknown>;
    return jsonOk({
      threshold,
      sources: SOURCE_REGISTRY.map((s) => {
        const h = health.get(s.key);
        const enabled = s.configKey ? dsRec[s.configKey] !== false : true;
        const autoDisabled = threshold > 0 && (h?.consecutiveFails ?? 0) >= threshold;
        return {
          key: s.key,
          label: s.label,
          note: s.note,
          weightNote: s.weightNote,
          configKey: s.configKey,
          enabled,
          autoDisabled,
          okCount: h?.okCount ?? 0,
          failCount: h?.failCount ?? 0,
          consecutiveFails: h?.consecutiveFails ?? 0,
          lastOkAt: h?.lastOkAt ?? null,
          lastError: h?.lastError ?? null,
        };
      }),
    });
  });
}
