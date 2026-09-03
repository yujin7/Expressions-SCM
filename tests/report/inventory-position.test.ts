/**
 * inventory-position/v1（D51/D52）——PGlite 造数：
 * 实时仓流水按 Asia/Shanghai 日界分日；快照仓相邻差分标 source=snapshot_delta；
 * 历史月末实时仓倒推、快照仓取当月最后快照；缺月留空；金额经 core/valuation 并给覆盖率；缓存按绑定失效。
 */
import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { computeInventoryPosition, loadInventoryPosition, monthAverageAmount } from "@/server/modules/report/inventory-position";
import { runInventoryPositionRefresh } from "@/jobs/inventory-position-refresh";
import { createTestDb, type TestDb } from "../helpers/db";

const TODAY = "2026-09-03";

describe("inventory-position/v1", () => {
  let db: TestDb;
  let skuA = 0;
  let skuB = 0;
  let whRealtime = 0;
  let whSnapshot = 0;

  beforeAll(async () => {
    ({ db } = await createTestDb());
    const [actor] = await db.insert(schema.users).values({ name: "库存读模型", roles: ["pmc"] }).returning();
    const [spu] = await db.insert(schema.spus).values({ code: "P91001", nameCn: "日级走向" }).returning();
    const mk = async (code: string) => {
      const [row] = await db.insert(schema.skus).values({ code, name: `货品${code}`, spuId: spu.id, skuType: "finished", baseUom: "支" }).returning();
      return row.id;
    };
    skuA = await mk("POS-A");
    skuB = await mk("POS-B");
    await db.insert(schema.skuCosts).values({ skuId: skuA, unitCost: "10.0000", updatedBy: actor.id });
    const [w1] = await db.insert(schema.warehouses).values({ code: "W-RT", name: "成品仓", kind: "finished", accountingMode: "realtime" }).returning();
    const [w2] = await db.insert(schema.warehouses).values({ code: "W-SNAP", name: "海外快照仓", kind: "snapshot", accountingMode: "snapshot", regionCode: "US" }).returning();
    whRealtime = w1.id;
    whSnapshot = w2.id;
    const [doc] = await db.insert(schema.stockDocs).values({ docNo: "RK-POS-1", status: "completed", subtype: "opening", createdBy: actor.id }).returning();
    const line = (skuId: number, qty: string, at: string, lineId: number) => ({
      skuId, warehouseId: whRealtime, qtyDelta: qty, sourceDocType: "opening", sourceDocId: doc.id, sourceLineId: lineId, action: "post", occurredAt: new Date(at),
    });
    await db.insert(schema.stockLedger).values([
      line(skuA, "100", "2026-07-10T08:00:00+08:00", 1),
      line(skuA, "-10", "2026-08-31T23:30:00+08:00", 2), // 上海 8-31（UTC 8-31 15:30）
      line(skuA, "20", "2026-09-01T00:10:00+08:00", 3), // 上海 9-1（UTC 8-31 16:10）——日界必须按上海
      line(skuA, "-5", "2026-09-02T10:00:00+08:00", 4),
      line(skuB, "50", "2026-09-02T11:00:00+08:00", 5),
    ]);
    await db.insert(schema.stockBalances).values([
      { skuId: skuA, warehouseId: whRealtime, qty: "105" },
      { skuId: skuB, warehouseId: whRealtime, qty: "50" },
    ]);
    await db.insert(schema.stockSnapshots).values([
      { warehouseId: whSnapshot, skuId: skuA, bizDate: "2026-07-31", qty: "30" },
      { warehouseId: whSnapshot, skuId: skuA, bizDate: "2026-08-15", qty: "40" },
      { warehouseId: whSnapshot, skuId: skuA, bizDate: "2026-08-30", qty: "35" },
      { warehouseId: whSnapshot, skuId: skuA, bizDate: "2026-09-02", qty: "45" },
    ]);
  });

  it("当前在库分列 + 估值覆盖率 + 各仓明细", async () => {
    const m = await computeInventoryPosition(db, { today: TODAY, historyMonths: 3 });
    expect(m.key).toBe("inventory-position/v1");
    expect(m.currentMonth).toBe("2026-09");
    expect(m.ledgerFirstDay).toBe("2026-07-10");
    expect(m.latestSnapshotDate).toBe("2026-09-02");
    expect(m.current.realtime).toMatchObject({ qty: "155.0000", skus: 2 });
    // A 105 × 10 = 1050；B 无成本 → 覆盖率 105/155
    expect(m.current.realtime.value).toMatchObject({ amount: "1050.00", coveragePct: 67.74, incomplete: true, coveredSkus: 1, uncoveredSkus: 1 });
    expect(m.current.snapshot).toMatchObject({ qty: "45.0000", skus: 1, bizDate: "2026-09-02" });
    expect(m.current.snapshot.value).toMatchObject({ amount: "450.00", coveragePct: 100, incomplete: false });
    expect(m.current.total).toMatchObject({ qty: "200.0000", skus: 2 });
    expect(m.current.total.value.amount).toBe("1500.00");
    expect(m.warehouses.map((w) => [w.warehouseId, w.mode, w.qty, w.bizDate])).toEqual([
      [whRealtime, "realtime", "155.0000", null],
      [whSnapshot, "snapshot", "45.0000", "2026-09-02"],
    ]);
    expect(m.warehouses[1]).toMatchObject({ regionCode: "US", kind: "snapshot", skus: 1 });
    expect(m.warehouses[1].value.amount).toBe("450.00");
  });

  it("当月逐日：实时仓按上海日界，快照仓相邻差分标 snapshot_delta，缺日留空", async () => {
    const m = await computeInventoryPosition(db, { today: TODAY, historyMonths: 3 });
    expect(m.daily.map((d) => d.date)).toEqual(["2026-09-01", "2026-09-02", "2026-09-03"]);
    const [d1, d2, d3] = m.daily;
    expect(d1.realtime).toMatchObject({ in: "20.0000", out: "0.0000", net: "20.0000", ledgerRows: 1 });
    expect(d1.realtime?.inValue).toMatchObject({ amount: "200.00", coveragePct: 100 });
    expect(d1.snapshot).toBeNull();
    expect(d2.realtime).toMatchObject({ in: "50.0000", out: "5.0000", net: "45.0000", ledgerRows: 2 });
    expect(d2.realtime?.inValue).toMatchObject({ amount: "0.00", coveragePct: 0, incomplete: true }); // B 无成本
    expect(d2.realtime?.outValue).toMatchObject({ amount: "50.00", coveragePct: 100 });
    expect(d2.snapshot).toMatchObject({ source: "snapshot_delta", in: "10.0000", out: "0.0000", net: "10.0000", warehouses: 1, maxSpanDays: 3 });
    expect(d2.snapshot?.netValue.amount).toBe("100.00");
    expect(d3.realtime).toMatchObject({ in: "0.0000", out: "0.0000", ledgerRows: 0 }); // 有账期覆盖但无异动
    expect(d3.snapshot).toBeNull();
  });

  it("历史月末：实时仓倒推、快照仓当月最后快照、缺月留空、环比", async () => {
    const m = await computeInventoryPosition(db, { today: TODAY, historyMonths: 3 });
    expect(m.monthEnd.map((x) => x.yearMonth)).toEqual(["2026-06", "2026-07", "2026-08", "2026-09"]);
    const [jun, jul, aug, sep] = m.monthEnd;
    expect(jun).toMatchObject({ realtime: null, snapshot: null, total: null, momQtyPct: null });
    // 7 月末：105 − (8 月 −10) − (9 月 +15) = 100；快照 7-31 = 30
    expect(jul.realtime).toMatchObject({ qty: "100.0000", asOf: "2026-07-31" });
    expect(jul.snapshot).toMatchObject({ qty: "30.0000", asOf: "2026-07-31" });
    expect(jul.total).toMatchObject({ qty: "130.0000", parts: ["realtime", "snapshot"] });
    expect(jul.total?.value.amount).toBe("1300.00");
    expect(jul.momQtyPct).toBeNull(); // 上期缺 → 不补零
    // 8 月末：105 − 15 = 90；快照取当月最后 8-30 = 35（不是 8-15）
    expect(aug.realtime?.qty).toBe("90.0000");
    expect(aug.snapshot).toMatchObject({ qty: "35.0000", asOf: "2026-08-30" });
    expect(aug.total?.qty).toBe("125.0000");
    expect(aug.momQtyPct).toBe(-3.85);
    expect(aug.momValuePct).toBe(-3.85);
    // 当月 = 当前时点
    expect(sep).toMatchObject({ isCurrent: true });
    expect(sep.total?.qty).toBe("200.0000");
    expect(sep.momQtyPct).toBe(60);
    // 当月估值不完整（B 无成本）→ 金额环比不用不完整金额
    expect(sep.total?.value.incomplete).toBe(true);
    expect(sep.momValuePct).toBeNull();
    expect(monthAverageAmount(jul, aug)).toBe("1275.00");
    expect(monthAverageAmount(aug, sep)).toBeNull();
  });

  it("缓存按 source_binding 命中；流水/快照变化后失效重算；任务刷新写两个读模型", async () => {
    const first = await loadInventoryPosition(db, { today: TODAY, historyMonths: 3 });
    const again = await loadInventoryPosition(db, { today: TODAY, historyMonths: 3 });
    expect(again.builtAt).toBe(first.builtAt);
    expect(again.sourceBinding).toBe(first.sourceBinding);

    const [doc] = await db.select({ id: schema.stockDocs.id }).from(schema.stockDocs).where(eq(schema.stockDocs.docNo, "RK-POS-1"));
    await db.insert(schema.stockLedger).values({
      skuId: skuB, warehouseId: whRealtime, qtyDelta: "-20", sourceDocType: "opening", sourceDocId: doc.id, sourceLineId: 9, action: "post",
      occurredAt: new Date("2026-09-03T09:00:00+08:00"),
    });
    await db.update(schema.stockBalances).set({ qty: "30" }).where(eq(schema.stockBalances.skuId, skuB));
    const after = await loadInventoryPosition(db, { today: TODAY, historyMonths: 3 });
    expect(after.sourceBinding).not.toBe(first.sourceBinding);
    expect(after.current.realtime.qty).toBe("135.0000");
    expect(after.daily[2].realtime).toMatchObject({ out: "20.0000", ledgerRows: 1 });

    const summary = await runInventoryPositionRefresh(db, { today: TODAY, historyMonths: 3 });
    expect(summary).toMatchObject({ today: TODAY, dailyPoints: 3, monthEndPoints: 4, warehouses: 2, ratioRows: 4 });
    const keys = await db.select({ key: schema.reportReadModelCache.key }).from(schema.reportReadModelCache);
    expect(keys.map((k) => k.key).sort()).toEqual(["inventory-position/v1", "inventory-sales-ratio/v1"]);
  });
});
