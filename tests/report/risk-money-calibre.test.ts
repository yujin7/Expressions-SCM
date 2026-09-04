/**
 * W2 修复：风险处置台的「钱」——精度、口径、排序。
 *
 * 三个缺陷各一条用例：
 *  T7 **精度**：`amount` 曾用已经四舍五入到 1 位小数的屏显数量去乘单位成本，而导出走 `precise: true`
 *     不舍入——同一行的屏显在库金额与导出在库金额对不上，差额随行数累积。
 *     效期清单（inventory/expiry-list）一直是从原始 decimal 串算的，风险台现在与之一致。
 *  T3 **排序**：金额排序必须在**服务端全集**上做。此前服务端按动作优先级排完分页，客户端再给
 *     金额列挂一个只作用于当页的比较器——第 8 页那笔 ¥180,000 永远浮不上来，
 *     而提示语写着「先处置钱最多的」。且 `Number(x ?? 0)` 把「没有成本」排成「零元」。
 *  T10 **口径**：`amount` 用记账在库、`atRiskAmount` 用 batch_stocks 参考层的 nearQty，
 *     两者不同源、as-of 也不同（`atRiskAmount > amount` 结构上可能）。页面必须说出这两句话。
 */
import { beforeAll, describe, expect, it } from "vitest";
import {
  batchStocks, brands, channels, salesMonthly, skuCosts, skus, spus,
  stockBalances, users, warehouses,
} from "@/db/schema";
import { getRiskWorklist, RISK_MONEY_CALIBRE, RISK_MONEY_CALIBRE_KEY } from "@/server/modules/report/risk";
import { todayShanghai } from "@/server/modules/master/common";
import { createTestDb, type TestDb } from "../helpers/db";

const today = todayShanghai();
const dayOffset = (n: number): string =>
  new Date(Date.parse(`${today}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

describe("风险处置台的金额：精度 / 排序 / 口径", () => {
  let db: TestDb;
  /** 分数数量 + 高单价：屏显舍入与全精度的差在金额上放大到可见 */
  let fractional = 0;
  /** 最贵的一条：必须能被排到第 1 页第 1 行 */
  let priciest = 0;
  /** 无成本：绝不能被当成 ¥0 排在有金额的行中间 */
  let uncosted = 0;
  /** 有成本、但风险金额恰好是 ¥0.00 —— 「没成本」与「算出来就是零元」必须能区分开 */
  let genuineZero = 0;

  beforeAll(async () => {
    ({ db } = await createTestDb());
    await db.insert(users).values({ name: "计划员", roles: ["pmc"], isApprover: false });
    const [brand] = await db.insert(brands).values({ code: "RB", nameCn: "风险品牌" }).returning();
    const [spu] = await db.insert(spus).values({ code: "RP1", nameCn: "风险测试" }).returning();
    const [wh] = await db.insert(warehouses).values({
      code: "RW1", name: "主仓", kind: "finished", accountingMode: "realtime", active: true,
    }).returning();
    const [ch] = await db.insert(channels).values({ code: "RCH", name: "渠道", kind: "platform" }).returning();

    const mk = async (code: string, qty: string, unitCost: string | null, near: number) => {
      const [sku] = await db.insert(skus).values({
        code, name: code, spuId: spu.id, brandId: brand.id, skuType: "finished", baseUom: "支",
        active: true, nearExpiryDays: 90,
      }).returning();
      await db.insert(stockBalances).values({ skuId: sku.id, warehouseId: wh.id, batchId: null, qty });
      // 有效期在临期阈值内 → 进 nearQty；动作判定必然命中（不进列表就什么都测不到）
      await db.insert(batchStocks).values({
        skuId: sku.id, warehouseId: wh.id, batchNo: `${code}-B1`, qty, expiryDate: dayOffset(near),
        stocktakeDate: today,
      });
      if (unitCost != null) await db.insert(skuCosts).values({ skuId: sku.id, unitCost });
      // 给一点销量，避免全部落进"无动销"从而动作判定分叉
      await db.insert(salesMonthly).values({ skuId: sku.id, channelId: ch.id, yearMonth: "2026-08", qty: "30" });
      return sku.id;
    };

    // 0.05 会被 r1 舍成 0.1（屏显），全精度是 0.05 —— 单价 1000 时差 50 元
    fractional = await mk("RSK-FRAC", "10.0500", "1000.0000", 10);
    priciest = await mk("RSK-TOP", "1000.0000", "900.0000", 20);
    uncosted = await mk("RSK-NOCOST", "5000.0000", null, 5);
    await mk("RSK-CHEAP", "1.0000", "1.0000", 30);

    /* 有成本、但阈值内到期量为 0 → atRiskAmount = "0.00"。
       这一行是分辨力的关键：`Number(x ?? 0)` 会让「没成本」与它**打平**，
       于是一个 5000 件、我们只是没记成本的 SKU，和一个真的零风险的 SKU 排在同一档。 */
    const [zeroSku] = await db.insert(skus).values({
      code: "RSK-ZERO", name: "RSK-ZERO", spuId: spu.id, brandId: brand.id, skuType: "finished",
      baseUom: "支", active: true, nearExpiryDays: 90,
    }).returning();
    genuineZero = zeroSku.id;
    await db.insert(stockBalances).values({ skuId: zeroSku.id, warehouseId: wh.id, batchId: null, qty: "800.0000" });
    await db.insert(skuCosts).values({ skuId: zeroSku.id, unitCost: "50.0000" });
    // 无临期批次、无销量 → 滞销关注（进列表），nearQty = 0 → 风险金额 0.00
  });

  it("T7 金额由全精度数量算出：屏显（1dp）与导出（precise）逐分相同", async () => {
    const screen = await getRiskWorklist({ withValue: true, all: true }, db);
    const exported = await getRiskWorklist({ withValue: true, all: true, precise: true }, db);

    const s = screen.rows.find((r) => r.skuId === fractional)!;
    const e = exported.rows.find((r) => r.skuId === fractional)!;
    expect(s, "分数数量的 SKU 必须进风险清单，否则本用例是空的").toBeDefined();

    expect(s.onHand, "屏显数量仍是 1 位小数").toBe(10.1);
    expect(e.onHand, "导出走全精度").toBe(10.05);
    expect(
      s.amount,
      "金额必须来自全精度 10.05 × 1000 = 10050.00；用屏显的 10.1 会算成 10100.00",
    ).toBe("10050.00");
    expect(e.amount, "导出与屏显的金额必须逐分相同").toBe(s.amount);
    expect(e.atRiskAmount).toBe(s.atRiskAmount);
  });

  it("T3 金额排序在服务端全集上做：第 1 页第 1 行就是全局最贵的那条", async () => {
    // 每页只有 1 行：客户端比较器在这种分页下完全失效，只有服务端序才可能正确
    const p1 = await getRiskWorklist({ withValue: true, sort: "atRiskAmount", page: 1, pageSize: 1 }, db);
    expect(p1.sort).toBe("atRiskAmount");
    expect(p1.total).toBeGreaterThan(1);
    expect(
      p1.rows[0].skuId,
      "「先处置钱最多的」：全局最贵的那条必须出现在第 1 页；客户端只排当页时它会沉在后面的页",
    ).toBe(priciest);
  });

  it("T3 没有单位成本的行显式排在最后，且与「算出来就是 ¥0」的行可区分", async () => {
    const all = await getRiskWorklist({ withValue: true, sort: "atRiskAmount", all: true }, db);
    const idx = all.rows.findIndex((r) => r.skuId === uncosted);
    const zeroIdx = all.rows.findIndex((r) => r.skuId === genuineZero);
    const withMoney = all.rows.filter((r) => r.atRiskAmount != null);

    expect(all.rows[idx].atRiskAmount, "没成本就是没成本，不是 ¥0").toBeNull();
    expect(all.rows[zeroIdx].atRiskAmount, "这一行是真的零元（有成本、无临期量）").toBe("0.00");
    expect(
      idx,
      "无成本的行必须整体置后：把它当 ¥0 排会让一个 5000 件的 SKU 被判成最不值钱的货",
    ).toBeGreaterThanOrEqual(withMoney.length);
    expect(
      zeroIdx,
      "`Number(x ?? 0)` 会让「没成本」与「零元」打平；有金额的行（哪怕是 0.00）必须排在无成本之前",
    ).toBeLessThan(idx);
    expect(all.costCoverage).toEqual({ covered: withMoney.length, total: all.rows.length });
  });

  it("缺省排序仍是动作优先级（不因为加了金额序就换掉默认口径）", async () => {
    const def = await getRiskWorklist({ withValue: true, all: true }, db);
    expect(def.sort).toBe("action");
    // 无金额权限时金额序一律回落 action（免得下发一个排不出来的序）
    const noMoney = await getRiskWorklist({ all: true, sort: "atRiskAmount" }, db);
    expect(noMoney.sort).toBe("action");
    expect(noMoney.moneyCalibre).toBeNull();
    expect(noMoney.costCoverage).toBeNull();
  });

  it("T10 口径说明随金额一起下发：成本来源 / 两套数量 / as-of / 覆盖率一句都不能少", async () => {
    const r = await getRiskWorklist({ withValue: true, all: true }, db);
    expect(r.moneyCalibre?.key).toBe(RISK_MONEY_CALIBRE_KEY);
    expect(r.moneyCalibre?.costSource, "必须说清单位成本来自哪里").toContain("core/valuation");
    expect(r.moneyCalibre?.amountBasis, "在库金额的分子是记账在库").toContain("记账在库");
    expect(r.moneyCalibre?.atRiskBasis, "风险金额的分子是 batch_stocks 参考层").toContain("batch_stocks");
    expect(
      r.moneyCalibre?.asOfNote,
      "两个金额来自两套数量、两个 as-of —— 风险金额可能大于在库金额，这是口径差不是错账",
    ).toContain("as-of");
    expect(r.moneyCalibre?.sortNote).toContain("服务端");
    expect(r.moneyCalibre?.precisionNote).toContain("全精度");
    expect(RISK_MONEY_CALIBRE.key).toBe(RISK_MONEY_CALIBRE_KEY);
  });
});
