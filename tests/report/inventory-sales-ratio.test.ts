/**
 * inventory-sales-ratio/v1（D54）：纯规则（占比/目标带）+ PGlite 装配（月末库存金额 ÷ 当月销售金额，
 * 月均版本并列，缺任一侧 null + gate，目标带读 sys_params，缓存按绑定失效）。
 */
import { beforeAll, describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import type { SessionUser } from "@/server/core/dto";
import { upsertSalesAmountMonthly } from "@/server/modules/master/sales-amount";
import { computeInventorySalesRatio, loadInventorySalesRatio, ratioBand, ratioPct } from "@/server/modules/report/inventory-sales-ratio";
import { createTestDb, type TestDb } from "../helpers/db";

const TODAY = "2026-09-03";

describe("inventory-sales-ratio：纯规则", () => {
  it("ratioPct：分子 ÷ 分母 × 100（2dp）；缺任一侧或分母 ≤ 0 → null", () => {
    expect(ratioPct("500.00", "1000.00")).toBe(50);
    expect(ratioPct("486.12", "1000.00")).toBe(48.61);
    expect(ratioPct(null, "1000")).toBeNull();
    expect(ratioPct("500", null)).toBeNull();
    expect(ratioPct("500", "0.00")).toBeNull();
    expect(ratioPct("500", "-1")).toBeNull();
  });

  it("ratioBand：红 > 基线、黄 (high, 基线]、绿 [low, high]、蓝 < low", () => {
    const t = { low: 45, high: 47, baseline: 50 };
    expect(ratioBand(51, t)).toBe("red");
    expect(ratioBand(50, t)).toBe("yellow");
    expect(ratioBand(48.6, t)).toBe("yellow");
    expect(ratioBand(47, t)).toBe("green");
    expect(ratioBand(45, t)).toBe("green");
    expect(ratioBand(44.99, t)).toBe("blue");
    expect(ratioBand(null, t)).toBeNull();
  });
});

describe("inventory-sales-ratio/v1：装配", () => {
  let db: TestDb;
  let finance: SessionUser;

  beforeAll(async () => {
    ({ db } = await createTestDb());
    const [f] = await db.insert(schema.users).values({ name: "财务", roles: ["finance"] }).returning();
    finance = { id: f.id, name: f.name, roles: f.roles, isApprover: false };
    const [spu] = await db.insert(schema.spus).values({ code: "P92001", nameCn: "占比" }).returning();
    const [sku] = await db.insert(schema.skus).values({ code: "RATIO-A", name: "占比货品", spuId: spu.id, skuType: "finished", baseUom: "支" }).returning();
    await db.insert(schema.skuCosts).values({ skuId: sku.id, unitCost: "10.0000", updatedBy: f.id });
    const [wh] = await db.insert(schema.warehouses).values({ code: "W-R", name: "成品仓", kind: "finished", accountingMode: "realtime" }).returning();
    const [doc] = await db.insert(schema.stockDocs).values({ docNo: "RK-RATIO-1", status: "completed", subtype: "opening", createdBy: f.id }).returning();
    await db.insert(schema.stockLedger).values({
      skuId: sku.id, warehouseId: wh.id, qtyDelta: "100", sourceDocType: "opening", sourceDocId: doc.id, sourceLineId: 1, action: "post",
      occurredAt: new Date("2026-08-05T10:00:00+08:00"),
    });
    await db.insert(schema.stockBalances).values({ skuId: sku.id, warehouseId: wh.id, qty: "100" });
    await db.insert(schema.sysParams).values([
      { key: "inventory_sales_ratio_target_low", value: "40" },
      { key: "inventory_sales_ratio_target_high", value: "50" },
    ]);
    await upsertSalesAmountMonthly(finance, { yearMonth: "2026-09", scopeKind: "company", amount: "2000" }, db);
  });

  it("月末版与月均版并列；缺销售金额 → null + gate；目标带读参数", async () => {
    const m = await computeInventorySalesRatio(db, { today: TODAY, historyMonths: 2 });
    expect(m.key).toBe("inventory-sales-ratio/v1");
    expect(m.target).toEqual({ low: 40, high: 50, baseline: 50 });
    expect(m.rows.map((r) => r.yearMonth)).toEqual(["2026-07", "2026-08", "2026-09"]);
    const [jul, aug, sep] = m.rows;
    expect(jul).toMatchObject({ inventoryMonthEnd: null, salesAmount: null, ratioMonthEndPct: null, band: null });
    expect(jul.gate).toContain("缺月末库存");
    expect(aug.inventoryMonthEnd).toEqual({ amount: "1000.00", coveragePct: 100 });
    expect(aug).toMatchObject({ salesAmount: null, ratioMonthEndPct: null, inventoryAvg: null });
    expect(aug.gate).toContain("缺当月销售金额");
    expect(sep).toMatchObject({ isCurrent: true, salesAmount: "2000.00", salesSource: "manual", ratioMonthEndPct: 50, band: "green", gate: null });
    expect(sep.inventoryAvg).toEqual({ amount: "1000.00" });
    expect(sep.ratioAvgPct).toBe(50);
    expect(sep.momPoints).toBeNull(); // 上月无占比
    expect(m.current.yearMonth).toBe("2026-09");
  });

  it("缓存命中；销售金额改写后绑定变化并重算", async () => {
    const first = await loadInventorySalesRatio(db, { today: TODAY, historyMonths: 2 });
    const again = await loadInventorySalesRatio(db, { today: TODAY, historyMonths: 2 });
    expect(again.builtAt).toBe(first.builtAt);
    await upsertSalesAmountMonthly(finance, { yearMonth: "2026-09", scopeKind: "company", amount: "1600" }, db);
    const after = await loadInventorySalesRatio(db, { today: TODAY, historyMonths: 2 });
    expect(after.sourceBinding).not.toBe(first.sourceBinding);
    expect(after.current).toMatchObject({ salesAmount: "1600.00", ratioMonthEndPct: 62.5, band: "red" });
  });
});
