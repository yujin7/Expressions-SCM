/**
 * 库存预警表（D57）与爆单预警（D56）读模型 + 看门狗投影。
 */
import { describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import { createTestDb } from "../helpers/db";
import { computeInventoryAlerts } from "@/server/modules/report/inventory-alerts";
import { computeSalesSpike } from "@/server/modules/report/sales-spike";
import { runInventoryCoverWatchdog, runSalesSpikeWatchdog } from "@/jobs/alert-watchdogs";

async function seed(db: Awaited<ReturnType<typeof createTestDb>>["db"]) {
  const [actor] = await db.insert(schema.users).values({ name: "责任人", roles: ["pmc"] }).returning();
  const [brand] = await db.insert(schema.brands).values({ code: "NING", nameCn: "NING", nameEn: "NING" }).returning();
  const [spu] = await db.insert(schema.spus).values({ code: "P1", nameCn: "测试" }).returning();
  const [hot] = await db.insert(schema.skus).values({ code: "N001-000", name: "爆款", spuId: spu.id, skuType: "finished", baseUom: "支", brandId: brand.id }).returning();
  const [cold] = await db.insert(schema.skus).values({ code: "N002-000", name: "冷门", spuId: spu.id, skuType: "finished", baseUom: "支", brandId: brand.id }).returning();
  const [ch] = await db.insert(schema.channels).values({ code: "tmall", name: "天猫", kind: "platform" }).returning();
  // 内部月销：hot 6 月 3000（日均 ~16），cold 60
  for (const ym of ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06"]) {
    await db.insert(schema.salesMonthly).values([{ skuId: hot.id, channelId: ch.id, yearMonth: ym, qty: "500" }, { skuId: cold.id, channelId: ch.id, yearMonth: ym, qty: "10" }]);
  }
  // 周期主数据：hot 有（20+10），cold 缺
  await db.insert(schema.skuParams).values({ skuId: hot.id, normalLeadDays: 20, logisticsLeadDays: 10 });
  // 在库：hot 100（主日销取外部 145/30≈4.8 → 可销 ~21 天 < 35 阈值），cold 0（有需求无在库 → 断货）
  const [wh] = await db.insert(schema.warehouses).values({ code: "WH-CP", name: "成品仓", kind: "finished", accountingMode: "realtime" }).returning();
  await db.insert(schema.stockBalances).values({ skuId: hot.id, warehouseId: wh.id, qty: "100" });
  // 天猫日销批次 + 对照表身份
  const [salesJob, cwJob] = await db.insert(schema.importJobs).values([
    { template: "jdy_tmall_sku_sales_observation", filename: "s", sourceAsOf: "2026-09-02", createdBy: actor.id, status: "done" },
    { template: "jdy_tmall_sku_crosswalk_observation", filename: "c", sourceAsOf: "2026-09-02", createdBy: actor.id, status: "done" },
  ]).returning();
  const finishedAt = new Date("2026-09-03T03:00:00.000Z");
  await db.insert(schema.integrationRuns).values([
    { connector: "jdy", stream: "tmall-sku-sales-observation", idempotencyKey: "s", status: "succeeded", importJobId: salesJob.id, finishedAt },
    { connector: "jdy", stream: "tmall-sku-crosswalk-observation", idempotencyKey: "c", status: "succeeded", importJobId: cwJob.id, finishedAt },
  ]);
  const shop = "(天猫国际)NING海外旗舰店";
  await db.insert(schema.stagingRows).values({ importJobId: cwJob.id, rowNo: 1, status: "pending", targetTable: "jdy_tmall_sku_crosswalk_observation", payload: { data: { shopName: shop, platformSkuId: "P-HOT" }, _identity: { skuId: hot.id } } });
  const rows: { importJobId: number; rowNo: number; status: "pending"; targetTable: string; payload: unknown }[] = [];
  let n = 1;
  // hot：前 7 天每日 10，最近 3 天 20/25/30（≥15）→ 命中；未映射平台 SKU P-X：前 7 天 2，最近 3 天 30/30/30 → 基线 2 < 10 不命中
  const days = ["2026-08-24", "2026-08-25", "2026-08-26", "2026-08-27", "2026-08-28", "2026-08-29", "2026-08-30", "2026-08-31", "2026-09-01", "2026-09-02"];
  days.forEach((d, i) => {
    const hotQty = i < 7 ? 10 : [20, 25, 30][i - 7];
    rows.push({ importJobId: salesJob.id, rowNo: n++, status: "pending", targetTable: "jdy_tmall_sku_sales_observation", payload: { data: { statisticalDate: d, shopName: shop, skuId: "P-HOT", paidNumber: String(hotQty), paidAmount: String(hotQty * 100) } } });
    rows.push({ importJobId: salesJob.id, rowNo: n++, status: "pending", targetTable: "jdy_tmall_sku_sales_observation", payload: { data: { statisticalDate: d, shopName: shop, skuId: "P-X", paidNumber: String(i < 7 ? 2 : 30), paidAmount: "1" } } });
  });
  await db.insert(schema.stagingRows).values(rows);
  return { hot, cold, actor };
}

describe("库存预警表 + 爆单预警 + 看门狗", () => {
  it("阈值逐 SKU（缺省标注）、主预警互斥、爆单命中已映射 SKU、小基数不命中；看门狗投影为去重告警", async () => {
    const { db, client } = await createTestDb();
    try {
      const { hot, cold } = await seed(db);
      const spike = await computeSalesSpike(db);
      expect(spike.state).toBe("ready");
      expect(spike.hits.map((h) => h.skuId)).toEqual([hot.id]);
      expect(spike.unmappedHits).toHaveLength(0); // 基线 2 < 最低基数 10
      expect(spike.coverage).toMatchObject({ platformSeries: 2, mappedSeries: 1 });

      const model = await computeInventoryAlerts(db);
      const h = model.rows.find((r) => r.skuId === hot.id)!;
      const c = model.rows.find((r) => r.skuId === cold.id)!;
      expect(h.alertDays).toBe(35); // 20 + 10 + 5
      expect(h.usedDefault).toBe(false);
      expect(c.alertDays).toBe(50); // 30 + 15 + 5 缺省
      expect(c.usedDefault).toBe(true);
      expect(h.tier).toBe("S");
      expect(h.primary).toBe("spike"); // 爆单优先于低库存标签
      expect(h.primaryDailySource).toBe("external");
      expect(h.tags).toContain("low_stock");
      expect(c.primary).toBe("out_of_stock");
      expect(c.tier).toBe("C"); // C 级只列表不开告警（D57）
      expect(model.rows[0].skuId).toBe(hot.id); // 有主预警且分数高者在前

      const w1 = await runInventoryCoverWatchdog(db, new Date("2026-09-03T03:00:00.000Z"));
      expect(w1.opened).toBe(1); // 只有 S 级 hot 开告警；C 级 cold 不开
      const w2 = await runSalesSpikeWatchdog(db, new Date("2026-09-03T03:00:00.000Z"));
      expect(w2.opened).toBe(1);
      const again = await runInventoryCoverWatchdog(db, new Date("2026-09-03T04:00:00.000Z"));
      expect(again).toMatchObject({ opened: 0, refreshed: 1, autoClosed: 0 });
    } finally {
      await client.close();
    }
  });
});
