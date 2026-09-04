/**
 * 批量补录周期（2026-09-04 审计 #1）——167 个补货试点候选的唯一解锁点。
 *
 * 事故形态：只有逐行 `PATCH /api/master/sku/{id}/supply-params`，
 * `api/master/supply-params/route.ts` 是 GET-only。生产库 5,376 个在用 SKU 只有 520 个有周期，
 * 逐行补需要点五千次——这条路事实上不存在，167 个试点候选就一直卡着。
 *
 * 本测试钉住批量写路径与逐行 PATCH 的边界完全一致，并且预演口径可信。
 */
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { auditLogs, brands, skuParams, skus, spus } from "@/db/schema";
import { bulkFillSupplyParams, BULK_MAX_SKUS } from "@/server/modules/master/sku-supply-params-bulk";
import { listSupplyParams } from "@/server/modules/master/sku-supply-params-fill";
import { buildSkuPlanningPolicy } from "@/server/modules/planning/policy";
import { createTestDb, type TestDb } from "../helpers/db";
import { seedTierWorld, type TierWorld } from "../helpers/tier-seed";

describe("master/sku-supply-params-bulk 批量补录", () => {
  let db: TestDb;
  let w: TierWorld;

  beforeEach(async () => {
    ({ db } = await createTestDb());
    w = await seedTierWorld(db);
  });

  it("勾选批量：只填空值，逐 SKU 留审计，不动已有值", async () => {
    // 种子：S 有 30/15；B 有加工 30、缺在途；A / C / NEW 全缺
    const res = await bulkFillSupplyParams(
      w.pmc,
      { scope: { kind: "ids", ids: [w.sku.S, w.sku.A, w.sku.B] }, values: { normalLeadDays: 40, logisticsLeadDays: 12 } },
      db,
    );
    expect(res.dryRun).toBe(false);
    expect(res.matched).toBe(3);
    // S 两个字段都有值 → 不动；A 两个都空 → 填 2；B 加工有值、在途空 → 填 1
    expect(res.filled).toBe(3);
    expect(res.overridden).toBe(0);
    expect(res.changedSkus).toBe(2);
    expect(res.unchangedSkus).toBe(1);

    const rows = await db.select().from(skuParams);
    const byId = new Map(rows.map((r) => [r.skuId, r]));
    expect(byId.get(w.sku.S)).toMatchObject({ normalLeadDays: 30, logisticsLeadDays: 15 }); // 原值保留
    expect(byId.get(w.sku.A)).toMatchObject({ normalLeadDays: 40, logisticsLeadDays: 12 });
    expect(byId.get(w.sku.B)).toMatchObject({ normalLeadDays: 30, logisticsLeadDays: 12 });

    const audits = await db.select().from(auditLogs).where(eq(auditLogs.entity, "sku_params"));
    expect(audits, "逐 SKU 一条审计——否则「谁批量改了这些」查不出来").toHaveLength(2);
    expect(audits.every((a) => a.action === "fill")).toBe(true);
    expect(audits.map((a) => a.entityId).sort()).toEqual([w.sku.A, w.sku.B].sort());
    expect((audits[0].after as { bulk?: boolean }).bulk).toBe(true);
  });

  it("dryRun 只预演不写：预演口径与随后真跑的结果一致", async () => {
    const preview = await bulkFillSupplyParams(
      w.pmc,
      { scope: { kind: "ids", ids: [w.sku.A, w.sku.C] }, values: { normalLeadDays: 25 }, dryRun: true },
      db,
    );
    expect(preview.dryRun).toBe(true);
    expect(preview.changedSkus).toBe(2);
    expect(preview.filled).toBe(2);
    expect(preview.sampleCodes.sort()).toEqual(["TIER-A", "TIER-C"]);
    expect(await db.select().from(skuParams).where(eq(skuParams.skuId, w.sku.C))).toHaveLength(0);

    const real = await bulkFillSupplyParams(
      w.pmc,
      { scope: { kind: "ids", ids: [w.sku.A, w.sku.C] }, values: { normalLeadDays: 25 } },
      db,
    );
    expect({ ...real, dryRun: true }).toEqual(preview);
  });

  it("覆盖须 pmc/admin：采购角色请求覆盖 403；不带 overwrite 时采购可补空", async () => {
    await expect(
      bulkFillSupplyParams(
        w.purchasing,
        { scope: { kind: "ids", ids: [w.sku.S] }, values: { normalLeadDays: 40 }, overwrite: true },
        db,
      ),
    ).rejects.toMatchObject({ status: 403 });

    const ok = await bulkFillSupplyParams(
      w.purchasing,
      { scope: { kind: "ids", ids: [w.sku.A] }, values: { normalLeadDays: 40 } },
      db,
    );
    expect(ok.filled).toBe(1);

    const over = await bulkFillSupplyParams(
      w.pmc,
      { scope: { kind: "ids", ids: [w.sku.S] }, values: { normalLeadDays: 40 }, overwrite: true },
      db,
    );
    expect(over.overridden).toBe(1);
    const audits = await db.select().from(auditLogs).where(eq(auditLogs.action, "override"));
    expect(audits).toHaveLength(1);
  });

  it("仓管等无权角色 403；不存在的 id 整批不改（404）", async () => {
    await expect(
      bulkFillSupplyParams(w.warehouse, { scope: { kind: "ids", ids: [w.sku.A] }, values: { normalLeadDays: 5 } }, db),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      bulkFillSupplyParams(w.pmc, { scope: { kind: "ids", ids: [w.sku.A, 999999] }, values: { normalLeadDays: 5 } }, db),
    ).rejects.toMatchObject({ status: 404 });
    expect(await db.select().from(skuParams).where(eq(skuParams.skuId, w.sku.A))).toHaveLength(0);
  });

  it("类型不适用的字段跳过该 SKU，而不是整批失败（选择天然混着成品与原料）", async () => {
    const [spu] = await db.select().from(spus).where(eq(spus.code, "SPU-TIER"));
    const [raw] = await db
      .insert(skus)
      .values({ code: "RAW-1", name: "原料一号", spuId: spu.id, skuType: "raw", baseUom: "kg", active: true })
      .returning();

    const res = await bulkFillSupplyParams(
      w.pmc,
      { scope: { kind: "ids", ids: [w.sku.A, raw.id] }, values: { normalLeadDays: 20, logisticsLeadDays: 8 } },
      db,
    );
    expect(res.matched).toBe(2);
    expect(res.changedSkus).toBe(1);
    expect(res.notApplicableSkus, "原料没有加工/在途周期，跳过它而不是让整批 400").toBe(1);
    expect(await db.select().from(skuParams).where(eq(skuParams.skuId, raw.id))).toHaveLength(0);

    // 原料要填的是采购周期
    const purchase = await bulkFillSupplyParams(
      w.pmc,
      { scope: { kind: "ids", ids: [raw.id] }, values: { purchaseLeadDays: 9 } },
      db,
    );
    expect(purchase.filled).toBe(1);
    const [row] = await db.select().from(skuParams).where(eq(skuParams.skuId, raw.id));
    expect(row.purchaseLeadDays).toBe(9);
  });

  it("按分层套用默认：作用域与页面清单同一口径，缺省只动「还缺周期」的行", async () => {
    await buildSkuPlanningPolicy("2026-09", { db, actor: w.pmc });
    const blocked = await listSupplyParams({ blockedOnly: true }, db);
    expect(blocked.rows.map((r) => r.code)).toEqual(["TIER-A", "TIER-B"]);

    const preview = await bulkFillSupplyParams(
      w.pmc,
      { scope: { kind: "filter", blockedOnly: true }, values: { normalLeadDays: 30, logisticsLeadDays: 15 }, dryRun: true },
      db,
    );
    expect(preview.matched, "命中数必须与「只看阻塞试点的」清单一致").toBe(2);
    expect(preview.changedSkus).toBe(2);
    expect(preview.filled, "A 缺两个、B 只缺在途").toBe(3);

    await bulkFillSupplyParams(
      w.pmc,
      { scope: { kind: "filter", blockedOnly: true }, values: { normalLeadDays: 30, logisticsLeadDays: 15 } },
      db,
    );
    const after = await listSupplyParams({}, db);
    expect(after.summary.blocked, "补完周期后阻塞清零——这正是 167 个试点候选的解锁点").toBe(0);
    expect((await listSupplyParams({ blockedOnly: true }, db)).total).toBe(0);
  });

  it("按品牌套用默认：只动该品牌的行", async () => {
    const [brand] = await db.insert(brands).values({ code: "BR1", nameCn: "品牌一" }).returning();
    await db.update(skus).set({ brandId: brand.id }).where(eq(skus.id, w.sku.A));

    const res = await bulkFillSupplyParams(
      w.pmc,
      { scope: { kind: "filter", brandId: brand.id }, values: { normalLeadDays: 33 } },
      db,
    );
    expect(res.matched).toBe(1);
    expect(res.changedSkus).toBe(1);
    const [row] = await db.select().from(skuParams).where(eq(skuParams.skuId, w.sku.A));
    expect(row.normalLeadDays).toBe(33);
    // 其它 SKU 未被波及
    expect((await db.select().from(skuParams).where(eq(skuParams.skuId, w.sku.C)))).toHaveLength(0);
  });

  it("入参校验：一个周期字段都不给、id 超过单次上限、空选择都被拒", async () => {
    await expect(bulkFillSupplyParams(w.pmc, { scope: { kind: "ids", ids: [w.sku.A] }, values: {} }, db)).rejects.toThrow();
    await expect(bulkFillSupplyParams(w.pmc, { scope: { kind: "ids", ids: [] }, values: { normalLeadDays: 3 } }, db)).rejects.toThrow();
    const tooMany = Array.from({ length: BULK_MAX_SKUS + 1 }, (_, i) => i + 1);
    await expect(
      bulkFillSupplyParams(w.pmc, { scope: { kind: "ids", ids: tooMany }, values: { normalLeadDays: 3 } }, db),
    ).rejects.toThrow();
    await expect(
      bulkFillSupplyParams(w.pmc, { scope: { kind: "ids", ids: [w.sku.A] }, values: { normalLeadDays: 400 } }, db),
    ).rejects.toThrow();
  });

  it("列表下发运行参数缺省周期，页面「套用默认」不再自写字面量", async () => {
    const list = await listSupplyParams({}, db);
    expect(list.defaults).toEqual({ production: 30, logistics: 15 });
  });
});
