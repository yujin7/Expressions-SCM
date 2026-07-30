import { describe, expect, it } from "vitest";
import {
  BomCycleError,
  BomDepthError,
  MAX_BOM_DEPTH,
  explode,
  grossFromBom,
  type BomLineLike,
} from "@/server/rules/bom-explode";

describe("E2-07 BOM 展开 grossFromBom()（双损耗，口径同 wo.ts 快照）", () => {
  it("无损耗：毛需求 = 计划产量 × 净单位用量", () => {
    expect(grossFromBom({ planQty: "1000", qtyPer: "2.5" })).toBe("2500.0000");
    expect(grossFromBom({ planQty: "1000", qtyPer: "2.5", incomingLossPct: "0", productionLossPct: "0", lossRatePct: "0" }))
      .toBe("2500.0000");
  });

  it("双损耗相乘放大毛需求：5% + 5% = ×1.1025（不是 ×1.10）", () => {
    // 1000 × 1 × (1+0.05) × (1+0.05) = 1102.5
    expect(grossFromBom({ planQty: "1000", qtyPer: "1", incomingLossPct: "5", productionLossPct: "5" }))
      .toBe("1102.5000");
  });

  it("来料损耗与生产损耗顺序正确：两者对调结果相同（相乘可交换），但均生效", () => {
    const a = grossFromBom({ planQty: "1000", qtyPer: "2", incomingLossPct: "10", productionLossPct: "3" });
    const b = grossFromBom({ planQty: "1000", qtyPer: "2", incomingLossPct: "3", productionLossPct: "10" });
    // 2 × 1.10 × 1.03 × 1000 = 2266
    expect(a).toBe("2266.0000");
    expect(b).toBe("2266.0000");
    // 只有单边损耗时也必须生效（不能被另一边的 0 吞掉走 legacy 分支）
    expect(grossFromBom({ planQty: "1000", qtyPer: "2", incomingLossPct: "10", productionLossPct: "0", lossRatePct: "99" }))
      .toBe("2200.0000");
    expect(grossFromBom({ planQty: "1000", qtyPer: "2", incomingLossPct: "0", productionLossPct: "3", lossRatePct: "99" }))
      .toBe("2060.0000");
  });

  it("legacy 回退：双损耗列均为 0 时用旧列 lossRatePct（存量 BOM 兼容）", () => {
    // 1000 × 2 × (1+0.08) = 2160
    expect(grossFromBom({ planQty: "1000", qtyPer: "2", incomingLossPct: "0", productionLossPct: "0", lossRatePct: "8" }))
      .toBe("2160.0000");
    // 双损耗有值时 legacy 列被忽略（不叠加）
    expect(grossFromBom({ planQty: "1000", qtyPer: "2", incomingLossPct: "5", productionLossPct: "5", lossRatePct: "50" }))
      .toBe("2205.0000");
  });

  it("null/undefined 损耗按 0 处理（drizzle 可空列兜底）", () => {
    expect(grossFromBom({ planQty: "100", qtyPer: "3", incomingLossPct: null, productionLossPct: null, lossRatePct: null }))
      .toBe("300.0000");
  });
});

describe("E2-07 explode()：多成品需求 → 末级物料毛需求合计（多层）", () => {
  const bom = new Map<number, BomLineLike[]>([
    // 成品 1：料 100（单耗 2，双损耗 5%/5%）、料 200（单耗 1，无损耗）
    [1, [
      { materialSkuId: 100, qtyPer: "2", incomingLossPct: "5", productionLossPct: "5", lossRatePct: "0" },
      { materialSkuId: 200, qtyPer: "1", incomingLossPct: "0", productionLossPct: "0", lossRatePct: "0" },
    ]],
    // 成品 2：共用料 200（单耗 3，legacy 损耗 10%）
    [2, [
      { materialSkuId: 200, qtyPer: "3", incomingLossPct: "0", productionLossPct: "0", lossRatePct: "10" },
    ]],
  ]);

  it("同一物料被多成品共用时毛需求求和", () => {
    const out = explode([{ skuId: 1, qty: "100" }, { skuId: 2, qty: "50" }], bom);
    // 料 100：100 × 2 × 1.1025 = 220.5
    expect(out.get(100)).toBe("220.5000");
    // 料 200：成品1 100×1=100 + 成品2 50×3×1.1=165 → 265
    expect(out.get(200)).toBe("265.0000");
    expect(out.size).toBe(2);
  });

  it("空 BOM / 无 BOM 的成品 / 零需求 → 返回空", () => {
    expect(explode([{ skuId: 1, qty: "100" }], new Map()).size).toBe(0);
    expect(explode([{ skuId: 9, qty: "100" }], bom).size).toBe(0); // 成品 9 无生效 BOM
    expect(explode([{ skuId: 1, qty: "0" }], bom).size).toBe(0);
    expect(explode([], bom).size).toBe(0);
    expect(explode([{ skuId: 1, qty: "100" }], new Map([[1, []]])).size).toBe(0);
  });

  it("数字入参与字符串入参等价（禁 float：内部全程 decimal）", () => {
    expect(explode([{ skuId: 1, qty: 100 }], bom).get(100)).toBe("220.5000");
  });

  it("逐层展开半成品并逐层应用损耗，中间半成品不重复计作末级物料", () => {
    const nested = new Map<number, BomLineLike[]>([
      [1, [{ materialSkuId: 10, qtyPer: "2", incomingLossPct: "10", productionLossPct: "0" }]],
      [10, [{ materialSkuId: 100, qtyPer: "3", incomingLossPct: "5", productionLossPct: "0" }]],
    ]);
    const out = explode([{ skuId: 1, qty: "100" }], nested);
    // 第 1 层：100 × 2 × 1.10 = 220；第 2 层：220 × 3 × 1.05 = 693
    expect(out.get(100)).toBe("693.0000");
    expect(out.has(10)).toBe(false);
    expect(out.size).toBe(1);
  });

  it("同一末级物料经多条多层路径汇入时精确合计", () => {
    const diamond = new Map<number, BomLineLike[]>([
      [1, [
        { materialSkuId: 10, qtyPer: "2" },
        { materialSkuId: 20, qtyPer: "4" },
      ]],
      [10, [{ materialSkuId: 100, qtyPer: "3" }]],
      [20, [{ materialSkuId: 100, qtyPer: "5" }]],
    ]);
    // 10 × 2 × 3 + 10 × 4 × 5 = 260
    expect(explode([{ skuId: 1, qty: "10" }], diamond).get(100)).toBe("260.0000");
  });

  it("循环时抛出明确路径且不返回任何部分结果", () => {
    const cyclic = new Map<number, BomLineLike[]>([
      [1, [
        { materialSkuId: 100, qtyPer: "1" },
        { materialSkuId: 2, qtyPer: "1" },
      ]],
      [2, [{ materialSkuId: 1, qtyPer: "1" }]],
    ]);
    expect(() => explode([{ skuId: 1, qty: "10" }], cyclic)).toThrow(BomCycleError);
    try {
      explode([{ skuId: 1, qty: "10" }], cyclic);
    } catch (error) {
      expect(error).toBeInstanceOf(BomCycleError);
      expect((error as BomCycleError).cycle).toEqual([1, 2, 1]);
    }
  });

  it(`超过 ${MAX_BOM_DEPTH} 层时阻断，避免递归耗尽或静默截断`, () => {
    const deep = new Map<number, BomLineLike[]>();
    for (let id = 1; id <= MAX_BOM_DEPTH + 1; id++) {
      deep.set(id, [{ materialSkuId: id + 1, qtyPer: "1" }]);
    }
    expect(() => explode([{ skuId: 1, qty: "1" }], deep)).toThrow(BomDepthError);
  });
});
