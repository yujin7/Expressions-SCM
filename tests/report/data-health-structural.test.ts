import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { bomLines, boms, skus, spus, users } from "@/db/schema";
import { getDataHealth } from "@/server/modules/report/data-health";
import { createTestDb, type TestDb } from "../helpers/db";

/**
 * 多层 BOM 本身是合法结构，不应再被误报。真正危险的是循环或异常深度：
 * 它们没有有限的末级需求，必须显式告警并由需求展开整根阻断。
 */
describe("主数据健康度：多层 BOM 结构性告警", () => {
  let db: TestDb;
  let finished = 0; // 成品：有生效 BOM
  let semi = 0; // 半成品：既是成品的子件，自身又有生效 BOM ← 嵌套点
  let raw = 0; // 原料：只作子件，自身无 BOM

  // skuType 必须收敛到枚举字面量联合——写成 string 会过不了 drizzle 的 insert 重载
  async function mkSku(
    code: string,
    name: string,
    skuType: "finished" | "semi" | "raw" | "packaging" | "service",
  ): Promise<number> {
    const [spu] = await db.insert(spus).values({ code: `SPU-${code}`, nameCn: name }).returning();
    const [s] = await db
      .insert(skus)
      .values({ spuId: spu.id, code, name, skuType, baseUom: "个", active: true })
      .returning();
    return s.id;
  }

  /** 建一张生效 BOM：productSkuId 由 materials 组成 */
  async function mkBom(productSkuId: number, materials: number[], userId: number): Promise<void> {
    const [b] = await db
      .insert(boms)
      .values({
        productSkuId,
        versionNo: "V1",
        status: "active",
        effectiveDate: "2026-01-01",
        createdBy: userId,
      })
      .returning();
    for (const m of materials) {
      await db.insert(bomLines).values({
        bomId: b.id,
        materialSkuId: m,
        qtyPer: "1",
        lossRatePct: "0",
        incomingLossPct: "0",
        productionLossPct: "0",
      });
    }
  }

  beforeAll(async () => {
    ({ db } = await createTestDb());
    await db
      .insert(users)
      .values({ username: "t_struct", name: "测试", passwordHash: "x", active: true })
      .returning();
    finished = await mkSku("FG-001", "成品甲", "finished");
    semi = await mkSku("SF-001", "半成品乙", "semi");
    raw = await mkSku("RM-001", "原料丙", "raw");
  });

  it("普通单层 BOM 不产生循环或深度告警", async () => {
    await mkBom(finished, [raw], 1);
    const r = await getDataHealth({ page: 1, pageSize: 50 }, db);
    expect(r.summary.totalSkus).toBe(1); // 原料/半成品的零售条码/品牌不适用，不污染成品健康率
    expect(r.structural.find((x) => x.key === "bom_cycle")).toBeUndefined();
    expect(r.structural.find((x) => x.key === "bom_depth")).toBeUndefined();
  });

  it("成品缺保质期时报「无法评估」，而不是沉默通过（不许把「没法查」当「没问题」）", async () => {
    // finished 成品建档时未设 shelfLifeDays —— 现实中 1026/1026 都是这个状态
    const r = await getDataHealth({ page: 1, pageSize: 50 }, db);
    const w = r.structural.find((x) => x.key === "shelf_life_missing");
    expect(w, "缺保质期必须显式报出，否则渠道临期口径的缺口会被静默掩盖").toBeTruthy();
    expect(w!.count).toBeGreaterThan(0);
    expect(w!.samples.join()).toContain("FG-001");
    // 必须澄清血缘：现有效期能力不依赖本字段，别把影响说大
    expect(w!.impact).toContain("batch_stocks.expiryDate");
    expect(w!.impact).toContain("仍正常工作");
  });

  it("有保质期但临期阈值低于渠道口径时报出，并给出应达到的天数", async () => {
    // 保质期 1095 天 → 渠道口径 max(1095*0.2, 100) = 219 天；阈值设 90 应命中
    await db.update(skus).set({ shelfLifeDays: 1095, nearExpiryDays: 90 }).where(eq(skus.id, finished));
    const r = await getDataHealth({ page: 1, pageSize: 50 }, db);
    const w = r.structural.find((x) => x.key === "near_expiry_below_channel");
    expect(w, "阈值 90 < 渠道口径 219，必须命中").toBeTruthy();
    expect(w!.samples.join()).toContain("≥219");
    // 阈值属业务口径，系统只呈现不代改
    expect(w!.impact).toContain("系统不代改");

    // 阈值调到渠道口径之上 → 不再告警
    await db.update(skus).set({ nearExpiryDays: 240 }).where(eq(skus.id, finished));
    const r2 = await getDataHealth({ page: 1, pageSize: 50 }, db);
    expect(r2.structural.find((x) => x.key === "near_expiry_below_channel")).toBeUndefined();
  });

  it("合法的成品 → 半成品 → 原料不告警", async () => {
    await mkBom(semi, [raw], 1);
    await db.insert(bomLines).values({
      bomId: (await db.select().from(boms).where(eq(boms.productSkuId, finished)))[0].id,
      materialSkuId: semi,
      qtyPer: "2",
      lossRatePct: "0",
      incomingLossPct: "0",
      productionLossPct: "0",
    });

    const r = await getDataHealth({ page: 1, pageSize: 50 }, db);
    expect(r.structural.find((x) => x.key === "bom_cycle")).toBeUndefined();
    expect(r.structural.find((x) => x.key === "bom_depth")).toBeUndefined();
  });

  it("存量 BOM 循环必须告警、指名完整路径并说明整根阻断", async () => {
    const [semiBom] = await db.select().from(boms).where(eq(boms.productSkuId, semi));
    await db.insert(bomLines).values({
      bomId: semiBom.id,
      materialSkuId: finished,
      qtyPer: "1",
      lossRatePct: "0",
      incomingLossPct: "0",
      productionLossPct: "0",
    });

    const r = await getDataHealth({ page: 1, pageSize: 50 }, db);
    const w = r.structural.find((x) => x.key === "bom_cycle");
    expect(w, "成品与半成品互相引用时必须命中循环告警").toBeTruthy();
    expect(w!.count).toBe(1);
    expect(w!.samples.join()).toContain("FG-001");
    expect(w!.samples.join()).toContain("SF-001");
    expect(w!.severity).toBe("high");
    expect(w!.impact).toContain("整根阻断");
  });
});
