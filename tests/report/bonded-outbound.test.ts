/**
 * 保税仓日出库观察（bonded-outbound/v1）：
 *   - 跨批次按源记录去重、取最新状态（契约已改全量观察，源表为归档）；取消不计出库；无发货时间不计出库；
 *   - `_identity.skuId` 已解析的行用系统编码与品牌，未映射行按源编码单列；
 *   - 数量 decimal 字符串；缓存绑定随批次集合变化；缺流 insufficient 不补零。
 */
import { describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import { createTestDb } from "../helpers/db";
import { bondedOutboundForWarehouse, computeBondedOutbound, loadBondedOutbound } from "@/server/modules/report/bonded-outbound";
import { jiandaoyunContract } from "@/server/integrations/jiandaoyun-contracts";
import { getCrossSystemIdentityStreamContract } from "@/lib/cross-system-identity";
import { getCrossSystemSemanticStreamContract } from "@/lib/cross-system-semantics";

const TABLE = "jdy_bonded_warehouse_order_observation";

describe("保税仓日出库观察", () => {
  it("契约只取最小字段、全量观察（源表为一次性归档，2026-09-04 去掉时间窗），且身份/语义登记表都有条目", () => {
    const contract = jiandaoyunContract("bonded-warehouse-order-observation")!;
    expect(contract.entryId).toBe("69bcf6dbbe2cb5ce06c1b827");
    expect(contract.window).toBeUndefined(); // 探针实核：源表 507 行统计日期全为 2026-03-01，时间窗永远 0 行
    expect(contract.label).toContain("全量归档");
    expect(contract.label).not.toContain("7天时间窗");
    const sources = contract.fields.map((f) => f.source);
    for (const pii of ["recipient_name", "contact_phone", "recipient_full_address", "id_card_name", "id_card_number", "province", "city", "district", "courier_tracking_number"]) {
      expect(sources, pii).not.toContain(pii);
    }
    expect(sources).toEqual(expect.arrayContaining(["statistical_date", "system_order_number", "product_code", "batch", "validity_period", "barcode", "shipment_quantity", "warehouse_name", "shop_name", "shipment_time"]));
    expect(getCrossSystemIdentityStreamContract("JIANDAOYUN", contract.key)?.identities.sku?.state).toBe("implemented");
    expect(getCrossSystemSemanticStreamContract("JIANDAOYUN", contract.key)?.controls.correction_semantics?.state).toBe("implemented");
  });

  it("缺流保持 insufficient", async () => {
    const { db, client } = await createTestDb();
    try {
      const model = await computeBondedOutbound(db);
      expect(model.state).toBe("insufficient");
      expect(model.totals.qty30).toBe("0.0000");
      expect(model.byWarehouse).toEqual([]);
    } finally {
      await client.close();
    }
  });

  it("跨滚动批次按源记录去重取最新状态；取消/未发货不计；映射与未映射分列；按仓/批次/效期汇总", async () => {
    const { db, client } = await createTestDb();
    try {
      const [actor] = await db.insert(schema.users).values({ name: "保税观察责任人" }).returning();
      const [brand] = await db.insert(schema.brands).values({ code: "NING", nameCn: "NING" }).returning();
      const [spu] = await db.insert(schema.spus).values({ code: "P-BONDED", nameCn: "保税测试" }).returning();
      const [sku] = await db.insert(schema.skus).values({ code: "N001-001", name: "保税成品", spuId: spu.id, skuType: "finished", baseUom: "支", brandId: brand.id }).returning();
      const [wh] = await db.insert(schema.warehouses).values({ code: "BND-E", name: "绍兴保税仓", kind: "snapshot", accountingMode: "snapshot", active: true }).returning();
      const [older, newer] = await db.insert(schema.importJobs).values([
        { template: TABLE, filename: "b1", sourceAsOf: "2026-08-30", createdBy: actor.id, status: "done" },
        { template: TABLE, filename: "b2", sourceAsOf: "2026-09-02", createdBy: actor.id, status: "done" },
      ]).returning();
      await db.insert(schema.integrationRuns).values([
        { connector: "jdy", stream: "bonded-warehouse-order-observation", idempotencyKey: "b1", status: "succeeded", importJobId: older.id, finishedAt: new Date("2026-08-30T03:00:00.000Z") },
        { connector: "jdy", stream: "bonded-warehouse-order-observation", idempotencyKey: "b2", status: "succeeded", importJobId: newer.id, finishedAt: new Date("2026-09-02T03:00:00.000Z") },
      ]);
      const row = (jobId: number, rowNo: number, sourceRecordId: string, data: Record<string, string>, identity: Record<string, number> = {}) => ({
        importJobId: jobId, rowNo, status: "pending" as const, targetTable: TABLE,
        payload: { sourceRecordId, data: { warehouseName: "绍兴保税仓", platformName: "天猫国际", ...data }, _identity: identity },
      });
      await db.insert(schema.stagingRows).values([
        // R1：旧批次已发货 3 件，新批次同一记录状态改为「已取消」→ 不计
        row(older.id, 1, "R1", { statisticalDate: "2026-08-28", systemOrderNumber: "SO1", orderStatus: "已发货", shipmentTime: "2026-08-28 10:00:00", productCode: "N001-001", batch: "L1", validityPeriod: "2027-08-01", shipmentQuantity: "3" }, { skuId: sku.id, warehouseId: wh.id }),
        row(newer.id, 1, "R1", { statisticalDate: "2026-08-28", systemOrderNumber: "SO1", orderStatus: "已取消", shipmentTime: "2026-08-28 10:00:00", productCode: "N001-001", batch: "L1", validityPeriod: "2027-08-01", shipmentQuantity: "3" }, { skuId: sku.id, warehouseId: wh.id }),
        // R2：旧批次 2 件 + 新批次同记录 2 件（重复上传）→ 只计一次
        row(older.id, 2, "R2", { statisticalDate: "2026-08-29", systemOrderNumber: "SO2", orderStatus: "已发货", shipmentTime: "2026-08-29 09:00:00", productCode: "N001-001", batch: "L1", validityPeriod: "2027-08-01", shipmentQuantity: "2.5" }, { skuId: sku.id, warehouseId: wh.id }),
        row(newer.id, 2, "R2", { statisticalDate: "2026-08-29", systemOrderNumber: "SO2", orderStatus: "已完成", shipmentTime: "2026-08-29 09:00:00", productCode: "N001-001", batch: "L1", validityPeriod: "2027-08-01", shipmentQuantity: "2.5" }, { skuId: sku.id, warehouseId: wh.id }),
        // R3：同 SKU 另一批次 4 件（锚点日）
        row(newer.id, 3, "R3", { statisticalDate: "2026-09-01", systemOrderNumber: "SO3", orderStatus: "已发货", shipmentTime: "2026-09-01 08:00:00", productCode: "N001-001", batch: "L2", validityPeriod: "2028-01-01", shipmentQuantity: "4" }, { skuId: sku.id, warehouseId: wh.id }),
        // R4：未映射商品编码 1 件
        row(newer.id, 4, "R4", { statisticalDate: "2026-09-01", systemOrderNumber: "SO4", orderStatus: "已发货", shipmentTime: "2026-09-01 08:30:00", productCode: "SW9999", batch: "X", validityPeriod: "", shipmentQuantity: "1" }),
        // R5：清关中，没有发货时间 → 不计出库
        row(newer.id, 5, "R5", { statisticalDate: "2026-09-02", systemOrderNumber: "SO5", orderStatus: "清关中", shipmentTime: "", productCode: "N001-001", batch: "L2", validityPeriod: "2028-01-01", shipmentQuantity: "9" }, { skuId: sku.id, warehouseId: wh.id }),
        // R6：窗口外（锚点 − 40 天）
        row(older.id, 6, "R6", { statisticalDate: "2026-07-20", systemOrderNumber: "SO6", orderStatus: "已发货", shipmentTime: "2026-07-20 08:00:00", productCode: "N001-001", batch: "L0", validityPeriod: "2027-01-01", shipmentQuantity: "100" }, { skuId: sku.id, warehouseId: wh.id }),
      ]);
      const model = await computeBondedOutbound(db);
      expect(model.state).toBe("ready");
      expect(model.anchorDate).toBe("2026-09-01");
      expect(model.batches).toBe(2);
      expect(model.sourceAsOf).toBe("2026-09-02");
      expect(model.totals.qty30).toBe("7.5000"); // 2.5 + 4 + 1
      expect(model.totals.qty7).toBe("7.5000");
      expect(model.totals.orders30).toBe(3);
      expect(model.totals.lines30).toBe(3);
      expect(model.totals.mappedLines30).toBe(2);
      expect(model.totals.skuMappedPct).toBe(66.7);
      expect(model.daily.map((d) => [d.date, d.qty])).toEqual([["2026-08-29", "2.5000"], ["2026-09-01", "5.0000"]]);
      expect(model.byWarehouse).toHaveLength(1);
      expect(model.byWarehouse[0]).toMatchObject({ warehouseName: "绍兴保税仓", warehouseId: wh.id, qty30: "7.5000", orders30: 3, lastShipDate: "2026-09-01" });
      const l1 = model.bySkuBatch.find((r) => r.batch === "L1")!;
      expect(l1).toMatchObject({ skuId: sku.id, skuCode: "N001-001", skuName: "保税成品", brand: "NING", validityPeriod: "2027-08-01", qty30: "2.5000" });
      const l2 = model.bySkuBatch.find((r) => r.batch === "L2")!;
      expect(l2.qty30).toBe("4.0000");
      const unmapped = model.bySkuBatch.find((r) => r.productCodeRaw === "SW9999")!;
      expect(unmapped).toMatchObject({ skuId: null, skuCode: "SW9999", brand: null, qty30: "1.0000" });
      expect(model.byStatus.find((s) => s.status === "已取消")).toMatchObject({ lines: 1, shipped: false });
      expect(model.byStatus.find((s) => s.status === "清关中")).toMatchObject({ lines: 1, shipped: false });
      expect(bondedOutboundForWarehouse(model, { warehouseId: wh.id })).toEqual({ qty30: "7.5000", qty7: "7.5000", lastShipDate: "2026-09-01", source: "bonded_order_observation" });
      expect(bondedOutboundForWarehouse(model, { warehouseName: "不存在的仓" })).toBeNull();

      // 缓存命中：同一绑定第二次读取一致
      const cached = await loadBondedOutbound(db);
      expect(cached.totals.qty30).toBe("7.5000");
    } finally {
      await client.close();
    }
  });

  it("被 supersede 的批次与数值非法的 review 批次不用；仅业务键问题的 review 批次仍可用", async () => {
    const { db, client } = await createTestDb();
    try {
      const [actor] = await db.insert(schema.users).values({ name: "保税批次责任人" }).returning();
      const [superseded, keyReview, numericReview] = await db.insert(schema.importJobs).values([
        { template: TABLE, filename: "s", sourceAsOf: "2026-09-01", createdBy: actor.id, status: "superseded" },
        { template: TABLE, filename: "k", sourceAsOf: "2026-09-02", createdBy: actor.id, status: "done" },
        { template: TABLE, filename: "n", sourceAsOf: "2026-09-02", createdBy: actor.id, status: "done" },
      ]).returning();
      const finishedAt = new Date("2026-09-02T03:00:00.000Z");
      await db.insert(schema.integrationRuns).values([
        { connector: "jdy", stream: "bonded-warehouse-order-observation", idempotencyKey: "s", status: "succeeded", importJobId: superseded.id, finishedAt },
        { connector: "jdy", stream: "bonded-warehouse-order-observation", idempotencyKey: "k", status: "succeeded", importJobId: keyReview.id, finishedAt, requestScope: { qualityBlocked: true, controlSummary: { invalidNumericValues: 0, reconciliationMismatchedRows: 0, deletedRows: 0, duplicateBusinessKeyRows: 2 } } },
        { connector: "jdy", stream: "bonded-warehouse-order-observation", idempotencyKey: "n", status: "succeeded", importJobId: numericReview.id, finishedAt, requestScope: { qualityBlocked: true, controlSummary: { invalidNumericValues: 1, reconciliationMismatchedRows: 0, deletedRows: 0 } } },
      ]);
      const mk = (jobId: number, id: string, qty: string) => ({
        importJobId: jobId, rowNo: 1, status: "pending" as const, targetTable: TABLE,
        payload: { sourceRecordId: id, data: { statisticalDate: "2026-09-01", systemOrderNumber: id, orderStatus: "已发货", shipmentTime: "2026-09-01", productCode: "X", shipmentQuantity: qty, warehouseName: "保税仓" } },
      });
      await db.insert(schema.stagingRows).values([mk(superseded.id, "S1", "100"), mk(keyReview.id, "K1", "5"), mk(numericReview.id, "N1", "1000")]);
      const model = await computeBondedOutbound(db);
      expect(model.batches).toBe(1);
      expect(model.totals.qty30).toBe("5.0000");
    } finally {
      await client.close();
    }
  });
});
