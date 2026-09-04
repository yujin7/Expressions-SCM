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
 *
 * 第二个缺口（2026-09-04 清理审计 #8）：手写迁移直接进 journal 而**不带 meta 快照**。
 * `0039_canonical_sku_external_scopes` 与 `0046_calm_read_model` 就是这么来的——
 * 53 条 entry 只有 50 份快照。后果同样静默：`drizzle-kit up` / `check` 逐条读快照会崩，
 * 历史重放断链，而 generate、dev、测试照常绿。更隐蔽的是 0046：下一次 generate 拿
 * 0045 的快照当基线，于是把 0046 已经建过的 `report_read_model_cache` 又生成了一遍
 * CREATE TABLE（当时靠人工在 0047 里删掉才没炸）。
 * 两份缺失快照已按邻居重建（0039 是纯数据迁移→与 0038 同态；0046 = 0045 + 该表），
 * prevId 链已重新接上，`drizzle-kit check` / `up` 均通过。下面这条断言钉住"不许再缺"。
 */
import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
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

  it("每条 journal entry 都有 meta 快照（缺快照 = drizzle-kit up/check 崩、历史重放断链）", () => {
    const journal = JSON.parse(readFileSync(path.join(DRIZZLE, "meta", "_journal.json"), "utf8")) as {
      entries: { idx: number; tag: string }[];
    };
    expect(journal.entries.length, "未读到任何 journal entry，解析逻辑可能已失效").toBeGreaterThan(10);

    const noSnapshot = journal.entries
      .map((e) => e.tag)
      .filter((tag) => !existsSync(path.join(DRIZZLE, "meta", `${tag.slice(0, 4)}_snapshot.json`)));
    expect(
      noSnapshot,
      `以下迁移在 drizzle/meta 没有快照：\n${noSnapshot.join("\n")}\n`
        + `手写迁移也必须补快照——drizzle-kit up/check 逐条读快照会直接崩，`
        + `而下一次 generate 会拿更早的快照当基线，把这条迁移已经建过的对象再生成一遍 DDL。`,
    ).toEqual([]);

    // 快照的 prevId 必须首尾相接：断链时 drizzle 无法重放历史（0039/0046 曾整段缺失）
    const snapshots = readdirSync(path.join(DRIZZLE, "meta"))
      .filter((f) => /^\d{4}_snapshot\.json$/.test(f))
      .sort()
      .map((f) => JSON.parse(readFileSync(path.join(DRIZZLE, "meta", f), "utf8")) as { id: string; prevId: string });
    const breaks = snapshots
      .slice(1)
      .map((s, i) => (s.prevId === snapshots[i].id ? null : `${i} → ${i + 1}`))
      .filter((v): v is string => v != null);
    expect(breaks, `快照 prevId 链在以下位置断开：\n${breaks.join("\n")}`).toEqual([]);
  });
});
