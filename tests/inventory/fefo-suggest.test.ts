import { beforeEach, describe, expect, it } from "vitest";
import { batches, binBalances, bins, skus, spus, stockBalances, warehouses } from "@/db/schema";
import { suggestFefoAllocation } from "@/server/modules/inventory/fefo";
import { createTestDb, type TestDb } from "../helpers/db";

/**
 * E2-12 FEFO 出库建议（服务层）。
 *
 * 纯规则的排序/缺口逻辑已在 tests/rules/fefo.test.ts 覆盖；这里只测服务层该负责的：
 * ① 取数口径对不对（只取该 SKU×仓 的分批余额，join 到效期）；
 * ② **迁移期回落**——分批行不足时能不能用 batchId=null 的历史库存补，且如实说明；
 * ③ 没有分批余额时是否诚实降级（不报错、不假装分配）。
 */
describe("suggestFefoAllocation", () => {
  const testToday = "2026-07-25";
  let db: TestDb;
  let skuId = 0;
  let whA = 0;
  let whB = 0;

  const mkBatch = async (batchNo: string, expiryDate: string | null): Promise<number> => {
    const [b] = await db.insert(batches).values({ batchNo, skuId, expiryDate }).returning();
    return b.id;
  };
  const bal = async (warehouseId: number, batchId: number | null, qty: string) => {
    await db.insert(stockBalances).values({ skuId, warehouseId, batchId, qty });
  };

  beforeEach(async () => {
    ({ db } = await createTestDb());
    const [spu] = await db.insert(spus).values({ code: "SPU-F", nameCn: "效期品" }).returning();
    const [s] = await db
      .insert(skus)
      .values({ spuId: spu.id, code: "F-001", name: "效期成品", skuType: "finished", baseUom: "个", active: true })
      .returning();
    skuId = s.id;
    const [a] = await db.insert(warehouses).values({ code: "WA", name: "甲仓", kind: "finished" }).returning();
    const [b] = await db.insert(warehouses).values({ code: "WB", name: "乙仓", kind: "finished" }).returning();
    whA = a.id;
    whB = b.id;
  });

  it("按到期日升序分配，且只取本仓的批次", async () => {
    const late = await mkBatch("L-LATE", "2027-12-01");
    const early = await mkBatch("L-EARLY", "2026-09-01");
    await bal(whA, late, "100");
    await bal(whA, early, "100");
    await bal(whB, early, "999"); // 他仓库存不得参与

    const r = await suggestFefoAllocation(db, { skuId, warehouseId: whA, qty: "150", today: testToday });
    expect(r.batchCoverage).toBe(true);
    expect(r.allocations.map((a) => a.batchNo)).toEqual(["L-EARLY", "L-LATE"]);
    expect(r.allocations[0].qty).toBe("100.0000");
    expect(r.allocations[1].qty).toBe("50.0000");
    expect(r.shortBy).toBe("0.0000");
    expect(r.fallbackQty).toBe("0.0000");
  });

  it("**无分批余额时诚实降级**：空分配 + 说明，不报错", async () => {
    await bal(whA, null, "500"); // 只有历史无批次库存
    const r = await suggestFefoAllocation(db, { skuId, warehouseId: whA, qty: "100", today: testToday });
    expect(r.batchCoverage).toBe(false);
    expect(r.allocations).toEqual([]);
    expect(r.shortBy).toBe("0.0000");
    expect(r.note).toContain("批次化未覆盖");
  });

  it("**迁移期回落**：分批行不足时用无批次历史库存补足，并如实说明", async () => {
    const b1 = await mkBatch("L-1", "2026-10-01");
    await bal(whA, b1, "30");
    await bal(whA, null, "200"); // 历史库存

    const r = await suggestFefoAllocation(db, { skuId, warehouseId: whA, qty: "100", today: testToday });
    expect(r.allocations[0].qty).toBe("30.0000");
    expect(r.fallbackQty).toBe("70.0000"); // 不回落的话这 200 就成了死库存
    expect(r.shortBy).toBe("0.0000");
    expect(r.note).toContain("历史库存");
    expect(r.note).toContain("无法参与批次追溯"); // 代价必须说出来
  });

  it("回落也不够时如实报缺口，不静默截断", async () => {
    const b1 = await mkBatch("L-1", "2026-10-01");
    await bal(whA, b1, "30");
    await bal(whA, null, "20");

    const r = await suggestFefoAllocation(db, { skuId, warehouseId: whA, qty: "100", today: testToday });
    expect(r.fallbackQty).toBe("20.0000");
    expect(r.shortBy).toBe("50.0000");
    expect(r.note).toContain("仍缺 50");
  });

  it("无效期批次排在最后但不被丢弃", async () => {
    const dated = await mkBatch("L-D", "2026-12-01");
    const undated = await mkBatch("L-N", null);
    await bal(whA, undated, "100");
    await bal(whA, dated, "40");

    const r = await suggestFefoAllocation(db, { skuId, warehouseId: whA, qty: "90", today: testToday });
    expect(r.allocations.map((a) => a.batchNo)).toEqual(["L-D", "L-N"]);
    expect(r.allocations[1].qty).toBe("50.0000");
  });

  it("已过期批次被排除并形成真实缺口", async () => {
    const expired = await mkBatch("L-EXP", "2026-01-01");
    await bal(whA, expired, "100");

    const r = await suggestFefoAllocation(db, { skuId, warehouseId: whA, qty: "10", today: "2026-07-25" });
    expect(r.allocations).toEqual([]);
    expect(r.shortBy).toBe("10.0000");
    expect(r.expiredLots).toBe(1);
    expect(r.note).toContain("已排除");
  });

  it("FEFO 只建议未定位可发量，已定位/隔离量不能被建议旁路", async () => {
    const batch = await mkBatch("L-PROTECTED", "2027-01-01");
    await bal(whA, batch, "100");
    const [quarantine] = await db.insert(bins).values({
      warehouseId: whA,
      code: "Q-01",
      kind: "quarantine",
    }).returning();
    await db.insert(binBalances).values({
      binId: quarantine.id,
      skuId,
      batchId: batch,
      qty: "70",
    });

    const r = await suggestFefoAllocation(db, { skuId, warehouseId: whA, qty: "50", today: testToday });
    expect(r.allocations).toEqual([
      expect.objectContaining({ batchId: batch, qty: "30.0000" }),
    ]);
    expect(r.shortBy).toBe("20.0000");
  });

  it("出库量为 0 或负 → 空分配，不查库也不报错", async () => {
    const r0 = await suggestFefoAllocation(db, { skuId, warehouseId: whA, qty: "0" });
    expect(r0.allocations).toEqual([]);
    expect(r0.note).toContain("无需分配");
    const rn = await suggestFefoAllocation(db, { skuId, warehouseId: whA, qty: "-5" });
    expect(rn.allocations).toEqual([]);
  });

  it("分配总量恰好等于需求（不多发）", async () => {
    const b1 = await mkBatch("L-1", "2026-09-01");
    const b2 = await mkBatch("L-2", "2026-10-01");
    await bal(whA, b1, "40");
    await bal(whA, b2, "80");

    const r = await suggestFefoAllocation(db, { skuId, warehouseId: whA, qty: "55", today: testToday });
    const sum = r.allocations.reduce((s, a) => s + Number(a.qty), 0);
    expect(sum).toBe(55);
    expect(r.allocations[1].qty).toBe("15.0000");
  });
});
