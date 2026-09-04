/**
 * W2-2 库存流水视图回归门。
 *
 * 修复前 `listLedger` 只返回 时间/SKU/仓库/±数量/来源类型/来源id/动作：
 * - 没有批次（`stock_ledger.batch_id` 一直有数据，页面从不显示）；
 * - 没有累计余额（要看"这条之后还剩多少"只能自己拿计算器）；
 * - 没有金额；
 * - 来源只有 `类型 #id` —— id 在任何单据页都搜不出来，等于死文本。
 *
 * 下面每条断言在修复前都会失败（返回对象上根本没有这些键）。
 */
import { describe, expect, it } from "vitest";
import {
  batches, skuCosts, skus, spus, stockDocLines, stockDocs, users, warehouses,
} from "@/db/schema";
import { maskSensitive } from "@/server/core/dto";
import { listLedger } from "@/server/modules/inventory/queries";
import { post } from "@/server/posting";
import { createTestDb, type TestDb } from "../helpers/db";

async function seed(db: TestDb) {
  const [u] = await db.insert(users).values({ name: "仓管", roles: ["warehouse"] }).returning();
  const [spu] = await db.insert(spus).values({ code: "P00001", nameCn: "测试产品" }).returning();
  const [sku] = await db
    .insert(skus)
    .values({ code: "CP00001", name: "测试成品", spuId: spu.id, baseUom: "个", skuType: "finished" })
    .returning();
  const [wh] = await db.insert(warehouses).values({ code: "WH-F", name: "成品仓", kind: "finished" }).returning();
  const [wh2] = await db.insert(warehouses).values({ code: "WH-B", name: "备用仓", kind: "finished" }).returning();
  const [batch] = await db
    .insert(batches)
    .values({ skuId: sku.id, batchNo: "B2026070101" })
    .returning();
  return { u, sku, wh, wh2, batch };
}

/** 建一张真实的期初单（有单号），并按它过账——来源链接要能解析出单号 */
async function openingDoc(db: TestDb, args: {
  docNo: string; userId: number; skuId: number; warehouseId: number; batchId: number | null;
  qty: string; occurredAt: Date;
}) {
  const [doc] = await db
    .insert(stockDocs)
    .values({ docNo: args.docNo, subtype: "opening", createdBy: args.userId })
    .returning();
  const [line] = await db
    .insert(stockDocLines)
    .values({
      stockDocId: doc.id, skuId: args.skuId, warehouseId: args.warehouseId,
      batchId: args.batchId, qty: args.qty,
    })
    .returning();
  await post(db, {
    sourceDocType: "opening",
    sourceDocId: doc.id,
    action: "post",
    occurredAt: args.occurredAt,
    lines: [{
      sourceLineId: line.id, skuId: args.skuId, warehouseId: args.warehouseId,
      batchId: args.batchId, qtyDelta: args.qty,
    }],
  });
  return doc;
}

describe("W2-2 库存流水：批次 / 窗口累计余额 / 金额 / 来源链接", () => {
  it("返回批次列，并把来源渲染成可解析的单号 + 单据页链接", async () => {
    const { db } = await createTestDb();
    const { u, sku, wh, batch } = await seed(db);
    const doc = await openingDoc(db, {
      docNo: "RK-20260701-0001", userId: u.id, skuId: sku.id, warehouseId: wh.id,
      batchId: batch.id, qty: "10", occurredAt: new Date("2026-07-01T02:00:00.000Z"),
    });

    const { rows } = await listLedger({ page: 1, pageSize: 20 }, db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      batchId: batch.id,
      batchNo: "B2026070101",
      sourceDocType: "opening",
      sourceDocId: doc.id,
      sourceDocNo: "RK-20260701-0001",
      sourceHref: "/inventory/docs?q=RK-20260701-0001",
    });
  });

  it("累计余额在 SQL 的排序窗口上算，跨页仍然正确（分页后再累加必错）", async () => {
    const { db } = await createTestDb();
    const { u, sku, wh } = await seed(db);
    const qtys = ["10", "20", "30", "40", "50"];
    for (let i = 0; i < qtys.length; i++) {
      await openingDoc(db, {
        docNo: `RK-2026070${i + 1}-0001`, userId: u.id, skuId: sku.id, warehouseId: wh.id,
        batchId: null, qty: qtys[i],
        occurredAt: new Date(`2026-07-0${i + 1}T02:00:00.000Z`),
      });
    }
    // 累计序列 10/30/60/100/150；页面按时间倒序，第 1 页是最新两条，第 3 页是最早一条
    const page1 = await listLedger({ page: 1, pageSize: 2 }, db);
    expect(page1.total).toBe(5);
    expect(page1.rows.map((r) => r.balanceQty)).toEqual(["150.0000", "100.0000"]);
    const page3 = await listLedger({ page: 3, pageSize: 2 }, db);
    expect(page3.rows.map((r) => r.balanceQty)).toEqual(["10.0000"]);
  });

  it("累计余额按 (SKU, 仓库) 分区，不同仓的流水互不串账", async () => {
    const { db } = await createTestDb();
    const { u, sku, wh, wh2 } = await seed(db);
    await openingDoc(db, {
      docNo: "RK-A", userId: u.id, skuId: sku.id, warehouseId: wh.id, batchId: null,
      qty: "10", occurredAt: new Date("2026-07-01T02:00:00.000Z"),
    });
    await openingDoc(db, {
      docNo: "RK-B", userId: u.id, skuId: sku.id, warehouseId: wh2.id, batchId: null,
      qty: "7", occurredAt: new Date("2026-07-02T02:00:00.000Z"),
    });
    const { rows } = await listLedger({ page: 1, pageSize: 20 }, db);
    const byWarehouse = Object.fromEntries(rows.map((r) => [r.warehouseName, r.balanceQty]));
    expect(byWarehouse).toEqual({ 成品仓: "10.0000", 备用仓: "7.0000" });
  });

  it("累计余额只统计筛选窗口内的流水（窗口口径 = 页面看到的口径）", async () => {
    const { db } = await createTestDb();
    const { u, sku, wh } = await seed(db);
    await openingDoc(db, {
      docNo: "RK-JUN", userId: u.id, skuId: sku.id, warehouseId: wh.id, batchId: null,
      qty: "100", occurredAt: new Date("2026-06-10T02:00:00.000Z"),
    });
    await openingDoc(db, {
      docNo: "RK-JUL", userId: u.id, skuId: sku.id, warehouseId: wh.id, batchId: null,
      qty: "5", occurredAt: new Date("2026-07-10T02:00:00.000Z"),
    });
    const all = await listLedger({ page: 1, pageSize: 20 }, db);
    expect(all.rows[0].balanceQty).toBe("105.0000");
    const julyOnly = await listLedger({ from: "2026-07-01", page: 1, pageSize: 20 }, db);
    expect(julyOnly.total).toBe(1);
    expect(julyOnly.rows[0].balanceQty).toBe("5.0000");
  });

  it("金额按角色下发：withValue=false 无金额键；withValue=true 用 core/valuation 单位成本，且 maskSensitive 对非价格角色剥离", async () => {
    const { db } = await createTestDb();
    const { u, sku, wh } = await seed(db);
    await db.insert(skuCosts).values({ skuId: sku.id, unitCost: "3.5" });
    await openingDoc(db, {
      docNo: "RK-VAL", userId: u.id, skuId: sku.id, warehouseId: wh.id, batchId: null,
      qty: "10", occurredAt: new Date("2026-07-01T02:00:00.000Z"),
    });

    const plain = await listLedger({ page: 1, pageSize: 20 }, db);
    expect(plain.rows[0]).not.toHaveProperty("amount");

    const valued = await listLedger({ page: 1, pageSize: 20, withValue: true }, db);
    expect(valued.rows[0]).toMatchObject({ amount: "35.00", balanceAmount: "35.00" });

    // R9 唯一收口兜底：即使服务端算了金额，非价格角色的 DTO 里也不得残留
    const masked = maskSensitive({ rows: valued.rows }, ["warehouse"]) as unknown as { rows: Record<string, unknown>[] };
    expect(masked.rows[0]).not.toHaveProperty("amount");
    expect(masked.rows[0]).not.toHaveProperty("balanceAmount");
    expect(masked.rows[0].balanceQty).toBe("10.0000"); // 数量不受影响
  });

  it("无单位成本的 SKU：金额为 null 而不是 0（0 会被当成「不值钱」）", async () => {
    const { db } = await createTestDb();
    const { u, sku, wh } = await seed(db);
    await openingDoc(db, {
      docNo: "RK-NOCOST", userId: u.id, skuId: sku.id, warehouseId: wh.id, batchId: null,
      qty: "10", occurredAt: new Date("2026-07-01T02:00:00.000Z"),
    });
    const { rows } = await listLedger({ page: 1, pageSize: 20, withValue: true }, db);
    expect(rows[0].amount).toBeNull();
    expect(rows[0].balanceAmount).toBeNull();
  });
});
