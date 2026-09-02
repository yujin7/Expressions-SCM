/**
 * 外部观察销速（简道云天猫近 30/90 天净需求）+ 驾驶舱/风险页影子列。
 *
 * 动机：内部 sales_monthly 停在 2026-06，外部日销到 2026-09；内部判"无动销"、外部仍在卖的 SKU
 * 最容易被错杀。这里钉住：窗口按批次内最大业务日锚定；两条身份桥都算；未映射 = null 不是 0；
 * 影子列不改内部销速与可销天数。
 */
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { createTestDb } from "../helpers/db";
import { computeExternalVelocity, loadExternalVelocity } from "@/server/modules/report/external-velocity";
import { getDashboard } from "@/server/modules/report/dashboard";
import { getRiskWorklist } from "@/server/modules/report/risk";

async function seed() {
  const { db, client } = await createTestDb();
  const [actor] = await db.insert(schema.users).values({ name: "外部数据责任人", roles: ["pmc"] }).returning();
  const [spu] = await db.insert(schema.spus).values({ code: "P90002", nameCn: "外部销速测试" }).returning();
  const [wh] = await db.insert(schema.warehouses).values({ code: "WH-EV", name: "测试仓", kind: "finished", accountingMode: "realtime", active: true }).returning();
  const mk = async (code: string) => {
    const [row] = await db.insert(schema.skus).values({ code, name: `货品${code}`, spuId: spu.id, skuType: "finished", baseUom: "支", commercialRole: "retail" }).returning();
    await db.insert(schema.stockBalances).values({ skuId: row.id, warehouseId: wh.id, batchId: null, qty: "500.0000" });
    return row;
  };
  const viaCrosswalk = await mk("EV-CW");   // 对照表唯一身份
  const viaDirect = await mk("EV-DIRECT");  // 直接认领
  const unmapped = await mk("EV-NONE");     // 没有任何外部身份
  const jobs = await db.insert(schema.importJobs).values([
    { template: "jdy_tmall_sku_crosswalk_observation", filename: "cw", sourceAsOf: "2026-09-01", createdBy: actor.id, status: "done" },
    { template: "jdy_tmall_sku_sales_observation", filename: "sales", sourceAsOf: "2026-09-02", createdBy: actor.id, status: "done" },
    { template: "jdy_tmall_sku_refund_observation", filename: "refunds", sourceAsOf: "2026-09-02", createdBy: actor.id, status: "done" },
  ]).returning();
  const [crosswalk, sales, refunds] = jobs;
  const finishedAt = new Date("2026-09-02T03:00:00.000Z");
  await db.insert(schema.integrationRuns).values([
    { connector: "jdy", stream: "tmall-sku-crosswalk-observation", idempotencyKey: "cw", status: "succeeded", importJobId: crosswalk.id, finishedAt },
    { connector: "jdy", stream: "tmall-sku-sales-observation", idempotencyKey: "sales", status: "succeeded", importJobId: sales.id, finishedAt },
    { connector: "jdy", stream: "tmall-sku-refund-observation", idempotencyKey: "refunds", status: "succeeded", importJobId: refunds.id, finishedAt },
  ]);
  const shop = "(天猫国际)NING海外旗舰店";
  await db.insert(schema.skuIdentifiers).values([
    { skuId: viaDirect.id, kind: "external", scope: "JIANDAOYUN:TMALL", value: `${shop}|P-DIRECT`, active: true, isPrimary: false, createdBy: actor.id },
    // 即使存在直接认领，对照表有多个系统 SKU 时也必须保持冲突，不得被第二桥覆盖。
    { skuId: viaDirect.id, kind: "external", scope: "JIANDAOYUN:TMALL", value: `${shop}|P-CONFLICT`, active: true, isPrimary: false, createdBy: actor.id },
  ]);
  const sale = (rowNo: number, psku: string, date: string, paid: string) => ({
    importJobId: sales.id, rowNo, status: "pending" as const, targetTable: "jdy_tmall_sku_sales_observation",
    payload: { data: { statisticalDate: date, shopName: shop, skuId: psku, paidNumber: paid, paidAmount: "1" } },
  });
  await db.insert(schema.stagingRows).values([
    { importJobId: crosswalk.id, rowNo: 1, status: "pending", targetTable: "jdy_tmall_sku_crosswalk_observation",
      payload: { data: { shopName: shop, platformSkuId: "P-CW" }, _identity: { skuId: viaCrosswalk.id } } },
    { importJobId: crosswalk.id, rowNo: 2, status: "pending", targetTable: "jdy_tmall_sku_crosswalk_observation",
      payload: { data: { shopName: shop, platformSkuId: "P-CONFLICT" }, _identity: { skuId: viaCrosswalk.id } } },
    { importJobId: crosswalk.id, rowNo: 3, status: "pending", targetTable: "jdy_tmall_sku_crosswalk_observation",
      payload: { data: { shopName: shop, platformSkuId: "P-CONFLICT" }, _identity: { skuId: viaDirect.id } } },
    // 锚点 = 2026-09-01。P-CW：30 天内 10+5，90 天内再 +20，90 天外 +100（不计）
    sale(1, "P-CW", "2026-09-01T00:00:00.000Z", "10"),
    sale(2, "P-CW", "2026-08-15", "5"),
    sale(3, "P-CW", "2026-07-01", "20"),
    sale(4, "P-CW", "2026-05-01", "100"),
    // P-DIRECT：小数数量验证全链路定点；0.3 − 0.1 必须精确等于 0.2。
    sale(5, "P-DIRECT", "2026-08-20", "0.3"),
    // P-NONE 没有任何身份桥 → 不归任何 SKU
    sale(6, "P-NONE", "2026-08-30", "999"),
    sale(7, "P-CONFLICT", "2026-08-30", "777"),
    { importJobId: refunds.id, rowNo: 1, status: "pending", targetTable: "jdy_tmall_sku_refund_observation",
      payload: { data: { statisticalDate: "2026-08-20", shopName: shop, skuId: "P-CW", successRefundSuborderNumber: "2" } } },
    { importJobId: refunds.id, rowNo: 2, status: "pending", targetTable: "jdy_tmall_sku_refund_observation",
      payload: { data: { statisticalDate: "2026-08-20", shopName: shop, skuId: "P-DIRECT", successRefundSuborderNumber: "0.1" } } },
  ]);
  return { db, client, actor, viaCrosswalk, viaDirect, unmapped };
}

describe("外部观察销速读模型", () => {
  it("质量阻断的拼多多批次不得被当成可用销速", async () => {
    const { db, client } = await createTestDb();
    try {
      const [actor] = await db.insert(schema.users).values({ name: "质量闸责任人" }).returning();
      const [job] = await db.insert(schema.importJobs).values({
        template: "jdy_pdd_order_observation", filename: "quality-blocked", sourceAsOf: "2026-09-03",
        createdBy: actor.id, status: "done",
      }).returning();
      await db.insert(schema.integrationRuns).values({
        connector: "jdy", stream: "pdd-order-observation", idempotencyKey: "quality-blocked",
        status: "succeeded", importJobId: job.id, requestScope: { qualityBlocked: true },
        finishedAt: new Date("2026-09-03T03:00:00.000Z"),
      });
      const result = await computeExternalVelocity(db);
      expect(result).toMatchObject({ state: "insufficient", bySku: {} });
    } finally {
      await client.close();
    }
  });
  it("按批次最大业务日锚定 30/90 天窗口，两条身份桥都算，未映射不计入", async () => {
    const { db, client, actor, viaCrosswalk, viaDirect, unmapped } = await seed();
    try {
      const v = await computeExternalVelocity(db);
      expect(v.state).toBe("ready");
      expect(v.anchorDate).toBe("2026-09-01");
      const cw = v.bySku[String(viaCrosswalk.id)]!;
      expect(cw.paid30).toBe("15.0000");
      expect(cw.refund30).toBe("2.0000");
      expect(cw.net30).toBe("13.0000");
      expect(cw.paid90).toBe("35.0000");
      expect(cw.net90).toBe("33.0000");
      expect(cw.lastSoldDate).toBe("2026-09-01");
      expect(cw.activeDays90).toBe(3);
      const direct = v.bySku[String(viaDirect.id)]!;
      expect(direct.net30).toBe("0.2000");
      expect(v.bySku[String(unmapped.id)]).toBeUndefined();
      expect(v.coverage).toEqual({
        platformSkus: 4,
        mappedPlatformSkus: 2,
        mappedSkus: 2,
        pddObservedDays30: 0,
        pddWindowComplete30: true,
      });

      const [emptySales] = await db.insert(schema.importJobs).values({
        template: "jdy_tmall_sku_sales_observation", filename: "empty-sales", sourceAsOf: "2026-09-03",
        createdBy: actor.id, status: "done",
      }).returning();
      await db.insert(schema.integrationRuns).values({
        connector: "jdy", stream: "tmall-sku-sales-observation", idempotencyKey: "empty-sales",
        status: "succeeded", importJobId: emptySales.id, requestScope: { emptySource: true },
        finishedAt: new Date("2026-09-03T03:00:00.000Z"),
      });
      const afterEmptyRead = await computeExternalVelocity(db);
      expect(afterEmptyRead.bySku[String(viaCrosswalk.id)]?.net30).toBe("13.0000");

      // 缓存命中：第二次读取不重算也一致
      const again = await loadExternalVelocity(db);
      expect(again.bySku[String(viaCrosswalk.id)]?.net30).toBe("13.0000");
    } finally {
      await client.close();
    }
  });

  it("驾驶舱滞销榜与风险页带外部影子列；内部无动销但外部在售被计数；未映射 = null", async () => {
    const { db, client, viaCrosswalk, unmapped } = await seed();
    try {
      const d = await getDashboard(["admin"], {}, db);
      expect(d.externalDemand.state).toBe("ready");
      expect(d.externalDemand.anchorDate).toBe("2026-09-01");
      // 三个 SKU 都没有内部销量 → 全部"无动销"；其中两个外部近 30 天在售
      expect(d.externalDemand.internalNoMoveButExternalSelling).toBe(2);
      const cwRow = d.slowTop.find((r) => r.code === viaCrosswalk.code)!;
      expect(cwRow.daysCover).toBeNull();          // 内部口径不变
      expect(cwRow.externalNet30).toBe("13.0000");
      expect(cwRow.externalLastSold).toBe("2026-09-01");
      const noneRow = d.slowTop.find((r) => r.code === unmapped.code)!;
      expect(noneRow.externalNet30).toBeNull();    // 未映射不是 0

      const risk = await getRiskWorklist({ pageSize: 100 }, db);
      const riskCw = risk.rows.find((r) => r.code === viaCrosswalk.code);
      expect(riskCw?.externalNet30).toBe("13.0000");
      const riskNone = risk.rows.find((r) => r.code === unmapped.code);
      expect(riskNone?.externalNet30 ?? null).toBeNull();
    } finally {
      await client.close();
    }
  });

  it("拼多多订单经对照表身份并入净需求：剔除已取消/退款成功，分平台可拆", async () => {
    const { db, client, viaCrosswalk } = await seed();
    try {
      const [actor] = await db.select().from(schema.users).limit(1);
      const [pddCw, pddOrders] = await db.insert(schema.importJobs).values([
        { template: "jdy_pdd_sku_crosswalk_observation", filename: "pdd-cw", sourceAsOf: "2026-09-01", createdBy: actor.id, status: "done" },
        { template: "jdy_pdd_order_observation", filename: "pdd-orders", sourceAsOf: "2026-09-02", createdBy: actor.id, status: "done" },
      ]).returning();
      const finishedAt = new Date("2026-09-02T04:00:00.000Z");
      await db.insert(schema.integrationRuns).values([
        { connector: "jdy", stream: "pdd-sku-crosswalk-observation", idempotencyKey: "pdd-cw", status: "succeeded", importJobId: pddCw.id, finishedAt },
        { connector: "jdy", stream: "pdd-order-observation", idempotencyKey: "pdd-orders", status: "succeeded", importJobId: pddOrders.id, finishedAt,
          requestScope: { window: {
            from: "2026-08-30T16:00:00.000Z",
            to: "2026-09-02T16:00:00.000Z",
            extractionCutoff: "2026-09-02T04:00:00.000Z",
          } } },
      ]);
      const shop = "(拼多多国际)NING官方海外旗舰店";
      const order = (rowNo: number, no: string, date: string, qty: string, status: string, afterSalesStatus = "", paymentTime = "") => ({
        importJobId: pddOrders.id, rowNo, status: "pending" as const, targetTable: "jdy_pdd_order_observation",
        payload: { data: { statisticalDate: date, shopName: shop, orderNumber: no, productId: "PID1", merchantSkuCode: "GW1", productQuantity: qty, orderStatus: status, afterSalesStatus, paymentTime } },
      });
      await db.insert(schema.stagingRows).values([
        { importJobId: pddCw.id, rowNo: 1, status: "pending", targetTable: "jdy_pdd_sku_crosswalk_observation",
          payload: { data: { shopName: shop, platformSkuId: "PS1", platformProductId: "PID1", merchantSkuCode: "GW1" }, _identity: { skuId: viaCrosswalk.id } } },
        order(1, "O1", "2026-08-25", "2", "已发货，待收货"),
        order(2, "O2", "2026-08-26", "3", "待发货"),
        order(3, "O3", "2026-08-27", "5", "已取消，退款成功"),
        order(4, "O4", "2026-06-20", "7", "已发货，待收货"),
        order(5, "O5", "2026-08-29", "11", "已发货，待收货", "退款成功"),
        order(6, "O6", "2026-08-30", "100", "待付款"),
      ]);
      const v = await computeExternalVelocity(db);
      const cw = v.bySku[String(viaCrosswalk.id)]!;
      expect(cw.pddNet30).toBe("5.0000");       // 2 + 3，取消的 5 不算
      expect(cw.pddIdentityCovered).toBe(true);
      expect(cw.pddNet90).toBe("12.0000");      // 再加 90 天内的 7
      expect(cw.tmallNet30).toBe("13.0000");
      expect(cw.net30).toBe("18.0000");         // 天猫 13 + 拼多多 5
      expect(v.pddSourceAsOf).toBe("2026-09-02");
      // 迟到更新带回 5 个订单日期，但实际抽取截止中午，只完整观察了 2 个自然日。
      expect(v.coverage.pddObservedDays30).toBe(2);
      expect(v.coverage.pddWindowComplete30).toBe(false);

      // 新批次的删除标记必须压过旧订单版本；不能让已删除的 O1 继续贡献 2 件。
      const [deletedOrders] = await db.insert(schema.importJobs).values({
        template: "jdy_pdd_order_observation", filename: "pdd-orders-tombstone", sourceAsOf: "2026-09-03",
        createdBy: actor.id, status: "done",
      }).returning();
      await db.insert(schema.integrationRuns).values({
        connector: "jdy", stream: "pdd-order-observation", idempotencyKey: "pdd-orders-tombstone",
        status: "succeeded", importJobId: deletedOrders.id, finishedAt: new Date("2026-09-03T04:00:00.000Z"),
        requestScope: { window: {
          from: "2026-08-31T16:00:00.000Z",
          to: "2026-09-03T16:00:00.000Z",
          extractionCutoff: "2026-09-03T04:00:00.000Z",
        } },
      });
      await db.insert(schema.stagingRows).values({
        importJobId: deletedOrders.id, rowNo: 1, status: "pending", targetTable: "jdy_pdd_order_observation",
        payload: {
          sourceDeletedAt: "2026-09-03T03:30:00.000Z",
          data: { statisticalDate: "2026-08-25", shopName: shop, orderNumber: "O1", productId: "PID1", merchantSkuCode: "GW1", productQuantity: "2", orderStatus: "已发货，待收货" },
        },
      });
      const afterDelete = await computeExternalVelocity(db);
      expect(afterDelete.bySku[String(viaCrosswalk.id)]?.pddNet30).toBe("3.0000");
      expect(afterDelete.bySku[String(viaCrosswalk.id)]?.pddNet90).toBe("10.0000");

      // 对照表 tombstone 必须先压过同一三元组旧映射，再整体退出身份桥。
      await db.insert(schema.stagingRows).values({
        importJobId: pddCw.id, rowNo: 2, status: "pending", targetTable: "jdy_pdd_sku_crosswalk_observation",
        payload: {
          sourceDeletedAt: "2026-09-03T05:00:00.000Z",
          data: { shopName: shop, platformSkuId: "PS1", platformProductId: "PID1", merchantSkuCode: "GW1" },
          _identity: { skuId: viaCrosswalk.id },
        },
      });
      const afterMappingDelete = await computeExternalVelocity(db);
      expect(afterMappingDelete.bySku[String(viaCrosswalk.id)]).toMatchObject({
        tmallNet30: "13.0000", pddNet30: "0.0000", net30: "13.0000",
      });
    } finally {
      await client.close();
    }
  });

  it("拼多多覆盖按成功查询窗口累计，零订单日也能形成完整 30 天观察", async () => {
    const { db, client } = await createTestDb();
    try {
      const [actor] = await db.insert(schema.users).values({ name: "拼多多窗口责任人" }).returning();
      const [job] = await db.insert(schema.importJobs).values({
        template: "jdy_pdd_order_observation", filename: "empty-pdd-windows",
        sourceAsOf: "2026-09-02", createdBy: actor.id, status: "done",
      }).returning();
      const runs = Array.from({ length: 10 }, (_, index) => {
        // UTC 16:00 = 中国业务日次日 00:00。十个无缝 3 日抽取岛共覆盖 30 个完整业务日。
        const from = new Date(Date.UTC(2026, 6, 30 + index * 3, 16));
        const cutoff = new Date(Date.UTC(2026, 7, 2 + index * 3, 16));
        const finishedAt = new Date(cutoff.getTime() + 60_000);
        return {
          connector: "jdy",
          stream: "pdd-order-observation",
          idempotencyKey: `empty-window-${index}`,
          status: "succeeded",
          importJobId: job.id,
          finishedAt,
          requestScope: { window: {
            from: from.toISOString(),
            to: cutoff.toISOString(),
            extractionCutoff: cutoff.toISOString(),
          } },
        };
      });
      await db.insert(schema.integrationRuns).values(runs);

      const result = await computeExternalVelocity(db);
      expect(result.state).toBe("insufficient");
      expect(result.anchorDate).toBe("2026-08-29");
      expect(result.coverage.pddObservedDays30).toBe(30);
      expect(result.coverage.pddWindowComplete30).toBe(true);

      // 停机一天超过连续边界后，最新抽取岛从 8/31 重新计数；不能沿用旧 30 天资格。
      await db.insert(schema.integrationRuns).values({
        connector: "jdy",
        stream: "pdd-order-observation",
        idempotencyKey: "window-after-outage",
        status: "succeeded",
        importJobId: job.id,
        finishedAt: new Date("2026-09-02T16:01:00.000Z"),
        requestScope: { window: {
          from: "2026-08-30T16:00:00.000Z",
          to: "2026-09-02T16:00:00.000Z",
          extractionCutoff: "2026-09-02T16:00:00.000Z",
        } },
      });
      const afterOutage = await computeExternalVelocity(db);
      expect(afterOutage.anchorDate).toBe("2026-09-02");
      expect(afterOutage.coverage.pddObservedDays30).toBe(3);
      expect(afterOutage.coverage.pddWindowComplete30).toBe(false);
    } finally {
      await client.close();
    }
  });

  it("拼多多直接认领（JIANDAOYUN:PDD）也能把订单件数归到系统 SKU", async () => {
    const { db, client, viaDirect } = await seed();
    try {
      const [actor] = await db.select().from(schema.users).limit(1);
      const [pddOrders] = await db.insert(schema.importJobs).values([
        { template: "jdy_pdd_order_observation", filename: "pdd-orders", sourceAsOf: "2026-09-02", createdBy: actor.id, status: "done" },
      ]).returning();
      await db.insert(schema.integrationRuns).values([
        { connector: "jdy", stream: "pdd-order-observation", idempotencyKey: "pdd-orders-2", status: "succeeded", importJobId: pddOrders.id, finishedAt: new Date("2026-09-02T04:00:00.000Z") },
      ]);
      const shop = "(拼多多国际)EXPRESSIONS海外旗舰店";
      await db.insert(schema.skuIdentifiers).values({ skuId: viaDirect.id, kind: "external", scope: "JIANDAOYUN:PDD", value: `${shop}|PID9|GE028-000`, active: true, isPrimary: false, createdBy: actor.id });
      await db.insert(schema.stagingRows).values([
        { importJobId: pddOrders.id, rowNo: 1, status: "pending", targetTable: "jdy_pdd_order_observation",
          payload: { data: { statisticalDate: "2026-08-28", shopName: shop, orderNumber: "X1", productId: "PID9", merchantSkuCode: "GE028-000", productQuantity: "4", orderStatus: "待发货" } } },
      ]);
      const v = await computeExternalVelocity(db);
      expect(v.bySku[String(viaDirect.id)]?.pddNet30).toBe("4.0000");
      expect(v.bySku[String(viaDirect.id)]?.pddIdentityCovered).toBe(true);
      expect(v.bySku[String(viaDirect.id)]?.net30).toBe("4.2000");
    } finally {
      await client.close();
    }
  });

  it("没有天猫批次时，拼多多成功批次仍可独立形成外部销速并命中缓存", async () => {
    const { db, client } = await createTestDb();
    try {
      const [actor] = await db.insert(schema.users).values({ name: "拼多多独立观察责任人" }).returning();
      const [spu] = await db.insert(schema.spus).values({ code: "P-PDD-ONLY", nameCn: "拼多多独立观察" }).returning();
      const [sku] = await db.insert(schema.skus).values({
        code: "PDD-ONLY-001", name: "拼多多独立观察成品", spuId: spu.id,
        skuType: "finished", baseUom: "支", commercialRole: "retail",
      }).returning();
      const [olderJob, job] = await db.insert(schema.importJobs).values([
        { template: "jdy_pdd_order_observation", filename: "pdd-only-older", sourceAsOf: "2026-08-26", createdBy: actor.id, status: "done" },
        { template: "jdy_pdd_order_observation", filename: "pdd-only", sourceAsOf: "2026-09-02", createdBy: actor.id, status: "done" },
      ]).returning();
      const [olderRun] = await db.insert(schema.integrationRuns).values([
        { connector: "jdy", stream: "pdd-order-observation", idempotencyKey: "pdd-only-older", status: "succeeded", importJobId: olderJob.id, finishedAt: new Date("2026-08-26T04:00:00.000Z") },
        { connector: "jdy", stream: "pdd-order-observation", idempotencyKey: "pdd-only", status: "succeeded", importJobId: job.id, finishedAt: new Date("2026-09-02T04:00:00.000Z") },
      ]).returning();
      const shop = "无品牌名的拼多多店";
      await db.insert(schema.skuIdentifiers).values({
        skuId: sku.id, kind: "external", scope: "JIANDAOYUN:PDD",
        value: `${shop}|PID-ONLY|M-ONLY`, active: true, isPrimary: false, createdBy: actor.id,
      });
      await db.insert(schema.stagingRows).values([
        { importJobId: olderJob.id, rowNo: 1, status: "pending", targetTable: "jdy_pdd_order_observation", payload: { data: { statisticalDate: "2026-08-25", shopName: shop, orderNumber: "PDD-ONLY-OLD", productId: "PID-ONLY", merchantSkuCode: "M-ONLY", productQuantity: "2", orderStatus: "待发货" } } },
        { importJobId: job.id, rowNo: 1, status: "pending", targetTable: "jdy_pdd_order_observation", payload: { data: { statisticalDate: "2026-09-01", shopName: shop, orderNumber: "PDD-ONLY-O1", productId: "PID-ONLY", merchantSkuCode: "M-ONLY", productQuantity: "6", orderStatus: "待发货" } } },
      ]);

      const computed = await computeExternalVelocity(db);
      expect(computed).toMatchObject({ state: "ready", sourceAsOf: null, pddSourceAsOf: "2026-09-02", anchorDate: "2026-09-01" });
      expect(computed.bySku[String(sku.id)]).toMatchObject({ pddNet30: "8.0000", net30: "8.0000" });
      const cached = await loadExternalVelocity(db);
      expect(cached.bySku[String(sku.id)]?.pddNet30).toBe("8.0000");

      // 最新批次仍保留且最新 job ID 不变；任一较早批次过期也必须刷新缓存并移除其数量。
      await db.update(schema.integrationRuns)
        .set({ finishedAt: new Date("2025-01-01T00:00:00.000Z") })
        .where(eq(schema.integrationRuns.id, olderRun.id));
      const expired = await loadExternalVelocity(db);
      expect(expired.bySku[String(sku.id)]).toMatchObject({ pddNet30: "6.0000", net30: "6.0000" });
    } finally {
      await client.close();
    }
  });
});
