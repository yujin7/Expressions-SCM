import { describe, it, expect } from "vitest";
import { asc, eq, and } from "drizzle-orm";
import { createTestDb, type TestDb } from "../helpers/db";
import { spus, skus, warehouses, stockLedger } from "@/db/schema";
import { post, reverse, getBalance, PostingError, type PostingEvent } from "@/server/posting";
import { dCmp } from "@/server/core/decimal";

/** 最小主数据：1 SPU + 成品/原料 SKU + 成品/原料/委外/快照 四仓 */
async function seed(db: TestDb) {
  const [spu] = await db.insert(spus).values({ code: "P00001", nameCn: "测试产品" }).returning();
  const [skuFin] = await db
    .insert(skus)
    .values({ code: "CP00001", spuId: spu.id, baseUom: "个", skuType: "finished" })
    .returning();
  const [skuRaw] = await db
    .insert(skus)
    .values({ code: "YL00001", spuId: spu.id, baseUom: "kg", skuType: "raw" })
    .returning();
  const [whFin] = await db
    .insert(warehouses)
    .values({ code: "WH-F", name: "成品仓", kind: "finished" })
    .returning();
  const [whRaw] = await db
    .insert(warehouses)
    .values({ code: "WH-R", name: "原料仓", kind: "raw" })
    .returning();
  const [whOut] = await db
    .insert(warehouses)
    .values({ code: "WH-O", name: "委外仓", kind: "outsource" })
    .returning();
  const [whSnap] = await db
    .insert(warehouses)
    .values({ code: "WH-S", name: "保税快照仓", kind: "snapshot", accountingMode: "snapshot" })
    .returning();
  return { skuFin, skuRaw, whFin, whRaw, whOut, whSnap };
}

async function ledgerRows(db: TestDb, sourceDocType: string, sourceDocId: number) {
  return db
    .select()
    .from(stockLedger)
    .where(and(eq(stockLedger.sourceDocType, sourceDocType), eq(stockLedger.sourceDocId, sourceDocId)))
    .orderBy(asc(stockLedger.id));
}

describe("posting engine", () => {
  it("1. post 写入流水且余额=各行合计", async () => {
    const { db } = await createTestDb();
    const { skuRaw, whRaw } = await seed(db);
    const event: PostingEvent = {
      sourceDocType: "opening",
      sourceDocId: 1,
      action: "post",
      lines: [
        { sourceLineId: 1, skuId: skuRaw.id, warehouseId: whRaw.id, qtyDelta: "10" },
        { sourceLineId: 2, skuId: skuRaw.id, warehouseId: whRaw.id, qtyDelta: "5.5" },
      ],
    };
    const r = await post(db, event);
    expect(r.posted).toBe(true);
    const rows = await ledgerRows(db, "opening", 1);
    expect(rows).toHaveLength(2);
    expect(dCmp(await getBalance(db, skuRaw.id, whRaw.id), "15.5")).toBe(0);
  });

  it("2. 同一事件重复过账幂等：第二次 {posted:false} 且余额不变", async () => {
    const { db } = await createTestDb();
    const { skuRaw, whRaw } = await seed(db);
    const event: PostingEvent = {
      sourceDocType: "sh_purchase_in",
      sourceDocId: 7,
      action: "post",
      lines: [{ sourceLineId: 1, skuId: skuRaw.id, warehouseId: whRaw.id, qtyDelta: "8" }],
    };
    expect((await post(db, event)).posted).toBe(true);
    expect((await post(db, event)).posted).toBe(false);
    expect(dCmp(await getBalance(db, skuRaw.id, whRaw.id), "8")).toBe(0);
    expect(await ledgerRows(db, "sh_purchase_in", 7)).toHaveLength(1);
  });

  it("3. 实时原料仓负库存 → PostingError 且整个事务回滚（余额与流水均不变）", async () => {
    const { db } = await createTestDb();
    const { skuRaw, whRaw } = await seed(db);
    await post(db, {
      sourceDocType: "opening",
      sourceDocId: 1,
      action: "post",
      lines: [{ sourceLineId: 1, skuId: skuRaw.id, warehouseId: whRaw.id, qtyDelta: "10" }],
    });
    await expect(
      post(db, {
        sourceDocType: "sales_out",
        sourceDocId: 2,
        action: "post",
        lines: [{ sourceLineId: 1, skuId: skuRaw.id, warehouseId: whRaw.id, qtyDelta: "-15" }],
      }),
    ).rejects.toMatchObject({ name: "PostingError", code: "NEGATIVE_STOCK" });
    // 回滚验证：余额仍是期初值，销售出库未留任何流水
    expect(dCmp(await getBalance(db, skuRaw.id, whRaw.id), "10")).toBe(0);
    expect(await ledgerRows(db, "sales_out", 2)).toHaveLength(0);
  });

  it("4. 委外仓可负（垫料）：负余额过账成功", async () => {
    const { db } = await createTestDb();
    const { skuFin, skuRaw, whFin, whOut } = await seed(db);
    // 委外收货：成品仓 +，委外仓 − 净标准用量（委外仓从 0 直接扣负=垫料）
    const r = await post(db, {
      sourceDocType: "sh_outsource_in",
      sourceDocId: 3,
      action: "post",
      lines: [
        { sourceLineId: 1, skuId: skuFin.id, warehouseId: whFin.id, qtyDelta: "10" },
        { sourceLineId: 2, skuId: skuRaw.id, warehouseId: whOut.id, qtyDelta: "-6.5" },
      ],
    });
    expect(r.posted).toBe(true);
    expect(dCmp(await getBalance(db, skuFin.id, whFin.id), "10")).toBe(0);
    expect(dCmp(await getBalance(db, skuRaw.id, whOut.id), "-6.5")).toBe(0);
  });

  it("5. 调拨两行事件（出−/入+）原子过账", async () => {
    const { db } = await createTestDb();
    const { skuRaw, whRaw, whFin } = await seed(db);
    await post(db, {
      sourceDocType: "opening",
      sourceDocId: 1,
      action: "post",
      lines: [{ sourceLineId: 1, skuId: skuRaw.id, warehouseId: whRaw.id, qtyDelta: "10" }],
    });
    const r = await post(db, {
      sourceDocType: "transfer",
      sourceDocId: 4,
      action: "post",
      lines: [
        { sourceLineId: 1, skuId: skuRaw.id, warehouseId: whRaw.id, qtyDelta: "-4" },
        { sourceLineId: 2, skuId: skuRaw.id, warehouseId: whFin.id, qtyDelta: "4" },
      ],
    });
    expect(r.posted).toBe(true);
    expect(dCmp(await getBalance(db, skuRaw.id, whRaw.id), "6")).toBe(0);
    expect(dCmp(await getBalance(db, skuRaw.id, whFin.id), "4")).toBe(0);
    expect(await ledgerRows(db, "transfer", 4)).toHaveLength(2);
  });

  it("6. reverse 红字冲销：余额回到冲销前，重复冲销幂等", async () => {
    const { db } = await createTestDb();
    const { skuRaw, whRaw } = await seed(db);
    const original: PostingEvent = {
      sourceDocType: "sh_purchase_in",
      sourceDocId: 5,
      action: "post",
      lines: [{ sourceLineId: 1, skuId: skuRaw.id, warehouseId: whRaw.id, qtyDelta: "12" }],
    };
    await post(db, original);
    expect(dCmp(await getBalance(db, skuRaw.id, whRaw.id), "12")).toBe(0);

    const r1 = await reverse(db, original, 999);
    expect(r1.posted).toBe(true);
    expect(dCmp(await getBalance(db, skuRaw.id, whRaw.id), "0")).toBe(0);
    const rows = await ledgerRows(db, "stock_doc", 999);
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe("reverse");
    expect(dCmp(rows[0].qtyDelta, "-12")).toBe(0);

    const r2 = await reverse(db, original, 999);
    expect(r2.posted).toBe(false);
    expect(dCmp(await getBalance(db, skuRaw.id, whRaw.id), "0")).toBe(0);
    expect(await ledgerRows(db, "stock_doc", 999)).toHaveLength(1);
  });

  it("7. 未注册 sourceDocType/action → 抛错（防旁路）", async () => {
    const { db } = await createTestDb();
    const { skuRaw, whRaw } = await seed(db);
    await expect(
      post(db, {
        sourceDocType: "bogus_doc",
        sourceDocId: 1,
        action: "post",
        lines: [{ sourceLineId: 1, skuId: skuRaw.id, warehouseId: whRaw.id, qtyDelta: "1" }],
      }),
    ).rejects.toMatchObject({ name: "PostingError", code: "UNREGISTERED_SOURCE" });
    // 已注册类型 + 未允许 action 同样拒绝
    await expect(
      post(db, {
        sourceDocType: "opening",
        sourceDocId: 1,
        action: "writeoff",
        lines: [{ sourceLineId: 1, skuId: skuRaw.id, warehouseId: whRaw.id, qtyDelta: "1" }],
      }),
    ).rejects.toMatchObject({ code: "UNREGISTERED_SOURCE" });
  });

  it("8. 行按 (skuId, warehouseId, batchId) 排序处理，与输入顺序无关", async () => {
    const { db } = await createTestDb();
    const { skuFin, skuRaw, whRaw } = await seed(db); // skuFin.id < skuRaw.id
    await post(db, {
      sourceDocType: "count_adjust",
      sourceDocId: 6,
      action: "post",
      lines: [
        // 故意乱序：skuRaw 在前
        { sourceLineId: 2, skuId: skuRaw.id, warehouseId: whRaw.id, qtyDelta: "3" },
        { sourceLineId: 1, skuId: skuFin.id, warehouseId: whRaw.id, qtyDelta: "2" },
      ],
    });
    const rows = await ledgerRows(db, "count_adjust", 6);
    expect(rows.map((r) => r.skuId)).toEqual([skuFin.id, skuRaw.id]); // 流水按排序后顺序落库
    expect(dCmp(await getBalance(db, skuFin.id, whRaw.id), "2")).toBe(0);
    expect(dCmp(await getBalance(db, skuRaw.id, whRaw.id), "3")).toBe(0);
  });

  it("9. 快照仓禁止过账（快照导入不触 ledger）", async () => {
    const { db } = await createTestDb();
    const { skuRaw, whSnap } = await seed(db);
    await expect(
      post(db, {
        sourceDocType: "opening",
        sourceDocId: 8,
        action: "post",
        lines: [{ sourceLineId: 1, skuId: skuRaw.id, warehouseId: whSnap.id, qtyDelta: "5" }],
      }),
    ).rejects.toMatchObject({ name: "PostingError", code: "SNAPSHOT_WAREHOUSE" });
    expect(await ledgerRows(db, "opening", 8)).toHaveLength(0);
  });

  it("空事件 → EMPTY_EVENT", async () => {
    const { db } = await createTestDb();
    await seed(db);
    await expect(
      post(db, { sourceDocType: "opening", sourceDocId: 9, action: "post", lines: [] }),
    ).rejects.toMatchObject({ name: "PostingError", code: "EMPTY_EVENT" });
    expect(PostingError).toBeDefined();
  });
});
