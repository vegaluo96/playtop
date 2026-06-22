// UI integrity check: every {{ root }} reference in the template must resolve to
// a renderVals key, a sc-for loop variable, a prop, or a literal — otherwise it
// renders blank (a silent UI bug). Reports anything unknown.
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

const { MiCallLogic } = await import("../src/logic/MiCallLogic.ts");

const here = dirname(fileURLToPath(import.meta.url));
const template = readFileSync(join(here, "../src/app.template.html"), "utf8");

// Known roots: renderVals keys + props + sc-for loop vars + literals.
const logic: any = new MiCallLogic({ theme: "light", orbColor: "#AAB8FF", aiName: "VEGAluo" });
const known = new Set<string>(Object.keys(logic.renderVals()));
["theme", "orbColor", "aiName", "true", "false", "null", "undefined"].forEach((k) => known.add(k));
for (const m of template.matchAll(/\bas="([A-Za-z_$][\w$]*)"/g)) known.add(m[1]);

const unknown = new Map<string, number>();
for (const m of template.matchAll(/\{\{([\s\S]+?)\}\}/g)) {
  const expr = m[1].replace(/"[^"]*"|'[^']*'/g, ""); // drop string literals
  for (const idm of expr.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)/g)) {
    const id = idm[1];
    if (/^\d/.test(id)) continue;
    if (!known.has(id)) unknown.set(id, (unknown.get(id) || 0) + 1);
  }
}

if (unknown.size) {
  console.error("✗ Unresolved bindings (would render blank):");
  for (const [id, n] of [...unknown].sort((a, b) => b[1] - a[1])) {
    console.error(`   {{ ${id} }} ×${n}`);
  }
  process.exit(1);
}
console.log(`✓ All ${known.size} known roots cover every {{ }} binding — no blank-UI references.`);
