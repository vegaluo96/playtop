import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema";

export type DB = BetterSQLite3Database<typeof schema>;

function resolveDbPath(): string {
  const p = process.env.DATABASE_PATH ?? path.join(process.cwd(), "data", "app.db");
  if (p === ":memory:") return p;
  return path.isAbsolute(p) ? p : path.join(process.cwd(), p);
}

function createDb(): DB {
  const dbPath = resolveDbPath();
  if (dbPath !== ":memory:") fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const sqlite = new Database(dbPath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");
  return drizzle(sqlite, { schema });
}

// dev HMR / 多入口下保持单连接
const g = globalThis as unknown as { __playtopDb?: DB };
export const db: DB = g.__playtopDb ?? (g.__playtopDb = createDb());

export { schema };
