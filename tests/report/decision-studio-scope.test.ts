/**
 * 决策工作室：跨维筛选 + 月份维（0727 会议「新增多维度切片器」）。
 *
 * 旧实现只有一个 dimension + 一个 key，品牌与渠道**互斥单选**——
 * 做不到「NING × 天猫」这类组合，而这正是会议里说的「匹配不同角色的查询需求」。
 *
 * 跨维筛选用 EXISTS 子查询而不是加 join：只过滤、不改变行的纳入口径，
 * 因此"不加筛选"时结果与改动前逐字等价（下面第一条就钉这个）。
 * 注：sales_monthly.channel_id 是 NOT NULL，所以不存在无渠道的销量行；
 * 但 brand 走 skus→brands 的 leftJoin，未分配品牌确实可能为空，EXISTS 用
 * coalesce(bb.code, '(unassigned)') 对齐，与分组维的 key 口径一致。
 */
import { describe, expect, it } from "vitest";
import { brands, channels, salesMonthly, skus, spus } from "@/db/schema";
import { createTestDb } from "../helpers/db";
import { getDecisionStudio } from "@/server/modules/report/decision-studio";

async function setup() {
  const { db } = await createTestDb();
  const [spu] = await db.insert(spus).values({ code: "P22001", nameCn: "切片测试品" }).returning();
  const [ning] = await db.insert(brands).values({ code: "NING", nameCn: "NING" }).returning();
  const [exp] = await db.insert(brands).values({ code: "EXP", nameCn: "EXPRESSIONS" }).returning();
  const [tmall] = await db.insert(channels).values({ code: "TMALL", name: "天猫", kind: "platform" }).returning();
  const [jd] = await db.insert(channels).values({ code: "JD", name: "京东", kind: "platform" }).returning();

  const mkSku = async (code: string, brandId: number) => {
    const [row] = await db.insert(skus).values({
      code, name: `货品${code}`, spuId: spu.id, skuType: "finished", baseUom: "支", brandId,
    }).returning();
    return row;
  };
  const nSku = await mkSku("DS-NING-1", ning.id);
  const eSku = await mkSku("DS-EXP-1", exp.id);
  // 未分配品牌的一行：证明 brand 维的 coalesce 口径与筛选口径一致，不会被误筛掉
  const [noBrandSku] = await db.insert(skus).values({
    code: "DS-NOBRAND-1", name: "未分配品牌货品", spuId: spu.id,
    skuType: "finished", baseUom: "支",
  }).returning();

  const add = async (skuId: number, channelId: number, ym: string, qty: string) => {
    await db.insert(salesMonthly).values({ skuId, channelId, yearMonth: ym, qty });
  };
  await add(nSku.id, tmall.id, "2026-06", "100");
  await add(nSku.id, jd.id, "2026-06", "40");
  await add(eSku.id, tmall.id, "2026-06", "25");
  await add(nSku.id, tmall.id, "2026-07", "60");
  await add(noBrandSku.id, tmall.id, "2026-06", "7");
  return { db };
}

describe("决策工作室：跨维筛选", () => {
  it("不加筛选时全量计入，含未分配品牌的行——EXISTS 只过滤，不改变基数", async () => {
    const { db } = await setup();
    const r = await getDecisionStudio({ dimension: "sku" }, db);
    expect(r.groups.map((g) => g.key).sort()).toContain("DS-NOBRAND-1");
    const total = r.groups.reduce((a, g) => a + g.total, 0);
    expect(total).toBe(232); // 100+40+25+60+7
  });

  it("未分配品牌可用 (unassigned) 精确筛出——与分组维 key 同口径", async () => {
    const { db } = await setup();
    const r = await getDecisionStudio({ dimension: "sku", scope: { brand: "(unassigned)" } }, db);
    expect(r.groups.map((g) => g.key)).toEqual(["DS-NOBRAND-1"]);
    expect(r.groups[0].total).toBe(7);
  });

  it("品牌 × 渠道可以同时收窄——这正是旧实现做不到的「NING × 天猫」", async () => {
    const { db } = await setup();
    const r = await getDecisionStudio(
      { dimension: "sku", scope: { brand: "NING", channel: "TMALL" } }, db,
    );
    const total = r.groups.reduce((a, g) => a + g.total, 0);
    expect(total).toBe(160); // 只剩 NING×天猫：100 + 60
    expect(r.groups.map((g) => g.key)).toEqual(["DS-NING-1"]);
  });

  it("只按品牌收窄时，该品牌跨全部渠道汇总", async () => {
    const { db } = await setup();
    const r = await getDecisionStudio({ dimension: "sku", scope: { brand: "NING" } }, db);
    const total = r.groups.reduce((a, g) => a + g.total, 0);
    expect(total).toBe(200); // 100+40+60（未分配品牌的 7 不属于 NING）
  });

  it("只按渠道收窄时跨品牌汇总", async () => {
    const { db } = await setup();
    const r = await getDecisionStudio({ dimension: "brand", scope: { channel: "TMALL" } }, db);
    const total = r.groups.reduce((a, g) => a + g.total, 0);
    expect(total).toBe(192); // 100+25+60+7（天猫下全部品牌，含未分配）
  });

  it("新增月份维：配合 scope 就是「NING × 天猫的月度走势」", async () => {
    const { db } = await setup();
    const r = await getDecisionStudio(
      { dimension: "month", scope: { brand: "NING", channel: "TMALL" } }, db,
    );
    const byMonth = Object.fromEntries(r.groups.map((g) => [g.key, g.total]));
    expect(byMonth["2026-06"]).toBe(100);
    expect(byMonth["2026-07"]).toBe(60);
  });

  it("筛不到任何数据时返回空而不是全量", async () => {
    const { db } = await setup();
    const r = await getDecisionStudio({ dimension: "sku", scope: { brand: "NOPE" } }, db);
    expect(r.groups).toEqual([]);
  });
});
