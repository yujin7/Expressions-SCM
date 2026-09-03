import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { auditLogs, opsPlanEvents } from "@/db/schema";
import {
  createPlanEvent, deletePlanEvent, listPlanEvents, loadOpenPlanEventsBySku, phaseOf, planEventTag, updatePlanEvent,
} from "@/server/modules/planning/plan-events";
import { createTestDb, type TestDb } from "../helpers/db";
import { seedTierWorld, type TierWorld } from "../helpers/tier-seed";

/**
 * 运营计划事件（ops_plan_events）：只作上下文，不驱动建议量。
 * 护栏：写=ops/pmc（admin 兜底）+ 同事务审计；受限用户（D62）范围外渠道 403、读只见范围内 + 不分渠道；
 * 日期窗校验；补货行展开只取未结束事件。
 */
describe("planning/plan-events", () => {
  let db: TestDb;
  let w: TierWorld;
  let promoId = 0;
  let launchId = 0;

  beforeAll(async () => {
    ({ db } = await createTestDb());
    w = await seedTierWorld(db);
  });

  it("纯函数：阶段与标签文案", () => {
    expect(phaseOf("2026-09-15", "2026-09-30", "2026-09-04")).toBe("upcoming");
    expect(phaseOf("2026-09-01", "2026-09-30", "2026-09-04")).toBe("active");
    expect(phaseOf("2026-08-01", "2026-08-30", "2026-09-04")).toBe("past");
    expect(phaseOf("2026-08-01", null, "2026-09-04")).toBe("active");
    expect(planEventTag({ kindLabel: "大促", startDate: "2026-09-15", endDate: "2026-09-30" })).toBe("大促 9/15–9/30");
    expect(planEventTag({ kindLabel: "下架", startDate: "2026-10-01", endDate: null })).toBe("下架 10/1起");
  });

  it("创建：ops 可写、同事务审计；SKU/SPU 至少一个；结束早于开始 400；warehouse 403", async () => {
    await expect(createPlanEvent(w.ops, { kind: "promo", startDate: "2099-01-01" }, db)).rejects.toMatchObject({ status: 400 });
    await expect(createPlanEvent(w.ops, { skuId: w.sku.S, kind: "promo", startDate: "2099-01-10", endDate: "2099-01-01" }, db)).rejects.toMatchObject({ status: 400 });
    await expect(createPlanEvent(w.ops, { skuId: 999999, kind: "promo", startDate: "2099-01-01" }, db)).rejects.toMatchObject({ status: 404 });
    await expect(createPlanEvent(w.warehouse, { skuId: w.sku.S, kind: "promo", startDate: "2099-01-01" }, db)).rejects.toMatchObject({ status: 403 });

    const r = await createPlanEvent(w.ops, { skuId: w.sku.S, channelId: w.tmall, kind: "promo", startDate: "2099-01-01", endDate: "2099-01-15", expectedUpliftPct: 80, note: "双十一" }, db);
    promoId = r.id;
    const [row] = await db.select().from(opsPlanEvents).where(eq(opsPlanEvents.id, promoId));
    expect(row).toMatchObject({ skuId: w.sku.S, channelId: w.tmall, kind: "promo", expectedUpliftPct: 80, createdBy: w.ops.id });
    const audits = await db.select().from(auditLogs).where(eq(auditLogs.entity, "ops_plan_event"));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ action: "create", entityId: promoId, userId: w.ops.id });
  });

  it("渠道范围（D62）：受限运营对范围外渠道 403、缺渠道 403（channelId 必填且须在范围内）；不受限用户可建不分渠道事件", async () => {
    await expect(createPlanEvent(w.opsPdd, { skuId: w.sku.S, channelId: w.tmall, kind: "launch", startDate: "2099-02-01" }, db)).rejects.toMatchObject({ status: 403 });
    await expect(createPlanEvent(w.opsPdd, { skuId: w.sku.A, kind: "price", startDate: "2099-03-01" }, db)).rejects.toMatchObject({ status: 403 });
    await expect(createPlanEvent(w.opsPdd, { skuId: w.sku.A, channelId: null, kind: "price", startDate: "2099-03-01" }, db)).rejects.toMatchObject({ status: 403 });
    launchId = (await createPlanEvent(w.opsPdd, { skuId: w.sku.S, channelId: w.pdd, kind: "launch", startDate: "2099-02-01" }, db)).id;
    await createPlanEvent(w.ops, { skuId: w.sku.A, kind: "price", startDate: "2099-03-01", expectedUpliftPct: -20 }, db);
    // 已结束事件（补货行展开不应出现）
    await createPlanEvent(w.pmc, { skuId: w.sku.S, kind: "other", startDate: "2020-01-01", endDate: "2020-01-31" }, db);
  });

  it("列表：不限用户见全部；受限用户只见范围内渠道 + 不分渠道；openOnly 缺省剔除已结束", async () => {
    const all = await listPlanEvents(w.pmc, { openOnly: false }, db);
    expect(all.total).toBe(4);
    const open = await listPlanEvents(w.pmc, {}, db);
    expect(open.total).toBe(3);
    expect(open.rows.every((r) => r.phase !== "past")).toBe(true);
    const scoped = await listPlanEvents(w.opsPdd, { openOnly: false }, db);
    expect(scoped.rows.map((r) => r.channelId).sort()).toEqual([null, null, w.pdd].sort());
    await expect(listPlanEvents(w.opsPdd, { channelId: w.tmall }, db)).rejects.toMatchObject({ status: 403 });
    const bySku = await listPlanEvents(w.pmc, { skuId: w.sku.A }, db);
    expect(bySku.total).toBe(1);
    expect(bySku.rows[0]).toMatchObject({ kind: "price", kindLabel: "调价", skuCode: "TIER-A", expectedUpliftPct: -20 });
  });

  it("修改：受限用户改不了范围外事件、不能把自己的事件改成不分渠道/范围外；窗口校验；审计 before/after", async () => {
    await expect(updatePlanEvent(w.opsPdd, promoId, { note: "x" }, db)).rejects.toMatchObject({ status: 403 });
    await expect(updatePlanEvent(w.opsPdd, launchId, { channelId: null }, db)).rejects.toMatchObject({ status: 403 });
    await expect(updatePlanEvent(w.opsPdd, launchId, { channelId: w.tmall }, db)).rejects.toMatchObject({ status: 403 });
    await updatePlanEvent(w.opsPdd, launchId, { note: "范围内可改" }, db);
    const [launch] = await db.select().from(opsPlanEvents).where(eq(opsPlanEvents.id, launchId));
    expect(launch).toMatchObject({ channelId: w.pdd, note: "范围内可改" });
    await expect(updatePlanEvent(w.ops, promoId, { endDate: "2098-12-31" }, db)).rejects.toMatchObject({ status: 400 });
    await expect(updatePlanEvent(w.ops, 999999, { note: "x" }, db)).rejects.toMatchObject({ status: 404 });
    await updatePlanEvent(w.ops, promoId, { endDate: "2099-01-31", expectedUpliftPct: 120 }, db);
    const [row] = await db.select().from(opsPlanEvents).where(eq(opsPlanEvents.id, promoId));
    expect(row.endDate).toBe("2099-01-31");
    expect(row.expectedUpliftPct).toBe(120);
    const audits = await db.select().from(auditLogs).where(eq(auditLogs.action, "update"));
    const a = audits.find((x) => x.entity === "ops_plan_event" && x.entityId === promoId);
    expect(a).toBeDefined();
    expect((a!.before as { expectedUpliftPct: number }).expectedUpliftPct).toBe(80);
  });

  it("补货行展开：按 SKU 取未结束事件，受限用户按范围裁剪", async () => {
    const m = await loadOpenPlanEventsBySku(db, [w.sku.S, w.sku.A, w.sku.C]);
    expect(m.get(w.sku.S)?.map((e) => e.kind)).toEqual(["promo", "launch"]); // 2020 的 other 已结束不出现
    expect(m.get(w.sku.A)?.map((e) => planEventTag(e))).toEqual(["调价 3/1起"]);
    expect(m.get(w.sku.C)).toBeUndefined();
    const scoped = await loadOpenPlanEventsBySku(db, [w.sku.S], w.opsPdd);
    expect(scoped.get(w.sku.S)?.map((e) => e.channelId)).toEqual([w.pdd]);
  });

  it("删除：物理删除但审计留 before；范围外 403", async () => {
    await expect(deletePlanEvent(w.opsPdd, promoId, db)).rejects.toMatchObject({ status: 403 });
    await deletePlanEvent(w.pmc, promoId, db);
    const rows = await db.select().from(opsPlanEvents).where(eq(opsPlanEvents.id, promoId));
    expect(rows).toHaveLength(0);
    const audits = await db.select().from(auditLogs).where(eq(auditLogs.action, "delete"));
    const a = audits.find((x) => x.entity === "ops_plan_event" && x.entityId === promoId);
    expect(a).toBeDefined();
    expect((a!.before as { kind: string }).kind).toBe("promo");
  });
});
