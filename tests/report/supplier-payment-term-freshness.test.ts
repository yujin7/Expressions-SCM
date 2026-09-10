import { afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import * as s from "@/db/schema";
import { computeSupplierPaymentTerm, isSupplierPaymentTermBindingCurrent, loadSupplierPaymentTerm, refreshSupplierPaymentTerm } from "@/server/modules/report/supplier-payment-term";
import { createGoal, getGoal, getGoalsBlock, listGoals, resolveAutoActual } from "@/server/modules/goals/service";
import { loadGoalHistory } from "@/server/modules/report/cockpit-trends";
import { createTestDb } from "../helpers/db";

const clients: Awaited<ReturnType<typeof createTestDb>>["client"][] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(clients.splice(0).map(c => c.close()));
});

async function fixture(since = "2023-01-01") {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-03T02:00:00Z"));
  const { db, client } = await createTestDb(); clients.push(client);
  const [user] = await db.insert(s.users).values({ username: "freshness", name: "合成采购" }).returning();
  const [supplier, other] = await db.insert(s.suppliers).values([
    { code: "F-A", name: "合成A", kinds: ["processor"], paymentTermType: "monthly_credit", creditDays: 60, paymentTermEffectiveFrom: "2026-01-01" },
    { code: "F-B", name: "合成B", kinds: ["processor"] },
  ]).returning();
  const [spu] = await db.insert(s.spus).values({ code: "F-SPU", nameCn: "合成" }).returning();
  const [sku] = await db.insert(s.skus).values({ code: "F-SKU", name: "合成", spuId: spu.id, baseUom: "支", skuType: "finished" }).returning();
  async function po(code: string, supplierId: number, day: string, qty: string) {
    const [doc] = await db.insert(s.poDocs).values({ docNo: code, supplierId, createdBy: user.id, status: "approved", createdAt: new Date(day + "T02:00:00Z") }).returning();
    await db.insert(s.approvals).values({ docType: "po", docId: doc.id, approverId: user.id, action: "approve", cycle: 1, createdAt: doc.createdAt });
    const [line] = await db.insert(s.poLines).values({ poId: doc.id, skuId: sku.id, lineType: "raw", purchaseUom: "支", qty, price: "100", taxIncluded: false }).returning();
    return { doc, line };
  }
  await po("F-A-FIRST", supplier.id, since, "1");
  await po("F-A-25", supplier.id, "2025-01-01", "10");
  const current = await po("F-A-26", supplier.id, "2026-01-01", "30");
  await po("F-B-25", other.id, "2025-01-01", "20");
  await po("F-B-26", other.id, "2026-01-01", "20");
  const [bom] = await db.insert(s.boms).values({ productSkuId: sku.id, versionNo: "1" }).returning();
  const [wo] = await db.insert(s.woDocs).values({ docNo: "F-WO", productSkuId: sku.id, supplierId: supplier.id, qty: "1", feeRatePlan: "1", bomId: bom.id, createdBy: user.id }).returning();
  const [jg] = await db.insert(s.jgDocs).values({ docNo: "F-JG", woId: wo.id, productSkuId: sku.id, supplierId: supplier.id, qty: "1", feeRateCurrent: "1", createdBy: user.id, createdAt: new Date("2020-01-01T02:00:00Z") }).returning();
  const [js] = await db.insert(s.jsDocs).values({ docNo: "F-JS", jgId: jg.id, goodQty: "1", feePayable: "100", settleAmount: "100", createdBy: user.id, createdAt: new Date("2026-01-01T02:00:00Z") }).returning();
  return { db, supplier, current, jg, js, user: { ...user, roles: ["admin"], isApprover: false } };
}

describe("账期决策事实新鲜度与年限边界", () => {
  it("驾驶舱、列表与详情同步撤下过期账期值，重建后读新值；人工证据不覆盖", async () => {
    const { db, supplier, current, user } = await fixture();
    await refreshSupplierPaymentTerm(db);
    const auto = await createGoal({ deptKey: "purchasing", period: "2026-09", metricKey: "paymentTermAttainment", targetValue: "80" }, user, db);
    await createGoal({ deptKey: "purchasing", period: "2026-08", metricKey: "paymentTermAttainment", targetValue: "80" }, user, db);
    const manual = await createGoal({ deptKey: "finance", period: "2026-Q3", metricKey: "paymentTermAttainment", targetValue: "80", actualSource: "manual" }, user, db);
    await db.update(s.departmentGoals).set({ actualValue: "75", note: "合成人工证据" }).where(eq(s.departmentGoals.id, manual.id));
    const storedBefore = await db.select().from(s.departmentGoals);
    const block = () => getGoalsBlock(user, db, { now: new Date("2026-09-03T02:00:00Z") });
    expect((await block()).rows.find(r => r.id === auto.id)).toMatchObject({ actualValue: "100.0000", attained: true });
    // A live annual/current-terms value is not proof of the old month's terms, even before any change.
    expect((await loadGoalHistory(db, user)).series.find(r => r.deptKey === "purchasing")!.points.every(p => p.actualValue === null)).toBe(true);
    await db.update(s.poLines).set({ price: "10" }).where(eq(s.poLines.id, current.line.id));
    const expected = { actualValue: null, attained: null, attainment: null, autoStatus: "unavailable" };
    expect(await getGoal(auto.id, user, db)).toMatchObject(expected);
    expect((await listGoals({}, user, db)).rows.find(r => r.id === auto.id)).toMatchObject(expected);
    const history = await loadGoalHistory(db, user);
    expect(history.series.find(r => r.deptKey === "purchasing")!.points.every(p => p.actualValue === null && p.attained === null && p.attainment === null)).toBe(true);
    const stale = await block();
    expect(stale.rows.find(r => r.id === auto.id)).toMatchObject(expected);
    expect(stale.byDept.find(d => d.deptKey === "purchasing")).toMatchObject({ withActual: 0, attained: 0, attainmentRate: null });
    expect(stale.rows.find(r => r.id === manual.id)).toMatchObject({ actualValue: "75.0000", actualSource: "manual", note: "合成人工证据" });
    // Rebuilding changes the supplier's rank: no eligible candidate must remain unknown, not a stale 100%.
    await refreshSupplierPaymentTerm(db);
    expect((await block()).rows.find(r => r.id === auto.id)).toMatchObject(expected);
    await db.update(s.poLines).set({ price: "100" }).where(eq(s.poLines.id, current.line.id));
    await db.update(s.suppliers).set({ creditDays: 20 }).where(eq(s.suppliers.id, supplier.id));
    await refreshSupplierPaymentTerm(db);
    expect((await block()).rows.find(r => r.id === auto.id)).toMatchObject({ actualValue: "0.0000", attained: false, attainment: "0.0", autoStatus: "ok" });
    expect(await db.select().from(s.departmentGoals)).toEqual(storedBefore);
  });

  it("历史不把本期模型补进旧月：两类账期自动值均留空，人工逐期值和部门范围保留", async () => {
    const { db, user } = await fixture();
    for (const metricKey of ["paymentTermAttainment", "creditTermSpendShare"]) {
      for (const period of ["2026-08", "2026-09"]) {
        await db.insert(s.departmentGoals).values([
          { deptKey: "purchasing", metricKey, period, targetValue: "80", actualValue: "100", actualSource: "auto", direction: "up", createdBy: user.id },
          { deptKey: "finance", metricKey, period, targetValue: "80", actualValue: "70", actualSource: "manual", direction: "up", createdBy: user.id, note: "合成逐期证据" },
        ]);
      }
    }
    const history = await loadGoalHistory(db, user);
    expect(history.series).toHaveLength(4);
    for (const series of history.series) {
      expect(series.points).toHaveLength(2);
      for (const point of series.points) {
        if (series.deptKey === "purchasing") expect(point).toMatchObject({ actualValue: null, attainment: null, attained: null, valueWithheld: false, unavailableReason: "账期自动值未封存逐期来源依据，不能作为历史实际值" });
        else expect(point).toMatchObject({ actualValue: "70.0000", attainment: "87.5", attained: false, unavailableReason: null });
      }
    }
    const scoped = await loadGoalHistory(db, { ...user, roles: ["ops"], deptScope: ["finance"] });
    expect(scoped.series).toHaveLength(2);
    expect(scoped.series.every(s => s.deptKey === "finance")).toBe(true);
  });

  it.each(["price", "poStatus", "jgStatus", "jsStatus"] as const)("已有单据%s变化必须撤下旧目标值并重算", async kind => {
    const { db, supplier, current, jg, js } = await fixture();
    if (kind === "poStatus") await db.update(s.poDocs).set({ status: "draft" }).where(eq(s.poDocs.id, current.doc.id));
    const old = await refreshSupplierPaymentTerm(db);
    expect(await isSupplierPaymentTermBindingCurrent(db, old.sourceBinding)).toBe(true);
    if (kind === "price") await db.update(s.poLines).set({ price: "10" }).where(eq(s.poLines.id, current.line.id));
    if (kind === "poStatus") await db.update(s.poDocs).set({ status: "approved" }).where(eq(s.poDocs.id, current.doc.id));
    if (kind === "jgStatus") await db.update(s.jgDocs).set({ status: "approved" }).where(eq(s.jgDocs.id, jg.id));
    if (kind === "jsStatus") await db.update(s.jsDocs).set({ status: "approved" }).where(eq(s.jsDocs.id, js.id));
    expect(await isSupplierPaymentTermBindingCurrent(db, old.sourceBinding)).toBe(false);
    expect((await resolveAutoActual(db, "paymentTermAttainment", "2026-09")).value).toBeNull();
    const fresh = await loadSupplierPaymentTerm(db);
    expect(fresh.sourceBinding).not.toBe(old.sourceBinding);
    const row = fresh.rows.find(r => r.supplierId === supplier.id)!;
    if (kind === "price") expect(row.spend[0].poNet).toBe("300.00");
    if (kind === "poStatus") expect(row.spend[0].poNet).toBe("3000.00");
    if (kind === "jgStatus") expect(row.cooperationSince).toBe("2020-01-01");
    if (kind === "jsStatus") expect(row.spend[0].jsSettle).toBe("100.00");
  });

  it("两周年前一天不能因显示四舍五入为2.00而成为候选", async () => {
    const { db, supplier } = await fixture("2024-09-04");
    const row = (await computeSupplierPaymentTerm(db)).rows.find(r => r.supplierId === supplier.id)!;
    expect(row.rankTrend).toBe("up");
    expect(row.candidate).toBe(false);
    vi.setSystemTime(new Date("2026-09-03T16:00:00Z"));
    expect((await computeSupplierPaymentTerm(db)).rows.find(r => r.supplierId === supplier.id)!.candidate).toBe(true);
  });

  it("闰日周年按非闰年二月末；不满周年和小数年门槛不靠舍入提前", async () => {
    const { db, supplier } = await fixture("2024-02-29");
    vi.setSystemTime(new Date("2026-02-27T02:00:00Z"));
    const row = async () => (await computeSupplierPaymentTerm(db)).rows.find(r => r.supplierId === supplier.id)!;
    expect((await row()).candidate).toBe(false);
    vi.setSystemTime(new Date("2026-02-27T16:00:00Z"));
    expect((await row()).candidate).toBe(true);
    await db.insert(s.sysParams).values({ scope: "global", key: "payment_term_min_years", value: "2.5" });
    vi.setSystemTime(new Date("2026-08-29T02:00:00Z"));
    expect((await row()).candidate).toBe(false);
    vi.setSystemTime(new Date("2026-08-30T02:00:00Z"));
    expect((await row()).candidate).toBe(true);
  });

  it("同一条JS改金额、JG改归属均不能复用旧金额或首单依据", async () => {
    const { db, supplier, jg, js } = await fixture();
    await db.update(s.jgDocs).set({ status: "approved" }).where(eq(s.jgDocs.id, jg.id));
    await db.update(s.jsDocs).set({ status: "approved" }).where(eq(s.jsDocs.id, js.id));
    const old = await refreshSupplierPaymentTerm(db);
    await db.update(s.jsDocs).set({ settleAmount: "500" }).where(eq(s.jsDocs.id, js.id));
    const changed = await loadSupplierPaymentTerm(db);
    expect(changed.sourceBinding).not.toBe(old.sourceBinding);
    expect(changed.rows.find(r => r.supplierId === supplier.id)!.spend[0].jsSettle).toBe("500.00");
    const other = changed.rows.find(r => r.supplierId !== supplier.id)!;
    await db.update(s.jgDocs).set({ supplierId: other.supplierId }).where(eq(s.jgDocs.id, jg.id));
    const moved = await loadSupplierPaymentTerm(db);
    expect(moved.sourceBinding).not.toBe(changed.sourceBinding);
    expect(moved.rows.find(r => r.supplierId === supplier.id)!.spend[0].jsSettle).toBeNull();
    expect(moved.rows.find(r => r.supplierId === other.supplierId)).toMatchObject({ cooperationSince: "2020-01-01" });
  });
});
