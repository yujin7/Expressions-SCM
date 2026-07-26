import { beforeAll, describe, expect, it } from "vitest";
import { boms, brands, skus, spus, users } from "@/db/schema";
import { getDuplicateCandidates } from "@/server/modules/report/data-health";
import { createTestDb, type TestDb } from "../helpers/db";

/**
 * 疑似重复主档（E5-09）服务层。
 *
 * 纯函数层的相似度/分簇已在 tests/core/dedupe.test.ts 覆盖；这里只测服务层该负责的三件事：
 * ① 证据是否取对（在库、生效 BOM）；
 * ② 「建议保留哪条」是否按证据排序，而不是随便挑一条；
 * ③ **合并代价是否被如实标出**——待并项身上还有库存时，合并不是改主档的文书工作。
 */
describe("主数据健康度：疑似重复主档", () => {
  let db: TestDb;
  let brandA = 0;
  let brandB = 0;
  let userId = 0;

  async function mkSku(
    code: string,
    name: string,
    brandId: number | null,
    skuType: "finished" | "raw" = "finished",
  ): Promise<number> {
    const [spu] = await db.insert(spus).values({ code: `SPU-${code}`, nameCn: name }).returning();
    const [s] = await db
      .insert(skus)
      .values({ spuId: spu.id, code, name, skuType, baseUom: "个", active: true, brandId })
      .returning();
    return s.id;
  }

  beforeAll(async () => {
    ({ db } = await createTestDb());
    const [u] = await db
      .insert(users)
      .values({ username: "dupe-tester", name: "去重测试", passwordHash: "x", active: true })
      .returning();
    userId = u.id;
    const [a] = await db.insert(brands).values({ code: "BA", nameCn: "甲牌" }).returning();
    const [b] = await db.insert(brands).values({ code: "BB", nameCn: "乙牌" }).returning();
    brandA = a.id;
    brandB = b.id;
  });

  it("归一化后同名的两条 SKU 被识别为同一簇", async () => {
    const id1 = await mkSku("D-001", "玻尿酸原液精华30ml", brandA);
    const id2 = await mkSku("D-002", "玻尿酸原液精华（30ml）", brandA);
    await mkSku("D-003", "完全无关的另一个商品", brandA);

    const r = await getDuplicateCandidates({}, db);
    const cluster = r.rows.find((c) => c.members.some((m) => m.skuId === id1));
    expect(cluster).toBeDefined();
    expect(cluster!.members.map((m) => m.skuId).sort((x, y) => x - y)).toEqual([id1, id2]);
    expect(cluster!.topScore).toBe(1);
    expect(r.scanned).toBeGreaterThanOrEqual(3);
  });

  it("**有生效 BOM 的那条被建议保留**（它是正在使用的主档）", async () => {
    const plain = await mkSku("D-010", "紧致修护眼霜", brandA);
    const withBom = await mkSku("D-011", "紧致修护眼霜 ", brandA);
    await db.insert(boms).values({
      productSkuId: withBom,
      versionNo: "V1",
      status: "active",
      effectiveDate: "2026-01-01",
      createdBy: userId,
    });

    const r = await getDuplicateCandidates({}, db);
    const cluster = r.rows.find((c) => c.members.some((m) => m.skuId === withBom));
    expect(cluster).toBeDefined();
    expect(cluster!.suggestedKeepSkuId).toBe(withBom); // 不是 skuId 更小的 plain
    expect(cluster!.keepReason).toContain("BOM");
    expect(cluster!.members.find((m) => m.skuId === plain)!.hasBom).toBe(false);
  });

  it("跨品牌簇被标记——同名不同品往往是正常的", async () => {
    await mkSku("D-020", "清爽补水喷雾", brandA);
    await mkSku("D-021", "清爽补水喷雾", brandB);

    const r = await getDuplicateCandidates({}, db);
    const cluster = r.rows.find((c) => c.members.some((m) => m.code === "D-020"));
    expect(cluster!.crossBrand).toBe(true);
  });

  it("crossBrand=false 时只留同品牌簇", async () => {
    const all = await getDuplicateCandidates({}, db);
    const sameOnly = await getDuplicateCandidates({ crossBrand: false }, db);
    expect(sameOnly.rows.every((r) => !r.crossBrand)).toBe(true);
    expect(sameOnly.total).toBeLessThan(all.total);
  });

  it("**无库存时 stockAtRisk = 0，note 不吓唬人**", async () => {
    const r = await getDuplicateCandidates({}, db);
    // 本测试库未过账任何库存
    expect(r.rows.every((c) => c.stockAtRisk === 0)).toBe(true);
    expect(r.clustersWithStock).toBe(0);
    expect(r.note).not.toContain("必须先处理库存");
  });

  it("note 始终声明「不会自动合并」——这是本功能的纪律，不能被改掉", async () => {
    const r = await getDuplicateCandidates({}, db);
    expect(r.note).toContain("不会自动合并");
  });

  it("阈值下限守住 0.7：不接受会把不同品类拖进来的低阈值", async () => {
    const r = await getDuplicateCandidates({ threshold: 0.1 }, db);
    expect(r.threshold).toBe(0.7);
  });

  it("关键词筛选按簇内任一成员匹配", async () => {
    const r = await getDuplicateCandidates({ q: "D-001" }, db);
    expect(r.total).toBe(1);
    expect(r.rows[0].members.some((m) => m.code === "D-001")).toBe(true);
  });

  it("孤立 SKU 不产出（只报真候选，不制造噪音）", async () => {
    const r = await getDuplicateCandidates({}, db);
    expect(r.rows.every((c) => c.members.length >= 2)).toBe(true);
    expect(r.rows.some((c) => c.members.some((m) => m.name.includes("完全无关")))).toBe(false);
  });
});
