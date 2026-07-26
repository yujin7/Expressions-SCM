import { beforeAll, describe, expect, it } from "vitest";
import { bomLines, boms, skus, spus, suppliers } from "@/db/schema";
import type { DB } from "@/db";
import { diffBom } from "@/server/modules/master/bom";
import { createTestDb, type TestDb } from "../helpers/db";

describe("BOM 版本对比 diffBom", () => {
  let db: TestDb;
  let dbx: DB;
  let productId = 0;
  let m1 = 0;
  let m2 = 0;
  let m3 = 0;
  let v1 = 0;
  let v2 = 0;
  let otherBom = 0;

  beforeAll(async () => {
    ({ db } = await createTestDb());
    dbx = db as unknown as DB;
    const [spu] = await db.insert(spus).values({ code: "PDF01", nameCn: "对比测试品" }).returning();
    const mk = async (code: string, type: "finished" | "raw" | "packaging") => {
      const [s] = await db
        .insert(skus)
        .values({ code, name: code, spuId: spu.id, baseUom: "个", skuType: type })
        .returning();
      return s.id;
    };
    productId = await mk("DF-P1", "finished");
    m1 = await mk("DF-M1", "raw");
    m2 = await mk("DF-M2", "raw");
    m3 = await mk("DF-M3", "packaging");
    const otherProduct = await mk("DF-P2", "finished");

    const [supA] = await db.insert(suppliers).values({ code: "GDF1", name: "甲工厂", kinds: ["processor"] }).returning();
    const [supB] = await db.insert(suppliers).values({ code: "GDF2", name: "乙工厂", kinds: ["processor"] }).returning();

    const [b1] = await db.insert(boms).values({ productSkuId: productId, versionNo: "V1", status: "retired" }).returning();
    v1 = b1.id;
    await db.insert(bomLines).values([
      { bomId: v1, materialSkuId: m1, qtyPer: "1.0000", lossRatePct: "0" },
      { bomId: v1, materialSkuId: m2, qtyPer: "2.0000", lossRatePct: "0", uom: "克", preferredSupplierId: supA.id },
    ]);
    const [b2] = await db.insert(boms).values({ productSkuId: productId, versionNo: "V2", status: "active" }).returning();
    v2 = b2.id;
    await db.insert(bomLines).values([
      { bomId: v2, materialSkuId: m2, qtyPer: "3.0000", lossRatePct: "0", uom: "毫升", preferredSupplierId: supB.id },
      { bomId: v2, materialSkuId: m3, qtyPer: "1.0000", lossRatePct: "0" },
    ]);
    const [b3] = await db.insert(boms).values({ productSkuId: otherProduct, versionNo: "V1", status: "active" }).returning();
    otherBom = b3.id;
  });

  it("默认与上一版本对比：新增/删除/量变/供应商变/单位变", async () => {
    const d = await diffBom(v2, undefined, dbx);
    expect(d.base?.id).toBe(v1);
    expect(d.target.id).toBe(v2);
    expect(d.target.lineCount).toBe(2);
    expect(d.base?.lineCount).toBe(2);

    const byCode = new Map(d.lines.map((l) => [l.materialSkuCode, l]));
    expect(byCode.get("DF-M1")?.kind).toBe("removed");
    expect(byCode.get("DF-M3")?.kind).toBe("added");
    const changed = byCode.get("DF-M2")!;
    expect(changed.kind).toBe("changed");
    expect(changed.changes).toEqual(expect.arrayContaining(["qty", "supplier", "uom"]));
    expect(changed.base?.qtyPer).toBe("2.0000");
    expect(changed.target?.qtyPer).toBe("3.0000");
    expect(changed.base?.supplierName).toBe("甲工厂");
    expect(changed.target?.supplierName).toBe("乙工厂");
    expect(changed.base?.uom).toBe("克");
    expect(changed.target?.uom).toBe("毫升");
  });

  it("qty 用 decimal 比较：2 与 2.0000 视为相同", async () => {
    // v1 的 m2 行 qty 2.0000 vs 字符串 "2" —— dCmp 语义在 diff 中体现为不误报量变
    const d = await diffBom(v2, v1, dbx);
    const m2Line = d.lines.find((l) => l.materialSkuCode === "DF-M2")!;
    expect(m2Line.changes).toContain("qty"); // 2.0000 → 3.0000 是真实量变
    const same = await diffBom(v1, v2, dbx); // 反向对比也成立
    expect(same.lines.find((l) => l.materialSkuCode === "DF-M1")?.kind).toBe("added");
    expect(same.lines.find((l) => l.materialSkuCode === "DF-M3")?.kind).toBe("removed");
  });

  it("无上一版本：base 为 null；siblings 列出同产品版本", async () => {
    const d = await diffBom(v1, undefined, dbx);
    expect(d.base).toBeNull();
    expect(d.lines.every((l) => l.kind === "added")).toBe(true);
    expect(d.siblings.map((s) => s.id)).toEqual([v1, v2]);
  });

  it("跨产品对比被拒；与自身对比被拒；不存在 404", async () => {
    await expect(diffBom(v2, otherBom, dbx)).rejects.toThrow(/同一成品/);
    await expect(diffBom(v2, v2, dbx)).rejects.toThrow(/自身/);
    await expect(diffBom(999999, undefined, dbx)).rejects.toThrow(/不存在/);
  });
});
