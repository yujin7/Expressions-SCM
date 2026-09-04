/**
 * 建议闭环 #12(a)：建议准确度分布（净需求 vs 实际下单 vs 实际出库，只给分布不给分数）
 * + 「已复核并放弃」写路径留痕且不进采纳率分母
 * + #12(b) 抑制复核：ref-gap 闸门扣住的建议后来是否断货（同样只给分布，快照仓 SKU 弃权）。
 */
import { beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import type { SessionUser } from "@/server/core/dto";
import { getClosedLoop, getSuggestionAccuracy, getSuppressionReview } from "@/server/modules/report/closed-loop";
import { declineReplenishSuggestion } from "@/server/modules/replenish/decline";
import { createTestDb, type TestDb } from "../helpers/db";

const NOW = new Date("2026-09-03T03:00:00.000Z");

describe("report/closed-loop 建议准确度 + 放弃留痕", () => {
  let db: TestDb;
  let pmc: SessionUser;
  let ops: SessionUser;
  const sku: Record<string, number> = {};
  let realtimeWh = 0;

  function envelope(businessDate: string, horizonDays: number, net: string) {
    return { schemaVersion: "decision-envelope/v1", businessDate, inputs: { policy: { horizonDays } }, outputs: { netRequiredBeforeRounding: net } };
  }

  beforeAll(async () => {
    ({ db } = await createTestDb());
    const [p] = await db.insert(schema.users).values({ name: "计划", roles: ["pmc"] }).returning();
    const [o] = await db.insert(schema.users).values({ name: "运营", roles: ["ops"] }).returning();
    pmc = { id: p.id, name: p.name, roles: ["pmc"], isApprover: false };
    ops = { id: o.id, name: o.name, roles: ["ops"], isApprover: false };
    const [rt] = await db.insert(schema.warehouses).values({ code: "CL-RT", name: "实时仓", kind: "finished" }).returning();
    realtimeWh = rt.id;
    const [spu] = await db.insert(schema.spus).values({ code: "CL-SPU", nameCn: "闭环品" }).returning();
    for (const k of ["A", "SNAP", "NEW", "SUPP", "SUPP-OK", "SUPP-SNAP", "SUPP-LATE"]) {
      const [s] = await db.insert(schema.skus).values({ code: `CL-${k}`, name: k, spuId: spu.id, baseUom: "件", skuType: "finished" }).returning();
      sku[k] = s.id;
    }
    // 同 SKU 同业务日的更早版本（先捕获、id 更小；应被最新版本覆盖，不重复计数）
    const [v0] = await db.insert(schema.planningVersions).values({
      name: "v0", weekStart: "2026-06-01", engineVersion: "test", parameters: {}, sourceMeta: {}, lineCount: 1, suggestedCount: 1, suppressedCount: 0,
      digest: "d0", idempotencyKey: "cl-v0", createdBy: pmc.id, createdAt: new Date("2026-06-01T01:00:00Z"),
    }).returning();
    const [v1] = await db.insert(schema.planningVersions).values({
      name: "v1", weekStart: "2026-06-01", engineVersion: "test", parameters: {}, sourceMeta: {}, lineCount: 4, suggestedCount: 3, suppressedCount: 1,
      digest: "d1", idempotencyKey: "cl-v1", createdBy: pmc.id, createdAt: new Date("2026-06-01T02:00:00Z"),
    }).returning();
    const line = (skuId: number, code: string, qty: string, env: unknown, suppressed = false) => ({
      versionId: v1.id, skuId, skuCode: code, skuName: code, baseUom: "件", suggestedQty: qty, suppressed, onHand: "0", inTransit: "0", daily: "1", safetyQty: "0",
      explanation: [], decisionEnvelope: env,
    });
    await db.insert(schema.planningVersionLines).values([{ ...line(sku.A, "CL-A", "999", envelope("2026-06-01", 30, "999")), versionId: v0.id }]);
    await db.insert(schema.planningVersionLines).values([
      line(sku.A, "CL-A", "100", envelope("2026-06-01", 30, "100")),
      line(sku.SNAP, "CL-SNAP", "50", envelope("2026-06-01", 30, "50")),
      line(sku.NEW, "CL-NEW", "20", envelope("2026-09-01", 30, "20")), // 视野期未走完
      line(sku.SUPP, "CL-SUPP", "30", envelope("2026-06-01", 30, "30"), true), // 抑制行不进准确度样本，进抑制复核
      line(sku["SUPP-OK"], "CL-SUPP-OK", "40", envelope("2026-06-01", 30, "40"), true),
      line(sku["SUPP-SNAP"], "CL-SUPP-SNAP", "50", envelope("2026-06-01", 30, "50"), true),
      line(sku["SUPP-LATE"], "CL-SUPP-LATE", "60", envelope("2026-09-01", 30, "60"), true), // 视野期未走完
    ]);

    // 实际下单：A 在视野期内 BH 95 件（90–110%）；作废单不计；视野期外不计
    const [bh] = await db.insert(schema.bhDocs).values({ docNo: "BH-CL-1", status: "approved", createdBy: pmc.id, createdAt: new Date("2026-06-10T02:00:00Z") }).returning();
    await db.insert(schema.bhLines).values({ bhId: bh.id, skuId: sku.A, qty: "95" });
    const [bhVoid] = await db.insert(schema.bhDocs).values({ docNo: "BH-CL-VOID", status: "void", createdBy: pmc.id, createdAt: new Date("2026-06-11T02:00:00Z") }).returning();
    await db.insert(schema.bhLines).values({ bhId: bhVoid.id, skuId: sku.A, qty: "500" });
    const [bhLate] = await db.insert(schema.bhDocs).values({ docNo: "BH-CL-LATE", status: "approved", createdBy: pmc.id, createdAt: new Date("2026-08-10T02:00:00Z") }).returning();
    await db.insert(schema.bhLines).values({ bhId: bhLate.id, skuId: sku.A, qty: "500" });
    // 实际出库：A 视野期内出 60（50–90%）；SNAP 无流水 → 覆盖弃权
    await db.insert(schema.stockLedger).values([
      { skuId: sku.A, warehouseId: realtimeWh, qtyDelta: "200", sourceDocType: "test", sourceDocId: 1, action: "post", occurredAt: new Date("2026-05-01T02:00:00Z") },
      { skuId: sku.A, warehouseId: realtimeWh, qtyDelta: "-60", sourceDocType: "test", sourceDocId: 2, action: "post", occurredAt: new Date("2026-06-15T02:00:00Z") },
      { skuId: sku.A, warehouseId: realtimeWh, qtyDelta: "-70", sourceDocType: "test", sourceDocId: 3, action: "post", occurredAt: new Date("2026-08-15T02:00:00Z") },
      // 抑制复核：SUPP 窗口内余额归零且有出库（断货确实发生）；SUPP-OK 余额从未归零；SUPP-SNAP 无流水 → 弃权
      { skuId: sku.SUPP, warehouseId: realtimeWh, qtyDelta: "10", sourceDocType: "test", sourceDocId: 4, action: "post", occurredAt: new Date("2026-05-01T02:00:00Z") },
      { skuId: sku.SUPP, warehouseId: realtimeWh, qtyDelta: "-10", sourceDocType: "test", sourceDocId: 5, action: "post", occurredAt: new Date("2026-06-10T02:00:00Z") },
      { skuId: sku["SUPP-OK"], warehouseId: realtimeWh, qtyDelta: "100", sourceDocType: "test", sourceDocId: 6, action: "post", occurredAt: new Date("2026-05-01T02:00:00Z") },
      { skuId: sku["SUPP-OK"], warehouseId: realtimeWh, qtyDelta: "-10", sourceDocType: "test", sourceDocId: 7, action: "post", occurredAt: new Date("2026-06-10T02:00:00Z") },
    ]);
  });

  it("分布：样本 3（抑制行不计、同日旧版本去重）、成熟 2；下单 90–110% ×1 + 0 ×1；出库 50–90% ×1；快照仓 SKU 覆盖弃权", async () => {
    const a = await getSuggestionAccuracy(db, { now: NOW });
    expect(a).toMatchObject({ version: "closed-loop-accuracy/v1", sample: 3, matured: 2, immature: 1, ledgerCoverage: { withRealtimeLedger: 1, snapshotOnly: 1 } });
    const count = (list: { key: string; count: number }[], key: string) => list.find((b) => b.key === key)?.count;
    expect(count(a.orderedVsRequired, "90_110")).toBe(1);
    expect(count(a.orderedVsRequired, "none")).toBe(1);
    expect(a.orderedVsRequired.reduce((s, b) => s + b.count, 0)).toBe(2);
    expect(count(a.outboundVsRequired, "50_90")).toBe(1);
    expect(a.outboundVsRequired.reduce((s, b) => s + b.count, 0)).toBe(1);
    expect(a.caliber.some((c) => c.includes("不给单一准确率"))).toBe(true);
    expect((a as unknown as Record<string, unknown>).accuracyPct).toBeUndefined();
  });

  it("抑制复核：被扣住的建议后来是否断货——随后断货 / 未断货 / 无流水弃权，各带样本数与扣住量", async () => {
    const r = await getSuppressionReview(db, { now: NOW });
    expect(r.version).toBe("closed-loop-suppression/v1");
    // 4 条抑制行：3 条视野期已走完，SUPP-LATE 的视野期还没走完 → 不判定
    expect(r).toMatchObject({ sample: 4, matured: 3, immature: 1 });
    expect(Number(r.heldQtyTotal)).toBe(180);
    const bucket = (key: string) => r.outcomes.find((b) => b.key === key)!;
    expect(bucket("stockout_followed").count).toBe(1); // SUPP：窗口内余额归零且有出库
    expect(Number(bucket("stockout_followed").heldQty)).toBe(30);
    expect(bucket("no_stockout").count).toBe(1); // SUPP-OK：余额从未归零
    expect(Number(bucket("no_stockout").heldQty)).toBe(40);
    expect(bucket("unverifiable").count).toBe(1); // SUPP-SNAP：实时仓无流水，弃权而不是判「抑制正确」
    expect(Number(bucket("unverifiable").heldQty)).toBe(50);
    expect(r.caliber.some((c) => c.includes("不给单一"))).toBe(true);
    // 不给单一「抑制正确率」
    expect((r as unknown as Record<string, unknown>).correctPct).toBeUndefined();
    // 闭环页一并下发
    const loop = await getClosedLoop({ page: 1, pageSize: 20 }, db);
    expect(loop.suppression.matured).toBe(3);
  });

  it("放弃留痕：pmc 写审计 decline_suggestion；同人同 SKU 同日重复只留一条；ops 403；不进采纳率分母", async () => {
    await expect(declineReplenishSuggestion(ops, { skuId: sku.A, reason: "x" }, db)).rejects.toThrow(/无权限/);
    await expect(declineReplenishSuggestion(pmc, { skuId: sku.A, reason: "" }, db)).rejects.toThrow();
    await expect(declineReplenishSuggestion(pmc, { skuId: 999999, reason: "x" }, db)).rejects.toThrow(/不存在/);
    const r1 = await declineReplenishSuggestion(pmc, { skuId: sku.A, reason: "参考仓充足", reasonCode: "reference_stock_sufficient" }, db);
    expect(r1).toMatchObject({ skuId: sku.A, skuCode: "CL-A", reasonCode: "reference_stock_sufficient", duplicate: false });
    const r2 = await declineReplenishSuggestion(pmc, { skuId: sku.A, reason: "再点一次" }, db);
    expect(r2.duplicate).toBe(true);
    const audits = await db.select().from(schema.auditLogs).where(and(eq(schema.auditLogs.entity, "replenish"), eq(schema.auditLogs.action, "decline_suggestion")));
    expect(audits).toHaveLength(1);
    expect(audits[0].entityId).toBe(sku.A);
    expect(audits[0].after).toMatchObject({ skuId: sku.A, skuCode: "CL-A", reason: "参考仓充足", reasonCode: "reference_stock_sufficient", source: "replenish_suggestion" });

    // 采纳率分母只数 draft_bh；放弃单列
    await db.insert(schema.auditLogs).values({ userId: pmc.id, entity: "replenish", entityId: 1, action: "draft_bh", after: { docNo: "BH-CL-1", lineCount: 1, source: "replenish_suggestion" } });
    const loop = await getClosedLoop({ page: 1, pageSize: 20 }, db);
    expect(loop.summary).toMatchObject({ total: 1, adopted: 1, adoptRate: 100, declined: 1 });
    expect(loop.accuracy.sample).toBe(3);
  });

  /* ── C8(c)：扣住的量与结果分布分母不同，关系必须写在读模型里 ── */
  it("heldQtyTotal 覆盖全部样本、结果分布只覆盖已成熟样本：并列 heldQtyMatured / heldQtyImmature 且三者自洽", async () => {
    const r = await getSuppressionReview(db, { now: NOW });
    // 全部 4 条 = 30 + 40 + 50 + 60；其中 SUPP-LATE(60) 视野期未走完
    expect(Number(r.heldQtyTotal)).toBe(180);
    expect(Number(r.heldQtyMatured)).toBe(120);
    expect(Number(r.heldQtyImmature)).toBe(60);
    // 已成熟量必须正好等于三个结果桶之和——否则页面上「扣住 180」与桶合计 120 对不上又无从解释
    const bucketSum = r.outcomes.reduce((acc, b) => acc + Number(b.heldQty), 0);
    expect(bucketSum).toBe(Number(r.heldQtyMatured));
    expect(Number(r.heldQtyMatured) + Number(r.heldQtyImmature)).toBe(Number(r.heldQtyTotal));
    expect(r.caliber.some((c) => c.includes("两者分母不同"))).toBe(true);
  });

  /* ── C8(d)：2000 行上限此前无声截断 ── */
  it("取数上限暴露为 truncated / rowLimit：命中上限时必须自己说出来", async () => {
    const full = await getSuggestionAccuracy(db, { now: NOW });
    expect(full.rowLimit).toBe(2000);
    expect(full.truncated).toBe(false);

    // 把上限压到 1 行：样本被截断，读模型必须承认
    const cut = await getSuggestionAccuracy(db, { now: NOW, limit: 1 });
    expect(cut.rowLimit).toBe(1);
    expect(cut.truncated).toBe(true);
    expect(cut.sample).toBeLessThan(full.sample);
    expect(cut.caliber.some((c) => c.includes("truncated"))).toBe(true);

    const supFull = await getSuppressionReview(db, { now: NOW });
    expect(supFull).toMatchObject({ rowLimit: 2000, truncated: false });
    const supCut = await getSuppressionReview(db, { now: NOW, limit: 2 });
    expect(supCut).toMatchObject({ rowLimit: 2, truncated: true });
    expect(supCut.sample).toBeLessThan(supFull.sample);
  });

  /* ── C9：空总体给 null，不给 0% ── */
  it("采纳率/到货率在没有任何建议草稿时是 null，不是 0%（0% 读作「建议全被无视」）", async () => {
    const { db: fresh, client } = await createTestDb();
    try {
      const loop = await getClosedLoop({ page: 1, pageSize: 20 }, fresh);
      expect(loop.summary.total).toBe(0);
      expect(loop.summary.adoptRate).toBeNull();
      expect(loop.summary.deliveredRate).toBeNull();
    } finally {
      await client.close();
    }
  });
});
