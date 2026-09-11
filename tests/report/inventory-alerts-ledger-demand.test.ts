import { afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { createTestDb, type TestDb } from "../helpers/db";
import { computeInventoryAlerts, loadInventoryAlerts } from "@/server/modules/report/inventory-alerts";
import { coverWhy, runInventoryCoverWatchdog } from "@/jobs/alert-watchdogs";
import { completedShanghaiDays, isCurrentObservationDay } from "@/server/core/business-day";
import * as externalVelocity from "@/server/modules/report/external-velocity";
import { upsertAlerts } from "@/server/modules/alerts/engine";
import { externalWindowFixture } from "../helpers/external-window";

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
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
  it("current observation admission uses Shanghai T+1 and rejects stale, future or invalid anchors", () => {
    for (const anchor of ["2026-09-08", "2026-09-07"]) expect(isCurrentObservationDay(anchor, NOW)).toBe(true);
    for (const anchor of [null, "2026-09-06", "2026-09-09", "2026-02-30", "2026-09-07T00:00:00Z"]) expect(isCurrentObservationDay(anchor, NOW)).toBe(false);
  });

  it("historical windows remain readable but neither stale/future observations nor a changed source prove recovery", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW);
    const { db, client } = await createTestDb();
    try {
      const f = await fixture(db); const s = await f.sku("SOURCE-CONTINUITY");
      await f.move(s.id, "-30");
      await db.insert(schema.stockBalances).values({ skuId: s.id, warehouseId: f.wh.id, qty: "1000" });
      await db.insert(schema.skuPlanningPolicy).values({ skuId: s.id, period: "2026-09", tier: "S", abc: "A", ownership: "joint_review" });
      const fact: externalVelocity.ExternalVelocityBySku = { paid30: "300", refund30: "0", net30: "300", paid90: "300", refund90: "0", net90: "300", lastSoldDate: "2026-09-07", activeDays90: 30, platformSkus: 1, tmallNet30: "300", pddNet30: "0", tmallNet90: "300", pddNet90: "0", pddIdentityCovered: false, windows: externalWindowFixture("300") };
      const mock = vi.spyOn(externalVelocity, "loadExternalVelocitySafe");
      const current = (anchorDate: string | null) => ({ ...externalVelocity.emptyExternalVelocity("Synthetic upstream evidence"), anchorDate, bySku: { [s.id]: { ...fact, windows: externalWindowFixture("300", anchorDate ?? "2026-09-07") } } });
      await upsertAlerts(db, { category: "inventory_cover", now: new Date("2026-09-01T04:00:00+08:00"), candidates: [{ refKey: s.code, dedupeKey: `inventory_cover:${s.id}`, title: "旧外部风险", severity: "high", paramsSnapshot: { primaryDailySource: "external" } }] });
      for (const anchor of ["2026-09-06", "2026-09-09", null]) {
        mock.mockResolvedValue(current(anchor));
        const row = (await computeInventoryAlerts(db)).rows[0];
        expect(row).toMatchObject({ net7External: "300", daily: { external: 10 }, primaryDailySource: "ledger", externalDemand: { current: false } });
        expect(coverWhy(row).find(w => w.label === "外部窗口资格")?.value).toContain("不作当前外部主需求");
        expect(await runInventoryCoverWatchdog(db, NOW)).toMatchObject({ autoClosed: 0, stillOpen: 1 });
      }
      mock.mockResolvedValue(externalVelocity.emptyExternalVelocity("Upstream unavailable"));
      expect(await runInventoryCoverWatchdog(db, NOW)).toMatchObject({ autoClosed: 0, stillOpen: 1 });
      mock.mockResolvedValue(current("2026-09-07"));
      expect(await runInventoryCoverWatchdog(db, NOW)).toMatchObject({ autoClosed: 1, stillOpen: 0 });
    } finally { await client.close(); }
  });
  it("需求缺失/净零/负净量/纯作业/对象停用/降为C均不证明恢复；有效正需求回到阈值外才迟滞关闭", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW);
    const { db, client } = await createTestDb();
    try {
      const f = await fixture(db);
      const cases = ["UNKNOWN", "ZERO", "NEGATIVE", "OPERATIONS", "INACTIVE", "TIER-C", "RECOVERED", "STILL-HIT"];
      const seeded = [];
      for (const code of cases) {
        const sku = await f.sku(code); seeded.push(sku);
        await db.insert(schema.skuPlanningPolicy).values({ skuId: sku.id, period: "2026-09", tier: code === "TIER-C" ? "C" : "S", abc: "A", ownership: "joint_review" });
        if (["ZERO", "NEGATIVE", "RECOVERED", "STILL-HIT", "TIER-C"].includes(code)) await f.move(sku.id, "-300");
        if (code === "ZERO" || code === "NEGATIVE") await f.move(sku.id, code === "ZERO" ? "300" : "330", "stock_doc", "reverse:sales_out#1");
        if (code === "OPERATIONS") await f.move(sku.id, "-300", "transfer");
        if (code === "INACTIVE") await db.update(schema.skus).set({ active: false }).where(eq(schema.skus.id, sku.id));
        if (code !== "STILL-HIT") await db.insert(schema.stockBalances).values({ skuId: sku.id, warehouseId: f.wh.id, qty: "1000" });
      }
      await upsertAlerts(db, { category: "inventory_cover", now: new Date("2026-09-03T04:00:00+08:00"), candidates: seeded.map(s => ({ refKey: s.code, dedupeKey: `inventory_cover:${s.id}`, title: "历史风险", severity: "high", ownerRole: "pmc", paramsSnapshot: { primaryDailySource: "ledger" } })) });
      const res = await runInventoryCoverWatchdog(db, NOW);
      expect(res).toMatchObject({ opened: 0, refreshed: 1, autoClosed: 1, stillOpen: 7 });
      const alerts = await db.select().from(schema.systemAlerts);
      expect(alerts.filter(a => a.status === "resolved").map(a => a.refKey)).toEqual(["RECOVERED"]);
      expect(alerts.filter(a => a.status === "open").map(a => a.refKey).sort()).toEqual(cases.filter(c => c !== "RECOVERED").sort());
      const closes = (await db.select().from(schema.alertEvents)).filter(e => e.event === "close");
      expect(closes).toHaveLength(1);
      expect(closes[0].alertId).toBe(alerts.find(a => a.refKey === "RECOVERED")!.id);
      // 整份评估为空同样不能将保留的风险当恢复；历史事件不改写。
      for (const s of seeded) await db.update(schema.skus).set({ active: false }).where(eq(schema.skus.id, s.id));
      expect(await runInventoryCoverWatchdog(db, NOW)).toMatchObject({ candidates: 0, autoClosed: 0, stillOpen: 7 });
    } finally { await client.close(); }
  });
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
      const more = await f.sku("TINY-MORE");
      await f.move(more.id, "-0.0002");
      const model = await computeInventoryAlerts(db);
      const row = model.rows.find((item) => item.skuId === sku.id)!;
      expect(row.daily.ledger).toBeGreaterThan(0);
      expect(row.primary).toBe("out_of_stock");
      expect(row.ledgerDemand.salesNetQty).toBe("0.0001");
      expect(row.priorityScore).toBe("0.0002");
      expect(row.priorityTerms.dailyAvg).toBe("0.000003");
      expect(coverWhy(row).find((why) => why.label === "优先级分")?.value).toContain("0.000003 × 50.0000");
      expect(model.rows.map((item) => item.code)).toEqual(["TINY-MORE", "TINY"]);
      expect(model.rows[0].priorityScore).toBe("0.0004");
      await db.insert(schema.reportReadModelCache).values({ key: "inventory-alerts/v7", sourceBinding: model.sourceBinding, payload: { ...model, key: "inventory-alerts/v7", rows: model.rows.map((r) => ({ ...r, priorityScore: "0.0000" })) } });
      expect((await loadInventoryAlerts(db)).rows[0].priorityScore).toBe("0.0004");
    } finally { await client.close(); }
  });

  it("外部日均同样保留六位精度及负净额；只在正日销中选择主来源", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW);
    const { db, client } = await createTestDb();
    try {
      const f = await fixture(db);
      const sku = await f.sku("EXTERNAL-TINY");
      const fact: externalVelocity.ExternalVelocityBySku = {
        paid30: "0.0001", refund30: "0.0000", net30: "0.0001", paid90: "0.0001", refund90: "0.0000", net90: "0.0001",
        lastSoldDate: "2026-09-07", activeDays90: 1, platformSkus: 1, tmallNet30: "0.0001", pddNet30: "0.0000",
        tmallNet90: "0.0001", pddNet90: "0.0000", pddIdentityCovered: false,
        windows: externalWindowFixture("0.0001"),
      };
      const mock = vi.spyOn(externalVelocity, "loadExternalVelocitySafe").mockResolvedValue({
        ...externalVelocity.emptyExternalVelocity("测试已接受观察值的下游精度，不证明上游窗口完整"), anchorDate: "2026-09-07", bySku: { [sku.id]: fact },
      });
      expect((await computeInventoryAlerts(db)).rows[0]).toMatchObject({ daily: { external: 0.000003 }, primaryDailySource: "external", priorityScore: "0.0002" });
      mock.mockResolvedValue({ ...externalVelocity.emptyExternalVelocity("负净额"), anchorDate: "2026-09-07", bySku: { [sku.id]: { ...fact, net30: "-0.0001", windows: externalWindowFixture("-0.0001") } } });
      expect((await computeInventoryAlerts(db)).rows[0]).toMatchObject({ daily: { external: -0.000003 }, primaryDailySource: null, primary: null });
    } finally { await client.close(); }
  });

  it("内部六个自然月销量用同一六个月天数折日，不误除三个月91天；微量和未知保留", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW);
    const { db, client } = await createTestDb();
    try {
      const f = await fixture(db);
      const normal = await f.sku("MONTHS");
      const tiny = await f.sku("MONTHS-TINY");
      const unknown = await f.sku("MONTHS-UNKNOWN");
      const [channel] = await db.insert(schema.channels).values({ code: "MONTHS", name: "正式月销", kind: "platform" }).returning();
      for (const [yearMonth, qty] of [["2026-01", "31"], ["2026-02", "28"], ["2026-03", "31"], ["2026-04", "30"], ["2026-05", "31"], ["2026-06", "30"]]) {
        await db.insert(schema.salesMonthly).values([
          { skuId: normal.id, channelId: channel.id, yearMonth, qty },
          { skuId: tiny.id, channelId: channel.id, yearMonth, qty: "0.0001" },
        ]);
      }
      const model = await computeInventoryAlerts(db);
      const row = model.rows.find((item) => item.skuId === normal.id)!;
      expect(row.daily.internal).toBe(1);
      expect(row.primaryDaily).toBe(1);
      expect(row.internalDemand).toMatchObject({ startDay: "2026-01-01", endDayExclusive: "2026-07-01", days: 181, salesQty: "181.0000", observedMonths: 6 });
      expect(model.rows.find((item) => item.skuId === tiny.id)).toMatchObject({ daily: { internal: 0.000003 }, priorityScore: "0.0002" });
      expect(model.rows.find((item) => item.skuId === unknown.id)).toMatchObject({ daily: { internal: null }, internalDemand: { salesQty: null, observedMonths: 0 } });
      expect(coverWhy(row).find((why) => why.label === "主日销口径")?.value).toContain("181 天");
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
