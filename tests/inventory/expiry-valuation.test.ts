/**
 * W2-5 效期与风险处置的「钱」回归门。
 *
 * 修复前：`/inventory/expiry` 只有数量，`/report/risk` 也只有数量。
 * 处置队列因此只能按件数排序——一箱赠品和一箱主推品在页面上一样重，
 * 「先处置哪一批」这个唯一要回答的问题，页面给不出依据。
 *
 * 修复前 `listExpiryBatches` / `getRiskWorklist` 的返回对象上没有 amount / atRiskAmount，
 * 也没有 withValue 入参——下面每条断言都会失败。
 */
import { describe, expect, it } from "vitest";
import { batchStocks, brands, skuCosts, skus, spus, warehouses } from "@/db/schema";
import { maskSensitive } from "@/server/core/dto";
import { listExpiryBatches } from "@/server/modules/inventory/expiry-list";
import { getRiskWorklist } from "@/server/modules/report/risk";
import { post } from "@/server/posting";
import { createTestDb, type TestDb } from "../helpers/db";

/** 今天固定不了（todayShanghai 读真实时钟），因此用「相对今天」的到期日构造段位 */
function isoDaysFromNow(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function seed(db: TestDb) {
  const [brand] = await db.insert(brands).values({ code: "BR1", nameCn: "测试品牌" }).returning();
  const [spu] = await db.insert(spus).values({ code: "P00001", nameCn: "测试产品" }).returning();
  const [pricey] = await db
    .insert(skus)
    .values({
      code: "CP-GUI", name: "高价成品", spuId: spu.id, brandId: brand.id,
      baseUom: "个", skuType: "finished", nearExpiryDays: 90,
    })
    .returning();
  const [cheap] = await db
    .insert(skus)
    .values({
      code: "CP-PIAN", name: "低价赠品", spuId: spu.id, brandId: brand.id,
      baseUom: "个", skuType: "finished", nearExpiryDays: 90,
    })
    .returning();
  const [wh] = await db.insert(warehouses).values({ code: "WH-F", name: "成品仓", kind: "finished" }).returning();

  await db.insert(skuCosts).values([
    { skuId: pricey.id, unitCost: "120" },
    { skuId: cheap.id, unitCost: "0.5" },
  ]);
  // 低价赠品数量更大：按数量排它在前，按金额排高价品才在前
  await db.insert(batchStocks).values([
    {
      skuId: pricey.id, warehouseId: wh.id, batchNo: "B-GUI", qty: "10",
      expiryDate: isoDaysFromNow(30), stocktakeDate: "2026-07-31",
    },
    {
      skuId: cheap.id, warehouseId: wh.id, batchNo: "B-PIAN", qty: "500",
      expiryDate: isoDaysFromNow(31), stocktakeDate: "2026-07-31",
    },
  ]);
  // 风险处置台的在库口径来自账本（core/stock-view），必须真过账，不能只放参考层批次行
  await post(db, {
    sourceDocType: "opening",
    sourceDocId: 1,
    action: "post",
    lines: [
      { sourceLineId: 1, skuId: pricey.id, warehouseId: wh.id, qtyDelta: "10" },
      { sourceLineId: 2, skuId: cheap.id, warehouseId: wh.id, qtyDelta: "500" },
    ],
  });
  return { pricey, cheap, wh };
}

describe("W2-5 效期清单带金额", () => {
  it("withValue=false 不下发金额键，也不做任何成本解析", async () => {
    const { db } = await createTestDb();
    await seed(db);
    const result = await listExpiryBatches({ bucket: "m3", pageSize: 50 }, db);
    expect(result.rows.length).toBe(2);
    expect(result.rows[0]).not.toHaveProperty("amount");
    expect(result.costCoverage).toBeNull();
  });

  it("withValue=true 逐批次给出 数量 × 单位成本，并汇总到段位小计", async () => {
    const { db } = await createTestDb();
    await seed(db);
    const result = await listExpiryBatches({ bucket: "m3", pageSize: 50, withValue: true }, db);
    const byBatch = Object.fromEntries(result.rows.map((r) => [r.batchNo, r.amount]));
    expect(byBatch).toEqual({ "B-GUI": "1200.00", "B-PIAN": "250.00" });
    expect(result.bucketCounts.m3.amount).toBe("1450.00");
    expect(result.costCoverage).toEqual({ covered: 2, total: 2 });
  });

  it("金额让处置队列能按「钱」排序——按数量排和按金额排结论相反", async () => {
    const { db } = await createTestDb();
    await seed(db);
    const { rows } = await listExpiryBatches({ bucket: "m3", pageSize: 50, withValue: true }, db);
    const topByQty = [...rows].sort((a, b) => b.qty - a.qty)[0];
    const topByAmount = [...rows].sort((a, b) => Number(b.amount ?? 0) - Number(a.amount ?? 0))[0];
    expect(topByQty.batchNo).toBe("B-PIAN");
    expect(topByAmount.batchNo).toBe("B-GUI");
  });

  it("无单位成本的批次金额为 null（不是 0），且不计入段位小计", async () => {
    const { db } = await createTestDb();
    const { wh } = await seed(db);
    const [spu] = await db.select().from(spus);
    const [nocost] = await db
      .insert(skus)
      .values({ code: "CP-WU", name: "无成本品", spuId: spu.id, baseUom: "个", skuType: "finished" })
      .returning();
    await db.insert(batchStocks).values({
      skuId: nocost.id, warehouseId: wh.id, batchNo: "B-WU", qty: "9",
      expiryDate: isoDaysFromNow(20), stocktakeDate: "2026-07-31",
    });
    const result = await listExpiryBatches({ bucket: "m3", pageSize: 50, withValue: true }, db);
    expect(result.rows.find((r) => r.batchNo === "B-WU")!.amount).toBeNull();
    expect(result.bucketCounts.m3.amount).toBe("1450.00");
    expect(result.costCoverage).toEqual({ covered: 2, total: 3 });
  });

  it("金额键经 maskSensitive 对非价格角色剥离（R9 唯一收口）", async () => {
    const { db } = await createTestDb();
    await seed(db);
    const result = await listExpiryBatches({ bucket: "m3", pageSize: 50, withValue: true }, db);
    const masked = maskSensitive(result, ["warehouse"]);
    expect(masked.rows[0]).not.toHaveProperty("amount");
    expect(masked.bucketCounts.m3).not.toHaveProperty("amount");
    expect(masked.rows[0].qty).toBeGreaterThan(0); // 数量不受影响
  });
});

describe("W2-5 风险处置台带金额", () => {
  it("withValue=true 给出在库金额与风险金额；按风险金额排序才能先处置钱最多的", async () => {
    const { db } = await createTestDb();
    await seed(db);
    const { rows } = await getRiskWorklist({ pageSize: 100, withValue: true, precise: true }, db);
    expect(rows.length).toBeGreaterThan(0);
    const gui = rows.find((r) => r.code === "CP-GUI");
    const pian = rows.find((r) => r.code === "CP-PIAN");
    expect(gui, "高价临期品应进入处置台").toBeTruthy();
    expect(gui!.atRiskAmount).toBe("1200.00");
    if (pian) {
      expect(pian.atRiskAmount).toBe("250.00");
      expect(Number(gui!.atRiskAmount)).toBeGreaterThan(Number(pian.atRiskAmount));
      expect(pian.nearQty).toBeGreaterThan(gui!.nearQty); // 数量口径结论相反
    }
  });

  it("withValue=false 不下发金额键；下发时对非价格角色由 maskSensitive 剥离", async () => {
    const { db } = await createTestDb();
    await seed(db);
    const plain = await getRiskWorklist({ pageSize: 100 }, db);
    expect(plain.rows[0]).not.toHaveProperty("amount");

    const valued = await getRiskWorklist({ pageSize: 100, withValue: true }, db);
    expect(valued.rows[0]).toHaveProperty("atRiskAmount");
    const masked = maskSensitive(valued, ["ops"]);
    expect(masked.rows[0]).not.toHaveProperty("amount");
    expect(masked.rows[0]).not.toHaveProperty("atRiskAmount");
  });
});
