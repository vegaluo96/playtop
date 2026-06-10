import path from "node:path";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { db } from "../src/server/db";

migrate(db, { migrationsFolder: path.join(__dirname, "..", "drizzle") });
console.log("数据库迁移完成");
