import { beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { approvals, auditLogs, departmentGoals, poDocs, poLines, reportReadModelCache, skus, spus, suppliers, sysParams, users } from "@/db/schema";
import { createGoal, getGoal, listGoals, refreshAutoActuals, resolveAutoActual, updateGoal } from "@/server/modules/goals/service";
import { setSupplierPaymentTerm } from "@/server/modules/master/supplier";
import {
  computeSupplierPaymentTerm, loadSupplierPaymentTerm, refreshSupplierPaymentTerm, stripSupplierPaymentTermMoney,
  SUPPLIER_PAYMENT_TERM_KEY,
} from "@/server/modules/report/supplier-payment-term";
import { createTestDb, type TestDb } from "../helpers/db";

/**
 * D64 供应商账期读模型：年采购额 = 已批 PO 未税额（JS 结算并列）；分池排名；
 * 候选 = 合作 ≥ N 年且当年排名较上年上升；达标 = 月结且 ≥ 目标下限；账期类采购额占比。
 */
const ASOF = new Date("2026-09-03T02:00:00.000Z");

describe("supplier-payment-term/v3 读模型（PGlite）", () => {
  let db: TestDb;
  let userId = 0;
  let supAId = 0;
  let supBId = 0;
  let supCId = 0;

  beforeAll(async () => {
    ({ db } = await createTestDb());
    const [user] = await db.insert(users).values({ username: "spt_buyer", name: "采购", roles: ["purchasing"], isApprover: true }).returning();
    userId = user.id;
    const [supA, supB, supC, supD] = await db.insert(suppliers).values([
      { code: "SPT-A", name: "加工厂A", kinds: ["processor"], status: "qualified" },
      { code: "SPT-B", name: "加工厂B", kinds: ["processor"], status: "qualified", paymentTermType: "monthly_credit", creditDays: 60, paymentTermEffectiveFrom: "2026-01-01" },
      { code: "SPT-C", name: "包材厂C", kinds: ["packaging"], status: "qualified", paymentTermType: "on_delivery", paymentTermEffectiveFrom: "2026-01-01" },
      { code: "SPT-D", name: "新原料商D", kinds: ["raw"], status: "pending" },
    ]).returning();
    supAId = supA.id;
    supBId = supB.id;
    supCId = supC.id;
    const [spu] = await db.insert(spus).values({ code: "SPT-SPU", nameCn: "账期产品" }).returning();
    const [sku] = await db.insert(skus).values({ code: "SPT-SKU", name: "账期物料", spuId: spu.id, baseUom: "支", skuType: "raw" }).returning();

    // 未税单价 100（taxIncluded=false），qty 即未税额
    const po = async (docNo: string, supplierId: number, createdAt: string, approvedAt: string, qty: string) => {
      const [doc] = await db.insert(poDocs).values({ docNo, status: "completed", supplierId, createdBy: userId, createdAt: new Date(createdAt) }).returning();
      await db.insert(approvals).values({ docType: "po", docId: doc.id, approverId: userId, action: "approve", cycle: 1, createdAt: new Date(approvedAt) });
      await db.insert(poLines).values({ poId: doc.id, skuId: sku.id, lineType: "raw", purchaseUom: "支", qty, price: "100.00", taxIncluded: false, taxRatePct: "13" });
    };
    // A：合作自 2023，2025 年 1000（第 2）→ 2026 年 3000（第 1）：候选
    await po("SPT-A-23", supA.id, "2023-05-01T02:00:00Z", "2023-05-02T02:00:00Z", "5");
    await po("SPT-A-25", supA.id, "2025-03-01T02:00:00Z", "2025-03-02T02:00:00Z", "10");
    await po("SPT-A-26", supA.id, "2026-02-01T02:00:00Z", "2026-02-02T02:00:00Z", "30");
    // B：合作自 2023，2025 年 2000（第 1）→ 2026 年 2000（第 2）：排名下降，非候选；月结 60 → 达标
    await po("SPT-B-23", supB.id, "2023-01-01T02:00:00Z", "2023-01-02T02:00:00Z", "5");
    await po("SPT-B-25", supB.id, "2025-03-01T02:00:00Z", "2025-03-02T02:00:00Z", "20");
    await po("SPT-B-26", supB.id, "2026-02-01T02:00:00Z", "2026-02-02T02:00:00Z", "20");
    // C：包材池独占，2025 → 2026 排名持平（第 1 → 第 1）：非候选；款到发货
    await po("SPT-C-25", supC.id, "2025-03-01T02:00:00Z", "2025-03-02T02:00:00Z", "10");
    await po("SPT-C-26", supC.id, "2026-02-01T02:00:00Z", "2026-02-02T02:00:00Z", "10");
    // D：无往来
    void supD;
  });

  it("分池排名、合作年限推算、候选判定与达标状态", async () => {
    const m = await computeSupplierPaymentTerm(db, { asOf: ASOF });
    expect(m.year).toBe(2026);
    const a = m.rows.find((r) => r.code === "SPT-A")!;
    expect(a.pool).toBe("processor");
    expect(a.cooperationSince).toBe("2023-05-01");
    expect(a.cooperationSource).toBe("system_inferred");
    expect(a.cooperationYears).toBeGreaterThanOrEqual(3);
    expect(a.spend[0]).toMatchObject({ year: 2026, poNet: "3000.00", jsSettle: null, total: "3000.00", rank: 1, rankOf: 2 });
    expect(a.spend[1]).toMatchObject({ year: 2025, total: "1000.00", rank: 2, rankOf: 2 });
    expect(a.rankTrend).toBe("up");
    expect(a.candidate).toBe(true);
    expect(a.attainment).toBe("unknown");

    const b = m.rows.find((r) => r.code === "SPT-B")!;
    expect(b.rankTrend).toBe("down");
    expect(b.candidate).toBe(false);
    expect(b.attainment).toBe("attained");

    const c = m.rows.find((r) => r.code === "SPT-C")!;
    expect(c.pool).toBe("packaging");
    expect(c.spend[0].rank).toBe(1);
    expect(c.rankTrend).toBe("flat");
    expect(c.attainment).toBe("not_credit");

    const d = m.rows.find((r) => r.code === "SPT-D")!;
    expect(d.cooperationSince).toBeNull();
    expect(d.candidate).toBe(false);
    expect(d.candidateReason).toContain("不可推算");
  });

  it("汇总：候选达成率保留已确认分子，A账期待核对时采购额占比弃权", async () => {
    const m = await computeSupplierPaymentTerm(db, { asOf: ASOF });
    expect(m.summary).toMatchObject({
      suppliers: 4,
      withSpend: 3,
      candidates: 1,
      candidatesAttained: 0,
      attainmentRate: 0,
      creditTermSuppliers: 1,
      totalSpend: "6000.00",
      creditTermSpend: "2000.00",
      creditTermSpendSharePct: null,
      unclassifiedSpendSuppliers: 1,
    });
    const processor = m.summary.byPool.find((p) => p.pool === "processor")!;
    expect(processor).toMatchObject({ suppliers: 2, candidates: 1, totalSpend: "5000.00", creditTermSpendSharePct: null, unclassifiedSpendSuppliers: 1 });
    expect(m.rows[0].code).toBe("SPT-A"); // 候选排最前
  });

  it("登记账期后达成率变化；参数 payment_term_min_years 可改", async () => {
    await setSupplierPaymentTerm(supAId, { paymentTermType: "monthly_credit", creditDays: 45, paymentTermEffectiveFrom: "2026-09-01" }, { id: userId, name: "采购", roles: ["purchasing"], isApprover: true }, db);
    const m = await computeSupplierPaymentTerm(db, { asOf: ASOF });
    expect(m.summary.candidatesAttained).toBe(1);
    expect(m.summary.attainmentRate).toBe(1);
    expect(m.summary.creditTermSpendSharePct).toBe("83.33");

    expect(m.sourceBinding).toContain("|pt:2/45/60");
    await db.insert(sysParams).values({ scope: "global", key: "payment_term_min_years", value: "10" });
    const strict = await computeSupplierPaymentTerm(db, { asOf: ASOF });
    expect(strict.params.minYears).toBe(10);
    expect(strict.summary.candidates).toBe(0);
    expect(strict.summary.attainmentRate).toBeNull();
    expect(strict.sourceBinding).toContain("|pt:10/45/60");
    expect(strict.sourceBinding).not.toBe(m.sourceBinding);
    await db.delete(sysParams).where(eq(sysParams.key, "payment_term_min_years"));
  });

  it("PO 行未税额走 rules/price normalizeLineNetGross：含税行去税后归年", async () => {
    const [sku] = await db.select({ id: skus.id }).from(skus).where(eq(skus.code, "SPT-SKU"));
    const [doc] = await db.insert(poDocs).values({ docNo: "SPT-C-26-TAX", status: "approved", supplierId: supCId, createdBy: userId, createdAt: new Date("2026-03-01T02:00:00Z") }).returning();
    await db.insert(approvals).values({ docType: "po", docId: doc.id, approverId: userId, action: "approve", cycle: 1, createdAt: new Date("2026-03-02T02:00:00Z") });
    await db.insert(poLines).values({ poId: doc.id, skuId: sku.id, lineType: "raw", purchaseUom: "支", qty: "10", price: "113.00", taxIncluded: true, taxRatePct: "13" });
    const m = await computeSupplierPaymentTerm(db, { asOf: ASOF });
    const c = m.rows.find((r) => r.code === "SPT-C")!;
    expect(c.spend[0]).toMatchObject({ year: 2026, poNet: "2000.00", total: "2000.00" }); // 1000 + 1130 ÷ 1.13
  });

  it("金额出口：非价格角色剥掉采购额，名次/候选/账期保留", async () => {
    const m = await computeSupplierPaymentTerm(db, { asOf: ASOF });
    const s = stripSupplierPaymentTermMoney(m, ["ops"]);
    expect(s.moneyVisible).toBe(false);
    expect(s.summary.totalSpend).toBeNull();
    expect(s.summary.byPool[0].creditTermSpend).toBeNull();
    expect(s.rows[0].spend[0]).toMatchObject({ poNet: null, jsSettle: null, total: null, rank: 1 });
    expect(s.rows[0].candidate).toBe(true);
    expect(s.rows.filter((r) => r.hasCurrentYearSpend).map((r) => r.supplierId)).toEqual(m.rows.filter((r) => r.hasCurrentYearSpend).map((r) => r.supplierId));
    expect(JSON.stringify(s)).not.toContain("3000.00");
  });

  it("缓存：绑定一致复用；供应商档案更新（updated_at）改变绑定后重算", async () => {
    const built = await refreshSupplierPaymentTerm(db);
    const [row] = await db.select().from(reportReadModelCache).where(eq(reportReadModelCache.key, SUPPLIER_PAYMENT_TERM_KEY));
    expect(row.sourceBinding).toBe(built.sourceBinding);
    expect((await loadSupplierPaymentTerm(db)).builtAt).toBe(built.builtAt);

    await db.update(suppliers).set({ paymentTermType: "monthly_credit", creditDays: 30, updatedAt: new Date("2030-01-01T00:00:00Z") }).where(eq(suppliers.id, supBId));
    const fresh = await loadSupplierPaymentTerm(db);
    expect(fresh.sourceBinding).not.toBe(built.sourceBinding);
    expect(fresh.rows.find((r) => r.code === "SPT-B")!.attainment).toBe("below_target");

    // 改账期目标参数：绑定变化 → 缓存失效重算（目标下限降到 30，B 的 30 天转为达标）
    await db.insert(sysParams).values({ scope: "global", key: "payment_term_target_min_days", value: "30" });
    const reparam = await loadSupplierPaymentTerm(db);
    expect(reparam.sourceBinding).not.toBe(fresh.sourceBinding);
    expect(reparam.sourceBinding).toContain("|pt:2/30/60");
    expect(reparam.params.targetMinDays).toBe(30);
    expect(reparam.rows.find((r) => r.code === "SPT-B")!.attainment).toBe("attained");
    await db.delete(sysParams).where(eq(sysParams.key, "payment_term_target_min_days"));
  });

  it("未来账期不提前达标，上海生效日零点缓存重新判定", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-10-31T15:59:59Z"));
      await setSupplierPaymentTerm(supAId, { paymentTermType: "monthly_credit", creditDays: 60, paymentTermEffectiveFrom: "2026-11-01" },
        { id: userId, name: "采购", roles: ["purchasing"], isApprover: true }, db);
      const pending = await refreshSupplierPaymentTerm(db);
      expect(pending.rows.find((r) => r.supplierId === supAId)).toMatchObject({ attainment: "pending", termState: "pending" });
      expect(pending.summary.candidatesAttained).toBe(0);
      expect(pending.summary.creditTermSuppliers).toBe(1);
      expect(pending.summary.creditTermSpend).toBe("2000.00");
      expect(pending.summary.creditTermSpendSharePct).toBeNull();
      expect(pending.summary.unclassifiedSpendSuppliers).toBe(1);
      expect((await loadSupplierPaymentTerm(db)).builtAt).toBe(pending.builtAt);
      vi.setSystemTime(new Date("2026-10-31T16:00:00Z"));
      const active = await loadSupplierPaymentTerm(db);
      expect(active.asOf).toBe("2026-11-01");
      expect(active.sourceBinding).not.toBe(pending.sourceBinding);
      expect(active.rows.find((r) => r.supplierId === supAId)).toMatchObject({ attainment: "attained", termState: "effective" });
      expect(active.summary.candidatesAttained).toBe(1);
      expect(active.summary.creditTermSuppliers).toBe(2);
      expect(active.summary.creditTermSpend).toBe("5000.00");
      expect(active.summary.creditTermSpendSharePct).toBe("71.43");
    } finally { vi.useRealTimers(); }
  });

  it("历史缺生效日的月结条款待核对，不算有效月结或达标", async () => {
    await db.update(suppliers).set({ paymentTermType: "monthly_credit", creditDays: 60, paymentTermEffectiveFrom: null }).where(eq(suppliers.id, supAId));
    const model = await computeSupplierPaymentTerm(db, { asOf: ASOF });
    expect(model.rows.find((r) => r.supplierId === supAId)).toMatchObject({ attainment: "unknown", termState: "unknown" });
    expect(model.summary.creditTermSuppliers).toBe(1);
    expect(model.summary.candidatesAttained).toBe(0);
    expect(model.summary.creditTermSpendSharePct).toBeNull();
  });

  it("账期源变更/跨日后目标不读旧缓存，列表详情不伪装旧达标，刷新清空旧自动值但保留人工值", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const buyer = { id: userId, name: "采购", roles: ["purchasing"], isApprover: true };
    try {
      vi.setSystemTime(ASOF);
      await setSupplierPaymentTerm(supAId, { paymentTermType: "monthly_credit", creditDays: 60, paymentTermEffectiveFrom: "2026-09-01" }, buyer, db);
      await refreshSupplierPaymentTerm(db);
      const goal = await createGoal({ deptKey: "purchasing", period: "2026-09", metricKey: "paymentTermAttainment", targetValue: "100" }, buyer, db);
      expect(goal.actualValue).toBe("100.0000");
      const manual = await createGoal({ deptKey: "purchasing", period: "2026-Q3", metricKey: "paymentTermAttainment", targetValue: "100", actualSource: "manual" }, buyer, db);
      await updateGoal(manual.id, { actualValue: "55", evidence: "合成财务核对凭证" }, buyer, db);

      await setSupplierPaymentTerm(supAId, { paymentTermType: "monthly_credit", creditDays: 60, paymentTermEffectiveFrom: "2026-11-01" }, buyer, db);
      expect((await resolveAutoActual(db, "paymentTermAttainment", "2026-09")).value).toBeNull();
      expect(await getGoal(goal.id, buyer, db)).toMatchObject({ actualValue: null, autoStatus: "unavailable", attained: null });
      expect((await listGoals({}, buyer, db)).rows.find((r) => r.id === goal.id)).toMatchObject({ actualValue: null, autoStatus: "unavailable" });
      // 读取不改历史存储值；只有显式刷新在同事务留痕撤下旧自动值。
      expect((await db.select().from(departmentGoals).where(eq(departmentGoals.id, goal.id)))[0].actualValue).toBe("100.0000");
      expect(await refreshAutoActuals(db, { actorId: userId })).toMatchObject({ updated: 1, unavailable: 1 });
      expect((await db.select().from(departmentGoals).where(eq(departmentGoals.id, goal.id)))[0].actualValue).toBeNull();
      const auditCount = (await db.select().from(auditLogs)).length;
      expect(await refreshAutoActuals(db, { actorId: userId })).toMatchObject({ updated: 0, unavailable: 1 });
      expect((await db.select().from(auditLogs)).length).toBe(auditCount);
      expect(await getGoal(manual.id, buyer, db)).toMatchObject({ actualValue: "55.0000", actualSource: "manual" });

      await refreshSupplierPaymentTerm(db);
      expect((await resolveAutoActual(db, "paymentTermAttainment", "2026-09")).value).toBe("0.0000");
      expect((await resolveAutoActual(db, "creditTermSpendShare", "2026-09")).value).toBeNull();
      vi.setSystemTime(new Date("2026-10-31T16:00:00Z"));
      expect((await resolveAutoActual(db, "paymentTermAttainment", "2026-09")).value).toBeNull();
      await loadSupplierPaymentTerm(db);
      await refreshAutoActuals(db, { actorId: userId });
      expect(await getGoal(goal.id, buyer, db)).toMatchObject({ actualValue: "100.0000", autoStatus: "ok" });
      expect(await getGoal(manual.id, buyer, db)).toMatchObject({ actualValue: "55.0000", actualSource: "manual" });
    } finally { vi.useRealTimers(); }
  });
});
