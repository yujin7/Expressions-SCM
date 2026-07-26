import { beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { auditLogs, skus, spus } from "@/db/schema";
import type { DB } from "@/db";
import { listSpuMembers, regroupSkus } from "@/server/modules/master/spu";
import { createTestDb, type TestDb } from "../helpers/db";

describe("SPU 批量归组 regroupSkus / listSpuMembers", () => {
  let db: TestDb;
  let dbx: DB;
  let spuA = 0;
  let spuB = 0;
  let s1 = 0;
  let s2 = 0;
  const pmc = { id: 21 };

  beforeAll(async () => {
    ({ db } = await createTestDb());
    dbx = db as unknown as DB;
    const [a] = await db.insert(spus).values({ code: "PRG01", nameCn: "簇A" }).returning();
    const [b] = await db.insert(spus).values({ code: "PRG02", nameCn: "簇B" }).returning();
    spuA = a.id;
    spuB = b.id;
    const [x] = await db
      .insert(skus)
      .values({
        code: "RG-S1", name: "壳SKU", spuId: spuA, baseUom: "件", skuType: "finished",
        attrs: { needsReview: ["spu", "baseUom"], source: "shell_import" },
      })
      .returning();
    const [y] = await db
      .insert(skus)
      .values({ code: "RG-S2", name: "普通SKU", spuId: spuA, baseUom: "个", skuType: "finished" })
      .returning();
    s1 = x.id;
    s2 = y.id;
  });

  it("成员列表带 needsReview 徽标数据", async () => {
    const res = await listSpuMembers(spuA, dbx);
    expect(res.total).toBe(2);
    const shell = res.data.find((r) => r.code === "RG-S1")!;
    expect(shell.needsReview).toEqual(["spu", "baseUom"]);
    expect(res.data.find((r) => r.code === "RG-S2")!.needsReview).toEqual([]);
  });

  it("移入目标 SPU：spuId 改挂 + 清除 needsReview 的 spu 标记 + 审计 before/after", async () => {
    const res = await regroupSkus(pmc, spuB, { skuIds: [s1, s2], mode: "move-in" }, dbx);
    expect(res.moved).toBe(2);
    const [r1] = await db.select().from(skus).where(eq(skus.id, s1));
    const [r2] = await db.select().from(skus).where(eq(skus.id, s2));
    expect(r1.spuId).toBe(spuB);
    expect(r2.spuId).toBe(spuB);
    // "spu" 标记被清除，其余标记保留
    expect((r1.attrs as { needsReview: string[] }).needsReview).toEqual(["baseUom"]);
    expect(r2.attrs).toBeNull(); // 无 attrs 的不受影响

    const audits = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entity, "spu"), eq(auditLogs.action, "regroup")));
    expect(audits).toHaveLength(1);
    const before = audits[0].before as { memberSpuIds: Record<string, number> };
    expect(before.memberSpuIds["RG-S1"]).toBe(spuA);
    expect((audits[0].after as { spuId: number }).spuId).toBe(spuB);
  });

  it("SKU 不存在 → 400；SPU 不存在 → 404；参数校验", async () => {
    await expect(regroupSkus(pmc, spuA, { skuIds: [999999], mode: "move-in" }, dbx)).rejects.toThrow(/SKU 不存在/);
    await expect(regroupSkus(pmc, 999999, { skuIds: [s1], mode: "move-in" }, dbx)).rejects.toThrow(/SPU 不存在/);
    await expect(regroupSkus(pmc, spuB, { skuIds: [], mode: "move-in" }, dbx)).rejects.toThrow();
    await expect(regroupSkus(pmc, spuB, { skuIds: [s1], mode: "move-out" }, dbx)).rejects.toThrow();
    await expect(listSpuMembers(999999, dbx)).rejects.toThrow(/不存在/);
  });
});
