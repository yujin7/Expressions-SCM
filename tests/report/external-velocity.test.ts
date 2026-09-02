/**
 * 外部观察销速（简道云天猫近 30/90 天净需求）+ 驾驶舱/风险页影子列。
 *
 * 动机：内部 sales_monthly 停在 2026-06，外部日销到 2026-09；内部判"无动销"、外部仍在卖的 SKU
 * 最容易被错杀。这里钉住：窗口按批次内最大业务日锚定；两条身份桥都算；未映射 = null 不是 0；
 * 影子列不改内部销速与可销天数。
 */
import { describe, expect, it } from "vitest";
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
    // P-DIRECT：只在 30 天内卖了 3
    sale(5, "P-DIRECT", "2026-08-20", "3"),
    // P-NONE 没有任何身份桥 → 不归任何 SKU
    sale(6, "P-NONE", "2026-08-30", "999"),
    sale(7, "P-CONFLICT", "2026-08-30", "777"),
    { importJobId: refunds.id, rowNo: 1, status: "pending", targetTable: "jdy_tmall_sku_refund_observation",
      payload: { data: { statisticalDate: "2026-08-20", shopName: shop, skuId: "P-CW", successRefundSuborderNumber: "2" } } },
  ]);
  return { db, client, viaCrosswalk, viaDirect, unmapped };
}

describe("外部观察销速读模型", () => {
  it("按批次最大业务日锚定 30/90 天窗口，两条身份桥都算，未映射不计入", async () => {
    const { db, client, viaCrosswalk, viaDirect, unmapped } = await seed();
    try {
      const v = await computeExternalVelocity(db);
      expect(v.state).toBe("ready");
      expect(v.anchorDate).toBe("2026-09-01");
      const cw = v.bySku[String(viaCrosswalk.id)]!;
      expect(cw.paid30).toBe(15);
      expect(cw.refund30).toBe(2);
      expect(cw.net30).toBe(13);
      expect(cw.paid90).toBe(35);
      expect(cw.net90).toBe(33);
      expect(cw.lastSoldDate).toBe("2026-09-01");
      expect(cw.activeDays90).toBe(3);
      const direct = v.bySku[String(viaDirect.id)]!;
      expect(direct.net30).toBe(3);
      expect(v.bySku[String(unmapped.id)]).toBeUndefined();
      expect(v.coverage).toEqual({ platformSkus: 4, mappedPlatformSkus: 2, mappedSkus: 2 });

      // 缓存命中：第二次读取不重算也一致
      const again = await loadExternalVelocity(db);
      expect(again.bySku[String(viaCrosswalk.id)]?.net30).toBe(13);
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
      expect(cwRow.externalNet30).toBe(13);
      expect(cwRow.externalLastSold).toBe("2026-09-01");
      const noneRow = d.slowTop.find((r) => r.code === unmapped.code)!;
      expect(noneRow.externalNet30).toBeNull();    // 未映射不是 0

      const risk = await getRiskWorklist({ pageSize: 100 }, db);
      const riskCw = risk.rows.find((r) => r.code === viaCrosswalk.code);
      expect(riskCw?.externalNet30).toBe(13);
      const riskNone = risk.rows.find((r) => r.code === unmapped.code);
      expect(riskNone?.externalNet30 ?? null).toBeNull();
    } finally {
      await client.close();
    }
  });
});
