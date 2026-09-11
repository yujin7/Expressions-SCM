/**
 * D60 / IAL-05 各仓明细与周转读模型（report/warehouse-inventory.ts /v1）：
 * 实时仓在库=Σ余额、快照仓=最新快照；周转 = 窗口出库 ÷ (期初+期末)/2（期初由流水倒推）；快照仓无流水；
 * 金额走 core/valuation（覆盖率 <80% 标不完整）；按 region_code 分组；缓存按 source_binding 命中/失效。
 */
import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { skuCosts, skus, spus, stockBalances, stockLedger, stockSnapshots, users, warehouses } from "@/db/schema";
import { loadWarehouseInventory, normalizeWindow, refreshWarehouseInventory } from "@/server/modules/report/warehouse-inventory";
import { createTestDb, type TestDb } from "../helpers/db";

const AS_OF = "2026-09-03";

describe("warehouse-inventory 读模型", () => {
  let db: TestDb;
  let whCn: number;
  let whCnChild: number;
  let whUs: number;
  let whSnap: number;
  let skuA: number;
  let skuB: number;

  beforeAll(async () => {
    ({ db } = await createTestDb());
    const [u] = await db.insert(users).values({ name: "周转测试", roles: ["finance"] }).returning();
    const [cn] = await db.insert(warehouses).values({ code: "WI-CN", name: "华东总仓", kind: "finished", regionCode: "CN" }).returning();
    const [cnChild] = await db.insert(warehouses).values({ code: "WI-CN2", name: "华东分仓", kind: "finished", regionCode: "CN", parentId: cn.id }).returning();
    const [us] = await db.insert(warehouses).values({ code: "WI-US", name: "美国仓", kind: "finished", regionCode: "US" }).returning();
    const [snap] = await db.insert(warehouses).values({ code: "WI-SNAP", name: "保税快照仓", kind: "snapshot", accountingMode: "snapshot", regionCode: "CN" }).returning();
    await db.insert(warehouses).values({ code: "WI-OFF", name: "停用仓", kind: "raw", active: false });
    whCn = cn.id; whCnChild = cnChild.id; whUs = us.id; whSnap = snap.id;
    const [spu] = await db.insert(spus).values({ code: "PWI01", nameCn: "周转品" }).returning();
    const [a] = await db.insert(skus).values({ code: "WI-A", name: "有成本", spuId: spu.id, baseUom: "件", skuType: "finished" }).returning();
    const [b] = await db.insert(skus).values({ code: "WI-B", name: "无成本", spuId: spu.id, baseUom: "件", skuType: "finished" }).returning();
    skuA = a.id; skuB = b.id;
    await db.insert(skuCosts).values({ skuId: skuA, unitCost: "10.0000", updatedBy: u.id });

    // 华东总仓：期末 A=100、B=50；窗口内（90 天）流水：入 +60（A），出 −40（A）、出 −10（B）→ 净 +10；期初 = 150 − 10 = 140
    await db.insert(stockBalances).values([
      { skuId: skuA, warehouseId: whCn, qty: "100" },
      { skuId: skuB, warehouseId: whCn, qty: "50" },
      { skuId: skuA, warehouseId: whCnChild, qty: "20" },
      { skuId: skuA, warehouseId: whUs, qty: "30" },
    ]);
    const t = (d: string) => new Date(`${d}T12:00:00+08:00`);
    await db.insert(stockLedger).values([
      { skuId: skuA, warehouseId: whCn, qtyDelta: "60", sourceDocType: "opening", sourceDocId: 1, sourceLineId: 1, action: "post", occurredAt: t("2026-07-01") },
      { skuId: skuA, warehouseId: whCn, qtyDelta: "-40", sourceDocType: "sales_out", sourceDocId: 2, sourceLineId: 1, action: "post", occurredAt: t("2026-08-01") },
      { skuId: skuB, warehouseId: whCn, qtyDelta: "-10", sourceDocType: "sales_out", sourceDocId: 3, sourceLineId: 1, action: "post", occurredAt: t("2026-08-15") },
      // 窗口外（> 90 天）不计
      { skuId: skuA, warehouseId: whCn, qtyDelta: "-500", sourceDocType: "sales_out", sourceDocId: 4, sourceLineId: 1, action: "post", occurredAt: t("2026-01-01") },
      // 美国仓：窗口内零出库
      { skuId: skuA, warehouseId: whUs, qtyDelta: "30", sourceDocType: "opening", sourceDocId: 5, sourceLineId: 1, action: "post", occurredAt: t("2026-08-20") },
    ]);
    // 快照仓：两期快照，取最新一期
    await db.insert(stockSnapshots).values([
      { warehouseId: whSnap, skuId: skuA, bizDate: "2026-08-30", qty: "500" },
      { warehouseId: whSnap, skuId: skuA, bizDate: "2026-09-01", qty: "480" },
      { warehouseId: whSnap, skuId: skuB, bizDate: "2026-09-01", qty: "20" },
    ]);
  });

  it("normalizeWindow：只接受 30/90/365，其余回落 90", () => {
    expect(normalizeWindow("30")).toBe(30);
    expect(normalizeWindow(365)).toBe(365);
    expect(normalizeWindow("7")).toBe(90);
    expect(normalizeWindow(null)).toBe(90);
  });

  it("逐仓在库/金额/周转；快照仓无流水；停用仓不出现；按地区分组", async () => {
    const m = await refreshWarehouseInventory(db, { windowDays: 90, asOf: AS_OF });
    expect(m.key).toBe("warehouse-inventory/v1/w90");
    expect(m.windowStart).toBe("2026-06-06");
    expect(m.rows.map((r) => r.code).sort()).toEqual(["WI-CN", "WI-CN2", "WI-SNAP", "WI-US"]);

    const cn = m.rows.find((r) => r.warehouseId === whCn)!;
    expect(cn.onHand).toBe("150.0000");
    expect(cn.skuCount).toBe(2);
    expect(cn.amount).toBe("1000.00"); // 只算有成本的 A：100 × 10
    expect(cn.valuationCoveragePct).toBeCloseTo(66.67, 1);
    expect(cn.valuationIncomplete).toBe(true);
    expect(cn.outboundQty).toBe("50.0000");
    expect(cn.openingOnHand).toBe("140.0000");
    expect(cn.avgOnHand).toBe("145.0000");
    // turns = 50 / 145 × (365/90) = 1.3985 → 1.4；dio = 365 / 1.3985 = 261.0
    expect(cn.turns).toBeCloseTo(1.4, 1);
    expect(cn.dio).toBeCloseTo(261, 0);
    expect(cn.turnoverNote).toBeNull();

    const child = m.rows.find((r) => r.warehouseId === whCnChild)!;
    expect(child.parentId).toBe(whCn);
    expect(child.parentName).toBe("华东总仓");
    expect(child.valuationCoveragePct).toBe(100);
    expect(child.valuationIncomplete).toBe(false);
    expect(child.outboundQty).toBe("0.0000");
    expect(child.turns).toBe(0);
    expect(child.dio).toBeNull();
    expect(child.turnoverNote).toBe("窗口内零出库");

    const us = m.rows.find((r) => r.warehouseId === whUs)!;
    expect(us.regionCode).toBe("US");
    expect(us.openingOnHand).toBe("0.0000"); // 30 − 30
    expect(us.avgOnHand).toBe("15.0000");
    expect(us.turns).toBe(0);

    const snap = m.rows.find((r) => r.warehouseId === whSnap)!;
    expect(snap.accountingMode).toBe("snapshot");
    expect(snap.onHand).toBe("500.0000"); // 最新一期 480 + 20
    expect(snap.snapshotDate).toBe("2026-09-01");
    expect(snap.outboundQty).toBeNull();
    expect(snap.turns).toBeNull();
    expect(snap.dio).toBeNull();
    expect(snap.turnoverNote).toBe("无流水（快照仓）");
    expect(snap.amount).toBe("4800.00");

    expect(m.regions.map((r) => r.regionCode)).toEqual(["CN", "US"]);
    const cnRegion = m.regions[0];
    expect(cnRegion.warehouseCount).toBe(3);
    expect(cnRegion.onHand).toBe("670.0000");
    expect(cnRegion.amount).toBe("6000.00");
    expect(cnRegion.outboundQty).toBe("50.0000");

    expect(m.summary).toMatchObject({ warehouseCount: 4, realtimeCount: 3, snapshotCount: 1, physicalActiveCount: 3, onHand: "700.0000", amount: "6300.00", latestSnapshotDate: "2026-09-01" });
    // 总周转只汇总实时仓：出库 50 ÷ 平均 (145 + 20 + 15) = 180
    expect(m.summary.outboundQty).toBe("50.0000");
    expect(m.summary.avgOnHand).toBe("180.0000");
    expect(m.summary.turns).toBeCloseTo((50 / 180) * (365 / 90), 1);
  });

  it("窗口 30 天：出库只算 08-05 起；缓存键分窗口", async () => {
    const m = await loadWarehouseInventory(db, { windowDays: 30, asOf: AS_OF });
    expect(m.key).toBe("warehouse-inventory/v1/w30");
    const cn = m.rows.find((r) => r.warehouseId === whCn)!;
    expect(cn.outboundQty).toBe("10.0000");
    expect(cn.openingOnHand).toBe("160.0000");
  });

  it("缓存：绑定不变命中；新增流水后绑定变化 → 重算", async () => {
    const first = await loadWarehouseInventory(db, { windowDays: 90, asOf: AS_OF });
    const second = await loadWarehouseInventory(db, { windowDays: 90, asOf: AS_OF });
    expect(second.builtAt).toBe(first.builtAt);
    const cached = await db.execute(sql`SELECT count(*)::int AS n FROM report_read_model_cache WHERE key LIKE 'warehouse-inventory/v1/%'`);
    const rows = (Array.isArray(cached) ? cached : (cached as { rows: unknown[] }).rows) as { n: number }[];
    expect(Number(rows[0].n)).toBe(2);
    await db.insert(stockLedger).values({ skuId: skuA, warehouseId: whUs, qtyDelta: "-5", sourceDocType: "sales_out", sourceDocId: 9, sourceLineId: 1, action: "post", occurredAt: new Date("2026-09-02T12:00:00+08:00") });
    await db.update(stockBalances).set({ qty: "25" }).where(sql`${stockBalances.warehouseId} = ${whUs}`);
    const third = await loadWarehouseInventory(db, { windowDays: 90, asOf: AS_OF });
    expect(third.builtAt).not.toBe(first.builtAt);
    const us = third.rows.find((r) => r.warehouseId === whUs)!;
    expect(us.outboundQty).toBe("5.0000");
    expect(us.onHand).toBe("25.0000");
  });
});
