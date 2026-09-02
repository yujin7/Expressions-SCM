/**
 * 天猫平台 SKU 身份缺口 + 直接认领桥。
 *
 * 生产实测（2026-09-02）：2,076 个平台 SKU 里 1,217 个根本不在对照表，按金额占 44%，
 * 而所有外部需求分析都建立在"已映射"之上。这里钉三件事：
 *   1. 缺口按支付金额倒序，状态分类正确（不在对照表 / 对照表无编码 / 条码待认领 / 已映射）；
 *   2. 候选只按规格 + 名称词元 + 品牌打分，只建议不落库；
 *   3. 认领落库后，缺口读模型与外部需求信号都把它当作已映射——这是"第二条桥"存在的意义。
 */
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { createTestDb } from "../helpers/db";
import {
  brandCodeForShop,
  computePlatformSkuIdentityGap,
  extractSpecToken,
  scoreCandidates,
} from "@/server/modules/report/platform-sku-identity-gap";
import { claimPlatformSku, claimPlatformSkusBulk } from "@/server/modules/master/platform-sku-claim";
import { refreshJiandaoyunExternalDemandReadModel } from "@/server/modules/report/external-demand-signal";

describe("规格与候选打分（纯函数）", () => {
  it("从平台 SKU 名里提取规格并规范化", () => {
    expect(extractSpecToken("净含量:220g", null)).toBe("220g");
    expect(extractSpecToken("净含量:30片", null)).toBe("30片");
    expect(extractSpecToken(":", "NING 咖啡因眼霜 60ML")).toBe("60ml");
    expect(extractSpecToken(":", "没有规格")).toBeNull();
  });

  it("店铺名含唯一品牌名才推断品牌，含糊时不收窄", () => {
    const brands = [
      { code: "NING", nameCn: "NING", nameEn: "NING" },
      { code: "EXP", nameCn: "EXPRESSIONS", nameEn: "EXPRESSIONS" },
      { code: "ABS", nameCn: "爱碧生", nameEn: null },
    ];
    expect(brandCodeForShop("(天猫国际)NING海外旗舰店", brands)).toBe("NING");
    // 一家店同时挂两个品牌名 → 不猜
    expect(brandCodeForShop("(天猫国际)Expressions爱碧生海外旗舰店", brands)).toBeNull();
  });

  it("规格一致 + 名称词元重合的成品排第一；规格不同被扣分；跨品牌不给候选", () => {
    const skus = [
      { skuId: 1, code: "N062-000", name: "(NING DERMOLOGIE)控油净颜面膜(100g)", brandCode: "NING", spec: "100g" },
      { skuId: 2, code: "N009-001", name: "(NING DERMOLOGIE)冰川净澈清洁泥膜(110g)升级版①", brandCode: "NING", spec: "110g" },
      { skuId: 3, code: "N009-000", name: "(NING DERMOLOGIE)冰川净澈清洁泥膜(220g)", brandCode: "NING", spec: "220g" },
      { skuId: 4, code: "E047-000", name: "(EXPRESSIONS)控油净肤清洁泥膜(220g)", brandCode: "EXP", spec: "220g" },
    ];
    const out = scoreCandidates({
      productName: "NING清洁泥膜去黑头粉刺闭口收缩毛孔深层补水涂抹式面膜",
      skuName: "净含量:220g", brandCode: "NING", specToken: "220g",
    }, skus);
    expect(out[0]?.code).toBe("N009-000");
    expect(out[0]?.reasons.join(" ")).toContain("规格一致");
    expect(out.map((c) => c.code)).not.toContain("E047-000");
    const second = out.find((c) => c.code === "N009-001");
    if (second) expect(second.score).toBeLessThan(out[0]!.score);
  });
});

describe("平台 SKU 认领输入边界", () => {
  it("拒绝会破坏店铺+平台 SKU 复合键的分隔符", async () => {
    const { platformSkuClaimSchema } = await import("@/server/modules/master/platform-sku-claim");
    expect(() => platformSkuClaimSchema.parse({ shopName: "店铺|A", platformSkuId: "P1", skuId: 1 })).toThrow(/分隔符/);
  });
});

async function seed() {
  const { db, client } = await createTestDb();
  const [actor] = await db.insert(schema.users).values({ name: "外部数据责任人", roles: ["pmc"] }).returning();
  const [ning] = await db.insert(schema.brands).values({ code: "NING", nameCn: "NING", nameEn: "NING" }).returning();
  const [spu] = await db.insert(schema.spus).values({ code: "P90001", nameCn: "泥膜" }).returning();
  const [mudMask] = await db.insert(schema.skus).values({
    code: "N009-000", name: "(NING DERMOLOGIE)冰川净澈清洁泥膜(220g)", spuId: spu.id, skuType: "finished", baseUom: "支", brandId: ning.id, spec: "220g",
  }).returning();
  const [mapped] = await db.insert(schema.skus).values({
    code: "N062-000", name: "(NING DERMOLOGIE)控油净颜面膜(100g)", spuId: spu.id, skuType: "finished", baseUom: "支", brandId: ning.id, spec: "100g",
  }).returning();
  const jobs = await db.insert(schema.importJobs).values([
    { template: "jdy_tmall_sku_crosswalk_observation", filename: "crosswalk", sourceAsOf: "2026-08-10", createdBy: actor.id, status: "done" },
    { template: "jdy_tmall_sku_sales_observation", filename: "sales", sourceAsOf: "2026-08-11", createdBy: actor.id, status: "done" },
    { template: "jdy_tmall_sku_refund_observation", filename: "refunds", sourceAsOf: "2026-08-11", createdBy: actor.id, status: "done" },
  ]).returning();
  const [crosswalk, sales, refunds] = jobs;
  const finishedAt = new Date("2026-08-11T03:00:00.000Z");
  await db.insert(schema.integrationRuns).values([
    { connector: "jdy", stream: "tmall-sku-crosswalk-observation", idempotencyKey: "cw", status: "succeeded", importJobId: crosswalk.id, finishedAt },
    { connector: "jdy", stream: "tmall-sku-sales-observation", idempotencyKey: "sales", status: "succeeded", importJobId: sales.id, finishedAt },
    { connector: "jdy", stream: "tmall-sku-refund-observation", idempotencyKey: "refunds", status: "succeeded", importJobId: refunds.id, finishedAt },
  ]);
  const shop = "(天猫国际)NING海外旗舰店";
  await db.insert(schema.stagingRows).values([
    // P1：对照表里有明确身份 → 已映射
    { importJobId: crosswalk.id, rowNo: 1, status: "pending", targetTable: "jdy_tmall_sku_crosswalk_observation",
      payload: { data: { shopName: shop, platformSkuId: "P1", merchantSkuCode: "N062-000" }, _identity: { skuId: mapped.id } } },
    // P2：对照表里只有条码、没解析 → 对照表无编码
    { importJobId: crosswalk.id, rowNo: 2, status: "pending", targetTable: "jdy_tmall_sku_crosswalk_observation",
      payload: { data: { shopName: shop, platformSkuId: "P2", barcode: "6900000000002" }, _identity: {} } },
    // P4：商家编码与系统编码逐字相等但同步未认领（治理：外部码不自动认领）→ 精确命中候选
    { importJobId: crosswalk.id, rowNo: 3, status: "pending", targetTable: "jdy_tmall_sku_crosswalk_observation",
      payload: { data: { shopName: shop, platformSkuId: "P4", merchantSkuCode: "N009-000" }, _identity: {} } },
    // 销量：P3 是最大的缺口且不在对照表；P1 已映射；P2 无编码
    { importJobId: sales.id, rowNo: 1, status: "pending", targetTable: "jdy_tmall_sku_sales_observation",
      payload: { data: { statisticalDate: "2026-08-10T00:00:00.000Z", shopName: shop, skuId: "P3", productName: "NING清洁泥膜去黑头深层清洁涂抹式面膜", skuName: "净含量:220g", paidNumber: "10", paidAmount: "5000.50" } } },
    { importJobId: sales.id, rowNo: 2, status: "pending", targetTable: "jdy_tmall_sku_sales_observation",
      payload: { data: { statisticalDate: "2026-08-11", shopName: shop, skuId: "P3", productName: "NING清洁泥膜去黑头深层清洁涂抹式面膜", skuName: "净含量:220g", paidNumber: "4", paidAmount: "2000" } } },
    { importJobId: sales.id, rowNo: 3, status: "pending", targetTable: "jdy_tmall_sku_sales_observation",
      payload: { data: { statisticalDate: "2026-08-10", shopName: shop, skuId: "P1", productName: "NING控油面膜", skuName: "净含量:100g", paidNumber: "20", paidAmount: "3000" } } },
    { importJobId: sales.id, rowNo: 4, status: "pending", targetTable: "jdy_tmall_sku_sales_observation",
      payload: { data: { statisticalDate: "2026-08-10", shopName: shop, skuId: "P2", productName: "NING眼霜", skuName: "净含量:15g", paidNumber: "1", paidAmount: "199" } } },
    { importJobId: sales.id, rowNo: 5, status: "pending", targetTable: "jdy_tmall_sku_sales_observation",
      payload: { data: { statisticalDate: "2026-08-10", shopName: shop, skuId: "P4", productName: "NING泥膜", skuName: "净含量:220g", paidNumber: "2", paidAmount: "300" } } },
    { importJobId: refunds.id, rowNo: 1, status: "pending", targetTable: "jdy_tmall_sku_refund_observation",
      payload: { data: { statisticalDate: "2026-08-11", shopName: shop, skuId: "P3", successRefundSuborderNumber: "1" } } },
  ]);
  return { db, client, actor, mudMask, mapped, shop };
}

describe("平台 SKU 身份缺口读模型", () => {
  it("按支付金额倒序、状态分类正确、只给缺口算候选", async () => {
    const { db, client, mudMask } = await seed();
    try {
      const gap = await computePlatformSkuIdentityGap(db);
      expect(gap.state).toBe("ready");
      expect(gap.totals.platformSkus).toBe(4);
      expect(gap.totals.mappedSkus).toBe(1);
      expect(gap.totals.paidAmount).toBe("10499.50");
      expect(gap.totals.mappedPaidAmount).toBe("3000.00");
      expect(gap.totals.unmappedPaidAmount).toBe("7499.50");
      expect(gap.totals.mappedAmountPct).toBe(28.6);
      expect(gap.totals.byStatus.not_in_crosswalk.skus).toBe(1);
      expect(gap.totals.byStatus.crosswalk_without_code.skus).toBe(2);

      // top 只含缺口，P3（¥7000.5）排第一
      expect(gap.top.map((r) => r.platformSkuId)).toEqual(["P3", "P4", "P2"]);
      const p3 = gap.top[0]!;
      expect(p3.status).toBe("not_in_crosswalk");
      expect(p3.paidAmount).toBe("7000.50");
      expect(p3.paidQty).toBe(14);
      expect(p3.refundQty).toBe(1);
      expect(p3.lastSoldDate).toBe("2026-08-11");
      expect(p3.activeDays).toBe(2);
      expect(p3.specToken).toBe("220g");
      expect(p3.brandCode).toBe("NING");
      // 候选：规格 220g + "清洁泥膜" 词元 → 冰川净澈清洁泥膜(220g)
      expect(p3.candidates[0]?.skuId).toBe(mudMask.id);
      expect(gap.totals.unmappedWithCandidates).toBeGreaterThanOrEqual(1);
      expect(gap.totals.coverableAmountPct).toBeGreaterThan(gap.totals.mappedAmountPct!);
      // P4：精确命中 → 候选分 100，并进入 exactHits 供批量认领
      expect(gap.top[1]!.platformSkuId).toBe("P4");
      expect(gap.top[1]!.candidates[0]).toMatchObject({ skuId: mudMask.id, score: 100 });
      expect(gap.exactHits).toEqual([{ shopName: gap.top[1]!.shopName, platformSkuId: "P4", skuId: mudMask.id, skuCode: "N009-000", paidAmount: "300.00", source: "crosswalk" }]);
      expect(gap.exactHitAmountPct).toBe(2.9);
      expect(gap.top[2]!.status).toBe("crosswalk_without_code");
      expect(gap.top[2]!.barcode).toBe("6900000000002");
    } finally {
      await client.close();
    }
  });

  it("认领后：缺口读模型转为已认领，外部需求信号也把它算进已映射", async () => {
    const { db, client, actor, mudMask, shop } = await seed();
    try {
      const before = await refreshJiandaoyunExternalDemandReadModel(db);
      expect(before.coverage.mappedIdentities).toBe(1);

      const result = await claimPlatformSku(
        { id: actor.id, name: actor.name, roles: ["pmc"], isApprover: false },
        { shopName: shop, platformSkuId: "P3", skuId: mudMask.id },
        db,
      );
      expect(result.created).toBe(true);
      expect(result.scope).toBe("JIANDAOYUN:TMALL");
      expect(result.value).toBe(`${shop}|P3`);

      // 幂等：再认领同一目标不报错、不重复
      const again = await claimPlatformSku(
        { id: actor.id, name: actor.name, roles: ["pmc"], isApprover: false },
        { shopName: shop, platformSkuId: "P3", skuId: mudMask.id },
        db,
      );
      expect(again.created).toBe(false);

      const gap = await computePlatformSkuIdentityGap(db);
      expect(gap.totals.byStatus.direct_claimed.skus).toBe(1);
      expect(gap.totals.mappedPaidAmount).toBe("10000.50");
      expect(gap.top.map((r) => r.platformSkuId)).toEqual(["P4", "P2"]);

      const after = await refreshJiandaoyunExternalDemandReadModel(db);
      expect(after.coverage.mappedIdentities).toBe(2);
      // 净需求 = 支付 14 − 退款 1 = 13 归到 mudMask
      expect(after.totals.mappedNetQty).toBe(before.totals.mappedNetQty + 13);

      // 审计已写
      const audits = await db.select().from(schema.auditLogs);
      expect(audits.some((a) => a.entity === "sku_identifier" && a.action === "create_from_alias_claim")).toBe(true);
    } finally {
      await client.close();
    }
  });

  it("同一平台 SKU 已属于别的系统 SKU 时拒绝抢占", async () => {
    const { db, client, actor, mudMask, mapped, shop } = await seed();
    try {
      const user = { id: actor.id, name: actor.name, roles: ["pmc"], isApprover: false };
      await claimPlatformSku(user, { shopName: shop, platformSkuId: "P3", skuId: mudMask.id }, db);
      await expect(
        claimPlatformSku(user, { shopName: shop, platformSkuId: "P3", skuId: mapped.id }, db),
      ).rejects.toThrow(/已关联/);
    } finally {
      await client.close();
    }
  });

  it("只允许认领到启用成品，并拒绝与最新唯一对照归属矛盾", async () => {
    const { db, client, actor, mudMask, mapped, shop } = await seed();
    try {
      const user = { id: actor.id, name: actor.name, roles: ["pmc"], isApprover: false };
      const [material] = await db.insert(schema.skus).values({
        code: "RM-CLAIM-1", name: "原料", spuId: mudMask.spuId, skuType: "raw", baseUom: "kg",
      }).returning();
      const [inactive] = await db.insert(schema.skus).values({
        code: "FG-INACTIVE-1", name: "停用成品", spuId: mudMask.spuId, skuType: "finished", baseUom: "支", active: false,
      }).returning();

      await expect(claimPlatformSku(user, { shopName: shop, platformSkuId: "P3", skuId: material.id }, db))
        .rejects.toThrow(/启用中的成品/);
      await expect(claimPlatformSku(user, { shopName: shop, platformSkuId: "P3", skuId: inactive.id }, db))
        .rejects.toThrow(/启用中的成品/);
      await expect(claimPlatformSku(user, { shopName: shop, platformSkuId: "P1", skuId: mudMask.id }, db))
        .rejects.toThrow(/相互矛盾/);
      await expect(claimPlatformSku(user, { shopName: shop, platformSkuId: "P1", skuId: mapped.id }, db))
        .resolves.toMatchObject({ created: true });
    } finally {
      await client.close();
    }
  });

  it("对照表多归属冲突不会被直接认领掩盖，也不给候选", async () => {
    const { db, client, actor, mudMask, mapped, shop } = await seed();
    try {
      const [crosswalkJob] = await db.select().from(schema.importJobs)
        .where(eq(schema.importJobs.template, "jdy_tmall_sku_crosswalk_observation"));
      const [salesJob] = await db.select().from(schema.importJobs)
        .where(eq(schema.importJobs.template, "jdy_tmall_sku_sales_observation"));
      await db.insert(schema.stagingRows).values([
        { importJobId: crosswalkJob!.id, rowNo: 50, status: "pending", targetTable: "jdy_tmall_sku_crosswalk_observation",
          payload: { data: { shopName: shop, platformSkuId: "P5", merchantSkuCode: "N009-000" }, _identity: { skuId: mudMask.id } } },
        { importJobId: crosswalkJob!.id, rowNo: 51, status: "pending", targetTable: "jdy_tmall_sku_crosswalk_observation",
          payload: { data: { shopName: shop, platformSkuId: "P5", merchantSkuCode: "N009-000" }, _identity: { skuId: mapped.id } } },
        { importJobId: salesJob!.id, rowNo: 50, status: "pending", targetTable: "jdy_tmall_sku_sales_observation",
          payload: { data: { statisticalDate: "2026-08-11", shopName: shop, skuId: "P5", productName: "NING清洁泥膜", skuName: "净含量:220g", paidNumber: "2", paidAmount: "800" } } },
      ]);
      await db.insert(schema.skuIdentifiers).values({
        skuId: mudMask.id, kind: "external", scope: "JIANDAOYUN:TMALL", value: `${shop}|P5`, createdBy: actor.id,
      });

      const gap = await computePlatformSkuIdentityGap(db);
      const conflict = gap.top.find((row) => row.platformSkuId === "P5");
      expect(conflict).toMatchObject({ status: "crosswalk_conflict", skuId: null, candidates: [] });
      expect(gap.totals.byStatus.crosswalk_conflict.skus).toBe(1);
      await expect(claimPlatformSku(
        { id: actor.id, name: actor.name, roles: ["pmc"], isApprover: false },
        { shopName: shop, platformSkuId: "P5", skuId: mudMask.id }, db,
      )).rejects.toThrow(/多个系统 SKU/);
    } finally {
      await client.close();
    }
  });

  it("候选数量与可覆盖金额按全部缺口计算，不截断在前 200 行", async () => {
    const { db, client } = await createTestDb();
    try {
      const [actor] = await db.insert(schema.users).values({ name: "候选口径测试" }).returning();
      const [brand] = await db.insert(schema.brands).values({ code: "NING", nameCn: "NING" }).returning();
      const [spu] = await db.insert(schema.spus).values({ code: "P91000", nameCn: "泥膜" }).returning();
      await db.insert(schema.skus).values({
        code: "N910-000", name: "NING冰川净澈清洁泥膜(220g)", spuId: spu.id,
        skuType: "finished", baseUom: "支", brandId: brand.id, spec: "220g",
      });
      const jobs = await db.insert(schema.importJobs).values([
        { template: "jdy_tmall_sku_crosswalk_observation", filename: "empty-crosswalk", sourceAsOf: "2026-08-11", createdBy: actor.id, status: "done" },
        { template: "jdy_tmall_sku_sales_observation", filename: "205-sales", sourceAsOf: "2026-08-11", createdBy: actor.id, status: "done" },
      ]).returning();
      await db.insert(schema.integrationRuns).values([
        { connector: "jdy", stream: "tmall-sku-crosswalk-observation", idempotencyKey: "empty-cw", status: "succeeded", importJobId: jobs[0]!.id, finishedAt: new Date() },
        { connector: "jdy", stream: "tmall-sku-sales-observation", idempotencyKey: "205-sales", status: "succeeded", importJobId: jobs[1]!.id, finishedAt: new Date() },
      ]);
      await db.insert(schema.stagingRows).values(Array.from({ length: 205 }, (_, index) => ({
        importJobId: jobs[1]!.id,
        rowNo: index + 1,
        status: "pending" as const,
        targetTable: "jdy_tmall_sku_sales_observation",
        payload: { data: { statisticalDate: "2026-08-11", shopName: "NING旗舰店", skuId: `PX${index}`, productName: "NING冰川净澈清洁泥膜", skuName: "净含量:220g", paidNumber: "1", paidAmount: "1" } },
      })));

      const gap = await computePlatformSkuIdentityGap(db);
      expect(gap.top).toHaveLength(60);
      expect(gap.totals.unmappedWithCandidates).toBe(205);
      expect(gap.totals.coverableAmountPct).toBe(100);
    } finally {
      await client.close();
    }
  });

  it("批量认领精确命中：逐行独立、冲突只记到该行、读模型随后刷新", async () => {
    const { db, client, actor, mudMask, mapped, shop } = await seed();
    try {
      const user = { id: actor.id, name: actor.name, roles: ["pmc"], isApprover: false };
      // 先把 P4 认领到别的 SKU，制造一条冲突
      await claimPlatformSku(user, { shopName: shop, platformSkuId: "P4", skuId: mapped.id }, db);
      const r = await claimPlatformSkusBulk(user, { items: [
        { shopName: shop, platformSkuId: "P3", skuId: mudMask.id },
        { shopName: shop, platformSkuId: "P4", skuId: mudMask.id }, // 冲突：已属于 mapped
        { shopName: shop, platformSkuId: "P3", skuId: mudMask.id }, // 重复：幂等
      ] }, db);
      expect(r.total).toBe(3);
      expect(r.claimed).toBe(1);
      expect(r.alreadyClaimed).toBe(1);
      expect(r.failed).toBe(1);
      expect(r.results[1]!.error).toMatch(/已关联/);
      const gap = await computePlatformSkuIdentityGap(db);
      expect(gap.totals.byStatus.direct_claimed.skus).toBe(2);
      expect(gap.exactHits).toEqual([]);
    } finally {
      await client.close();
    }
  });

  it("天猫单品汇总的子货品编码 = 系统编码：作为第三条确定性线索进入 exactHits（source=unit_daily）", async () => {
    const { db, client, actor, mudMask, shop } = await seed();
    try {
      const [unitJob] = await db.insert(schema.importJobs).values([
        { template: "jdy_tmall_unit_daily_observation", filename: "unit", sourceAsOf: "2026-01-10", createdBy: actor.id, status: "done" },
      ]).returning();
      await db.insert(schema.integrationRuns).values([
        { connector: "jdy", stream: "tmall-unit-daily-observation", idempotencyKey: "unit", status: "succeeded", importJobId: unitJob.id, finishedAt: new Date("2026-01-10T03:00:00.000Z") },
      ]);
      await db.insert(schema.stagingRows).values([
        // P3 不在对照表，但单品汇总里 P3 的子货品编码就是 N009-000
        { importJobId: unitJob.id, rowNo: 1, status: "pending", targetTable: "jdy_tmall_unit_daily_observation",
          payload: { data: { statisticalDate: "2026-01-05", shopName: shop, platformSkuId: "P3", unitCode: "N009-000", paidNumber: "1" } } },
        { importJobId: unitJob.id, rowNo: 2, status: "pending", targetTable: "jdy_tmall_unit_daily_observation",
          payload: { data: { statisticalDate: "2026-01-06", shopName: shop, platformSkuId: "P3", unitCode: "N009-000", paidNumber: "2" } } },
      ]);
      const gap = await computePlatformSkuIdentityGap(db);
      const p3 = gap.top.find((r) => r.platformSkuId === "P3")!;
      expect(p3.status).toBe("not_in_crosswalk");
      expect(p3.candidates[0]).toMatchObject({ skuId: mudMask.id, score: 100 });
      expect(gap.exactHits.map((h) => [h.platformSkuId, h.source]).sort()).toEqual([["P3", "unit_daily"], ["P4", "crosswalk"]]);
    } finally {
      await client.close();
    }
  });

  it("拼多多：对照表商家编码精确命中进入 pddExactHits，按 platform=pdd 认领后从队列消失", async () => {
    const { db, client, actor, mudMask } = await seed();
    try {
      const [pddCw] = await db.insert(schema.importJobs).values([
        { template: "jdy_pdd_sku_crosswalk_observation", filename: "pdd-cw", sourceAsOf: "2026-09-01", createdBy: actor.id, status: "done" },
      ]).returning();
      await db.insert(schema.integrationRuns).values([
        { connector: "jdy", stream: "pdd-sku-crosswalk-observation", idempotencyKey: "pdd-cw", status: "succeeded", importJobId: pddCw.id, finishedAt: new Date("2026-09-01T03:00:00.000Z") },
      ]);
      const shop = "(拼多多国际)NING官方海外旗舰店";
      await db.insert(schema.stagingRows).values([
        { importJobId: pddCw.id, rowNo: 1, status: "pending", targetTable: "jdy_pdd_sku_crosswalk_observation",
          payload: { data: { shopName: shop, platformSkuId: "PS1", platformProductId: "PID1", merchantSkuCode: "N009-000", productName: "泥膜" }, _identity: {} } },
        { importJobId: pddCw.id, rowNo: 2, status: "pending", targetTable: "jdy_pdd_sku_crosswalk_observation",
          payload: { data: { shopName: shop, platformSkuId: "PS2", platformProductId: "PID2", merchantSkuCode: "SW1557", productName: "别的命名空间" }, _identity: {} } },
      ]);
      let gap = await computePlatformSkuIdentityGap(db);
      expect(gap.pddSummary).toEqual({ crosswalkRows: 2, merchantCodes: 2, exactCodes: 1, claimed: 0 });
      expect(gap.pddExactHits).toEqual([{ shopName: shop, platformSkuId: "PID1|N009-000", skuId: mudMask.id, skuCode: "N009-000", productName: "泥膜" }]);

      const user = { id: actor.id, name: actor.name, roles: ["pmc"], isApprover: false };
      const r = await claimPlatformSkusBulk(user, { items: gap.pddExactHits.map((h) => ({ shopName: h.shopName, platformSkuId: h.platformSkuId, skuId: h.skuId, platform: "pdd" })) }, db);
      expect(r.claimed).toBe(1);
      const [ident] = await db.select().from(schema.skuIdentifiers).where(eq(schema.skuIdentifiers.scope, "JIANDAOYUN:PDD"));
      expect(ident?.value).toBe(`${shop}|PID1|N009-000`);
      gap = await computePlatformSkuIdentityGap(db);
      expect(gap.pddExactHits).toEqual([]);
      expect(gap.pddSummary.claimed).toBe(1);
    } finally {
      await client.close();
    }
  });
});
