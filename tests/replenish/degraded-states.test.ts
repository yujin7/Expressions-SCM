/**
 * 两个「降级时说谎」的小项。
 *
 * (a) 账面在库为负时的临期净额。`Math.min(净额, 账面在库)` 只夹了上限：
 *     账面为负（委外仓垫料等合法负值汇总后可为负）时它给出一个**负的** unsellableQty，
 *     `dSub(onHand, 负数)` 反而把可用在库调高，DTO 里还会出现负的
 *     `expiryRisk.unsellableQty` / `decisionEvidence.expiringUnsellable`。
 *     净额是「扣掉多少」，永远不可能是负数。
 *
 * (b) 引擎没算过的 SKU。`replenish/projection` 取不到引擎行时所有字段回落 0/null，
 *     曲线画出一条平的零线——读者看到的是「这个 SKU 一直没货也没需求」，
 *     真相是「引擎根本没算过它」。两者的处置完全不同，必须能分辨。
 */
import { describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import { getReplenishSuggestions } from "@/server/modules/replenish/service";
import { getSkuProjection } from "@/server/modules/replenish/projection";
import { todayShanghai } from "@/server/modules/master/common";
import { createTestDb } from "../helpers/db";

const dayAfter = (days: number): string =>
  new Date(Date.parse(`${todayShanghai()}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

describe("(a) 账面在库为负时不得产出负的临期净额", () => {
  it("负在库 → unsellableQty 夹到 0，可用在库不被「调高」，DTO 里不出现负数", async () => {
    const { db, client } = await createTestDb();
    try {
      const [spu] = await db.insert(schema.spus).values({ code: "P1", nameCn: "测试" }).returning();
      const [sku] = await db.insert(schema.skus).values({
        code: "CP00009", name: "面霜", spuId: spu.id, skuType: "finished", baseUom: "支", nearExpiryDays: 90,
      }).returning();
      const [ch] = await db.insert(schema.channels).values({ code: "tmall", name: "天猫", kind: "platform" }).returning();
      // 委外仓可负（R4 允许：加工厂垫料），全网汇总后账面在库为负
      const [wh] = await db.insert(schema.warehouses).values({
        code: "WH-OS", name: "委外仓", kind: "outsource", accountingMode: "realtime",
      }).returning();
      for (const ym of ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06"]) {
        await db.insert(schema.salesMonthly).values({ skuId: sku.id, channelId: ch.id, yearMonth: ym, qty: "900" });
      }
      await db.insert(schema.skuParams).values({ skuId: sku.id, normalLeadDays: 30, logisticsLeadDays: 15 });
      await db.insert(schema.stockBalances).values({ skuId: sku.id, warehouseId: wh.id, qty: "-200" });
      await db.insert(schema.batchStocks).values({
        skuId: sku.id, warehouseId: wh.id, stocktakeDate: todayShanghai(), batchNo: "B1",
        expiryDate: dayAfter(5), qty: "300",
      });

      const res = await getReplenishSuggestions({ allRows: true }, db);
      const row = res.rows.find((r) => r.skuId === sku.id)!;
      expect(row.onHand).toBe(-200);
      expect(row.expiryRisk!.unsellableQty, "净额是「扣掉多少」，不可能是负数").toBe(0);
      expect(Number(row.decisionEvidence.expiringUnsellable)).toBe(0);
      expect(row.availableOnHand, "不许因为夹取写错把可用在库反而调高").toBe(-200);
      expect(Number(row.decisionEvidence.availableOnHand)).toBe(-200);
    } finally {
      await client.close();
    }
  });
});

describe("(b) 引擎没覆盖的 SKU 不得画成一条「一直是 0」的平线", () => {
  it("非成品（引擎不跑）→ engineCovered=false 且给出可执行的说明，而不是静默的零曲线", async () => {
    const { db, client } = await createTestDb();
    try {
      const [spu] = await db.insert(schema.spus).values({ code: "P1", nameCn: "测试" }).returning();
      // 引擎只跑启用中的成品；原料不在范围内
      const [raw] = await db.insert(schema.skus).values({
        code: "RM00001", name: "原料A", spuId: spu.id, skuType: "raw", baseUom: "kg",
      }).returning();

      const proj = await getSkuProjection(raw.id, 120, db);
      expect(proj.engineCovered).toBe(false);
      expect(proj.engineCoverageReason, "必须说得出「为什么没覆盖」，而不只是一个 false").toBe("not_finished");
      expect(proj.engineCoverageNote, "零线必须自带解释，否则读者会读成「一直没货也没需求」").toBeTruthy();
      /* 引擎口径的数一律 null，**不是 0**：0 会被读成「算过，结果是 0」，
         于是抽屉给一个从未被计算的 SKU 画平线并宣布「视野内不会跌破安全库存」。 */
      expect(proj.startOnHand).toBeNull();
      expect(proj.safetyQty).toBeNull();
      expect(proj.daily).toBeNull();
      expect(proj.leadDays).toBeNull();
      expect(proj.points, "未覆盖不得画曲线").toEqual([]);
    } finally {
      await client.close();
    }
  });

  it("引擎覆盖的成品 → engineCovered=true 且不带未覆盖说明", async () => {
    const { db, client } = await createTestDb();
    try {
      const [spu] = await db.insert(schema.spus).values({ code: "P1", nameCn: "测试" }).returning();
      const [sku] = await db.insert(schema.skus).values({
        code: "CP00010", name: "面霜", spuId: spu.id, skuType: "finished", baseUom: "支",
      }).returning();
      const [ch] = await db.insert(schema.channels).values({ code: "tmall", name: "天猫", kind: "platform" }).returning();
      const [wh] = await db.insert(schema.warehouses).values({
        code: "WH-CP", name: "成品仓", kind: "finished", accountingMode: "realtime",
      }).returning();
      for (const ym of ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06"]) {
        await db.insert(schema.salesMonthly).values({ skuId: sku.id, channelId: ch.id, yearMonth: ym, qty: "900" });
      }
      await db.insert(schema.skuParams).values({ skuId: sku.id, normalLeadDays: 30, logisticsLeadDays: 15 });
      await db.insert(schema.stockBalances).values({ skuId: sku.id, warehouseId: wh.id, qty: "100" });

      const proj = await getSkuProjection(sku.id, 120, db);
      expect(proj.engineCovered).toBe(true);
      expect(proj.engineCoverageNote).toBeNull();
      expect(proj.startOnHand).toBe(100);
    } finally {
      await client.close();
    }
  });
});
