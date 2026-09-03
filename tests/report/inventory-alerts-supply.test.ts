/**
 * 库存预警表 v2（inventory-alerts/v2）+ 爆单 v2（sales-spike/v2）+ 看门狗 why 载荷。
 *
 * 覆盖审计 #1（未结供给降级，在库 0 不降）、#4（why）、#5（优先级拆项）、#6（学习交期只观察）、
 * #7（大促预期内爆单降严重度 + 日历覆盖率）、#8（reason/gaps 透传）、#11b（临期/积压两种预警开始产出）。
 * 日期相对 todayShanghai 取，避免测试随日历失效。
 */
import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { createTestDb } from "../helpers/db";
import { todayShanghai } from "@/server/modules/master/common";
import { computeInventoryAlerts, INVENTORY_ALERTS_CACHE_KEY, summarizeSupplyForAlerts } from "@/server/modules/report/inventory-alerts";
import { computeSalesSpike, SALES_SPIKE_CACHE_KEY } from "@/server/modules/report/sales-spike";
import { coverWhy, runInventoryCoverWatchdog, runSalesSpikeWatchdog, spikeWhy } from "@/jobs/alert-watchdogs";

function shift(ymd: string, days: number): string {
  return new Date(Date.parse(`${ymd}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

async function seed(db: Awaited<ReturnType<typeof createTestDb>>["db"]) {
  const today = todayShanghai();
  const [actor] = await db.insert(schema.users).values({ name: "责任人", roles: ["pmc"] }).returning();
  const [brand] = await db.insert(schema.brands).values({ code: "NING", nameCn: "NING", nameEn: "NING" }).returning();
  const [spu] = await db.insert(schema.spus).values({ code: "P1", nameCn: "测试" }).returning();
  const [hot] = await db.insert(schema.skus).values({ code: "N001-000", name: "爆款", spuId: spu.id, skuType: "finished", baseUom: "支", brandId: brand.id }).returning();
  const [cold] = await db.insert(schema.skus).values({ code: "N002-000", name: "冷门", spuId: spu.id, skuType: "finished", baseUom: "支", brandId: brand.id }).returning();
  const [aging] = await db.insert(schema.skus).values({ code: "N003-000", name: "临期", spuId: spu.id, skuType: "finished", baseUom: "支", brandId: brand.id, nearExpiryDays: 60 }).returning();
  const [slow] = await db.insert(schema.skus).values({ code: "N004-000", name: "积压", spuId: spu.id, skuType: "finished", baseUom: "支", brandId: brand.id }).returning();
  const [ch] = await db.insert(schema.channels).values({ code: "tmall", name: "天猫", kind: "platform" }).returning();
  for (const ym of ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06"]) {
    await db.insert(schema.salesMonthly).values([
      { skuId: hot.id, channelId: ch.id, yearMonth: ym, qty: "500" },
      { skuId: cold.id, channelId: ch.id, yearMonth: ym, qty: "10" },
      { skuId: aging.id, channelId: ch.id, yearMonth: ym, qty: "300" },
      { skuId: slow.id, channelId: ch.id, yearMonth: ym, qty: "2" },
    ]);
  }
  await db.insert(schema.skuParams).values([{ skuId: hot.id, normalLeadDays: 20, logisticsLeadDays: 10 }, { skuId: aging.id, normalLeadDays: 20, logisticsLeadDays: 10 }]);
  // 分层固化：cold 提到 A（在库 0 → 断货要开告警）；slow 提到 B（积压只对非 C 级判）
  await db.insert(schema.skuPlanningPolicy).values([
    { skuId: cold.id, period: "2026-08", tier: "A", abc: "A", ownership: "joint_review" },
    { skuId: slow.id, period: "2026-08", tier: "B", abc: "B", ownership: "joint_review" },
  ]);
  const [wh] = await db.insert(schema.warehouses).values({ code: "WH-CP", name: "成品仓", kind: "finished", accountingMode: "realtime" }).returning();
  await db.insert(schema.stockBalances).values([
    { skuId: hot.id, warehouseId: wh.id, qty: "100" }, // 主日销外部 ~4.83 → 可销 ~20.7 < 35 → 在库口径 alert
    { skuId: aging.id, warehouseId: wh.id, qty: "5000" }, // 内部 300×6/183≈9.8/日 → 可销 ~508 天
    { skuId: slow.id, warehouseId: wh.id, qty: "1000" }, // 内部 12/183≈0.07/日 → 可销 > 180 → 积压
  ]);
  // 未结供给：hot 一笔 PO 10 天后到（阈值 35 天内 → 降级）；cold 一笔 PO 5 天后到（在库 0 → 仍断货）；另一笔无交期
  const [sup] = await db.insert(schema.suppliers).values({ code: "S001", name: "供应商甲" }).returning();
  const [po] = await db.insert(schema.poDocs).values({ docNo: "PO-ALERT-1", status: "approved", supplierId: sup.id, createdBy: actor.id }).returning();
  const [po2] = await db.insert(schema.poDocs).values({ docNo: "PO-ALERT-2", status: "in_progress", supplierId: sup.id, createdBy: actor.id }).returning();
  await db.insert(schema.poLines).values([
    { poId: po.id, skuId: hot.id, lineType: "raw", purchaseUom: "支", uomFactor: "1", qty: "300", price: "5.00", expectedDate: shift(today, 10) },
    { poId: po.id, skuId: hot.id, lineType: "raw", purchaseUom: "支", uomFactor: "1", qty: "50", price: "5.00", expectedDate: shift(today, 40) },
    { poId: po.id, skuId: cold.id, lineType: "raw", purchaseUom: "支", uomFactor: "1", qty: "80", price: "5.00", expectedDate: shift(today, 5) },
    { poId: po2.id, skuId: hot.id, lineType: "raw", purchaseUom: "支", uomFactor: "1", qty: "7", price: "5.00" },
  ]);
  // 学习交期：hot 两家供应商，取样本多的一行（P90 31 vs 档案 20 → +11 > 容差 3 → 观察项）
  const [sup2] = await db.insert(schema.suppliers).values({ code: "S002", name: "供应商乙" }).returning();
  await db.insert(schema.rollupSupplierLead).values([
    { supplierId: sup.id, skuId: hot.id, samples: 12, leadP50Days: "24.00", leadP90Days: "31.00", leadStdevDays: "3.00", onTimeRate: "0.5833" },
    { supplierId: sup2.id, skuId: hot.id, samples: 2, leadP50Days: "20.00", leadP90Days: "99.00", leadStdevDays: "1.00", onTimeRate: "1.0000" },
  ]);
  // 临期批次：aging 40 天后到期（阈值 60）
  await db.insert(schema.batchStocks).values({ skuId: aging.id, warehouseId: wh.id, batchNo: "B1", expiryDate: shift(today, 40), qty: "800", stocktakeDate: today });
  // 天猫日销批次 + 对照表身份（hot 爆单）
  const [salesJob, cwJob] = await db.insert(schema.importJobs).values([
    { template: "jdy_tmall_sku_sales_observation", filename: "s", sourceAsOf: "2026-09-02", createdBy: actor.id, status: "done" },
    { template: "jdy_tmall_sku_crosswalk_observation", filename: "c", sourceAsOf: "2026-09-02", createdBy: actor.id, status: "done" },
  ]).returning();
  const finishedAt = new Date("2026-09-03T03:00:00.000Z");
  await db.insert(schema.integrationRuns).values([
    { connector: "jdy", stream: "tmall-sku-sales-observation", idempotencyKey: "s", status: "succeeded", importJobId: salesJob.id, finishedAt },
    { connector: "jdy", stream: "tmall-sku-crosswalk-observation", idempotencyKey: "c", status: "succeeded", importJobId: cwJob.id, finishedAt },
  ]);
  const shop = "(天猫国际)NING海外旗舰店";
  await db.insert(schema.stagingRows).values({ importJobId: cwJob.id, rowNo: 1, status: "pending", targetTable: "jdy_tmall_sku_crosswalk_observation", payload: { data: { shopName: shop, platformSkuId: "P-HOT" }, _identity: { skuId: hot.id } } });
  const rows: { importJobId: number; rowNo: number; status: "pending"; targetTable: string; payload: unknown }[] = [];
  let n = 1;
  // hot：前 7 天中缺 1 天（8/26，按 0 计），其余 12（基线 72/7≈10.29 ≥ 10）；最近 3 天 20/25/30 → 命中且 gaps=1
  const days = ["2026-08-24", "2026-08-25", "2026-08-27", "2026-08-28", "2026-08-29", "2026-08-30", "2026-08-31", "2026-09-01", "2026-09-02"];
  days.forEach((d, i) => {
    const hotQty = i < 6 ? 12 : [20, 25, 30][i - 6];
    rows.push({ importJobId: salesJob.id, rowNo: n++, status: "pending", targetTable: "jdy_tmall_sku_sales_observation", payload: { data: { statisticalDate: d, shopName: shop, skuId: "P-HOT", paidNumber: String(hotQty), paidAmount: String(hotQty * 100) } } });
  });
  await db.insert(schema.stagingRows).values(rows);
  // 大促日历：hot 9/1–9/5 大促，预期 +80%（判定窗口 8/31–9/2 与之重叠）
  const [promo] = await db.insert(schema.opsPlanEvents).values({ skuId: hot.id, kind: "promo", startDate: "2026-09-01", endDate: "2026-09-05", expectedUpliftPct: 80, createdBy: actor.id }).returning();
  return { hot, cold, aging, slow, actor, today, promo };
}

describe("summarizeSupplyForAlerts", () => {
  it("有日期未逾期 / 无日期 / 逾期 分开累加；nextArrival 取最早未逾期", () => {
    const m = summarizeSupplyForAlerts([
      { skuId: 1, qty: 10, expectDate: "2026-09-20", source: "po", ref: "PO-2", sourceDocId: 1, sourceLineId: 1 },
      { skuId: 1, qty: 5, expectDate: "2026-09-10", source: "wo", ref: "WO-1", sourceDocId: 2, sourceLineId: null },
      { skuId: 1, qty: 3, expectDate: "2026-08-01", source: "po", ref: "PO-OLD", sourceDocId: 3, sourceLineId: 2 },
      { skuId: 1, qty: 7, expectDate: null, source: "legacy_fg", ref: null, sourceDocId: 4, sourceLineId: null },
    ], "2026-09-04");
    expect(m.get(1)).toEqual({ dated: 15, undated: 7, overdue: 3, next: { date: "2026-09-10", qty: 5, source: "wo", ref: "WO-1" } });
  });
});

describe("库存预警表 v2 + 爆单 v2 + 看门狗 why", () => {
  it("阈值内到货降级但在库 0 不降；临期/积压产出；学习交期只观察；优先级拆项；爆单 reason/gaps/大促预期", async () => {
    const { db, client } = await createTestDb();
    try {
      const { hot, cold, aging, slow, today, promo } = await seed(db);
      expect(INVENTORY_ALERTS_CACHE_KEY).toBe("inventory-alerts/v2");
      expect(SALES_SPIKE_CACHE_KEY).toBe("sales-spike/v2");

      /* ── 爆单 v2 ── */
      const spike = await computeSalesSpike(db);
      expect(spike.state).toBe("ready");
      expect(spike.hits.map((h) => h.skuId)).toEqual([hot.id]);
      const sh = spike.hits[0];
      expect(sh.gaps).toBe(1);
      expect(sh.reason).toContain("连续 3 天");
      expect(sh.expected).toBe(true);
      expect(sh.planEventRef).toBe(promo.id);
      expect(sh.expectedUpliftPct).toBe(80);
      expect(sh.planEventWindow).toBe("大促 2026-09-01–2026-09-05");
      expect(spike.coverage).toMatchObject({ mappedSeries: 1, systemSkus: 1, calendarSkus: 1, calendarPct: 100, expectedHits: 1 });
      expect(spike.limitations.some((l) => l.includes("日历覆盖率 100%"))).toBe(true);
      const sw = spikeWhy(sh);
      expect(sw.map((w) => w.label)).toEqual(["判定", "窗口", "基线", "缺天", "大促预期内"]);
      expect(sw.find((w) => w.label === "大促预期内")?.value).toContain("预期涨幅 80%");

      /* ── 库存预警表 v2 ── */
      const model = await computeInventoryAlerts(db);
      expect(model.params.today).toBe(today);
      const h = model.rows.find((r) => r.skuId === hot.id)!;
      const c = model.rows.find((r) => r.skuId === cold.id)!;
      const a = model.rows.find((r) => r.skuId === aging.id)!;
      const s = model.rows.find((r) => r.skuId === slow.id)!;

      // hot：在库口径 alert（20.7 < 35），10 天后 300 件到 → watch；在途拆分；含在途可销
      expect(h.alertDays).toBe(35);
      expect(h.statusOnHand).toBe("alert");
      expect(h.status).toBe("watch");
      expect(h.downgradedBySupply).toBe(true);
      expect(h.statusBasis).toContain("PO-ALERT-1");
      expect(h.nextArrival).toEqual({ date: shift(today, 10), qty: 300, source: "po", ref: "PO-ALERT-1" });
      expect(h.inTransitDated).toBe(350);
      expect(h.inTransitUndated).toBe(7);
      expect(h.inTransitOverdue).toBe(0);
      expect(h.coverDays).not.toBeNull();
      expect(h.coverDaysWithSupply!).toBeGreaterThan(h.coverDays!);
      expect(h.primary).toBe("spike");
      expect(h.spikeExpected).toBe(true);
      expect(h.tags).not.toContain("low_stock"); // 降级后不再是低库存
      // 学习交期：取样本多的一行（n=12，P90 31）→ +11 观察项，阈值不变
      expect(h.learnedLead).toMatchObject({ archiveDays: 20, p90: 31, samples: 12, delta: 11, observeOnly: true, applied: false });
      expect(h.alertBasis).toContain("学习修正 +11(P90, n=12, 观察)");
      expect(h.alertBasis.startsWith("加工 20 + 在途 10 + 缓冲 5")).toBe(true);
      // 优先级拆项
      expect(h.priorityTerms.alertDays).toBe(35);
      expect(h.priorityTerms.dailyAvg).not.toBeNull();
      expect(h.priorityFormula).toContain("日均销");
      expect(Number(h.priorityScore)).toBeGreaterThan(0);

      // cold：在库 0、有需求、5 天后有到货 → 仍 out_of_stock（物理事实）
      expect(c.primary).toBe("out_of_stock");
      expect(c.status).toBe("alert");
      expect(c.downgradedBySupply).toBe(false);
      expect(c.nextArrival?.qty).toBe(80);
      expect(c.tier).toBe("A");

      // aging：可销 ~508 天但 S/A/B 级才判积压——分层现算它是 A（300×6 占比高），临期批次 40 天 ≤ 60 → near_expiry
      expect(a.nearExpiry).toMatchObject({ nearQty: 800, expiredQty: 0, thresholdDays: 60 });
      expect(a.nearExpiry?.minDaysLeft).toBe(40);
      expect(a.tags.includes("near_expiry") || a.primary === "near_expiry").toBe(true);

      // slow：B 级、可销 > 180 → overstock；hot 未积压
      expect(s.tier).toBe("B");
      expect(s.overstock).toBe(true);
      expect(s.primary).toBe("overstock");
      expect(h.overstock).toBe(false);
      // aging 可销 ~508 天且 A 级 → 也积压，但临期优先作主预警、积压作标签（一 SKU 一主预警）
      expect(a.primary).toBe("near_expiry");
      expect(a.tags).toContain("overstock");
      expect(model.totals).toMatchObject({ downgradedBySupply: 1, overstock: 2, learnedObserved: 1 });
      expect(model.totals.nearExpiry).toBeGreaterThanOrEqual(1);
      expect(model.limitations.some((l) => l.includes("未结供给"))).toBe(true);

      /* ── 看门狗：why 落库、降级行不开告警、大促预期内爆单降为 medium ── */
      const cw = coverWhy(c);
      expect(cw.map((w) => w.label)).toContain("下一笔到货");
      expect(cw.map((w) => w.label)).toContain("优先级分");
      expect(coverWhy(h).find((w) => w.label === "学习交期（只观察）")?.value).toContain("本周期阈值未变");
      expect(coverWhy(h).find((w) => w.label === "供给降级")?.value).toContain("PO-ALERT-1");

      const now = new Date("2026-09-04T03:00:00.000Z");
      const w1 = await runInventoryCoverWatchdog(db, now);
      expect(w1.opened).toBe(1); // 只有 cold（A 级断货）；hot 已降级为 watch，不开
      expect(w1.downgradedBySupply).toBe(1);
      const [coldAlert] = await db.select().from(schema.systemAlerts).where(and(eq(schema.systemAlerts.category, "inventory_cover"), eq(schema.systemAlerts.status, "open")));
      expect(coldAlert.refKey).toBe(cold.code);
      const snap = coldAlert.paramsSnapshot as { why: { label: string; value: string; source: string }[]; nextArrival: { qty: number }; priorityTerms: { alertDays: number } };
      expect(snap.why.length).toBeGreaterThanOrEqual(6);
      expect(snap.why.every((w) => typeof w.label === "string" && typeof w.value === "string" && typeof w.source === "string")).toBe(true);
      expect(snap.nextArrival.qty).toBe(80);
      expect(snap.priorityTerms.alertDays).toBe(50);

      const w2 = await runSalesSpikeWatchdog(db, now);
      expect(w2).toMatchObject({ opened: 1, expected: 1, calendarPct: 100 });
      const [spikeAlert] = await db.select().from(schema.systemAlerts).where(and(eq(schema.systemAlerts.category, "sales_spike"), eq(schema.systemAlerts.status, "open")));
      expect(spikeAlert.severity).toBe("medium"); // 大促预期内降级
      expect(spikeAlert.title).toContain("大促预期内");
      const ss = spikeAlert.paramsSnapshot as { why: { label: string }[]; expected: boolean; gaps: number; reason: string; planEventRef: number };
      expect(ss).toMatchObject({ expected: true, gaps: 1, planEventRef: promo.id });
      expect(ss.reason).toContain("连续 3 天");
      expect(ss.why.map((w) => w.label)).toContain("大促预期内");
    } finally {
      await client.close();
    }
  });
});
