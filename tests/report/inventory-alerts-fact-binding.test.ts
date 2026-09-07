/**
 * W2 修复：`inventory-alerts` 的来源绑定要补上兄弟读模型早就有的两块指纹。
 *
 * 事故形态（与 wave 1 给 `risk-expiry-buckets` 补数量指纹时修的是同一个）：
 *  - `batch_stocks` 只绑 `max(id)`。**原地改数量**（同一行 qty 从 500 改成 5，仓管纠错常见）
 *    与**删行**都不改变 max(id) —— 临期量因此可以整夜不重算，页面上还是昨天的结论；
 *  - `skus` **一列都没绑**。而行集就是「启用成品」、临期判定又逐 SKU 读 `near_expiry_days`：
 *    停用一个 SKU、新建一个成品、把某 SKU 的临期阈值从 90 改成 30，绑定全都看不见。
 *
 * 每一种输入变化各一条断言：绑定必须变。
 */
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { createTestDb, type TestDb } from "../helpers/db";
import {
  computeInventoryAlerts,
  INVENTORY_ALERTS_CACHE_KEY,
} from "@/server/modules/report/inventory-alerts";
import { todayShanghai } from "@/server/modules/master/common";

const today = todayShanghai();

async function seed(db: TestDb) {
  const [spu] = await db.insert(schema.spus).values({ code: "FB1", nameCn: "事实绑定测试" }).returning();
  const [wh] = await db.insert(schema.warehouses).values({
    code: "FBW1", name: "主仓", kind: "finished", accountingMode: "realtime", active: true,
  }).returning();
  const [sku] = await db.insert(schema.skus).values({
    code: "FB001", name: "绑定测试成品", spuId: spu.id, skuType: "finished", baseUom: "支",
    active: true, nearExpiryDays: 90,
  }).returning();
  const [batch] = await db.insert(schema.batchStocks).values({
    skuId: sku.id, warehouseId: wh.id, batchNo: "FB-B1", qty: "500.0000",
    expiryDate: "2026-10-01", stocktakeDate: today,
  }).returning();
  return { spu, wh, sku, batch };
}

const bindingOf = async (db: TestDb) => (await computeInventoryAlerts(db)).sourceBinding;

describe("inventory-alerts：批次数量指纹与 skus 指纹", () => {
  it("键已随口径升版（绑定口径变了就必须换键，否则旧缓存把新线索藏起来）", () => {
    expect(INVENTORY_ALERTS_CACHE_KEY).toBe("inventory-alerts/v8");
  });

  it("批次**原地改数量**必须换出新绑定（max(id) 不动，此前完全看不见）", async () => {
    const { db, client } = await createTestDb();
    try {
      const { batch } = await seed(db);
      const before = await bindingOf(db);
      await db.update(schema.batchStocks).set({ qty: "5.0000" }).where(eq(schema.batchStocks.id, batch.id));
      const after = await bindingOf(db);
      expect(after, "500 改成 5 只改了 qty，max(id) 一动不动——绑定必须靠数量指纹发现它").not.toBe(before);
    } finally {
      await client.close();
    }
  });

  it("**删掉**一行批次必须换出新绑定（max(id) 也可能不动）", async () => {
    const { db, client } = await createTestDb();
    try {
      const { sku, wh } = await seed(db);
      // 再加一行（max(id) 前移），然后删掉它之前那一行：max(id) 保持不变
      await db.insert(schema.batchStocks).values({
        skuId: sku.id, warehouseId: wh.id, batchNo: "FB-B2", qty: "1.0000",
        expiryDate: "2026-10-02", stocktakeDate: today,
      });
      const before = await bindingOf(db);
      await db.delete(schema.batchStocks).where(eq(schema.batchStocks.batchNo, "FB-B1"));
      const after = await bindingOf(db);
      expect(after, "删行不改 max(id)；行数/Σqty 指纹才看得见").not.toBe(before);
    } finally {
      await client.close();
    }
  });

  it("改某个 SKU 的 near_expiry_days 必须换出新绑定（临期判定逐 SKU 读它）", async () => {
    const { db, client } = await createTestDb();
    try {
      const { sku } = await seed(db);
      const before = await bindingOf(db);
      await db.update(schema.skus).set({ nearExpiryDays: 30 }).where(eq(schema.skus.id, sku.id));
      const after = await bindingOf(db);
      expect(after, "阈值 90→30 直接改变临期量，绑定此前对 skus 一列都没绑").not.toBe(before);
    } finally {
      await client.close();
    }
  });

  it("停用一个 SKU 必须换出新绑定（行集 = 启用成品）", async () => {
    const { db, client } = await createTestDb();
    try {
      const { sku } = await seed(db);
      const before = await bindingOf(db);
      await db.update(schema.skus).set({ active: false }).where(eq(schema.skus.id, sku.id));
      const after = await bindingOf(db);
      expect(after, "行集少了一行，绑定必须变").not.toBe(before);
    } finally {
      await client.close();
    }
  });

  it("新建一个启用成品必须换出新绑定", async () => {
    const { db, client } = await createTestDb();
    try {
      const { spu } = await seed(db);
      const before = await bindingOf(db);
      await db.insert(schema.skus).values({
        code: "FB002", name: "新成品", spuId: spu.id, skuType: "finished", baseUom: "支",
        active: true, nearExpiryDays: 90,
      });
      const after = await bindingOf(db);
      expect(after).not.toBe(before);
    } finally {
      await client.close();
    }
  });

  it("绑定串里逐段可读（bs/sku 两段都在，出问题时能一眼看出是哪一块没变）", async () => {
    const { db, client } = await createTestDb();
    try {
      await seed(db);
      const b = await bindingOf(db);
      expect(b).toContain("|bs:");
      expect(b).toContain("|sku:");
    } finally {
      await client.close();
    }
  });
});
