import { beforeEach, describe, expect, it } from "vitest";
import {
  batches,
  auditLogs,
  ctDocs,
  ctLines,
  poDocs,
  poLines,
  skus,
  spus,
  stockBalances,
  stockDocLines,
  stockDocs,
  suppliers,
  sysParams,
  users,
  warehouses,
} from "@/db/schema";
import {
  activateBatchPosting,
  BATCH_ROLLOUT_CONFIRMATION,
  getBatchRolloutReport,
} from "@/server/modules/inventory/batch-rollout";
import { updateParam } from "@/server/modules/admin/params";
import { createTestDb, type TestDb } from "../helpers/db";

describe("批次过账上线体检与一次性启用", () => {
  let db: TestDb;
  let adminId = 0;
  let skuId = 0;
  let warehouseId = 0;

  beforeEach(async () => {
    ({ db } = await createTestDb());
    const [admin] = await db.insert(users).values({
      username: "batch-admin",
      name: "批次管理员",
      passwordHash: "test",
      roles: ["admin"],
      isApprover: true,
    }).returning();
    adminId = admin.id;
    const [spu] = await db.insert(spus).values({ code: "BR-SPU", nameCn: "批次上线" }).returning();
    const [sku] = await db.insert(skus).values({
      spuId: spu.id,
      code: "BR-SKU",
      name: "批次上线 SKU",
      skuType: "finished",
      baseUom: "个",
    }).returning();
    skuId = sku.id;
    const [warehouse] = await db.insert(warehouses).values({
      code: "BR-WH",
      name: "批次上线仓",
      kind: "finished",
      accountingMode: "realtime",
    }).returning();
    warehouseId = warehouse.id;
  });

  it("如实汇总批次覆盖、历史无批次余额、过期批次和在途旧单", async () => {
    const [valid, expired] = await db.insert(batches).values([
      { skuId, batchNo: "VALID", expiryDate: "2027-12-31" },
      { skuId, batchNo: "EXPIRED", expiryDate: "2026-01-01" },
    ]).returning();
    await db.insert(stockBalances).values([
      { skuId, warehouseId, batchId: valid.id, qty: "60" },
      { skuId, warehouseId, batchId: expired.id, qty: "10" },
      { skuId, warehouseId, batchId: null, qty: "30" },
    ]);
    const [doc] = await db.insert(stockDocs).values({
      docNo: "CK-BR-1",
      subtype: "sales_out",
      createdBy: adminId,
    }).returning();
    await db.insert(stockDocLines).values({
      stockDocId: doc.id,
      skuId,
      warehouseId,
      qty: "1",
      batchId: null,
    });

    const report = await getBatchRolloutReport(db);
    expect(report).toMatchObject({
      enabled: false,
      positiveQty: 100,
      traceableBatchQty: 70,
      legacyQty: 30,
      orphanBatchQty: 0,
      coveragePct: 70,
      batchPairs: 2,
      legacyPairs: 1,
      orphanBatchPairs: 0,
      expiredLots: 1,
      expiredQty: 10,
      openLegacyOutboundLines: 1,
      canEnable: true,
    });
    expect(report.warnings.join("；")).toContain("不可追溯");
    expect(report.warnings.join("；")).toContain("过期");
    expect(report.snapshotToken).toMatch(/^[0-9a-f]{16}$/);
  });

  it("拒绝陈旧快照与未确认的历史回落，确认后一次性启用且重试幂等", async () => {
    await db.insert(stockBalances).values({
      skuId,
      warehouseId,
      batchId: null,
      qty: "5",
    });
    const user = { id: adminId, name: "批次管理员", roles: ["admin"], isApprover: true };
    const report = await getBatchRolloutReport(db);

    await expect(activateBatchPosting(user, {
      snapshotToken: "stale",
      confirmation: BATCH_ROLLOUT_CONFIRMATION,
    }, db)).rejects.toMatchObject({ status: 409 });
    await expect(activateBatchPosting(user, {
      snapshotToken: report.snapshotToken,
    }, db)).rejects.toMatchObject({ status: 400 });

    const enabled = await activateBatchPosting(user, {
      snapshotToken: report.snapshotToken,
      confirmation: BATCH_ROLLOUT_CONFIRMATION,
    }, db);
    expect(enabled).toMatchObject({ enabled: true, idempotent: false });
    const [param] = await db.select().from(sysParams);
    expect(param.value).toBe("1");

    const retry = await activateBatchPosting(user, {}, db);
    expect(retry).toMatchObject({ enabled: true, idempotent: true });
  });

  it("普通参数入口不能绕过体检启用，也不能在启用后关闭", async () => {
    const user = { id: adminId, name: "批次管理员", roles: ["admin"], isApprover: true };
    await expect(updateParam(user, { key: "batch_posting_enabled", value: 1 }, db))
      .rejects.toMatchObject({ status: 409, message: expect.stringContaining("上线体检") });

    await db.insert(sysParams).values({
      scope: "global",
      key: "batch_posting_enabled",
      value: "1",
    });
    await expect(updateParam(user, { key: "batch_posting_enabled", value: 0 }, db))
      .rejects.toMatchObject({ status: 409, message: expect.stringContaining("不可直接关闭") });
  });

  it("失联批次余额不冒充可追溯库存并阻断启用", async () => {
    await db.insert(stockBalances).values({
      skuId,
      warehouseId,
      batchId: 999_999,
      qty: "12",
    });
    const report = await getBatchRolloutReport(db);
    expect(report).toMatchObject({
      positiveQty: 12,
      traceableBatchQty: 0,
      orphanBatchQty: 12,
      orphanBatchPairs: 1,
      coveragePct: 0,
      canEnable: false,
    });
    expect(report.warnings.join("；")).toContain("数据完整性阻断项");
  });

  it("并发确认只有一个请求赢得 0→1 转换并写一条激活审计", async () => {
    await db.insert(sysParams).values({
      scope: "global",
      key: "batch_posting_enabled",
      value: "0",
    });
    const user = { id: adminId, name: "批次管理员", roles: ["admin"], isApprover: true };
    const report = await getBatchRolloutReport(db);
    const results = await Promise.all([
      activateBatchPosting(user, { snapshotToken: report.snapshotToken }, db),
      activateBatchPosting(user, { snapshotToken: report.snapshotToken }, db),
    ]);
    expect(results.filter((result) => !result.idempotent)).toHaveLength(1);
    const audits = await db.select().from(auditLogs);
    expect(audits.filter((row) => row.entity === "batch_posting" && row.action === "activate")).toHaveLength(1);
  });

  it("体检覆盖采购退货旧单行，不把零库存计入覆盖率", async () => {
    const [supplier] = await db.insert(suppliers).values({ code: "BR-SUP", name: "批次供应商" }).returning();
    const [po] = await db.insert(poDocs).values({
      docNo: "PO-BR-1",
      supplierId: supplier.id,
      createdBy: adminId,
    }).returning();
    const [poLine] = await db.insert(poLines).values({
      poId: po.id,
      skuId,
      lineType: "raw",
      purchaseUom: "个",
      qty: "5",
      price: "1",
    }).returning();
    const [ct] = await db.insert(ctDocs).values({
      docNo: "CT-BR-1",
      poId: po.id,
      warehouseId,
      createdBy: adminId,
    }).returning();
    await db.insert(ctLines).values({
      ctId: ct.id,
      poLineId: poLine.id,
      skuId,
      qty: "1",
      batchId: null,
    });
    await db.insert(stockBalances).values({
      skuId,
      warehouseId,
      batchId: null,
      qty: "0",
    });

    const report = await getBatchRolloutReport(db);
    expect(report.openLegacyOutboundLines).toBe(1);
    expect(report.positiveQty).toBe(0);
    expect(report.coveragePct).toBe(100);
  });
});
