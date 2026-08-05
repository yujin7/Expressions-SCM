/**
 * 库存余额按业务用途筛选（M-22）。
 *
 * 0727 会议要「小样单独查库存明细」。此前能筛小样的地方（SKU 主档）没有库存数量，
 * 有库存数量的地方（库存余额/导出）没有业务用途列——两头对不上，需求无处落地。
 */
import { describe, expect, it } from "vitest";
import { skus, spus, stockBalances, warehouses } from "@/db/schema";
import { createTestDb } from "../helpers/db";
import { listBalances } from "@/server/modules/inventory/queries";

async function setup() {
  const { db } = await createTestDb();
  const [spu] = await db.insert(spus).values({ code: "P66001", nameCn: "余额测试品" }).returning();
  const [wh] = await db.insert(warehouses).values({
    code: "WH-BAL", name: "余额测试仓", kind: "finished", accountingMode: "realtime",
  }).returning();
  const mk = async (code: string, role: string) => {
    const [row] = await db.insert(skus).values({
      code, name: `货品${code}`, spuId: spu.id, skuType: "finished",
      baseUom: "支", commercialRole: role,
    }).returning();
    await db.insert(stockBalances).values({
      skuId: row.id, warehouseId: wh.id, batchId: null, qty: "10.0000",
    });
    return row;
  };
  const retail = await mk("BAL-RETAIL", "retail");
  const sample = await mk("BAL-SAMPLE", "sample");
  const unclassified = await mk("BAL-UNCL", "unclassified");
  return { db, retail, sample, unclassified };
}

describe("库存余额：业务用途", () => {
  it("不传筛选时返回全部，并且每行都带业务用途列", async () => {
    const { db } = await setup();
    const res = await listBalances({ page: 1, pageSize: 50 }, db);
    expect(res.total).toBe(3);
    const roles = (res.rows as { commercialRole: string }[]).map((r) => r.commercialRole).sort();
    expect(roles).toEqual(["retail", "sample", "unclassified"]);
  });

  it("按 sample 筛选只返回小样，且 total 同步收敛（不是只裁当页）", async () => {
    const { db, sample } = await setup();
    const res = await listBalances({ commercialRole: "sample", page: 1, pageSize: 50 }, db);
    expect(res.total).toBe(1);
    expect((res.rows as { skuCode: string }[])[0].skuCode).toBe(sample.code);
  });

  it("未分类可单独查出来——这正是需要业务补分类的那批", async () => {
    const { db } = await setup();
    const res = await listBalances({ commercialRole: "unclassified", page: 1, pageSize: 50 }, db);
    expect(res.total).toBe(1);
    expect((res.rows as { skuCode: string }[])[0].skuCode).toBe("BAL-UNCL");
  });
});
