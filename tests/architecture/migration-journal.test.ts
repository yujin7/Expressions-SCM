/**
 * 架构护栏：drizzle/*.sql 必须逐一登记进 drizzle/meta/_journal.json。
 *
 * 事故背景（2026-07-25）：0018_drop_unread_rollups.sql 手工丢进 drizzle/ 却没登记 journal。
 * dev 与测试按**文件名扫描**应用迁移（src/db/index.ts、tests/helpers/db.ts），所以照常生效；
 * 而 prod 的 `drizzle-kit migrate` 只遍历 journal.entries —— 未登记的文件对生产**完全不可见**，
 * 两侧 schema 就此分叉。
 *
 * 为什么必须由测试来守：这个缺口对**四个**面同时静默——
 * drizzle-kit generate、drizzle-kit check、测试与 dev、/api/health 全都不报。
 * 当时是靠人工数文件数（19 个 .sql vs 18 条 entry）才发现的。
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const DRIZZLE = path.resolve(__dirname, "../../drizzle");

describe("架构护栏：迁移登记", () => {
  it("每个 .sql 都在 _journal.json 里（未登记的文件生产永远不会执行）", () => {
    const sqls = readdirSync(DRIZZLE).filter((f) => f.endsWith(".sql")).sort();
    const journal = JSON.parse(readFileSync(path.join(DRIZZLE, "meta", "_journal.json"), "utf8")) as {
      entries: { idx: number; tag: string }[];
    };
    const tags = new Set(journal.entries.map((e) => e.tag));

    // 防腐化：目录改名/读空时不能「全绿」
    expect(sqls.length, "未读到任何迁移文件，解析逻辑可能已失效").toBeGreaterThan(10);

    const orphans = sqls.map((f) => f.replace(/\.sql$/, "")).filter((tag) => !tags.has(tag));
    expect(
      orphans,
      `以下迁移文件未登记进 _journal.json，prod 的 drizzle-kit migrate 永远不会执行它们，` +
        `而 dev/测试按文件名扫描会照常应用 —— 两侧 schema 分叉且四个面全都不报：\n` +
        orphans.join("\n"),
    ).toEqual([]);

    // 反向：journal 里不能有指向不存在文件的条目
    const missing = journal.entries.map((e) => e.tag).filter((t) => !sqls.includes(`${t}.sql`));
    expect(missing, `_journal.json 指向了不存在的 .sql：\n${missing.join("\n")}`).toEqual([]);
  });
});
