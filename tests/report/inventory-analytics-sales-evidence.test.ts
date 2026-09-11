import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { channels, salesMonthly, skus, spus, stockBalances, warehouses } from "@/db/schema";
import { getInventoryAnalytics } from "@/server/modules/report/inventory-analytics";
import { EXPORT_KINDS } from "@/server/modules/report/export";
import { createTestDb } from "../helpers/db";

describe("库存分析：已登记月销、未知和微量正销贯通", () => {
  let fixture: Awaited<ReturnType<typeof createTestDb>>;
  beforeAll(async () => {
    fixture = await createTestDb();
    const { db } = fixture;
    const [spu] = await db.insert(spus).values({ code: "EVID", nameCn: "销量证据" }).returning();
    const cs = await db.insert(channels).values([
      { code: "EVID-A", name: "渠道A", kind: "platform" },
      { code: "EVID-B", name: "渠道B", kind: "platform" },
    ]).returning();
    const [wh] = await db.insert(warehouses).values({ code: "EVID", name: "合成仓", kind: "finished" }).returning();
    for (const [code, quantities] of Object.entries({
      MISSING: [], ZERO: ["0", "0", "0"], TINY: ["0", "0", "0.0001"],
      NEGATIVE: ["0", "0", "-0.0001"], PARTIAL: ["91"], FULL: ["91", "91", "91"],
      MULTI: ["1", "1", "1"],
    })) {
      const [sku] = await db.insert(skus).values({ code: `EVID-${code}`, name: code,
        spuId: spu.id, skuType: "finished", baseUom: "支", commercialRole: "retail" }).returning();
      await db.insert(stockBalances).values({ skuId: sku.id, warehouseId: wh.id, qty: "91" });
      if (quantities.length) await db.insert(salesMonthly).values(quantities.map((qty, i) => ({
        skuId: sku.id, channelId: cs[0].id, yearMonth: ["2026-04", "2026-05", "2026-06"][i], qty,
      })));
      if (code === "MULTI") await db.insert(salesMonthly).values([
        { skuId: sku.id, channelId: cs[1].id, yearMonth: "2026-04", qty: "88" },
        { skuId: sku.id, channelId: cs[1].id, yearMonth: "2026-03", qty: "9999" },
      ]);
    }
  });
  afterAll(async () => { await fixture?.client.close(); });
  const row = async (code: string) => (await getInventoryAnalytics({ q: `EVID-${code}` }, fixture.db)).rows[0];

  it("没有月销记录不是零日销，不能伪称无动销", async () => {
    expect(await row("MISSING")).toMatchObject({ daily: null, daysCover: null,
      salesQty: null, salesMonths: 0, salesState: "missing" });
  });
  it("三个月均登记为零保留真零及其证据", async () => {
    expect(await row("ZERO")).toMatchObject({ daily: 0, daysCover: null,
      salesQty: "0.0000", salesMonths: 3, salesState: "registered" });
  });
  it("最小四位数量的正日销不舍零，天数与返回日均用同一值", async () => {
    const r = await row("TINY");
    expect(r.daily).toBeGreaterThan(0);
    expect(r.daily).toBeCloseTo(0.0001 / 91, 14);
    expect(r.daysCover).toBeCloseTo(91 / r.daily!, 1);
    expect(r.salesQty).toBe("0.0001");
  });
  it("负净量保留，不变零或正值，也不产可销天数", async () => {
    const r = await row("NEGATIVE");
    expect(r.daily).toBeLessThan(0);
    expect(r.salesState).toBe("registered");
    expect(r.daysCover).toBeNull();
  });
  it("部分月份保留已登记量，缺月不补零后除整窗", async () => {
    expect(await row("PARTIAL")).toMatchObject({ daily: null, daysCover: null,
      salesQty: "91.0000", salesMonths: 1, salesState: "partial" });
  });
  it("合格三月仍复用历史91天日均，披露月份而非冒充今天", async () => {
    const res = await getInventoryAnalytics({ q: "EVID-FULL" }, fixture.db);
    expect(res.salesWindow).toEqual({ months: ["2026-04", "2026-05", "2026-06"], divisorDays: 91, latestMonth: "2026-06" });
    expect(res.rows[0]).toMatchObject({ daily: 3, daysCover: 30.3, salesMonths: 3, salesState: "registered" });
  });
  it("多渠道不多算月份，窗外旧月不进入日销", async () => {
    expect(await row("MULTI")).toMatchObject({ daily: 1, salesQty: "91.0000", salesMonths: 3 });
  });
  it("完整异步导出保留未知行、原量、月份和可核验日均", async () => {
    const exported = await EXPORT_KINDS["inventory-analytics"].produce(
      { id: 1, name: "合成仓管", roles: ["warehouse"], isApprover: false }, { q: "EVID-" }, 50000, fixture.db);
    expect(exported.total).toBe(7);
    expect(exported.rows).toHaveLength(7);
    expect(exported.rows.find((r) => r.code === "EVID-MISSING")).toMatchObject({
      daily: null, salesQty: null, salesMonths: 0, salesStatus: "无月销记录", salesPeriod: "2026-04 ～ 2026-06", salesDivisorDays: 91,
    });
    expect(Number(exported.rows.find((r) => r.code === "EVID-TINY")!.daily)).toBeGreaterThan(0);
    for (const key of ["salesQty", "salesMonths", "salesStatus", "salesPeriod", "salesDivisorDays"]) {
      expect(exported.columns.some((c) => c.key === key)).toBe(true);
    }
  });
  it("全空销售源仍有显式未知窗口，不伪造当前月份", async () => {
    const empty = await createTestDb();
    try {
      const res = await getInventoryAnalytics({}, empty.db);
      expect(res.salesWindow).toEqual({ months: [], divisorDays: 91, latestMonth: null });
    } finally { await empty.client.close(); }
  });
});
