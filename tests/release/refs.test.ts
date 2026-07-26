/**
 * releaseFeeRefs / releaseBatchStocks / releaseSalesMonthly / releaseStatus：
 * 别名解析行提交（staging 翻 committed）；未解析阻塞带原因；upsert 幂等；
 * dry-run 零写入；响应中绝不出现 feeRate；状态汇总形状。
 */
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { createTestDb, type TestDb } from "../helpers/db";
import { writeStagingRows } from "@/server/import/staging";
import {
  releaseBatchStocks,
  releaseFeeRefs,
  releaseSalesMonthly,
  releaseStatus,
  type ReleaseUser,
} from "@/server/modules/release/engine";

const pmc: ReleaseUser = { id: 1, name: "放行员", roles: ["pmc"], isApprover: false };

async function newJob(db: TestDb): Promise<number> {
  const [j] = await db
    .insert(schema.importJobs)
    .values({ template: "test", filename: "t.xlsx", status: "done", createdBy: 1 })
    .returning({ id: schema.importJobs.id });
  return j.id;
}

/** 主档种子：SPU+成品 SKU、供应商+OEM 别名、仓库+别名、渠道+别名 */
async function seedMasters(db: TestDb) {
  const [spu] = await db.insert(schema.spus).values({ code: "P00001", nameCn: "洁面乳" }).returning();
  const [sku] = await db
    .insert(schema.skus)
    .values({ code: "N006-a", name: "洁面乳", spuId: spu.id, skuType: "finished", baseUom: "件" })
    .returning();
  const [supplier] = await db
    .insert(schema.suppliers)
    .values({ code: "S001", name: "中源泰", kinds: ["processor"] })
    .returning();
  await db.insert(schema.aliases).values({ aliasType: "supplier_oem", rawValue: "ZYT", targetId: supplier.id });
  const [wh] = await db
    .insert(schema.warehouses)
    .values({ code: "W1", name: "天猫保税仓", kind: "finished" })
    .returning();
  await db.insert(schema.aliases).values({ aliasType: "warehouse", rawValue: "天猫保税仓", targetId: wh.id });
  const [ch] = await db
    .insert(schema.channels)
    .values({ code: "tmall", name: "天猫", kind: "platform" })
    .returning();
  await db.insert(schema.aliases).values({ aliasType: "channel", rawValue: "天猫", targetId: ch.id });
  return { spu, sku, supplier, wh, ch };
}

describe("releaseFeeRefs", () => {
  it("解析行提交（feeRate=null 且不出现在响应）；未解析阻塞；跨 job upsert 幂等", async () => {
    const { db } = await createTestDb();
    const { sku, supplier } = await seedMasters(db);
    const job1 = await newJob(db);
    await writeStagingRows(db, job1, [
      { rowNo: 1, targetTable: "processing_fee_candidate", payload: { productCode: "N006-a", supplierRaw: "ZYT" } },
      { rowNo: 2, targetTable: "processing_fee_candidate", payload: { productCode: "N006-a", supplierRaw: "未知厂" } },
      { rowNo: 3, targetTable: "processing_fee_candidate", payload: { productCode: "ZZZ", supplierRaw: "ZYT" } },
      { rowNo: 4, targetTable: "processing_fee_candidate", payload: { productCode: null, supplierRaw: "ZYT" } },
    ]);

    const dry = await releaseFeeRefs(pmc, { dryRun: true }, db);
    expect(dry).toMatchObject({ dryRun: true, created: 1, existing: 0 });
    expect(dry.blocked).toHaveLength(3);
    expect(await db.select().from(schema.processingFeeRefs)).toHaveLength(0);

    const run = await releaseFeeRefs(pmc, { dryRun: false }, db);
    expect(run.created).toBe(1);
    expect(run.blocked.map((b) => b.reason).sort()).toEqual(["SKU 未放行", "供应商别名未认领", "无产品编码"]);
    expect(JSON.stringify(run)).not.toContain("feeRate"); // 敏感字段不入响应（本阶段本就 null）
    const refs = await db.select().from(schema.processingFeeRefs);
    expect(refs).toHaveLength(1);
    expect(refs[0].skuId).toBe(sku.id);
    expect(refs[0].supplierId).toBe(supplier.id);
    expect(refs[0].feeRate).toBeNull();
    expect(refs[0].source).toBe("bom_import");
    const rows = await db.select().from(schema.stagingRows).where(eq(schema.stagingRows.importJobId, job1));
    const good = rows.find((r) => r.rowNo === 1)!;
    expect(good.status).toBe("committed");
    expect(good.targetId).toBe(refs[0].id);
    const bad = rows.find((r) => r.rowNo === 2)!;
    expect(bad.status).toBe("pending");
    expect(bad.errorMsg).toBe("供应商别名未认领");

    // 跨 job 同键：existing，不重插
    const job2 = await newJob(db);
    await writeStagingRows(db, job2, [
      { rowNo: 1, targetTable: "processing_fee_candidate", payload: { productCode: "N006-a", supplierRaw: "ZYT" } },
    ]);
    const run2 = await releaseFeeRefs(pmc, { jobIds: [job2], dryRun: false }, db);
    expect(run2.created).toBe(0);
    expect(run2.existing).toBe(1);
    expect(await db.select().from(schema.processingFeeRefs)).toHaveLength(1);
    const row2 = (await db.select().from(schema.stagingRows).where(eq(schema.stagingRows.importJobId, job2)))[0];
    expect(row2.status).toBe("committed");
  });
});

describe("releaseBatchStocks", () => {
  it("别名解析提交；仓库未认领/缺盘点期间阻塞；dry-run 零写入", async () => {
    const { db } = await createTestDb();
    const { sku, wh } = await seedMasters(db);
    const jobId = await newJob(db);
    const base = {
      sheetWarehouse: "天猫保税仓", operatorRaw: "菜鸟", brand: "NING", skuCode: "N006-a",
      skuName: "洁面乳", prodDate: "2025-01-01", expiryDate: "2028-01-01",
      shelfLifeDays: 1095, qty: 5, stocktakeDate: "2026-07-01", _resolved: {},
    };
    await writeStagingRows(db, jobId, [
      { rowNo: 1, targetTable: "batch_stock", payload: base },
      { rowNo: 2, targetTable: "batch_stock", payload: { ...base, sheetWarehouse: "神秘仓" } },
      { rowNo: 3, targetTable: "batch_stock", payload: { ...base, stocktakeDate: null } },
      { rowNo: 4, targetTable: "batch_stock", payload: { ...base, skuCode: "NOPE" } },
    ]);

    const dry = await releaseBatchStocks(pmc, { dryRun: true }, db);
    expect(dry).toMatchObject({ dryRun: true, created: 1, unresolved: { sku: 1, warehouse: 1 } });
    expect(await db.select().from(schema.batchStocks)).toHaveLength(0);

    const run = await releaseBatchStocks(pmc, { dryRun: false }, db);
    expect(run.created).toBe(1);
    expect(run.blocked).toHaveLength(3);
    const stocks = await db.select().from(schema.batchStocks);
    expect(stocks).toHaveLength(1);
    expect(stocks[0].skuId).toBe(sku.id);
    expect(stocks[0].warehouseId).toBe(wh.id);
    expect(Number(stocks[0].qty)).toBe(5);
    expect(stocks[0].stocktakeDate).toBe("2026-07-01");
    expect(stocks[0].source).toBe("expiry_import");
    const rows = await db.select().from(schema.stagingRows).where(eq(schema.stagingRows.importJobId, jobId));
    expect(rows.find((r) => r.rowNo === 1)!.status).toBe("committed");
    expect(rows.find((r) => r.rowNo === 2)!.errorMsg).toContain("仓库别名未认领");
    expect(rows.find((r) => r.rowNo === 3)!.errorMsg).toContain("盘点所属期间");
  });
});

describe("releaseSalesMonthly", () => {
  it("UNIQUE(sku,channel,yearMonth) upsert：新建/覆盖计数；未解析按类型计数阻塞", async () => {
    const { db } = await createTestDb();
    const { sku, ch } = await seedMasters(db);
    const job1 = await newJob(db);
    const row = (over: Record<string, unknown>) => ({
      brandSheet: "NING销量", skuCode: "N006-a", yearMonth: "2026-01", channelRaw: "天猫", qty: 10,
      _resolved: {}, ...over,
    });
    await writeStagingRows(db, job1, [
      { rowNo: 1, targetTable: "sales_monthly", payload: row({}) },
      { rowNo: 2, targetTable: "sales_monthly", payload: row({ channelRaw: "神秘渠道" }) },
      { rowNo: 3, targetTable: "sales_monthly", payload: row({ skuCode: "NOPE" }) },
    ]);

    const dry = await releaseSalesMonthly(pmc, { dryRun: true }, db);
    expect(dry).toMatchObject({ dryRun: true, created: 1, updated: 0, blocked: 2, unresolved: { sku: 1, channel: 1 } });
    expect(await db.select().from(schema.salesMonthly)).toHaveLength(0);

    const run = await releaseSalesMonthly(pmc, { dryRun: false }, db);
    expect(run).toMatchObject({ created: 1, updated: 0, blocked: 2 });
    const sales = await db.select().from(schema.salesMonthly);
    expect(sales).toHaveLength(1);
    expect(sales[0].skuId).toBe(sku.id);
    expect(sales[0].channelId).toBe(ch.id);
    expect(Number(sales[0].qty)).toBe(10);

    // 新 job 同键改量 → updated（覆盖）
    const job2 = await newJob(db);
    await writeStagingRows(db, job2, [{ rowNo: 1, targetTable: "sales_monthly", payload: row({ qty: 20 }) }]);
    const run2 = await releaseSalesMonthly(pmc, { jobIds: [job2], dryRun: false }, db);
    expect(run2).toMatchObject({ created: 0, updated: 1 });
    const after = await db.select().from(schema.salesMonthly);
    expect(after).toHaveLength(1);
    expect(Number(after[0].qty)).toBe(20);
    expect(
      (await db.select().from(schema.stagingRows).where(eq(schema.stagingRows.importJobId, job2)))[0].status,
    ).toBe("committed");
  });
});

describe("releaseStatus", () => {
  it("按 targetTable 汇总 待放行/已提交/拒收 + 阻塞原因排行", async () => {
    const { db } = await createTestDb();
    await seedMasters(db);
    const jobId = await newJob(db);
    await writeStagingRows(db, jobId, [
      { rowNo: 1, targetTable: "processing_fee_candidate", payload: { productCode: "N006-a", supplierRaw: "ZYT" } },
      { rowNo: 2, targetTable: "processing_fee_candidate", payload: { productCode: "N006-a", supplierRaw: "未知厂" } },
      { rowNo: 3, targetTable: "bom_block", payload: { sheet: "S", rowNo: 9, reason: "工艺未确认", raw: "x" }, status: "error", errorMsg: "工艺未确认" },
    ]);
    await releaseFeeRefs(pmc, { dryRun: false }, db);

    const status = await releaseStatus(undefined, db);
    const fee = status.tables.find((t) => t.targetTable === "processing_fee_candidate")!;
    expect(fee.committed).toBe(1);
    expect(fee.staged).toBe(1);
    expect(fee.blockedReasons).toContainEqual({ reason: "供应商别名未认领", count: 1 });
    const bom = status.tables.find((t) => t.targetTable === "bom_block")!;
    expect(bom.error).toBe(1);
    expect(bom.blockedReasons).toContainEqual({ reason: "工艺未确认", count: 1 });

    // job 维度过滤
    const scoped = await releaseStatus(jobId, db);
    expect(scoped.tables.map((t) => t.targetTable).sort()).toEqual(["bom_block", "processing_fee_candidate"]);
    const other = await releaseStatus(jobId + 999, db);
    expect(other.tables).toHaveLength(0);
  });
});
