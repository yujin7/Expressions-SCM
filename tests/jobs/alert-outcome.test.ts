/**
 * 告警结果核验（闭环审计 #3）：关闭 ≥3 天的断货告警回看实时仓流水 → alert_events(verify)；
 * 快照仓 SKU 弃权并说明覆盖；每条只核验一次；精确率汇总按 category × sourceRule。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { INTERVAL_JOBS } from "@/jobs/interval-runner";
import { SCHEDULES } from "@/jobs/scheduler";
import { ALERT_OUTCOME_VERSION, alertPrecision, runAlertOutcome } from "@/jobs/alert-outcome";
import { createTestDb, type TestDb } from "../helpers/db";

const NOW = new Date("2026-09-03T03:00:00.000Z");
const OPENED = new Date("2026-08-20T03:00:00.000Z");
const RESOLVED = new Date("2026-08-28T03:00:00.000Z");

describe("jobs/alert-outcome", () => {
  let db: TestDb;
  let client: Awaited<ReturnType<typeof createTestDb>>["client"] | undefined;
  let realtimeWh = 0;
  const skuIds: Record<string, number> = {};
  const alertIds: Record<string, number> = {};
  let ledgerSeq = 0;

  async function ledger(skuId: number, warehouseId: number, qtyDelta: string, day: string) {
    ledgerSeq += 1;
    await db.insert(schema.stockLedger).values({
      skuId, warehouseId, qtyDelta, sourceDocType: qtyDelta.startsWith("-") ? "sales_out" : "opening", sourceDocId: ledgerSeq, sourceLineId: 0, action: "post",
      occurredAt: new Date(`${day}T10:00:00+08:00`),
    });
  }

  beforeAll(async () => {
    ({ db, client } = await createTestDb());
    const [rt] = await db.insert(schema.warehouses).values({ code: "AO-RT", name: "实时仓", kind: "finished" }).returning();
    const [snapshot] = await db.insert(schema.warehouses).values({ code: "AO-SNAP", name: "快照仓", kind: "snapshot", accountingMode: "snapshot" }).returning();
    realtimeWh = rt.id;
    const [spu] = await db.insert(schema.spus).values({ code: "AO-SPU", nameCn: "核验品" }).returning();
    for (const k of ["TP", "FP", "SNAP", "AVERT", "FRESH"]) {
      const [s] = await db.insert(schema.skus).values({ code: `AO-${k}`, name: k, spuId: spu.id, baseUom: "件", skuType: "finished" }).returning();
      skuIds[k] = s.id;
      const [a] = await db.insert(schema.systemAlerts).values({
        category: "inventory_cover", refKey: `AO-${k}`, dedupeKey: `inventory_cover:${s.id}`, title: `${k} 断货`, severity: "high",
        status: "resolved", autoResolved: true, createdAt: OPENED, resolvedAt: k === "FRESH" ? new Date("2026-09-02T03:00:00.000Z") : RESOLVED,
        sourceRule: "rules/alert-threshold + rules/alert-priority",
      }).returning();
      alertIds[k] = a.id;
    }
    // 已登记快照仓明确覆盖为零；缺少记录不再充当零库存证据。
    await db.insert(schema.stockSnapshots).values(Object.values(skuIds).map((skuId) => ({
      warehouseId: snapshot.id, skuId, bizDate: "2026-08-01", qty: "0",
    })));
    // TP：期初 10，窗口内出 6 + 4 → 归零且有需求
    await ledger(skuIds.TP, realtimeWh, "10", "2026-08-01");
    await ledger(skuIds.TP, realtimeWh, "-6", "2026-08-22");
    await ledger(skuIds.TP, realtimeWh, "-4", "2026-08-25");
    // FP：期初 100，窗口内出 5，无入库 → 从未归零
    await ledger(skuIds.FP, realtimeWh, "100", "2026-08-01");
    await ledger(skuIds.FP, realtimeWh, "-5", "2026-08-22");
    // SNAP：无任何实时仓流水 → 弃权
    // AVERT：期初 10，出 8，窗口内入 50 → 未归零但有入库 → 弃权（可能被规避）
    await ledger(skuIds.AVERT, realtimeWh, "10", "2026-08-01");
    await ledger(skuIds.AVERT, realtimeWh, "-8", "2026-08-22");
    await ledger(skuIds.AVERT, realtimeWh, "50", "2026-08-26");
  });

  afterAll(async () => { await client?.close(); });

  it("关闭 ≥3 天的 inventory_cover 告警逐条核验：真 / 误 / 弃权（快照仓、规避）；未满 3 天不扫", async () => {
    const s = await runAlertOutcome(db, { now: NOW });
    expect(s).toMatchObject({ scanned: 4, verified: 4, truePositive: 1, falsePositive: 1, unverifiable: 2, realtimeWarehouses: 1 });
    const evs = await db.select().from(schema.alertEvents).where(eq(schema.alertEvents.event, "verify"));
    expect(evs).toHaveLength(4);
    const byAlert = new Map(evs.map((e) => [e.alertId, e.evidenceRef as Record<string, unknown>]));
    expect(evs.every((e) => (e.evidenceRef as Record<string, unknown>).version === "alert-outcome/v3")).toBe(true);
    expect(byAlert.get(alertIds.TP)).toMatchObject({ result: "true_positive", reason: "zero_stock_with_demand", coverage: "realtime", minBalance: "0.0000", demandOutQty: "10.0000" });
    expect(byAlert.get(alertIds.FP)).toMatchObject({ result: "false_positive", reason: "stock_never_zero", minBalance: "95.0000", inboundQty: "0" });
    expect(byAlert.get(alertIds.SNAP)).toMatchObject({ result: "unverifiable", reason: "snapshot_only_no_realtime_ledger", coverage: "none" });
    expect(byAlert.get(alertIds.AVERT)).toMatchObject({ result: "unverifiable", reason: "averted_by_inbound", inboundQty: "50.0000" });
    expect(byAlert.has(alertIds.FRESH)).toBe(false);
    // 核验事件不带 actor、不带原因码；幂等键 = `${alertId}:verify`
    expect(evs.every((e) => e.actorId === null && e.reasonCode === null && e.idempotencyKey === `${e.alertId}:verify`)).toBe(true);
    // system_alerts 不被回写
    const [tp] = await db.select().from(schema.systemAlerts).where(eq(schema.systemAlerts.id, alertIds.TP));
    expect(tp).toMatchObject({ status: "resolved", autoResolved: true });
  });

  it("再跑一轮：已核验的不再扫；FRESH 满 3 天后才进入", async () => {
    const s2 = await runAlertOutcome(db, { now: NOW });
    expect(s2).toMatchObject({ scanned: 0, verified: 0 });
    const s3 = await runAlertOutcome(db, { now: new Date("2026-09-06T03:00:00.000Z") });
    expect(s3).toMatchObject({ scanned: 1, verified: 1, unverifiable: 1 });
    expect(await db.select().from(schema.alertEvents).where(eq(schema.alertEvents.event, "verify"))).toHaveLength(5);
  });

  it("alertPrecision：按 category × sourceRule 计数，弃权不进分母，不给单一总分", async () => {
    const p = await alertPrecision(db, { days: 30, now: new Date("2026-09-06T04:00:00.000Z") });
    expect(p).toMatchObject({ verifiedTotal: 5, legacyVerifiedTotal: 0 });
    expect(p.groups).toHaveLength(1);
    expect(p.groups[0]).toMatchObject({
      category: "inventory_cover", sourceRule: "rules/alert-threshold + rules/alert-priority",
      verified: 5, truePositive: 1, falsePositive: 1, unverifiable: 3, precisionPct: 50,
    });
    expect(p.caliber).toContain("弃权");
    expect((p as unknown as Record<string, unknown>).precisionPct).toBeUndefined();
    const empty = await alertPrecision(db, { days: 1, now: new Date("2026-12-01T00:00:00.000Z") });
    expect(empty.groups).toEqual([]);
  });

  it("任务已登记：INTERVAL_JOBS(05 点) 与 SCHEDULES(05:30，rollup 之后)", () => {
    const job = INTERVAL_JOBS.find((j) => j.name === "alert-outcome");
    expect(job?.atHours).toEqual([5]);
    expect(SCHEDULES["alert-outcome"]).toBe("30 5 * * *");
    const hour = (expr: string) => Number(expr.split(/\s+/)[1]);
    expect(hour(SCHEDULES["alert-outcome"])).toBeGreaterThan(hour(SCHEDULES.rollup));
  });
});


/**
 * 红队审计 A3：告警来自 getOnHandBySku＝**实时仓余额 + 快照仓最新快照**，
 * 而核验只能看实时仓流水。修复前只要该 SKU 在实时仓动过一笔就标 coverage=realtime 并打真/误的分——
 * 一个货主要压在快照仓、实时仓只有零星调拨的 SKU 会被算进精确率，而那正是人用来调阈值的数。
 */
describe("jobs/alert-outcome：快照仓 SKU 不得用实时仓流水打分（红队 A3）", () => {
  it("有实时流水但窗口内仍有快照仓在库 → unverifiable(snapshot_stock_outside_ledger)，不进精确率分母", async () => {
    const { db, client } = await createTestDb();
    try {
      const [rt] = await db.insert(schema.warehouses).values({ code: "MX-RT", name: "实时仓", kind: "finished" }).returning();
      const [snapWh] = await db.insert(schema.warehouses).values({ code: "MX-SNAP", name: "快照仓", kind: "snapshot", accountingMode: "snapshot" }).returning();
      const [spu] = await db.insert(schema.spus).values({ code: "MX-SPU", nameCn: "混合品" }).returning();
      const [mixed] = await db.insert(schema.skus).values({ code: "MX-MIXED", name: "混合", spuId: spu.id, baseUom: "件", skuType: "finished" }).returning();
      const [pure] = await db.insert(schema.skus).values({ code: "MX-PURE", name: "纯实时", spuId: spu.id, baseUom: "件", skuType: "finished" }).returning();
      const mk = async (sku: { id: number }, code: string) => {
        const [a] = await db.insert(schema.systemAlerts).values({
          category: "inventory_cover", refKey: code, dedupeKey: `inventory_cover:${sku.id}`, title: `${code} 断货`, severity: "high",
          status: "resolved", autoResolved: true, createdAt: OPENED, resolvedAt: RESOLVED,
          sourceRule: "rules/alert-threshold + rules/alert-priority",
        }).returning();
        return a.id;
      };
      const mixedAlert = await mk(mixed, "MX-MIXED");
      const pureAlert = await mk(pure, "MX-PURE");
      let seq = 0;
      const ledgerRow = async (skuId: number, qtyDelta: string, day: string) => {
        seq += 1;
        await db.insert(schema.stockLedger).values({
          skuId, warehouseId: rt.id, qtyDelta, sourceDocType: qtyDelta.startsWith("-") ? "sales_out" : "opening", sourceDocId: seq, sourceLineId: 0, action: "post",
          occurredAt: new Date(`${day}T10:00:00+08:00`),
        });
      };
      // 两个 SKU 的实时仓流水一模一样：期初 10、窗口内出 12 → 实时仓口径都"归零且有需求"
      for (const id of [mixed.id, pure.id]) {
        await ledgerRow(id, "10", "2026-08-01");
        await ledgerRow(id, "-12", "2026-08-22");
      }
      // 唯一差别：MIXED 的货主要在快照仓（500 件，窗口内的最新一期）
      await db.insert(schema.stockSnapshots).values({ warehouseId: snapWh.id, skuId: mixed.id, bizDate: "2026-08-15", qty: "500" });
      await db.insert(schema.stockSnapshots).values({ warehouseId: snapWh.id, skuId: pure.id, bizDate: "2026-08-15", qty: "0" });

      const s = await runAlertOutcome(db, { now: NOW });
      expect(s).toMatchObject({ scanned: 2, verified: 2, truePositive: 1, falsePositive: 0, unverifiable: 1 });
      const evs = await db.select().from(schema.alertEvents).where(eq(schema.alertEvents.event, "verify"));
      const byAlert = new Map(evs.map((e) => [e.alertId, e.evidenceRef as Record<string, unknown>]));
      // 修复前：MIXED 也被判 true_positive（coverage: "realtime"），证据里那批 500 件根本没被看见
      expect(byAlert.get(mixedAlert)).toMatchObject({
        result: "unverifiable", reason: "snapshot_stock_outside_ledger", coverage: "snapshot_mixed",
      });
      expect(String(byAlert.get(mixedAlert)?.note)).toContain("快照仓在库");
      expect(byAlert.get(pureAlert)).toMatchObject({ result: "true_positive", coverage: "realtime" });

      // 精确率分母里只剩纯实时仓那条
      const p = await alertPrecision(db, { days: 30, now: NOW });
      expect(p.groups[0]).toMatchObject({ verified: 2, truePositive: 1, falsePositive: 0, unverifiable: 1, precisionPct: 100 });
    } finally {
      await client.close();
    }
  });
});

describe("jobs/alert-outcome：旧核验留存但不冒充新口径", () => {
  it("v1、缺版本与未知版本单列，不进入 v2 分母，重跑不覆写或自动补写 verify", async () => {
    const { db, client } = await createTestDb();
    try {
      const cases = [
        { version: ALERT_OUTCOME_VERSION, result: "true_positive" },
        { version: ALERT_OUTCOME_VERSION, result: "false_positive" },
        { version: "alert-outcome/v1", result: "true_positive" },
        { version: undefined, result: "true_positive" },
        { version: "alert-outcome/v999", result: "true_positive" },
      ];
      for (const [index, evidence] of cases.entries()) {
        const [alert] = await db.insert(schema.systemAlerts).values({
          category: "inventory_cover", dedupeKey: `inventory_cover:legacy-${index}`, title: "合成历史核验",
          severity: "high", status: "resolved", sourceRule: "fixture-rule", createdAt: OPENED, resolvedAt: RESOLVED,
        }).returning();
        await db.insert(schema.alertEvents).values({
          alertId: alert.id, event: "verify", at: NOW, idempotencyKey: `${alert.id}:verify`,
          evidenceRef: evidence.version == null ? { result: evidence.result } : evidence,
        });
      }
      const before = await db.select().from(schema.alertEvents).orderBy(schema.alertEvents.id);
      const precision = await alertPrecision(db, { days: 30, now: NOW });
      expect(precision).toMatchObject({ verifiedTotal: 2, legacyVerifiedTotal: 3 });
      expect(precision.groups).toEqual([{
        category: "inventory_cover", sourceRule: "fixture-rule", verified: 2,
        truePositive: 1, falsePositive: 1, unverifiable: 0, precisionPct: 50,
      }]);
      expect(precision.caliber).toContain(ALERT_OUTCOME_VERSION);
      expect(precision.caliber).toContain("不自动重算");
      expect(await runAlertOutcome(db, { now: NOW })).toMatchObject({ scanned: 0, verified: 0 });
      expect(await db.select().from(schema.alertEvents).orderBy(schema.alertEvents.id)).toEqual(before);
    } finally {
      await client.close();
    }
  });
});

describe("jobs/alert-outcome：异常 SKU 键不拖垮同批核验", () => {
  it("0、int32 溢出、极长数值分别弃权；有效 refKey 可兜底，正常告警仍完成", async () => {
    const { db, client } = await createTestDb();
    try {
      const [warehouse] = await db.insert(schema.warehouses).values({ code: "ID-RT", name: "合成实时仓", kind: "finished" }).returning();
      const [spu] = await db.insert(schema.spus).values({ code: "ID-SPU", nameCn: "合成编号核验" }).returning();
      const [sku] = await db.insert(schema.skus).values({
        code: "ID-SKU", name: "合成品", spuId: spu.id, baseUom: "件", skuType: "finished",
      }).returning();
      await db.insert(schema.stockLedger).values([
        { skuId: sku.id, warehouseId: warehouse.id, qtyDelta: "10", sourceDocType: "id-test", sourceDocId: 1, action: "post", occurredAt: new Date("2026-08-01T00:00:00Z") },
        { skuId: sku.id, warehouseId: warehouse.id, qtyDelta: "-10", sourceDocType: "sales_out", sourceDocId: 2, action: "post", occurredAt: new Date("2026-08-22T00:00:00Z") },
      ]);
      const addAlert = async (suffix: string, refKey: string | null) => {
        const [alert] = await db.insert(schema.systemAlerts).values({
          category: "inventory_cover", dedupeKey: `inventory_cover:${suffix}`, refKey, title: "合成编号告警",
          severity: "high", status: "resolved", createdAt: OPENED, resolvedAt: RESOLVED,
        }).returning();
        return alert.id;
      };
      const unresolved: number[] = [];
      const resolved = [await addAlert(String(sku.id), null)];
      for (const suffix of ["0", "2147483648", "9".repeat(400)]) {
        unresolved.push(await addAlert(suffix, "unknown-code"));
        resolved.push(await addAlert(suffix, sku.code));
      }
      expect(await runAlertOutcome(db, { now: NOW })).toMatchObject({
        scanned: 7, verified: 7, truePositive: 4, falsePositive: 0, unverifiable: 3,
      });
      const events = await db.select().from(schema.alertEvents).where(eq(schema.alertEvents.event, "verify"));
      expect(events).toHaveLength(7);
      const byAlert = new Map(events.map((event) => [event.alertId, event.evidenceRef]));
      for (const id of unresolved) {
        expect(byAlert.get(id)).toMatchObject({ skuId: null, result: "unverifiable", reason: "sku_unresolved", coverage: "none" });
      }
      for (const id of resolved) {
        expect(byAlert.get(id)).toMatchObject({ skuId: sku.id, result: "true_positive", coverage: "realtime", version: ALERT_OUTCOME_VERSION });
      }
      expect(await runAlertOutcome(db, { now: NOW })).toMatchObject({ scanned: 0, verified: 0 });
    } finally {
      await client.close();
    }
  });
});
