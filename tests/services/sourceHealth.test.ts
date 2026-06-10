import { beforeAll, describe, expect, it } from "vitest";

import { runMigrations } from "@/server/db/migrate";
import { setConfig } from "@/server/lib/config";
import { isSourceUsable, reportSourceFail, reportSourceOk, withSource } from "@/server/services/sourceHealth";

beforeAll(() => {
  runMigrations();
  setConfig("datasources", { sourceAutoDisableAfter: 3 });
});

describe("数据源健康账本与自动停用", () => {
  it("连败达阈值自动停用，成功一次即复活", () => {
    expect(isSourceUsable("demo", true)).toBe(true);
    reportSourceFail("demo", "网络错误");
    reportSourceFail("demo", "网络错误");
    expect(isSourceUsable("demo", true)).toBe(true); // 连败 2 < 3
    reportSourceFail("demo", "网络错误");
    expect(isSourceUsable("demo", true)).toBe(false); // 自动停用
    reportSourceOk("demo");
    expect(isSourceUsable("demo", true)).toBe(true); // 复活
  });

  it("开关关闭时无论健康与否都不可用", () => {
    reportSourceOk("demo2");
    expect(isSourceUsable("demo2", false)).toBe(false);
  });

  it("withSource：成功记账并透传返回值，失败记账并重抛", async () => {
    const v = await withSource("demo3", async () => 42);
    expect(v).toBe(42);
    await expect(withSource("demo3", async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(isSourceUsable("demo3", true)).toBe(true); // 1 次失败未达阈值
  });

  it("阈值 0 = 不自动停用", () => {
    setConfig("datasources", { sourceAutoDisableAfter: 0 });
    for (let i = 0; i < 10; i++) reportSourceFail("demo4", "x");
    expect(isSourceUsable("demo4", true)).toBe(true);
    setConfig("datasources", { sourceAutoDisableAfter: 3 });
  });
});
