/**
 * 外部盘口校准 CLI:
 *   npm run calibrate -- samples.json
 *   npm run calibrate -- samples.json --skew 600 --water 0.05
 *   npm run calibrate -- --example
 *
 * samples 支持 JSON 数组或 JSONL。ah/ou 可填净水(0.90)或 format=decimal 的十进制赔率(1.90)。
 */
import { readFileSync } from "node:fs";
import type { ExternalOddsInput } from "../src/server/af/calibrate";
import { loadEnvFile } from "../src/server/env-file";

const EXAMPLE: ExternalOddsInput[] = [
  {
    fixtureId: 123456,
    source: "足球财富",
    market: "ah",
    line: 0.25,
    h: 0.9,
    a: 0.96,
    capturedAt: "2026-06-12T20:30:00+08:00",
    url: "https://example.com/match/123456",
  },
  {
    fixtureId: 123456,
    source: "百度世界杯",
    market: "ou",
    line: 2.5,
    h: 1.9,
    a: 1.94,
    format: "decimal",
    capturedAt: "2026-06-12T20:30:00+08:00",
  },
];

function parseSamples(path: string): ExternalOddsInput[] {
  const text = readFileSync(path, "utf8").trim();
  if (!text) return [];
  if (path.endsWith(".jsonl")) {
    return text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as ExternalOddsInput);
  }
  const v = JSON.parse(text) as ExternalOddsInput | ExternalOddsInput[];
  return Array.isArray(v) ? v : [v];
}

async function main() {
  if (loadEnvFile()) console.log("已加载 /srv/playtop.env(与 pm2 同源)");
  const args = process.argv.slice(2);
  if (args.includes("--example")) {
    console.log(JSON.stringify(EXAMPLE, null, 2));
    return;
  }
  const file = args.find((a) => !a.startsWith("--"));
  if (!file) {
    console.error("用法:npm run calibrate -- samples.json  |  --example");
    process.exit(1);
  }
  const numArg = (name: string, fallback: number) => {
    const i = args.indexOf(name);
    return i >= 0 && args[i + 1] ? Number(args[i + 1]) : fallback;
  };
  const skewSec = numArg("--skew", 600);
  const water = numArg("--water", 0.05);
  const eu = numArg("--eu", 0.08);
  const { compareExternalOdds, formatCalibrationReport, importExternalOddsSamples } = await import("../src/server/af/calibrate");
  const samples = importExternalOddsSamples(parseSamples(file));
  const rows = compareExternalOdds(samples, { skewMs: skewSec * 1000, waterTolerance: water, euTolerance: eu });
  console.log(formatCalibrationReport(rows));
  if (rows.some((r) => r.status === "fail")) process.exitCode = 2;
}

main().catch((e) => {
  console.error("✗", e instanceof Error ? e.message : e);
  process.exit(1);
});

export {};
