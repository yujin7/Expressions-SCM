/**
 * W2 修复：效期批次清单的金额——**逐段位**覆盖率与服务端金额排序。
 *
 * T9 事故形态：段位小计旁边只有一个**全局**覆盖率（如「90.5% 已覆盖」）。
 *   一个只有 5% 批次有单位成本的段位照样显示一个金额小计，读者拿全局覆盖率去信这个局部小计，
 *   方向可以完全反过来（"已过期只有 3 千块"其实是 3 千块 ÷ 5% 的样本）。
 *   覆盖率必须**逐段位**给。
 *
 * T3 事故形态（与风险处置台同构）：金额列的排序是 AntD 的本地比较器，只排当前一页，
 *   而分页总数来自服务端——最贵的那批落在第 8 页就永远浮不上来；
 *   `Number(x ?? 0)` 还会把「没有成本」排成「零元」。
 */
import { beforeAll, describe, expect, it } from "vitest";
import { batchStocks, skuCosts, skus, spus, users, warehouses } from "@/db/schema";
import {
  EXPIRY_MONEY_CALIBRE_KEY,
  listExpiryBatches,
} from "@/server/modules/inventory/expiry-list";
import { todayShanghai } from "@/server/modules/master/common";
import { createTestDb, type TestDb } from "../helpers/db";

const today = todayShanghai();
const dayOffset = (n: number): string =>
  new Date(Date.parse(`${today}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

describe("效期批次金额：逐段位覆盖率与服务端排序", () => {
  let db: TestDb;
  let pricyId = 0;

  beforeAll(async () => {
    ({ db } = await createTestDb());
    await db.insert(users).values({ name: "仓管", roles: ["warehouse"], isApprover: false });
    const [spu] = await db.insert(spus).values({ code: "EP1", nameCn: "效期测试" }).returning();
    const [wh] = await db.insert(warehouses).values({
      code: "EW1", name: "主仓", kind: "finished", accountingMode: "realtime", active: true,
    }).returning();

    const mkSku = async (code: string, unitCost: string | null) => {
      const [sku] = await db.insert(skus).values({
        code, name: code, spuId: spu.id, skuType: "finished", baseUom: "支", active: true,
      }).returning();
      if (unitCost != null) await db.insert(skuCosts).values({ skuId: sku.id, unitCost });
      return sku.id;
    };
    const costed = await mkSku("EXP-COSTED", "100.0000");
    const pricy = await mkSku("EXP-PRICY", "900.0000");
    const bare = await mkSku("EXP-BARE", null);

    const mkBatch = async (skuId: number, no: string, qty: string, daysLeft: number) => {
      const [b] = await db.insert(batchStocks).values({
        skuId, warehouseId: wh.id, batchNo: no, qty, expiryDate: dayOffset(daysLeft), stocktakeDate: today,
      }).returning();
      return b.id;
    };

    /* expired 段位：1 个有成本 + 3 个没成本 → 该段位覆盖率 1/4，而全局覆盖率会高得多 */
    await mkBatch(costed, "EXPIRED-1", "10.0000", -5);
    await mkBatch(bare, "EXPIRED-2", "1000.0000", -6);
    await mkBatch(bare, "EXPIRED-3", "1000.0000", -7);
    await mkBatch(bare, "EXPIRED-4", "1000.0000", -8);
    /* m3 段位：全部有成本 → 覆盖率 3/3；其中最贵的一批用来验证服务端排序 */
    await mkBatch(costed, "M3-1", "5.0000", 10);
    await mkBatch(costed, "M3-2", "5.0000", 20);
    pricyId = await mkBatch(pricy, "M3-TOP", "1000.0000", 30); // 90 万，全局最贵
  });

  it("T9 段位金额小计旁必须是**该段位自己**的成本覆盖率", async () => {
    const r = await listExpiryBatches({ withValue: true, pageSize: 500 }, db);

    expect(r.bucketCounts.expired.batches).toBe(4);
    expect(
      r.bucketCounts.expired.covered,
      "已过期段位只有 1/4 有成本，段位小计只覆盖这一部分——不能拿全局覆盖率去读它",
    ).toBe(1);
    expect(r.bucketCounts.expired.amount, "10 × 100 = 1000.00（另外 3 批没成本，不计入）").toBe("1000.00");

    expect(r.bucketCounts.m3.batches).toBe(3);
    expect(r.bucketCounts.m3.covered, "m3 段位全部有成本").toBe(3);

    // 全局覆盖率仍在（4/7 ≈ 57%），但它对 expired 段位（1/4）是误导——两者必须都有
    expect(r.costCoverage).toEqual({ covered: 4, total: 7 });
    expect(
      r.bucketCounts.expired.covered! / r.bucketCounts.expired.batches,
      "逐段位覆盖率与全局覆盖率必须能不同，否则这条修复没有意义",
    ).not.toBe(r.costCoverage!.covered / r.costCoverage!.total);
  });

  it("无金额权限时不下发覆盖率也不查成本（withValue=false 一次成本查询都不发生）", async () => {
    const r = await listExpiryBatches({ pageSize: 500 }, db);
    expect(r.costCoverage).toBeNull();
    expect(r.moneyCalibreKey).toBeNull();
    expect(r.bucketCounts.expired.covered).toBeUndefined();
    expect(r.bucketCounts.expired.amount).toBeUndefined();
    expect(r.rows.every((x) => x.amount === undefined)).toBe(true);
  });

  it("T3 金额排序在服务端全集上做：每页 1 行时第 1 行仍是全局最贵的那批", async () => {
    const p1 = await listExpiryBatches({ withValue: true, sort: "amount", page: 1, pageSize: 1 }, db);
    expect(p1.sort).toBe("amount");
    expect(p1.total).toBeGreaterThan(1);
    expect(
      p1.rows[0].id,
      "客户端比较器只排当前一页；最贵的那批落在后面的页就永远浮不上来",
    ).toBe(pricyId);
    expect(p1.moneyCalibreKey).toBe(EXPIRY_MONEY_CALIBRE_KEY);
  });

  it("T3 无成本的批次显式置后，不按 ¥0 参与比较；缺省仍按剩余天数升序", async () => {
    const byAmount = await listExpiryBatches({ withValue: true, sort: "amount", pageSize: 500 }, db);
    const withMoney = byAmount.rows.filter((x) => x.amount != null);
    const firstBare = byAmount.rows.findIndex((x) => x.amount == null);
    expect(firstBare, "无成本的批次必须整体排在有金额的批次之后").toBe(withMoney.length);

    const def = await listExpiryBatches({ withValue: true, pageSize: 500 }, db);
    expect(def.sort, "缺省仍是「最急的在前」").toBe("daysLeft");
    const days = def.rows.map((x) => x.daysLeft);
    expect([...days].sort((a, b) => a - b)).toEqual(days);
  });
});
