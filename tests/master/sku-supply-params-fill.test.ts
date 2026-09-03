import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { auditLogs, skuParams, skus, spus } from "@/db/schema";
import { leadFieldsFor, listSupplyParams, patchSupplyParams } from "@/server/modules/master/sku-supply-params-fill";
import { buildSkuPlanningPolicy } from "@/server/modules/planning/policy";
import { createTestDb, type TestDb } from "../helpers/db";
import { seedTierWorld, type TierWorld } from "../helpers/tier-seed";

/**
 * 周期主数据补录：列表给缺失维度与分层阻塞；PATCH 只允许填空，覆盖非空须 pmc/admin；
 * 同事务 upsert sku_params + 审计（fill / override）。
 */
describe("master/sku-supply-params-fill", () => {
  let db: TestDb;
  let w: TierWorld;

  beforeAll(async () => {
    ({ db } = await createTestDb());
    w = await seedTierWorld(db);
  });

  it("列表：缺失维度按类型适用；未固化时 tier=null；筛选 missing / tier=NONE", async () => {
    const r = await listSupplyParams({}, db);
    expect(r.policyPeriod).toBeNull();
    expect(r.summary.scanned).toBe(5);
    const by = new Map(r.rows.map((x) => [x.skuId, x]));
    expect(by.get(w.sku.S)).toMatchObject({ tier: null, normalLeadDays: 30, logisticsLeadDays: 15, missing: ["moq", "cost"], blocked: false });
    expect(by.get(w.sku.B)?.missing).toEqual(["logistics", "moq", "cost"]);
    expect(by.get(w.sku.A)?.missing).toEqual(["production", "logistics", "moq", "cost"]);
    expect(r.summary.byDimension).toEqual({ production: 3, logistics: 4, purchase: 0, moq: 5, cost: 5 });
    expect((await listSupplyParams({ missing: "logistics" }, db)).total).toBe(4);
    expect((await listSupplyParams({ tier: "NONE" }, db)).total).toBe(5);
    expect((await listSupplyParams({ blockedOnly: true }, db)).total).toBe(0);
  });

  it("固化后：S/A/B 缺周期即阻塞，阻塞行排最前；tier 筛选", async () => {
    await buildSkuPlanningPolicy("2026-09", { db, actor: w.pmc });
    const r = await listSupplyParams({}, db);
    expect(r.policyPeriod).toBe("2026-09");
    expect(r.summary.blocked).toBe(2);
    expect(r.rows.slice(0, 2).map((x) => x.code)).toEqual(["TIER-A", "TIER-B"]);
    expect(r.summary.byTier.S).toEqual({ total: 1, complete: 1, blocked: 0 });
    expect(r.summary.byTier.C).toEqual({ total: 2, complete: 0, blocked: 0 });
    expect((await listSupplyParams({ blockedOnly: true }, db)).rows.map((x) => x.code)).toEqual(["TIER-A", "TIER-B"]);
    expect((await listSupplyParams({ tier: "C" }, db)).total).toBe(2);
  });

  it("PATCH：采购只能填空（fill）；覆盖非空 403；pmc 可覆盖（override）；warehouse 403；审计同事务", async () => {
    await expect(patchSupplyParams(w.warehouse, w.sku.A, { normalLeadDays: 20 }, db)).rejects.toMatchObject({ status: 403 });
    await expect(patchSupplyParams(w.purchasing, w.sku.A, {}, db)).rejects.toThrow();
    await expect(patchSupplyParams(w.purchasing, 999999, { normalLeadDays: 20 }, db)).rejects.toMatchObject({ status: 404 });

    const fill = await patchSupplyParams(w.purchasing, w.sku.A, { normalLeadDays: 20, logisticsLeadDays: 10 }, db);
    expect(fill).toMatchObject({ action: "fill", normalLeadDays: 20, logisticsLeadDays: 10, purchaseLeadDays: null });
    const [row] = await db.select().from(skuParams).where(eq(skuParams.skuId, w.sku.A));
    expect(row).toMatchObject({ normalLeadDays: 20, logisticsLeadDays: 10, updatedBy: w.purchasing.id });

    await expect(patchSupplyParams(w.purchasing, w.sku.A, { normalLeadDays: 25 }, db)).rejects.toMatchObject({ status: 403 });
    // 同值不算覆盖（幂等，不写审计）
    const same = await patchSupplyParams(w.purchasing, w.sku.A, { normalLeadDays: 20 }, db);
    expect(same.action).toBe("fill");

    const ov = await patchSupplyParams(w.pmc, w.sku.A, { normalLeadDays: 25, note: "供应商确认" }, db);
    expect(ov).toMatchObject({ action: "override", normalLeadDays: 25, logisticsLeadDays: 10 });

    const audits = await db.select().from(auditLogs).where(eq(auditLogs.entity, "sku_params"));
    expect(audits.map((a) => a.action)).toEqual(["fill", "override"]);
    expect((audits[1].before as { normalLeadDays: number }).normalLeadDays).toBe(20);
    expect((audits[1].after as { normalLeadDays: number; note: string }).note).toBe("供应商确认");

    // A 补齐后不再阻塞
    const r = await listSupplyParams({ blockedOnly: true }, db);
    expect(r.rows.map((x) => x.code)).toEqual(["TIER-B"]);
  });

  it("周期口径按类型（前后端唯一口径 leadFields）：半成品同成品=加工+在途；采购周期只对原料/包材；写路径拒绝不适用字段", async () => {
    expect(leadFieldsFor("finished")).toEqual(["normalLeadDays", "logisticsLeadDays"]);
    expect(leadFieldsFor("semi")).toEqual(["normalLeadDays", "logisticsLeadDays"]);
    expect(leadFieldsFor("raw")).toEqual(["purchaseLeadDays"]);
    expect(leadFieldsFor("packaging")).toEqual(["purchaseLeadDays"]);
    expect(leadFieldsFor("service")).toEqual([]);

    const [spu] = await db.select().from(spus).limit(1);
    const [semi] = await db.insert(skus).values({ code: "SEMI-1", name: "半成品料体", spuId: spu.id, skuType: "semi", baseUom: "kg", active: true }).returning();
    const [raw] = await db.insert(skus).values({ code: "RAW-1", name: "原料", spuId: spu.id, skuType: "raw", baseUom: "kg", active: true }).returning();

    const s = (await listSupplyParams({ skuType: "semi" }, db)).rows.find((x) => x.skuId === semi.id)!;
    expect(s.leadFields).toEqual(["normalLeadDays", "logisticsLeadDays"]);
    expect(s.missing).toEqual(["production", "logistics", "moq", "cost"]);
    expect(s).toMatchObject({ tier: null, blocked: false }); // 分层只对成品
    const rw = (await listSupplyParams({ skuType: "raw" }, db)).rows.find((x) => x.skuId === raw.id)!;
    expect(rw.leadFields).toEqual(["purchaseLeadDays"]);
    expect(rw.missing).toEqual(["purchase", "moq", "cost"]);
    expect((await listSupplyParams({}, db)).rows.find((x) => x.skuId === w.sku.S)!.leadFields).toEqual(["normalLeadDays", "logisticsLeadDays"]);

    await expect(patchSupplyParams(w.pmc, semi.id, { purchaseLeadDays: 10 }, db)).rejects.toMatchObject({ status: 400 });
    await expect(patchSupplyParams(w.pmc, raw.id, { normalLeadDays: 10 }, db)).rejects.toMatchObject({ status: 400 });
    await expect(patchSupplyParams(w.pmc, w.sku.S, { purchaseLeadDays: 10 }, db)).rejects.toMatchObject({ status: 400 });
    await patchSupplyParams(w.pmc, semi.id, { normalLeadDays: 12, logisticsLeadDays: 3 }, db);
    await patchSupplyParams(w.pmc, raw.id, { purchaseLeadDays: 20 }, db);
    expect((await listSupplyParams({ skuType: "semi" }, db)).rows.find((x) => x.skuId === semi.id)!.missing).toEqual(["moq", "cost"]);
    expect((await listSupplyParams({ skuType: "raw" }, db)).rows.find((x) => x.skuId === raw.id)!.missing).toEqual(["moq", "cost"]);
  });
});
