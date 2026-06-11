/**
 * 服务器 env 文件自动加载(/srv/playtop.env,PLAYTOP_ENV_FILE 可覆盖):
 * 防止手跑 CLI 时漏带环境变量而连到错误的 PLAYTOP_DB(只补缺,不覆盖已有 env)。
 */
import { existsSync, readFileSync } from "node:fs";

export function loadEnvFile(path = process.env.PLAYTOP_ENV_FILE || "/srv/playtop.env"): boolean {
  try {
    if (!existsSync(path)) return false;
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const i = t.indexOf("=");
      if (i <= 0) continue;
      const k = t.slice(0, i).trim();
      if (!(k in process.env)) process.env[k] = t.slice(i + 1).trim();
    }
    return true;
  } catch {
    return false;
  }
}
