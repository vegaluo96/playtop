// UI integrity check for the Admin template — see frontend/scripts/lint-bindings.tsx.
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const dom = new JSDOM("<!doctype html><html><head></head><body></body></html>", { url: "http://localhost/" });
const g = globalThis as any;
g.window = dom.window;
g.document = dom.window.document;
g.DOMParser = dom.window.DOMParser;
g.Node = dom.window.Node;

const { AdminLogic } = await import("../src/logic/AdminLogic.ts");

const here = dirname(fileURLToPath(import.meta.url));
const template = readFileSync(join(here, "../src/app.template.html"), "utf8");

const logic: any = new AdminLogic();
const known = new Set<string>(Object.keys(logic.renderVals()));
["true", "false", "null", "undefined"].forEach((k) => known.add(k));
for (const m of template.matchAll(/\bas="([A-Za-z_$][\w$]*)"/g)) known.add(m[1]);

const unknown = new Map<string, number>();
for (const m of template.matchAll(/\{\{([\s\S]+?)\}\}/g)) {
  const expr = m[1].replace(/"[^"]*"|'[^']*'/g, "");
  for (const idm of expr.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)/g)) {
    const id = idm[1];
    if (/^\d/.test(id)) continue;
    if (!known.has(id)) unknown.set(id, (unknown.get(id) || 0) + 1);
  }
}

if (unknown.size) {
  console.error("✗ Unresolved bindings (would render blank):");
  for (const [id, n] of [...unknown].sort((a, b) => b[1] - a[1])) console.error(`   {{ ${id} }} ×${n}`);
  process.exit(1);
}
console.log(`✓ All ${known.size} known roots cover every {{ }} binding — no blank-UI references.`);
