import path from "node:path";
import fs from "node:fs";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { db } from "./index";

/** 幂等迁移：应用启动与脚本共用 */
export function runMigrations(): void {
  const candidates = [
    path.join(process.cwd(), "drizzle"),
    path.join(process.cwd(), "..", "drizzle"),
  ];
  const folder = candidates.find((p) => fs.existsSync(path.join(p, "meta", "_journal.json")));
  if (!folder) throw new Error("找不到 drizzle 迁移目录");
  migrate(db, { migrationsFolder: folder });
}
