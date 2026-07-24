/** E4-01 批次登记与追溯 */
import { describe, it, expect, beforeAll } from "vitest";
import { and, eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "../helpers/db";
import { batches, batchStocks, skus, spus, warehouses } from "@/db/schema";
import { registerBatchesFromReceipt, requireBatchForExpirySkus, traceBatch } from "@/server/modules/inventory/batch-trace";
import { ApiError } from "@/server/modules/master/common";

describe("批次登记与追溯", () => {
  let db: TestDb;
  let skuManaged = 0; // 管效期（nearExpiryDays 非空）
  let skuPlain = 0; // 不管效期
  let whId = 0;

  beforeAll(async () => {
    ({ db } = await createTestDb());
    const [spu] = await db.insert(spus).values({ code: "PB", nameCn: "批次测试" }).returning();
    const [a] = await db
      .insert(skus)
      .values({ code: "BT-MANAGED", name: "管效期品", spuId: spu.id, skuType: "finished", baseUom: "件", nearExpiryDays: 90 })
      .returning();
    const [b] = await db
      .insert(skus)
      .values({ code: "BT-PLAIN", name: "不管效期品", spuId: spu.id, skuType: "finished", baseUom: "件" })
      .returning();
    skuManaged = a.id;
    skuPlain = b.id;
    const [wh] = await db.insert(warehouses).values({ code: "BT-W", name: "批次仓", kind: "finished", accountingMode: "realtime" }).returning();
    whId = wh.id;
  });

  it("管效期 SKU 缺批次号 → 拒收（否则效期与召回能力形同虚设）", async () => {
    await expect(
      requireBatchForExpirySkus(db, [{ skuId: skuManaged, batchNo: null }]),
    ).rejects.toThrow(ApiError);
    await expect(
      requireBatchForExpirySkus(db, [{ skuId: skuManaged, batchNo: "  " }]),
    ).rejects.toThrow(/必须填写批次号/);
  });

  it("不管效期的 SKU 无批次号可放行", async () => {
    await expect(requireBatchForExpirySkus(db, [{ skuId: skuPlain, batchNo: null }])).resolves.toBeUndefined();
  });

  it("收货登记批次进主档，并记录来源单", async () => {
    const map = await registerBatchesFromReceipt(
      db,
      [{ skuId: skuManaged, batchNo: "L2601", prodDate: "2026-01-05" }],
      { docType: "sh", docId: 77 },
    );
    expect(map.get(`${skuManaged}:L2601`)).toBeGreaterThan(0);
    const [row] = await db.select().from(batches).where(and(eq(batches.skuId, skuManaged), eq(batches.batchNo, "L2601")));
    expect(row.prodDate).toBe("2026-01-05");
    expect(row.sourceDocType).toBe("sh");
    expect(row.sourceDocId).toBe(77);
  });

  it("重复登记幂等：同 (SKU,批次号) 复用既有行", async () => {
    const first = await registerBatchesFromReceipt(db, [{ skuId: skuManaged, batchNo: "L2602" }], { docType: "sh", docId: 1 });
    const second = await registerBatchesFromReceipt(db, [{ skuId: skuManaged, batchNo: "L2602" }], { docType: "sh", docId: 2 });
    expect(second.get(`${skuManaged}:L2602`)).toBe(first.get(`${skuManaged}:L2602`));
    const rows = await db.select().from(batches).where(and(eq(batches.skuId, skuManaged), eq(batches.batchNo, "L2602")));
    expect(rows.length).toBe(1);
    expect(rows[0].sourceDocId).toBe(1); // 首登来源不被后续覆盖
  });

  it("补齐缺失日期但不覆盖已有值（先到先得，防后录篡改）", async () => {
    await registerBatchesFromReceipt(db, [{ skuId: skuPlain, batchNo: "L01", prodDate: null }], { docType: "sh", docId: 3 });
    await registerBatchesFromReceipt(db, [{ skuId: skuPlain, batchNo: "L01", prodDate: "2026-02-02", expiryDate: "2027-02-02" }], { docType: "sh", docId: 4 });
    const [row] = await db.select().from(batches).where(and(eq(batches.skuId, skuPlain), eq(batches.batchNo, "L01")));
    expect(row.prodDate).toBe("2026-02-02"); // 原为空 → 补齐
    expect(row.expiryDate).toBe("2027-02-02");

    await registerBatchesFromReceipt(db, [{ skuId: skuPlain, batchNo: "L01", prodDate: "2020-01-01" }], { docType: "sh", docId: 5 });
    const [again] = await db.select().from(batches).where(and(eq(batches.skuId, skuPlain), eq(batches.batchNo, "L01")));
    expect(again.prodDate).toBe("2026-02-02"); // 已有值不被覆盖
  });

  it("无批次号的行被跳过（不产生空批次登记）", async () => {
    const map = await registerBatchesFromReceipt(db, [{ skuId: skuPlain, batchNo: "" }], { docType: "sh", docId: 6 });
    expect(map.size).toBe(0);
  });

  it("追溯：返回登记信息+来源单+批次库存分布", async () => {
    await db.insert(batchStocks).values({
      skuId: skuManaged, warehouseId: whId, batchNo: "L2601", qty: "120",
      expiryDate: "2027-01-05", stocktakeDate: "2026-07-01",
    });
    const t = await traceBatch("BT-MANAGED", "L2601", db);
    expect(t.batch.batchNo).toBe("L2601");
    expect(t.source.docType).toBe("sh");
    expect(t.stockByWarehouse[0].qty).toBe(120);
  });

  it("出库侧覆盖如实标注：无带批次流水时明说追不到销售终点", async () => {
    const t = await traceBatch("BT-MANAGED", "L2601", db);
    expect(t.coverage.outboundTraceable).toBe(false);
    expect(t.coverage.note).toContain("FEFO");
  });

  it("未登记批次 → 404 并提示可能早于功能上线", async () => {
    await expect(traceBatch("BT-MANAGED", "NOPE", db)).rejects.toThrow(/未找到批次登记/);
  });
});
