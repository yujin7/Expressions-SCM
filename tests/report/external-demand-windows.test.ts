import { describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import { createTestDb } from "../helpers/db";
import { computeExternalVelocity } from "@/server/modules/report/external-velocity";
import { getReplenishSuggestions } from "@/server/modules/replenish/service";

async function fixture() {
  const { db, client } = await createTestDb();
  const [actor] = await db.insert(schema.users).values({ name: "窗口核验" }).returning();
  const [spu] = await db.insert(schema.spus).values({ code: "WINDOW", nameCn: "窗口" }).returning();
  const [sku] = await db.insert(schema.skus).values({ code: "WIN-1", name: "窗口商品", spuId: spu.id, skuType: "finished", baseUom: "支" }).returning();
  const [sales, refunds] = await db.insert(schema.importJobs).values([
    "jdy_tmall_sku_sales_observation", "jdy_tmall_sku_refund_observation",
  ].map((template) => ({ template, filename: template, createdBy: actor.id, status: "done" as const, sourceAsOf: "2026-09-07" }))).returning();
  await db.insert(schema.integrationRuns).values([sales, refunds].map((job, i) => ({ connector: "jdy", stream: i ? "tmall-sku-refund-observation" : "tmall-sku-sales-observation", importJobId: job.id, idempotencyKey: `window-${i}`, status: "succeeded" as const, finishedAt: new Date() })));
  let rowNo = 0;
  const day = (back: number) => new Date(Date.UTC(2026, 8, 7 - back)).toISOString().slice(0, 10);
  const fact = (job: typeof sales, shop: string, back: number, qty: string, deleted = false) => ({
    importJobId: job.id, rowNo: ++rowNo, status: "pending" as const, targetTable: job.template,
    payload: { ...(deleted ? { sourceDeletedAt: "2026-09-08" } : {}), data: { shopName: shop, skuId: "P1", statisticalDate: day(back), paidNumber: qty, successRefundSuborderNumber: qty } },
  });
  const series = async (shop: string, days: number, paid: string, refund: string) => {
    await db.insert(schema.skuIdentifiers).values({ skuId: sku.id, kind: "external", scope: "JIANDAOYUN:TMALL", value: `${shop}|P1`, active: true, createdBy: actor.id });
    await db.insert(schema.stagingRows).values(Array.from({ length: days }, (_, i) => [fact(sales, shop, i, paid), fact(refunds, shop, i, refund)]).flat());
  };
  return { db, client, actor, sku, sales, refunds, fact, series };
}

describe("external net-demand windows require independent daily evidence", () => {
  it.each([
    { days: 7, paid: "3", refund: "0.3", daily: null },
    { days: 30, paid: "1", refund: "1", daily: 0 },
    { days: 30, paid: "1", refund: "2", daily: -1 },
    { days: 30, paid: "3", refund: "0.3", daily: 2.7 },
  ])("replenishment consumes real $days-day evidence without converting unknown to decimal or changing quantity ($daily)", async ({ days, paid, refund, daily }) => {
    const f = await fixture();
    try {
      await f.series("补货跨域", days, paid, refund);
      const result = await getReplenishSuggestions({ q: "WIN-1" }, f.db);
      expect(result.rows).toHaveLength(1);
      const row = result.rows[0];
      expect(row.externalDaily30).toBe(daily);
      if (daily == null) expect(row.externalDaily30Gate).toContain("30日窗口覆盖不足");
      else expect(row.externalDaily30Gate).toBeNull();
      // External observations remain a parallel reference, never R11 quantity inputs.
      expect(row.suggestQty).toBeNull();
      expect(row.daily).toBe(0);
    } finally { await f.client.close(); }
  });

  it("invalid calendar evidence remains unknown without a SQL 500", async () => {
    const f = await fixture();
    try {
      await f.series("日历店", 30, "1", "0");
      const bad = f.fact(f.refunds, "日历店", 1, "0");
      bad.payload.data.statisticalDate = "2026-02-30";
      await f.db.insert(schema.stagingRows).values(bad);
      const row = (await computeExternalVelocity(f.db)).bySku[f.sku.id];
      expect(row.windows[7]).toMatchObject({ complete: false, net: null });
    } finally { await f.client.close(); }
  });

  it("PDD complete zero-order days qualify seven days only; shop belongs to the order identity", async () => {
    const f = await fixture();
    try {
      const [job] = await f.db.insert(schema.importJobs).values({ template: "jdy_pdd_order_observation", filename: "pdd-window", createdBy: f.actor.id, status: "done", sourceAsOf: "2026-09-07" }).returning();
      await f.db.insert(schema.integrationRuns).values({ connector: "jdy", stream: "pdd-order-observation", importJobId: job.id, idempotencyKey: "pdd-window", status: "succeeded", finishedAt: new Date(), requestScope: { window: { from: "2026-09-01T00:00:00+08:00", to: "2026-09-09T00:00:00+08:00", extractionCutoff: "2026-09-08T10:00:00+08:00" } } });
      await f.db.insert(schema.skuIdentifiers).values(["甲", "乙"].map(shop => ({ skuId: f.sku.id, kind: "external" as const, scope: "JIANDAOYUN:PDD", value: `${shop}|P|M`, active: true, createdBy: f.actor.id })));
      let model = await computeExternalVelocity(f.db);
      expect(model.anchorDate).toBe("2026-09-07"); // Do not count the current partial day.
      expect(model.bySku[f.sku.id].windows[7]).toMatchObject({ net: "0.0000", complete: true, requiredSequences: 2, completeSequences: 2 });
      expect(model.bySku[f.sku.id].windows[15].net).toBeNull();
      expect(model.bySku[f.sku.id].net30).toBeNull();
      const order = (shop: string, rowNo: number, qty: string, date = "2026-09-07") => ({ importJobId: job.id, rowNo, status: "pending" as const, targetTable: "jdy_pdd_order_observation", payload: { data: { shopName: shop, orderNumber: "SAME-ORDER", productId: "P", merchantSkuCode: "M", productQuantity: qty, statisticalDate: date, orderStatus: "已发货" } } });
      await f.db.insert(schema.stagingRows).values([order("甲", 1, "2.1"), order("乙", 2, "3.2")]);
      model = await computeExternalVelocity(f.db);
      expect(model.bySku[f.sku.id].windows[7].net).toBe("5.3000");
      await f.db.insert(schema.stagingRows).values(order("乙", 3, "4.2"));
      expect((await computeExternalVelocity(f.db)).bySku[f.sku.id].windows[7].net).toBe("6.3000");
      await f.db.insert(schema.stagingRows).values(order("乙", 4, "4.2", "2026-02-30"));
      expect((await computeExternalVelocity(f.db)).bySku[f.sku.id].windows[7]).toMatchObject({ net: null, completeSequences: 1 });
    } finally { await f.client.close(); }
  });

  it("publishes precise 7/15/30 totals independently; zero and negative net are real observations", async () => {
    const f = await fixture();
    try {
      await f.series("完整店", 30, "0.3000", "0.1000");
      let row = (await computeExternalVelocity(f.db)).bySku[f.sku.id];
      expect(row.windows["7"]).toMatchObject({ days: 7, startDay: "2026-09-01", endDay: "2026-09-07", complete: true, net: "1.4000", requiredSequences: 1, completeSequences: 1 });
      expect(row.windows["15"].net).toBe("3.0000");
      expect(row.net30).toBe("6.0000");
      expect(row.net90).toBeNull();
      await f.db.insert(schema.stagingRows).values(f.fact(f.refunds, "完整店", 0, "1.5000"));
      row = (await computeExternalVelocity(f.db)).bySku[f.sku.id];
      expect(row.windows["7"].net).toBe("0.0000");
      await f.db.insert(schema.stagingRows).values(f.fact(f.refunds, "完整店", 0, "2.5000"));
      expect((await computeExternalVelocity(f.db)).bySku[f.sku.id].windows["7"].net).toBe("-1.0000");
    } finally { await f.client.close(); }
  });

  it("one shop cannot fill another shop's missing days; invalid latest values and deletions cannot resurrect older evidence", async () => {
    const f = await fixture();
    try {
      await f.series("甲店", 30, "10", "1");
      await f.series("乙店", 7, "2", "0");
      let row = (await computeExternalVelocity(f.db)).bySku[f.sku.id];
      expect(row.windows["7"]).toMatchObject({ net: "77.0000", completeSequences: 2, requiredSequences: 2 });
      expect(row.windows["15"]).toMatchObject({ net: null, completeSequences: 1, requiredSequences: 2 });
      expect(row.net30).toBeNull();
      // A latest invalid refund is unknown, never a zero refund or a reason to reuse the older zero.
      await f.db.insert(schema.stagingRows).values(f.fact(f.refunds, "乙店", 0, "bad"));
      row = (await computeExternalVelocity(f.db)).bySku[f.sku.id];
      expect(row.windows["7"]).toMatchObject({ net: null, complete: false });
      await f.db.insert(schema.stagingRows).values(f.fact(f.refunds, "乙店", 0, "0", true));
      expect((await computeExternalVelocity(f.db)).bySku[f.sku.id].windows["7"].net).toBeNull();
    } finally { await f.client.close(); }
  });
});
