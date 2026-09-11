/**
 * B4 历史采购交期观察（supplier-lead-history/v2）。
 *
 * 钉住的口径：
 *   - 字段名全部来自 integrations/jiandaoyun-contracts.ts 的两条契约（不自造字段）；
 *   - 单据键 = 入库 purchaseOrderNo ↔ 订单 orderNo；多次入库取最早一次；负交期丢弃；
 *   - 承诺交期缺失的样本只进分布、不进准时率分母；
 *   - 商品编码与 skus.code 精确相等才映射，未映射按源编码单列（不按名称猜）；
 *   - 与系统侧 rollup_supplier_lead **并列不合并**；
 *   - 接入 rules/alert-threshold 后 **阈值 days 不变**，只多一段 observed 解释；
 *   - 被 supersede 的批次不用；缺流保持 insufficient。
 */
import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import * as schema from "@/db/schema";
import { createTestDb, type TestDb } from "../helpers/db";
import { jiandaoyunContract } from "@/server/integrations/jiandaoyun-contracts";
import {
  computeSupplierLeadHistory, loadSupplierLeadHistory, observedLeadForSku,
  SUPPLIER_LEAD_HISTORY_CACHE_KEY,
} from "@/server/modules/report/supplier-lead-history";
import { alertDays } from "@/server/rules/alert-threshold";

const ORDER_TABLE = "jdy_purchase_order_observation";
const RECEIPT_TABLE = "jdy_purchase_receipt_observation";

interface Seeded {
  supplierId: number;
  skuId: number;
  orderJob: number;
  receiptJob: number;
}

/** 订单表头 + 子表（字段名与契约 target 一一对应） */
function orderRow(
  jobId: number,
  rowNo: number,
  sourceRecordId: string,
  data: Record<string, unknown>,
  identity: Record<string, number> = {},
) {
  return {
    importJobId: jobId,
    rowNo,
    status: "pending" as const,
    targetTable: ORDER_TABLE,
    payload: {
      sourceRecordId,
      sourceCreatedAt: "2024-01-01T02:00:00.000Z",
      data: {
        supplierName: "苏州华美包材",
        supplierCode: "SUP-001",
        orderName: "采购订单",
        warehouse: "成品仓",
        receiptStatus: "已入库",
        totalQty: "100",
        orderAmount: "1000.00",
        ...data,
      },
      _identity: identity,
    },
  };
}

function receiptRow(
  jobId: number,
  rowNo: number,
  sourceRecordId: string,
  data: Record<string, unknown>,
  identity: Record<string, number> = {},
) {
  return {
    importJobId: jobId,
    rowNo,
    status: "pending" as const,
    targetTable: RECEIPT_TABLE,
    payload: {
      sourceRecordId,
      sourceCreatedAt: "2024-01-20T02:00:00.000Z",
      data: {
        supplierName: "苏州华美包材",
        supplierCode: "SUP-001",
        warehouse: "成品仓",
        totalReceivedQty: "100",
        receiptAmount: "1000.00",
        receiptConfirmed: "是",
        ...data,
      },
      _identity: identity,
    },
  };
}

async function seed(db: TestDb): Promise<Seeded> {
  const [actor] = await db.insert(schema.users).values({ name: "采购观察责任人" }).returning();
  const [supplier] = await db.insert(schema.suppliers).values({ code: "SUP-001", name: "苏州华美包材" }).returning();
  const [spu] = await db.insert(schema.spus).values({ code: "SPU-LH", nameCn: "交期观察" }).returning();
  const [sku] = await db.insert(schema.skus).values({ code: "N100-001", name: "面霜 50g", spuId: spu.id, skuType: "finished", baseUom: "支" }).returning();
  await db.insert(schema.skuParams).values({ skuId: sku.id, normalLeadDays: 20, logisticsLeadDays: 7 });

  const [orderJob, receiptJob] = await db.insert(schema.importJobs).values([
    { template: ORDER_TABLE, filename: "po", sourceAsOf: "2024-12-11", createdBy: actor.id, status: "done" },
    { template: RECEIPT_TABLE, filename: "sh", sourceAsOf: "2024-12-10", createdBy: actor.id, status: "done" },
  ]).returning();
  await db.insert(schema.integrationRuns).values([
    { connector: "jdy", stream: "purchase-order-observation", idempotencyKey: "po-1", status: "succeeded", importJobId: orderJob.id, finishedAt: new Date("2026-09-01T02:00:00.000Z") },
    { connector: "jdy", stream: "purchase-receipt-observation", idempotencyKey: "sh-1", status: "succeeded", importJobId: receiptJob.id, finishedAt: new Date("2026-09-01T02:10:00.000Z") },
  ]);
  return { supplierId: supplier.id, skuId: sku.id, orderJob: orderJob.id, receiptJob: receiptJob.id };
}

describe("历史采购交期观察", () => {
  it("契约字段确实存在（不自造字段名），且两张表靠单号关联", () => {
    const order = jiandaoyunContract("purchase-order-observation")!;
    const receipt = jiandaoyunContract("purchase-receipt-observation")!;
    const targets = (c: typeof order) => c.fields.map((f) => f.target);
    expect(targets(order)).toEqual(expect.arrayContaining(["orderNo", "signedAt", "deliveryAt", "approvedAt", "supplierName", "supplierCode"]));
    expect(targets(receipt)).toEqual(expect.arrayContaining(["purchaseOrderNo", "receiptNo", "receivedAt", "inspectedAt"]));
    expect(order.subforms?.[0].items.map((f) => f.target)).toEqual(expect.arrayContaining(["productCode", "purchaseQty"]));
    expect(receipt.subforms?.[0].items.map((f) => f.target)).toEqual(expect.arrayContaining(["productCode", "receivedQty"]));
    expect(order.targetTable).toBe(ORDER_TABLE);
    expect(receipt.targetTable).toBe(RECEIPT_TABLE);
  });

  it("缺流保持 insufficient，不补零", async () => {
    const { db, client } = await createTestDb();
    try {
      const model = await computeSupplierLeadHistory(db);
      expect(model.state).toBe("insufficient");
      expect(model.authority).toBe("observation_only");
      expect(model.totals.samples).toBe(0);
      expect(model.bySupplier).toEqual([]);
    } finally {
      await client.close();
    }
  });

  it("按单号配对出交期分布：多次入库取最早、负交期丢弃、无承诺交期不进准时率分母", async () => {
    const { db, client } = await createTestDb();
    try {
      const s = await seed(db);
      const line = (productCode: string, qty: string) => ({ productCode, productName: "面霜 50g", brand: "N", specification: "50g", unit: "支", purchaseQty: qty, lineAmountTaxed: "100.00" });
      const rLine = (productCode: string, qty: string) => ({ productCode, productName: "面霜 50g", orderedQty: qty, receivedQty: qty, lineAmountTaxed: "100.00" });
      await db.insert(schema.stagingRows).values([
        // PO-1：签订 2024-03-01，承诺 2024-03-21，最早入库 2024-03-25 → 实际 24 天、承诺 20 天 → 延误
        orderRow(s.orderJob, 1, "O1", { orderNo: "PO-1", signedAt: "2024-03-01T00:00:00.000Z", deliveryAt: "2024-03-21T00:00:00.000Z", lines: [line("N100-001", "60")] }, { supplierId: s.supplierId }),
        // PO-2：签订 2024-04-01，承诺 2024-04-25，入库 2024-04-20 → 实际 19 天，准时
        orderRow(s.orderJob, 2, "O2", { orderNo: "PO-2", signedAt: "2024-04-01T00:00:00.000Z", deliveryAt: "2024-04-25T00:00:00.000Z", lines: [line("N100-001", "40")] }, { supplierId: s.supplierId }),
        // PO-3：无承诺交期（deliveryAt 空）→ 只进分布；签订 2024-05-01、入库 2024-05-31 → 30 天
        orderRow(s.orderJob, 3, "O3", { orderNo: "PO-3", signedAt: "2024-05-01T00:00:00.000Z", deliveryAt: "", lines: [line("N100-001", "10")] }, { supplierId: s.supplierId }),
        // PO-4：签订日缺失（signedAt 与 approvedAt 都空）→ 不产生样本
        orderRow(s.orderJob, 4, "O4", { orderNo: "PO-4", signedAt: "", approvedAt: "", deliveryAt: "", lines: [line("N100-001", "5")] }, { supplierId: s.supplierId }),
        // PO-5：入库早于签订（历史补录脏数据）→ 丢弃
        orderRow(s.orderJob, 5, "O5", { orderNo: "PO-5", signedAt: "2024-07-10T00:00:00.000Z", deliveryAt: "", lines: [line("N100-001", "5")] }, { supplierId: s.supplierId }),
        // PO-6：未映射商品编码 + 供应商未认领（无 _identity.supplierId）
        orderRow(s.orderJob, 6, "O6", { orderNo: "PO-6", supplierName: "宁波未认领厂", supplierCode: "SUP-X", signedAt: "2024-06-01T00:00:00.000Z", deliveryAt: "2024-06-20T00:00:00.000Z", lines: [line("SW9999", "3")] }),

        receiptRow(s.receiptJob, 1, "R1a", { purchaseOrderNo: "PO-1", receiptNo: "SH-1a", receivedAt: "2024-03-25T00:00:00.000Z", lines: [rLine("N100-001", "30")] }, { supplierId: s.supplierId }),
        // 同单第二次入库更晚 → 不能污染分布
        receiptRow(s.receiptJob, 2, "R1b", { purchaseOrderNo: "PO-1", receiptNo: "SH-1b", receivedAt: "2024-04-30T00:00:00.000Z", lines: [rLine("N100-001", "30")] }, { supplierId: s.supplierId }),
        receiptRow(s.receiptJob, 3, "R2", { purchaseOrderNo: "PO-2", receiptNo: "SH-2", receivedAt: "2024-04-20T00:00:00.000Z", lines: [rLine("N100-001", "40")] }, { supplierId: s.supplierId }),
        receiptRow(s.receiptJob, 4, "R3", { purchaseOrderNo: "PO-3", receiptNo: "SH-3", receivedAt: "2024-05-31T00:00:00.000Z", lines: [rLine("N100-001", "10")] }, { supplierId: s.supplierId }),
        receiptRow(s.receiptJob, 5, "R5", { purchaseOrderNo: "PO-5", receiptNo: "SH-5", receivedAt: "2024-07-01T00:00:00.000Z", lines: [rLine("N100-001", "5")] }, { supplierId: s.supplierId }),
        receiptRow(s.receiptJob, 6, "R6", { purchaseOrderNo: "PO-6", receiptNo: "SH-6", supplierName: "宁波未认领厂", receivedAt: "2024-06-15T00:00:00.000Z", lines: [rLine("SW9999", "3")] }),
      ]);

      const model = await computeSupplierLeadHistory(db);
      expect(model.state).toBe("ready");
      expect(model.authority).toBe("observation_only");
      expect(model.sourceAsOf).toBe("2024-12-11");

      const mapped = model.bySupplier.find((r) => r.supplierId === s.supplierId)!;
      // 样本 = PO-1(24) / PO-2(19) / PO-3(30)；PO-4 无下单日（整单不计），PO-5 负交期（计入订单数但不产样本）
      expect(mapped.orders).toBe(4);
      expect(mapped.ordersWithReceipt).toBe(3);
      expect(mapped.observed.samples).toBe(3);
      expect(mapped.observed.p50).toBe(24);
      expect(mapped.observed.promisedSamples).toBe(2); // PO-3 无承诺交期
      expect(mapped.observed.onTimeRate).toBe(0.5); // PO-2 准时、PO-1 延误
      expect(mapped.observed.avgDelayDays).toBe(-0.5); // PO-1 延误 +4、PO-2 提前 −5
      expect(mapped.firstReceiptDate).toBe("2024-03-25");
      expect(mapped.lastReceiptDate).toBe("2024-05-31");

      // 未认领供应商单列，绝不并进已认领行
      const unmapped = model.bySupplier.find((r) => r.supplierId == null)!;
      expect(unmapped.supplierName).toBe("宁波未认领厂");
      expect(unmapped.observed.samples).toBe(1);
      expect(unmapped.observed.p50).toBe(14);

      // 供应商 × 商品：映射与未映射分列
      const skuRow = model.bySupplierSku.find((r) => r.skuId === s.skuId)!;
      expect(skuRow.skuCode).toBe("N100-001");
      expect(skuRow.observed.samples).toBe(3);
      const rawRow = model.bySupplierSku.find((r) => r.productCode === "SW9999")!;
      expect(rawRow.skuId).toBeNull();
      expect(rawRow.skuCode).toBeNull();
      expect(model.totals.skuPairsMapped).toBe(1);
      expect(model.totals.matchRatePct).toBe(80); // 有下单日的 5 单里 4 单配对到入库
    } finally {
      await client.close();
    }
  });

  it("与系统学习交期并列不合并；接入阈值后 days 一模一样，只多一段 observed", async () => {
    const { db, client } = await createTestDb();
    try {
      const s = await seed(db);
      const line = (qty: string) => ({ productCode: "N100-001", productName: "面霜 50g", purchaseQty: qty });
      const rLine = (qty: string) => ({ productCode: "N100-001", productName: "面霜 50g", receivedQty: qty });
      // 4 单，实际交期 30/32/34/40 天 → P90 ≈ 38.2，档案 20 天，容差 3 → 观察项命中
      const orders = [
        { no: "PO-1", signed: "2024-03-01", received: "2024-03-31" },
        { no: "PO-2", signed: "2024-04-01", received: "2024-05-03" },
        { no: "PO-3", signed: "2024-05-01", received: "2024-06-04" },
        { no: "PO-4", signed: "2024-06-01", received: "2024-07-11" },
      ];
      await db.insert(schema.stagingRows).values([
        ...orders.map((o, i) => orderRow(s.orderJob, i + 1, `O${i}`, { orderNo: o.no, signedAt: `${o.signed}T00:00:00.000Z`, deliveryAt: `${o.signed}T00:00:00.000Z`, lines: [line("10")] }, { supplierId: s.supplierId })),
        ...orders.map((o, i) => receiptRow(s.receiptJob, i + 1, `R${i}`, { purchaseOrderNo: o.no, receiptNo: `SH-${i}`, receivedAt: `${o.received}T00:00:00.000Z`, lines: [rLine("10")] }, { supplierId: s.supplierId })),
      ]);
      // 系统侧学习交期：另一套口径、另一批样本
      await db.insert(schema.rollupSupplierLead).values({
        supplierId: s.supplierId, skuId: s.skuId, samples: 12,
        leadP50Days: "22.00", leadP90Days: "30.00", leadStdevDays: "4.00", onTimeRate: "0.6000",
      });

      const model = await computeSupplierLeadHistory(db);
      const row = model.bySupplierSku.find((r) => r.skuId === s.skuId)!;
      expect(row.observed.samples).toBe(4);
      expect(row.observed.p90).toBe(38.2);
      // 并列：系统侧原样保留，没有被历史观察平均掉
      expect(row.system).toEqual({ samples: 12, p50: 22, p90: 30, stdev: 4, onTimeRate: 0.6 });
      expect(row.archiveLeadDays).toBe(20);

      // 阈值不变：加工 20 + 在途 7 + 缓冲 5 = 32，接入观察前后完全一致
      const withoutObservation = alertDays({
        normalLeadDays: 20, logisticsLeadDays: 7, defaults: { production: 30, logistics: 15 }, bufferDays: 5,
        learned: { p50: 22, p90: 30, samples: 12, onTimeRate: 0.6 },
      });
      expect(row.alertDays).toBe(withoutObservation.days);
      expect(row.alertDays).toBe(32);
      expect(row.observedObservation).toMatchObject({ authority: "observation_only", observeOnly: true, applied: false, samples: 4 });
      expect(row.leadCompare).toBe("档案 20 / 系统学习 30(n=12) / 历史观察 38.2(n=4，只观察)");
      expect(row.alertBasis).toContain("加工 20 + 在途 7 + 缓冲 5");

      // 供给库存预警行的取数入口：按 SKU 取样本最多的一条
      const forSku = observedLeadForSku(model, s.skuId)!;
      expect(forSku.samples).toBe(4);
      expect(observedLeadForSku(model, 999_999)).toBeNull();

      // 缓存：按批次 + rollup + sku_params 绑定，键带 /v1
      const loaded = await loadSupplierLeadHistory(db);
      expect(loaded.key).toBe(SUPPLIER_LEAD_HISTORY_CACHE_KEY);
      const cached = await db.execute(sql`SELECT key, source_binding FROM report_read_model_cache WHERE key = ${SUPPLIER_LEAD_HISTORY_CACHE_KEY}`);
      const rows = (Array.isArray(cached) ? cached : (cached as { rows?: unknown[] }).rows ?? []) as { key: string; source_binding: string }[];
      expect(rows).toHaveLength(1);
      expect(rows[0].source_binding).toContain(`po:${s.orderJob}`);
      expect(rows[0].source_binding).toContain("rl:");
    } finally {
      await client.close();
    }
  });

  it("被 supersede 的订单批次不再可用（一次重同步不得静默改写历史）", async () => {
    const { db, client } = await createTestDb();
    try {
      const s = await seed(db);
      await db.insert(schema.stagingRows).values([
        orderRow(s.orderJob, 1, "O1", { orderNo: "PO-1", signedAt: "2024-03-01T00:00:00.000Z", deliveryAt: "2024-03-21T00:00:00.000Z", lines: [{ productCode: "N100-001", purchaseQty: "10" }] }, { supplierId: s.supplierId }),
        receiptRow(s.receiptJob, 1, "R1", { purchaseOrderNo: "PO-1", receiptNo: "SH-1", receivedAt: "2024-03-25T00:00:00.000Z", lines: [{ productCode: "N100-001", receivedQty: "10" }] }, { supplierId: s.supplierId }),
      ]);
      expect((await computeSupplierLeadHistory(db)).state).toBe("ready");

      await db.execute(sql`UPDATE import_jobs SET status = 'superseded' WHERE id = ${s.orderJob}`);
      const after = await computeSupplierLeadHistory(db);
      expect(after.state).toBe("insufficient");
      expect(after.totals.samples).toBe(0);
    } finally {
      await client.close();
    }
  });
  /* ── C1：可空的 on_time_rate 不得当成 0% 进加权分母 ── */
  it("系统侧样本加权准时率只用可评样本作分母：一对已测 100%、一对未测，读数是 100% 而不是 50%", async () => {
    const { db, client } = await createTestDb();
    try {
      const s = await seed(db);
      const [spu2] = await db.insert(schema.spus).values({ code: "SPU-LH2", nameCn: "第二品" }).returning();
      const [sku2] = await db.insert(schema.skus).values({ code: "N100-002", name: "精华 30ml", spuId: spu2.id, skuType: "finished", baseUom: "支" }).returning();
      // 一单可配对，供应商行才会出现
      await db.insert(schema.stagingRows).values([
        orderRow(s.orderJob, 1, "O1", { orderNo: "PO-1", signedAt: "2024-03-01T00:00:00.000Z", deliveryAt: "2024-03-21T00:00:00.000Z", lines: [{ productCode: "N100-001", purchaseQty: "10" }] }, { supplierId: s.supplierId }),
        receiptRow(s.receiptJob, 1, "R1", { purchaseOrderNo: "PO-1", receiptNo: "SH-1", receivedAt: "2024-03-25T00:00:00.000Z", lines: [{ productCode: "N100-001", receivedQty: "10" }] }, { supplierId: s.supplierId }),
      ]);
      // 同一供应商两个 (供应商 × SKU) 对子，样本数相同：一个测出 100%，另一个 on_time_rate 为 NULL（没测出来）
      await db.insert(schema.rollupSupplierLead).values([
        { supplierId: s.supplierId, skuId: s.skuId, samples: 10, leadP50Days: "20.00", leadP90Days: "25.00", leadStdevDays: "2.00", onTimeRate: "1.0000" },
        { supplierId: s.supplierId, skuId: sku2.id, samples: 10, leadP50Days: "20.00", leadP90Days: "25.00", leadStdevDays: "2.00", onTimeRate: null },
      ]);

      const model = await computeSupplierLeadHistory(db);
      const row = model.bySupplier.find((r) => r.supplierId === s.supplierId)!;
      expect(row.system).not.toBeNull();
      expect(row.system!.pairs).toBe(2);
      expect(row.system!.samples).toBe(20);      // 样本合计仍是 20（如实呈现规模）
      expect(row.system!.ratedSamples).toBe(10); // 但只有 10 个样本可评准时率
      // 未测量的对子若进分母，会渲染成 50% —— 把「没测」说成「一半没准时」
      expect(row.system!.onTimeRate).toBe(1);
    } finally {
      await client.close();
    }
  });

  it("全部对子都没测出准时率 → onTimeRate 为 null（不是 0%）", async () => {
    const { db, client } = await createTestDb();
    try {
      const s = await seed(db);
      await db.insert(schema.stagingRows).values([
        orderRow(s.orderJob, 1, "O1", { orderNo: "PO-1", signedAt: "2024-03-01T00:00:00.000Z", lines: [{ productCode: "N100-001", purchaseQty: "10" }] }, { supplierId: s.supplierId }),
        receiptRow(s.receiptJob, 1, "R1", { purchaseOrderNo: "PO-1", receiptNo: "SH-1", receivedAt: "2024-03-25T00:00:00.000Z", lines: [{ productCode: "N100-001", receivedQty: "10" }] }, { supplierId: s.supplierId }),
      ]);
      await db.insert(schema.rollupSupplierLead).values({
        supplierId: s.supplierId, skuId: s.skuId, samples: 8, leadP50Days: "20.00", leadP90Days: "25.00", leadStdevDays: "2.00", onTimeRate: null,
      });
      const row = (await computeSupplierLeadHistory(db)).bySupplier.find((r) => r.supplierId === s.supplierId)!;
      expect(row.system).toMatchObject({ pairs: 1, samples: 8, ratedSamples: 0, onTimeRate: null });
    } finally {
      await client.close();
    }
  });

  /* ── C7(a)：绑定必须覆盖 alertDays 用到的运行参数与 skus ── */
  it("source_binding 覆盖运行参数与 skus：改一个参数，页面不得继续引用旧阈值", async () => {
    const { db, client } = await createTestDb();
    try {
      const s = await seed(db);
      await db.insert(schema.stagingRows).values([
        orderRow(s.orderJob, 1, "O1", { orderNo: "PO-1", signedAt: "2024-03-01T00:00:00.000Z", deliveryAt: "2024-03-21T00:00:00.000Z", lines: [{ productCode: "N100-001", purchaseQty: "10" }] }, { supplierId: s.supplierId }),
        receiptRow(s.receiptJob, 1, "R1", { purchaseOrderNo: "PO-1", receiptNo: "SH-1", receivedAt: "2024-03-25T00:00:00.000Z", lines: [{ productCode: "N100-001", receivedQty: "10" }] }, { supplierId: s.supplierId }),
      ]);
      const before = await loadSupplierLeadHistory(db);
      const skuRowBefore = before.bySupplierSku.find((r) => r.skuId === s.skuId)!;
      expect(skuRowBefore.alertDays).toBe(32); // 加工 20 + 在途 7 + 缓冲 5
      const bindingBefore = before.sourceBinding;
      expect(bindingBefore).toContain("params:");
      expect(bindingBefore).toContain("alert_buffer_days=");
      expect(bindingBefore).toContain("sk:");

      // 缓冲天数从缺省 5 改成 9：阈值应立刻变成 36，绝不能继续供旧缓存
      await db.insert(schema.sysParams).values({ scope: "global", key: "alert_buffer_days", value: "9" });
      const after = await loadSupplierLeadHistory(db);
      expect(after.sourceBinding).not.toBe(bindingBefore);
      const skuRowAfter = after.bySupplierSku.find((r) => r.skuId === s.skuId)!;
      expect(skuRowAfter.alertDays).toBe(36);
      expect(skuRowAfter.alertBasis).toContain("缓冲 9");

      // skus 指纹：新增一个 SKU（可能让此前未映射的商品编码挂上系统 SKU）也要让绑定失效
      const bindingAfterParam = after.sourceBinding;
      const [spu3] = await db.insert(schema.spus).values({ code: "SPU-LH3", nameCn: "第三品" }).returning();
      await db.insert(schema.skus).values({ code: "N100-003", name: "水乳", spuId: spu3.id, skuType: "finished", baseUom: "支" });
      const afterSku = await loadSupplierLeadHistory(db);
      expect(afterSku.sourceBinding).not.toBe(bindingAfterParam);
    } finally {
      await client.close();
    }
  });
});
