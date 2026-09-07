import { afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { createTestDb, type TestDb } from "../helpers/db";
import { computeInventoryAlerts, loadInventoryAlerts } from "@/server/modules/report/inventory-alerts";
import { coverWhy, runInventoryCoverWatchdog } from "@/jobs/alert-watchdogs";
import { completedShanghaiDays } from "@/server/core/business-day";

const NOW = new Date("2026-09-08T04:00:00+08:00");
const INSIDE = new Date("2026-09-07T12:00:00+08:00");

async function fixture(db: TestDb) {
  const [spu] = await db.insert(schema.spus).values({ code: "LD", nameCn: "需求性质" }).returning();
  const [wh] = await db.insert(schema.warehouses).values({ code: "LD-W", name: "实时仓", kind: "finished", accountingMode: "realtime" }).returning();
  let seq = 0;
  const sku = async (code: string) => (await db.insert(schema.skus).values({ code, name: code, spuId: spu.id, skuType: "finished", baseUom: "件" }).returning())[0];
  const move = async (skuId: number, qtyDelta: string, sourceDocType = "sales_out", action = "post", occurredAt = INSIDE, warehouseId = wh.id) => {
    await db.insert(schema.stockLedger).values({ skuId, warehouseId, qtyDelta, sourceDocType, action, occurredAt, sourceDocId: ++seq });
  };
  return { wh, sku, move };
}

describe("库存预警：销售净出库与非销售作业分离（G02）", () => {
  afterEach(() => vi.useRealTimers());
  it("窗口按上海整日跨月/闰日，拒绝无效日历和非整数天数", () => {
    expect(completedShanghaiDays(1, "2024-03-01")).toMatchObject({ startDay: "2024-02-29", endDayExclusive: "2024-03-01", days: 1 });
    expect(completedShanghaiDays(30, "2026-09-08").start.toISOString()).toBe("2026-08-08T16:00:00.000Z");
    expect(() => completedShanghaiDays(30, "2026-02-30")).toThrow();
    expect(() => completedShanghaiDays(0, "2026-09-08")).toThrow();
    expect(() => completedShanghaiDays(7.5, "2026-09-08")).toThrow();
  });
  it("纯调拨/发料/采购退货/盘亏/入库冲销不成为销售需求，也不生成断货告警", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW);
    const { db, client } = await createTestDb();
    try {
      const f = await fixture(db);
      await db.insert(schema.users).values({ name: "PMC", roles: ["pmc"] });
      for (const type of ["transfer", "fl_issue", "ct_return", "count_adjust", "stock_doc"]) {
        const sku = await f.sku(`NON-${type}`);
        await f.move(sku.id, "-300", type, type === "stock_doc" ? "reverse:sh_receipt#12" : "post");
        await db.insert(schema.skuPlanningPolicy).values({ skuId: sku.id, period: "2026-09", tier: "S", abc: "A", ownership: "joint_review" });
      }
      const model = await computeInventoryAlerts(db);
      for (const row of model.rows) {
        expect(row.daily.ledger).toBeNull();
        expect(row.primaryDaily).toBeNull();
        expect(row.primary).toBeNull();
        expect(row.ledgerDemand).toMatchObject({ salesNetQty: null, operationsOutQty: "300.0000" });
      }
      await runInventoryCoverWatchdog(db);
      expect(await db.select().from(schema.systemAlerts)).toHaveLength(0);
    } finally { await client.close(); }
  });

  it("销售减同窗红字；零/负净量不触发销售需求；无记录保留未知", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW);
    const { db, client } = await createTestDb();
    try {
      const f = await fixture(db);
      for (const [code, reversal] of [["NET", "30"], ["ZERO", "300"], ["NEGATIVE", "330"]]) {
        const sku = await f.sku(code);
        await f.move(sku.id, "-300");
        await f.move(sku.id, reversal, "stock_doc", "reverse:sales_out#1");
        await f.move(sku.id, "-600", "transfer");
      }
      await f.sku("UNKNOWN");
      const model = await computeInventoryAlerts(db);
      const byCode = new Map(model.rows.map((row) => [row.code, row]));
      expect(byCode.get("NET")).toMatchObject({ daily: { ledger: 9 }, primaryDailySource: "ledger", primaryDaily: 9, primary: "out_of_stock", ledgerDemand: { salesNetQty: "270.0000", operationsOutQty: "600.0000" } });
      expect(byCode.get("ZERO")).toMatchObject({ daily: { ledger: 0 }, primaryDaily: null, primary: null });
      expect(byCode.get("NEGATIVE")).toMatchObject({ daily: { ledger: -1 }, primaryDaily: null, primary: null });
      expect(byCode.get("UNKNOWN")).toMatchObject({ daily: { ledger: null }, ledgerDemand: { salesNetQty: null, operationsOutQty: null } });
      const explanation = coverWhy(byCode.get("NET")!).map((item) => item.value).join(" ");
      expect(explanation).toContain("销售净出库");
      expect(explanation).toContain("2026-08-09");
      expect(explanation).toContain("非销售");
    } finally { await client.close(); }
  });

  it("30个已结束上海业务日：含开始午夜，不含今天、未来或窗外；快照仓不冒充实时销售", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW);
    const { db, client } = await createTestDb();
    try {
      const f = await fixture(db); const sku = await f.sku("BOUNDS");
      const [snapshot] = await db.insert(schema.warehouses).values({ code: "SNAP", name: "快照", kind: "snapshot", accountingMode: "snapshot" }).returning();
      await f.move(sku.id, "-30", "sales_out", "post", new Date("2026-08-09T00:00:00+08:00"));
      await f.move(sku.id, "-300", "sales_out", "post", new Date("2026-08-08T23:59:59.999+08:00"));
      await f.move(sku.id, "-300", "sales_out", "post", new Date("2026-09-08T00:00:00+08:00"));
      await f.move(sku.id, "-300", "sales_out", "post", new Date("2026-09-09T00:00:00+08:00"));
      await f.move(sku.id, "-300", "sales_out", "post", INSIDE, snapshot.id);
      const row = (await computeInventoryAlerts(db)).rows[0];
      expect(row.daily.ledger).toBe(1);
      expect(row.ledgerDemand).toMatchObject({ startDay: "2026-08-09", endDayExclusive: "2026-09-08", days: 30, salesNetQty: "30.0000" });
    } finally { await client.close(); }
  });

  it("小数销售不因两位日均舍入变成无需求", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW);
    const { db, client } = await createTestDb();
    try {
      const f = await fixture(db); const sku = await f.sku("TINY");
      await f.move(sku.id, "-0.0001");
      const row = (await computeInventoryAlerts(db)).rows[0];
      expect(row.daily.ledger).toBeGreaterThan(0);
      expect(row.primary).toBe("out_of_stock");
      expect(row.ledgerDemand.salesNetQty).toBe("0.0001");
    } finally { await client.close(); }
  });

  it("相似动作名与错误来源不能冒充销售冲销；纯销售冲销保留负净额", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW);
    const { db, client } = await createTestDb();
    try {
      const f = await fixture(db); const sku = await f.sku("ACTIONS");
      await f.move(sku.id, "-30");
      await f.move(sku.id, "300", "transfer", "reverse:sales_out#1");
      await f.move(sku.id, "300", "stock_doc", "reverse:sales_out#1-extra");
      await f.move(sku.id, "300", "stock_doc", "reverse:sales_out#0");
      const onlyReverse = await f.sku("ONLY-REVERSE");
      await f.move(onlyReverse.id, "30", "stock_doc", "reverse:sales_out#8");
      const model = await computeInventoryAlerts(db);
      expect(model.rows.find((r) => r.skuId === sku.id)).toMatchObject({ daily: { ledger: 1 }, ledgerDemand: { salesNetQty: "30.0000" } });
      expect(model.rows.find((r) => r.skuId === onlyReverse.id)).toMatchObject({ daily: { ledger: -1 }, primaryDaily: null, ledgerDemand: { salesNetQty: "-30.0000" } });
    } finally { await client.close(); }
  });

  it("日界和仓模式进入缓存绑定，历史销售仓停用不抹掉销售历史", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW);
    const { db, client } = await createTestDb();
    try {
      const f = await fixture(db); const sku = await f.sku("CACHE");
      await f.move(sku.id, "-30", "sales_out", "post", new Date("2026-09-08T01:00:00+08:00"));
      const before = await loadInventoryAlerts(db);
      expect(before.rows[0].daily.ledger).toBeNull();
      vi.setSystemTime(new Date("2026-09-09T00:00:00+08:00"));
      const tomorrow = await loadInventoryAlerts(db);
      expect(tomorrow.sourceBinding).not.toBe(before.sourceBinding);
      expect(tomorrow.rows[0].daily.ledger).toBe(1);
      await db.update(schema.warehouses).set({ active: false }).where(eq(schema.warehouses.id, f.wh.id));
      expect((await computeInventoryAlerts(db)).rows[0].daily.ledger).toBe(1);
      await db.update(schema.warehouses).set({ accountingMode: "snapshot", kind: "snapshot" }).where(eq(schema.warehouses.id, f.wh.id));
      const changed = await loadInventoryAlerts(db);
      expect(changed.sourceBinding).not.toBe(tomorrow.sourceBinding);
      expect(changed.rows[0].daily.ledger).toBeNull();
    } finally { await client.close(); }
  });
});
