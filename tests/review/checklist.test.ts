import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { auditLogs, reviewItems } from "@/db/schema";
import type { DB } from "@/db";
import {
  bulkDecideReviewItems,
  countReviewItems,
  decideReviewItem,
  listReviewItems,
} from "@/server/modules/review/checklist";
import { createTestDb, type TestDb } from "../helpers/db";

describe("在案复核清单：列表/计数/改判/批量/角色门禁", () => {
  let db: TestDb;
  let dbx: DB;
  let ids: number[] = [];
  const pmc = { id: 11, name: "PMC", roles: ["pmc"] };
  const ops = { id: 12, name: "运营", roles: ["ops"] };

  beforeAll(async () => {
    ({ db } = await createTestDb());
    dbx = db as unknown as DB;
    const rows = await db
      .insert(reviewItems)
      .values([
        { category: "spu_cluster", refType: "spu", refKey: "DEV001", title: "SPU 簇代决接受：DEV001", detail: "成员 1" },
        { category: "bom_version", refType: "bom", refKey: "N009-004", title: "BOM 歧义代决：N009-004", detail: "1 块" },
        { category: "segment", refType: "sku", refKey: "N032-0501", title: "物料代决分类为包材：N032-0501 中文标贴" },
        { category: "uncoded", title: "无编码物料待人工建档：收缩膜", detail: "出现 284 次" },
      ])
      .returning({ id: reviewItems.id });
    ids = rows.map((r) => r.id);
  });

  it("列表：类别/状态/关键字过滤", async () => {
    const all = await listReviewItems({ page: 1, pageSize: 10 }, dbx);
    expect(all.total).toBe(4);
    const cat = await listReviewItems({ category: "bom_version", page: 1, pageSize: 10 }, dbx);
    expect(cat.total).toBe(1);
    expect(cat.data[0].refKey).toBe("N009-004");
    const q = await listReviewItems({ q: "收缩膜", page: 1, pageSize: 10 }, dbx);
    expect(q.total).toBe(1);
    const none = await listReviewItems({ status: "done", page: 1, pageSize: 10 }, dbx);
    expect(none.total).toBe(0);
    // 非法类别值被忽略（不过滤）
    const bad = await listReviewItems({ category: "hacker", page: 1, pageSize: 10 }, dbx);
    expect(bad.total).toBe(4);
  });

  it("单条通过/改判/重开 + 审计", async () => {
    const done = await decideReviewItem(pmc, ids[0], { status: "done" }, dbx);
    expect(done.status).toBe("done");
    expect(done.decidedBy).toBe(pmc.id);
    expect(done.decidedAt).not.toBeNull();

    const over = await decideReviewItem(pmc, ids[1], { status: "overruled", note: "版本取错，应取首块" }, dbx);
    expect(over.status).toBe("overruled");
    expect(over.note).toBe("版本取错，应取首块");

    const reopened = await decideReviewItem(pmc, ids[0], { status: "open" }, dbx);
    expect(reopened.status).toBe("open");
    expect(reopened.decidedBy).toBeNull();
    expect(reopened.decidedAt).toBeNull();

    const audits = await db.select().from(auditLogs).where(eq(auditLogs.entity, "review_item"));
    expect(audits.length).toBeGreaterThanOrEqual(3);
    expect(audits.map((a) => a.action)).toEqual(
      expect.arrayContaining(["review_done", "review_overrule", "review_reopen"]),
    );
  });

  it("计数按类别×状态分组", async () => {
    const { counts } = await countReviewItems(dbx);
    const bomOverruled = counts.find((c) => c.category === "bom_version" && c.status === "overruled");
    expect(bomOverruled?.count).toBe(1);
    const spuOpen = counts.find((c) => c.category === "spu_cluster" && c.status === "open");
    expect(spuOpen?.count).toBe(1);
  });

  it("批量通过 + 审计（按批 1 行）", async () => {
    const res = await bulkDecideReviewItems(pmc, { ids: [ids[2], ids[3]], status: "done" }, dbx);
    expect(res.updated).toBe(2);
    const rows = await listReviewItems({ status: "done", page: 1, pageSize: 10 }, dbx);
    expect(rows.total).toBe(2);
    const audits = await db.select().from(auditLogs).where(eq(auditLogs.action, "review_bulk"));
    expect(audits).toHaveLength(1);
  });

  it("角色门禁：运营无决策权（403）；不存在的项 404", async () => {
    await expect(decideReviewItem(ops, ids[0], { status: "done" }, dbx)).rejects.toThrow(/无权限/);
    await expect(bulkDecideReviewItems(ops, { ids: [ids[0]], status: "done" }, dbx)).rejects.toThrow(/无权限/);
    await expect(decideReviewItem(pmc, 999999, { status: "done" }, dbx)).rejects.toThrow(/不存在/);
    await expect(decideReviewItem(pmc, ids[0], { status: "deleted" }, dbx)).rejects.toThrow();
  });
});
