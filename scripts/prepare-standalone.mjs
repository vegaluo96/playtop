import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const standalone = join(root, ".next", "standalone");
const staticSrc = join(root, ".next", "static");
const staticDest = join(standalone, ".next", "static");
const publicSrc = join(root, "public");
const publicDest = join(standalone, "public");

if (!existsSync(standalone)) {
  console.log("[prepare-standalone] skip: .next/standalone not found");
  process.exit(0);
}

if (existsSync(staticSrc)) {
  mkdirSync(join(standalone, ".next"), { recursive: true });
  rmSync(staticDest, { recursive: true, force: true });
  cpSync(staticSrc, staticDest, { recursive: true });
}

if (existsSync(publicSrc)) {
  rmSync(publicDest, { recursive: true, force: true });
  cpSync(publicSrc, publicDest, { recursive: true });
}

console.log("[prepare-standalone] copied static assets");
