import { describe, expect, it } from "vitest";

import {
  buildDecisionStudio,
  getDecisionStudio,
  type DailyFact,
  type MonthlyGroupFact,
} from "@/server/modules/report/decision-studio";
import * as schema from "@/db/schema";
import { createTestDb } from "../helpers/db";

function months(startYear: number, startMonth: number, count: number): string[] {
  return Array.from({ length: count }, (_, index) => {
    const zeroBased = startMonth - 1 + index;
    const year = startYear + Math.floor(zeroBased / 12);
    const month = (zeroBased % 12) + 1;
    return `${year}-${String(month).padStart(2, "0")}`;
  });
}

describe("decision studio evidence model", () => {
  it("builds Pareto, comparisons, pivot and SPC from complete monthly facts", () => {
    const periods = months(2025, 7, 13);
    const facts: MonthlyGroupFact[] = periods.flatMap((month, index) => [
      { month, key: "A", label: "品牌 A", qty: 70 + index },
      { month, key: "B", label: "品牌 B", qty: 20 },
      { month, key: "C", label: "品牌 C", qty: 10 },
    ]);

    const result = buildDecisionStudio(facts, [], { dimension: "brand" });

    expect(result.months).toHaveLength(13);
    expect(result.latestMonth).toBe("2026-07");
    expect(result.pareto.map((item) => item.key)).toEqual(["A", "B", "C"]);
    expect(result.pareto80Count).toBe(2);
    expect(result.comparison.previous).toBe(111);
    expect(result.comparison.current).toBe(112);
    expect(result.comparison.yearAgo).toBe(100);
    expect(result.comparison.yoyPct).toBe(12);
    expect(result.pivot[0].byMonth["2026-07"]).toBe(82);
    expect(result.spc.samples).toBe(13);
    expect(result.spc.bands).not.toBeNull();
    expect(result.commerceIdentity.state).toBe("insufficient");
  });

  it("keeps unavailable YoY, SPC and daily analysis explicitly gated", () => {
    const facts: MonthlyGroupFact[] = [
      { month: "2026-05", key: "A", label: "品牌 A", qty: 10 },
      { month: "2026-06", key: "A", label: "品牌 A", qty: 15 },
    ];

    const result = buildDecisionStudio(facts, [], { dimension: "brand" });

    expect(result.comparison.momPct).toBe(50);
    expect(result.comparison.yoyPct).toBeNull();
    expect(result.comparison.yoyGate).toContain("缺少 2025-06");
    expect(result.spc.bands).toBeNull();
    expect(result.spc.note).toContain("样本不足");
    expect(result.daily.state).toBe("insufficient");
    expect(result.daily.gate).toContain("尚未导入");
  });

  it("uses only the latest JST import per date and reports mapping coverage", () => {
    const facts: MonthlyGroupFact[] = [
      { month: "2026-07", key: "SKU-1", label: "货品一", qty: 30 },
    ];
    const daily: DailyFact[] = [
      { importJobId: 1, status: "validated", bizDate: "2026-07-01", skuCode: "SKU-1", qty: 9, skuId: 1 },
      { importJobId: 2, status: "validated", bizDate: "2026-07-01", skuCode: "SKU-1", qty: 10, skuId: 1 },
      { importJobId: 2, status: "pending", bizDate: "2026-07-01", skuCode: "SKU-X", qty: 3, skuId: null },
      { importJobId: 3, status: "validated", bizDate: "2026-07-02", skuCode: "SKU-1", qty: 12, skuId: 1 },
    ];

    const result = buildDecisionStudio(facts, daily, { dimension: "sku", key: "SKU-1" });

    expect(result.daily.state).toBe("ready");
    expect(result.daily.dates).toEqual([
      { date: "2026-07-01", qty: 10 },
      { date: "2026-07-02", qty: 12 },
    ]);
    expect(result.daily.coveredRows).toBe(2);
    expect(result.daily.totalRows).toBe(2);
  });

  it("does not pretend JST can explain a selected channel", () => {
    const facts: MonthlyGroupFact[] = [
      { month: "2026-07", key: "tmall", label: "天猫", qty: 30 },
    ];
    const daily: DailyFact[] = [
      { importJobId: 1, status: "validated", bizDate: "2026-07-01", skuCode: "SKU-1", qty: 10, skuId: 1 },
    ];

    const result = buildDecisionStudio(facts, daily, { dimension: "channel", key: "tmall" });

    expect(result.daily.state).toBe("insufficient");
    expect(result.daily.dates).toEqual([]);
    expect(result.daily.gate).toContain("没有渠道维度");
  });

  it("aggregates the real database joins for every supported dimension", async () => {
    const { db, client } = await createTestDb();
    try {
      const [brand] = await db.insert(schema.brands).values({
        code: "EXP",
        nameCn: "Expressions",
      }).returning();
      const [channel] = await db.insert(schema.channels).values({
        code: "tmall",
        name: "天猫",
        kind: "platform",
      }).returning();
      const [spu] = await db.insert(schema.spus).values({
        code: "P90001",
        nameCn: "测试产品",
      }).returning();
      const [sku] = await db.insert(schema.skus).values({
        code: "CS90001",
        name: "测试货品",
        spuId: spu.id,
        baseUom: "支",
        skuType: "finished",
        brandId: brand.id,
      }).returning();
      await db.insert(schema.salesMonthly).values([
        { skuId: sku.id, channelId: channel.id, yearMonth: "2026-06", qty: "10" },
        { skuId: sku.id, channelId: channel.id, yearMonth: "2026-07", qty: "15" },
      ]);

      const byBrand = await getDecisionStudio({ dimension: "brand" }, db);
      const byChannel = await getDecisionStudio({ dimension: "channel" }, db);
      const bySku = await getDecisionStudio({ dimension: "sku" }, db);

      expect(byBrand.groups[0]).toMatchObject({ key: "EXP", label: "Expressions", total: 25 });
      expect(byChannel.groups[0]).toMatchObject({ key: "tmall", label: "天猫", total: 25 });
      expect(bySku.groups[0]).toMatchObject({ key: "CS90001", label: "测试货品", total: 25 });
      expect(byBrand.comparison.momPct).toBe(50);
    } finally {
      await client.close();
    }
  });
});
