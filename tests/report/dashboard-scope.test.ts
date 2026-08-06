/**
 * 经营驾驶舱跨维筛选（0727「多维度切片器」的驾驶舱这一半）。
 *
 * 口径是刻意的、也必须被如实呈现：**只有销售类聚合跟随筛选**
 * （销量趋势/渠道结构/品牌销量/Top SKU/上月销量）。
 * 库存、临期、待审批、复核积压不跟随——它们不是按品牌或渠道记账的事实，
 * 强行按销售维度切会得到似是而非的数字。
 *
 * 因此返回体必须带 `scope.notAppliedTo`：页面要能明确标注"这些卡片没跟着筛"。
 * 只筛一半却不说明，比不筛更糟——同一页会自相矛盾。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { brands, channels, salesMonthly, skus, spus } from "@/db/schema";
import { createTestDb } from "../helpers/db";
import { getDashboard } from "@/server/modules/report/dashboard";

async function setup() {
  const { db } = await createTestDb();
  const [spu] = await db.insert(spus).values({ code: "P11001", nameCn: "驾驶舱测试品" }).returning();
  const [ning] = await db.insert(brands).values({ code: "NING", nameCn: "NING" }).returning();
  const [exp] = await db.insert(brands).values({ code: "EXP", nameCn: "EXPRESSIONS" }).returning();
  const [tmall] = await db.insert(channels).values({ code: "TMALL", name: "天猫", kind: "platform" }).returning();
  const [jd] = await db.insert(channels).values({ code: "JD", name: "京东", kind: "platform" }).returning();

  const mk = async (code: string, brandId: number) => {
    const [row] = await db.insert(skus).values({
      code, name: `货品${code}`, spuId: spu.id, skuType: "finished", baseUom: "支", brandId,
    }).returning();
    return row;
  };
  const n = await mk("DB-NING-1", ning.id);
  const e = await mk("DB-EXP-1", exp.id);
  const ym = "2026-06";
  await db.insert(salesMonthly).values([
    { skuId: n.id, channelId: tmall.id, yearMonth: ym, qty: "100" },
    { skuId: n.id, channelId: jd.id, yearMonth: ym, qty: "40" },
    { skuId: e.id, channelId: tmall.id, yearMonth: ym, qty: "25" },
  ]);
  return { db };
}

describe("驾驶舱跨维筛选", () => {
  it("不加筛选时销量为全量——EXISTS 只过滤，不改变基数", async () => {
    const { db } = await setup();
    const d = await getDashboard(["admin"], {}, db);
    expect(d.kpi.salesLastMonth).toBe(165); // 100+40+25
    expect(d.scope.brand).toBeNull();
    expect(d.scope.channel).toBeNull();
  });

  it("按品牌筛：销售类聚合跟随", async () => {
    const { db } = await setup();
    const d = await getDashboard(["admin"], { brand: "NING" }, db);
    expect(d.kpi.salesLastMonth).toBe(140); // 100+40
    expect(d.brandSales.map((b) => b.name)).toEqual(["NING"]);
    expect(d.topSkus.map((s) => s.code)).toEqual(["DB-NING-1"]);
  });

  it("品牌 × 渠道可同时收窄", async () => {
    const { db } = await setup();
    const d = await getDashboard(["admin"], { brand: "NING", channel: "TMALL" }, db);
    expect(d.kpi.salesLastMonth).toBe(100);
    expect(d.channelMix.map((c) => c.name)).toEqual(["天猫"]);
  });

  it("返回体必须交代哪些卡片没跟着筛——只筛一半却不说明比不筛更糟", async () => {
    const { db } = await setup();
    const d = await getDashboard(["admin"], { brand: "NING" }, db);
    expect(d.scope.brand).toBe("NING");
    expect(d.scope.appliesTo).toContain("销量趋势");
    expect(d.scope.notAppliedTo).toContain("库存总量");
    expect(d.scope.notAppliedTo).toContain("待审批");
  });

  it("筛不到数据时销售类归零，而不是回落成全量", async () => {
    const { db } = await setup();
    const d = await getDashboard(["admin"], { brand: "NOPE" }, db);
    expect(d.kpi.salesLastMonth).toBe(0);
    expect(d.brandSales).toEqual([]);
    expect(d.topSkus).toEqual([]);
  });
});

describe("驾驶舱缓存键", () => {
  it("缓存键必须含筛选——否则带筛选的结果会污染无筛选的缓存", () => {
    // 单测注入 dbArg 时缓存被旁路，跑不到这条路径，故在源码层面钉住
    const src = readFileSync("src/server/modules/report/dashboard.ts", "utf8");
    const keyBlock = src.slice(src.indexOf("const key = ["), src.indexOf("].join(\"|\")") + 12);
    expect(keyBlock).toContain("scope.brand");
    expect(keyBlock).toContain("scope.channel");
  });
});
