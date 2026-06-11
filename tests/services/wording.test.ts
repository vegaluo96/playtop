import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * 前台合规词表（防回流）：用户可见层（页面/组件/研报模板/引擎 trace）
 * 不得出现下注引导类表述。统一替代口径：赛前观点 / 模型方向 / 参考赔率 /
 * 最低可接受赔率 / 可评估点位 / 模拟单位（风险刻度）/ 赛后公开验证。
 */
const BANNED = [
  "下注建议",
  "可下注",
  "建议仓位",
  "赌球",
  "稳赚",
  "必中",
  "包赢",
  "梭哈",
  "跟单",
  "自动下注",
  "投注通道",
  "充值投注",
  "收益承诺",
  "投注平台",
  "开户",
  "套利",
  "对冲仓位",
];
const SCAN_DIRS = ["src/app", "src/components", "src/server/llm", "src/server/engine"];
/** 否定式声明（"不构成投注建议/不提供投注平台"）是合规要求本身，放行 */
const NEGATION = /不构成|不提供|不跳转/;

function* walk(dir: string): Generator<string> {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (/\.(ts|tsx)$/.test(e.name)) yield p;
  }
}

describe("前台合规词表", () => {
  it("用户可见代码不出现违禁表述", () => {
    const violations: string[] = [];
    for (const dir of SCAN_DIRS) {
      for (const file of walk(path.join(process.cwd(), dir))) {
        const lines = fs.readFileSync(file, "utf8").split("\n");
        lines.forEach((line, i) => {
          if (NEGATION.test(line)) return;
          for (const w of BANNED) {
            if (line.includes(w)) violations.push(`${path.relative(process.cwd(), file)}:${i + 1} 「${w}」`);
          }
        });
      }
    }
    expect(violations, violations.join("\n")).toEqual([]);
  });
});
