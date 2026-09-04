/**
 * W2-#2 临期不进补货判定 = 结构性缺货。
 *
 * `core/stock-view.getOnHandBySku` 把临期与已过期批次一并算作在库，逐日推演据此判「视野内水位够」，
 * 那批货随后过期报废——库存表上一直有数，货架上却断了。补的不是参数，是**判定的输入**。
 *
 * 纪律同时钉住：账面在库（onHand）**不许被悄悄改小**，扣减量与理由必须在行上单独给出。
 */
import { describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import { netExpiringStock } from "@/server/rules/expiry-netting";
import { getReplenishSuggestions } from "@/server/modules/replenish/service";
import { todayShanghai } from "@/server/modules/master/common";
import { createTestDb } from "../helpers/db";

const dayAfter = (days: number): string =>
  new Date(Date.parse(`${todayShanghai()}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

describe("临期净额纯函数（rules/expiry-netting）", () => {
  it("已过期批次容量为 0，全额计入", () => {
    const r = netExpiringStock({ batches: [{ daysLeft: -3, qty: 500 }], daily: 10, horizonDays: 120 });
    expect(r).toMatchObject({ unsellableQty: 500, expiredQty: 500, bindingDaysLeft: -3 });
  });

  it("按 FEFO 前缀比较：先到期的批次挤占后到期批次的销售窗口", () => {
    // 日均 10：10 天内最多卖 100，20 天内最多卖 200
    const r = netExpiringStock({
      batches: [{ daysLeft: 20, qty: 100 }, { daysLeft: 10, qty: 300 }],
      daily: 10,
      horizonDays: 120,
    });
    // 第一批（10 天）300 − 100 = 200；前两批合计 400 − 200 = 200；取最大 200
    expect(r.unsellableQty).toBe(200);
    expect(r.atRiskQty).toBe(400);
  });

  it("效期够长的批次卖得完，不产生净额", () => {
    const r = netExpiringStock({ batches: [{ daysLeft: 60, qty: 300 }], daily: 10, horizonDays: 120 });
    expect(r).toMatchObject({ unsellableQty: 0, bindingDaysLeft: null, atRiskQty: 300 });
  });

  it("剩余效期超出视野的批次不参与（其容量必然不是最紧的一项）", () => {
    const r = netExpiringStock({ batches: [{ daysLeft: 400, qty: 9999 }], daily: 10, horizonDays: 120 });
    expect(r).toMatchObject({ unsellableQty: 0, atRiskQty: 0, batchesConsidered: 0 });
  });

  it("日均 0 时任何批次都卖不掉（如实给出，用途由调用方决定）", () => {
    const r = netExpiringStock({ batches: [{ daysLeft: 30, qty: 80 }], daily: 0, horizonDays: 120 });
    expect(r.unsellableQty).toBe(80);
  });
});

describe("临期进入补货判定（W2-#2）", () => {
  it("在库全是临期货时引擎不再判「够」，账面在库原样保留、扣减量与理由单列", async () => {
    const { db, client } = await createTestDb();
    try {
      const [spu] = await db.insert(schema.spus).values({ code: "P1", nameCn: "测试" }).returning();
      const [sku] = await db.insert(schema.skus).values({ code: "CP00001", name: "面霜", spuId: spu.id, skuType: "finished", baseUom: "支", nearExpiryDays: 90 }).returning();
      const [ch] = await db.insert(schema.channels).values({ code: "tmall", name: "天猫", kind: "platform" }).returning();
      const [wh] = await db.insert(schema.warehouses).values({ code: "WH-CP", name: "成品仓", kind: "finished", accountingMode: "realtime" }).returning();
      // 日均 ≈ 3000/91 ≈ 33/天
      for (const ym of ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06"]) {
        await db.insert(schema.salesMonthly).values({ skuId: sku.id, channelId: ch.id, yearMonth: ym, qty: "1000" });
      }
      await db.insert(schema.skuParams).values({ skuId: sku.id, normalLeadDays: 30, logisticsLeadDays: 10 });
      // 账面在库 6000（≈180 天可销）：不看效期就是「水位很够」
      await db.insert(schema.stockBalances).values({ skuId: sku.id, warehouseId: wh.id, qty: "6000" });

      const before = await getReplenishSuggestions({ allRows: true }, db);
      const noExpiry = before.rows.find((r) => r.skuId === sku.id)!;
      expect(noExpiry.onHand).toBe(6000);
      expect(noExpiry.availableOnHand).toBe(6000);
      expect(noExpiry.expiryRisk).toBeNull();
      expect(noExpiry.suggestQty, "无效期数据时按原口径：水位够，不建议").toBeNull();

      // 同一批实物在批次参考层：全部 10 天后到期 —— 10 天最多卖 ~330 支，其余 5670 支必然报废
      await db.insert(schema.batchStocks).values({
        skuId: sku.id, warehouseId: wh.id, stocktakeDate: todayShanghai(), batchNo: "B1",
        expiryDate: dayAfter(10), qty: "6000",
      });

      const after = await getReplenishSuggestions({ allRows: true }, db);
      const row = after.rows.find((r) => r.skuId === sku.id)!;

      // 账面在库一个字都不许变
      expect(row.onHand, "账面在库是 core/stock-view 的口径，临期不得悄悄改小它").toBe(6000);
      // 可用在库被扣到接近 0，判定随之翻转
      expect(row.availableOnHand).toBeLessThan(500);
      expect(row.expiryRisk).not.toBeNull();
      expect(row.expiryRisk!.unsellableQty).toBeGreaterThan(5000);
      expect(row.expiryRisk!.atRiskQty).toBe(6000);
      expect(row.expiryRisk!.bindingDaysLeft).toBe(10);
      expect(row.expiryRisk!.label, "必须能解释扣了多少、为什么").toContain("临期净额");
      expect(row.planExplain.some((line) => line.includes("临期净额"))).toBe(true);
      expect(row.suggestQty, "临期货撑起来的『够』必须翻转为建议补货").not.toBeNull();
      expect(row.decisionEvidence.onHand).toBe("6000.0000");
      expect(Number(row.decisionEvidence.availableOnHand)).toBeLessThan(500);
      expect(Number(row.decisionEvidence.expiringUnsellable)).toBeGreaterThan(5000);
    } finally {
      await client.close();
    }
  });

  it("效期足够长的批次不影响判定（不制造假缺口）", async () => {
    const { db, client } = await createTestDb();
    try {
      const [spu] = await db.insert(schema.spus).values({ code: "P1", nameCn: "测试" }).returning();
      const [sku] = await db.insert(schema.skus).values({ code: "CP00002", name: "水乳", spuId: spu.id, skuType: "finished", baseUom: "支" }).returning();
      const [ch] = await db.insert(schema.channels).values({ code: "tmall", name: "天猫", kind: "platform" }).returning();
      const [wh] = await db.insert(schema.warehouses).values({ code: "WH-CP", name: "成品仓", kind: "finished", accountingMode: "realtime" }).returning();
      for (const ym of ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06"]) {
        await db.insert(schema.salesMonthly).values({ skuId: sku.id, channelId: ch.id, yearMonth: ym, qty: "1000" });
      }
      await db.insert(schema.skuParams).values({ skuId: sku.id, normalLeadDays: 30, logisticsLeadDays: 10 });
      await db.insert(schema.stockBalances).values({ skuId: sku.id, warehouseId: wh.id, qty: "6000" });
      await db.insert(schema.batchStocks).values({
        skuId: sku.id, warehouseId: wh.id, stocktakeDate: todayShanghai(), batchNo: "B1",
        expiryDate: dayAfter(300), qty: "6000",
      });

      const res = await getReplenishSuggestions({ allRows: true }, db);
      const row = res.rows.find((r) => r.skuId === sku.id)!;
      expect(row.availableOnHand).toBe(6000);
      expect(row.expiryRisk).toBeNull();
      expect(row.suggestQty).toBeNull();
    } finally {
      await client.close();
    }
  });
});
