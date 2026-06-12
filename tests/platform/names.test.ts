/** 名称汉化:词典 → name_zh 表 → 原名+入队;中文旁路 */
import { beforeEach, describe, expect, it } from "vitest";

process.env.PLAYTOP_DB = ":memory:";

import { db, _resetDbForTest } from "../../src/server/db";
import { nameZh } from "../../src/server/views/names";
import { kvGet } from "../../src/server/af/store";

beforeEach(() => {
  _resetDbForTest();
  db();
});

describe("nameZh", () => {
  it("词典命中:主流球队/国家队/教练", () => {
    expect(nameZh("Manchester City")).toBe("曼城");
    expect(nameZh("Real Madrid")).toBe("皇家马德里");
    expect(nameZh("Mexico")).toBe("墨西哥");
    expect(nameZh("South Africa")).toBe("南非");
    expect(nameZh("Bosnia and Herzegovina")).toBe("波黑");
    expect(nameZh("Bosnia & Herzegovina")).toBe("波黑");
    expect(nameZh("Pep Guardiola", "coach")).toBe("瓜迪奥拉");
  });

  it("表命中:LLM 缓存译名", () => {
    db().prepare("INSERT INTO name_zh (raw, kind, zh, src, updated_at) VALUES ('FC Obscure', 'team', '无名俱乐部', 'llm', 1)").run();
    expect(nameZh("FC Obscure")).toBe("无名俱乐部");
  });

  it("固定短名优先:避免长国名撑开用户端", () => {
    db().prepare("INSERT INTO name_zh (raw, kind, zh, src, updated_at) VALUES ('Bosnia & Herzegovina', 'team', '波斯尼亚和黑塞哥维那', 'llm', 1)").run();

    expect(nameZh("Bosnia & Herzegovina")).toBe("波黑");
    expect(nameZh("波斯尼亚和黑塞哥维那")).toBe("波黑");
  });

  it("未命中:返回原名并入队待译;中文输入旁路", () => {
    expect(nameZh("Random Unknown FC")).toBe("Random Unknown FC");
    const q = JSON.parse(kvGet("namezh:queue") || "[]") as { raw: string }[];
    expect(q.some((x) => x.raw === "Random Unknown FC")).toBe(true);
    expect(nameZh("曼城")).toBe("曼城");
  });
});
