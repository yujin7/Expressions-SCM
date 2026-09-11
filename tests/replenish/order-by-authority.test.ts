/**
 * W2-#3 「最晚下单日」只能有一套口径。
 *
 * 事故形状：补货**行**走 `rules/timephased`（跌破**安全库存**触发、倒推**生产+物流**总供应周期），
 * 曲线**抽屉**走 `rules/projection`（跌破 **0** 触发、只减 **normalLeadDays**）。
 * 同一个 SKU、同一个时刻，两个用来互相印证的界面给出两个不同的下单日；
 * 计划员按页面执行、待办却按另一个日子考核。
 *
 * 裁决：权威是 `rules/timephased`。
 *   ① 再订货点是安全库存线而不是 0——等到 0 才动手，安全库存那段时间已经白让掉了；
 *   ② 能补上货的是**总供应周期**（生产 + 物流/调拨），货离开工厂那天并不能卖。
 * 抽屉改为调用同一个函数、喂同一份输入，于是不是"尽量一致"，而是同一个数。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import { getSkuProjection } from "@/server/modules/replenish/projection";
import { getReplenishSuggestions } from "@/server/modules/replenish/service";
import { createTestDb } from "../helpers/db";

const root = path.resolve(__dirname, "../..");

async function seed(db: Awaited<ReturnType<typeof createTestDb>>["db"]) {
  const [spu] = await db.insert(schema.spus).values({ code: "P1", nameCn: "测试" }).returning();
  const [sku] = await db.insert(schema.skus).values({ code: "CP00001", name: "面霜", spuId: spu.id, skuType: "finished", baseUom: "支" }).returning();
  const [ch] = await db.insert(schema.channels).values({ code: "tmall", name: "天猫", kind: "platform" }).returning();
  const [wh] = await db.insert(schema.warehouses).values({ code: "WH-CP", name: "成品仓", kind: "finished", accountingMode: "realtime" }).returning();
  for (const ym of ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06"]) {
    await db.insert(schema.salesMonthly).values({ skuId: sku.id, channelId: ch.id, yearMonth: ym, qty: "900" });
  }
  // 生产 30 + 物流 15：旧抽屉只会减 30，与行差 15 天
  await db.insert(schema.skuParams).values({ skuId: sku.id, normalLeadDays: 30, logisticsLeadDays: 15 });
  await db.insert(schema.stockBalances).values({ skuId: sku.id, warehouseId: wh.id, qty: "1500" });
  return { sku };
}

describe("最晚下单日：单一权威（W2-#3）", () => {
  it("曲线规则里不得再出现下单日的第二套推导", () => {
    // 去掉注释后只看代码：注释里可以（也应该）讲清这段历史，代码里不许再有第二套推导
    const code = readFileSync(path.join(root, "src/server/rules/projection.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(code, "orderByDate 属于判定，不属于画曲线").not.toMatch(/orderByDate/);
    expect(code, "曲线不该知道生产周期").not.toMatch(/leadDays/);

    const svc = readFileSync(path.join(root, "src/server/modules/replenish/projection.ts"), "utf8");
    expect(svc, "抽屉的判定必须调用唯一权威 rules/timephased").toContain("timePhasedNetReq");
    expect(svc, "抽屉的输入必须取自补货引擎本身，否则安全库存/总周期又会各算一份").toContain("getReplenishSuggestions");
  });

  it("抽屉与补货行给出同一个 shortageDate / orderByDate / orderWindowMissed", async () => {
    const { db, client } = await createTestDb();
    try {
      const { sku } = await seed(db);
      const res = await getReplenishSuggestions({ allRows: true }, db);
      const row = res.rows.find((r) => r.skuId === sku.id)!;
      const drawer = await getSkuProjection(sku.id, 120, db);

      expect(row.orderByDate).not.toBeNull();
      expect(drawer.orderByDate).toBe(row.orderByDate);
      expect(drawer.shortageDate).toBe(row.shortageDate);
      expect(drawer.daysToShortage).toBe(row.daysToShortage);
      expect(drawer.orderWindowMissed).toBe(row.orderWindowMissed);
      // 总供应周期（30+15），不是 normalLeadDays
      expect(drawer.leadDays).toBe(45);
      expect(row.leadDays).toBe(45);
      // 触发线是安全库存而不是 0：短缺日必然早于曲线跌破 0 的那天
      expect(drawer.safetyQty).toBe(row.safetyQty);
      if (drawer.stockoutDate && drawer.shortageDate) {
        expect(drawer.shortageDate <= drawer.stockoutDate).toBe(true);
      }
    } finally {
      await client.close();
    }
  });

  it("沙盘变量只改输入，判定仍走同一个函数（追加到货把下单日推后）", async () => {
    const { db, client } = await createTestDb();
    try {
      const { sku } = await seed(db);
      const base = await getSkuProjection(sku.id, 120, db);
      const withInbound = await getSkuProjection(sku.id, 120, db, { extraInboundQty: 5000, extraInboundDate: base.today });
      expect(withInbound.scenarioApplied).toBe(true);
      expect(base.shortageDate).not.toBeNull();
      expect(
        withInbound.shortageDate === null || withInbound.shortageDate > base.shortageDate!,
        "多来一批货，短缺只能更晚",
      ).toBe(true);
    } finally {
      await client.close();
    }
  });
});
