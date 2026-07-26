/**
 * RED TEAM — R1 价格规则 / R5 结算 / R11 净需求 边界攻击。
 * 约定：断言【正确】行为；用例失败 = 漏洞证实。
 */
import { describe, expect, it } from "vitest";
import { checkPriceDeviation, normalizeToBaseNet } from "@/server/rules/price";
import { suggestQty } from "@/server/rules/netreq";
import { settle } from "@/server/rules/settlement";

describe("redteam/price", () => {
  it("[BUG?] 基准价=0（免费样品/归零价）时偏差检查不应裸抛 division by zero", () => {
    // 正确行为：优雅处理（视为需 PC 或视同首购），而非未分类 Error 直接 500
    expect(() =>
      checkPriceDeviation({ baselineBaseNet: "0", newBaseNet: "1.00", tolerancePct: "3" }),
    ).not.toThrow();
  });

  it("[BUG?] 基准价可被归一化产出为 0.00：price=0.001, factor=1 → '0.00'（为上一条铺路）", () => {
    // normalizeToBaseNet 落金额口径 scale=2，会把微小价抹成 0.00 存为基准价
    const baseline = normalizeToBaseNet({
      price: "0.001", taxIncluded: false, taxRatePct: "13", uomFactor: "1",
    });
    expect(baseline).toBe("0.00");
    // 该 0.00 一旦成为基准价，后续任何报价的偏差检查都会炸
    expect(() =>
      checkPriceDeviation({ baselineBaseNet: baseline, newBaseNet: "0.002", tolerancePct: "3" }),
    ).not.toThrow();
  });

  it("[BUG?] uomFactor=0 应被拒绝为业务校验错误，而非裸 division by zero", () => {
    expect(() =>
      normalizeToBaseNet({ price: "10", taxIncluded: false, taxRatePct: "13", uomFactor: "0" }),
    ).toThrow(/uomFactor|换算系数/); // 期望是可识别的业务错误信息
  });

  it("taxIncluded=false 且 taxRatePct=13：税率被忽略（报价已未税，符合口径）", () => {
    expect(
      normalizeToBaseNet({ price: "100", taxIncluded: false, taxRatePct: "13", uomFactor: "1" }),
    ).toBe("100.00");
  });

  it("含税归一化：113 含税 13% → 100.00；负偏差对称判定", () => {
    expect(
      normalizeToBaseNet({ price: "113", taxIncluded: true, taxRatePct: "13", uomFactor: "1" }),
    ).toBe("100.00");
    const down = checkPriceDeviation({ baselineBaseNet: "100", newBaseNet: "96.90", tolerancePct: "3" });
    expect(down.deviationPct).toBe("-3.10");
    expect(down.requiresPc).toBe(true);
    const edge = checkPriceDeviation({ baselineBaseNet: "100", newBaseNet: "97.00", tolerancePct: "3" });
    expect(edge.requiresPc).toBe(false); // |−3| == 3 不超容差
  });

  it("首购 null 基准价免检", () => {
    expect(checkPriceDeviation({ baselineBaseNet: null, newBaseNet: "5", tolerancePct: "3" })).toEqual({
      deviationPct: null, requiresPc: false,
    });
  });
});

describe("redteam/netreq", () => {
  it("净需求 ≤0 → 0；MOQ/倍数不得把 0 抬成正数", () => {
    expect(suggestQty({ grossReq: "5", onHand: "10", inTransit: "0", moq: "100", orderMultiple: "7" })).toBe("0.0000");
  });

  it("负 MOQ / 0 倍数不破坏结果", () => {
    expect(suggestQty({ grossReq: "5", onHand: "0", inTransit: "0", moq: "-3", orderMultiple: "0" })).toBe("5.0000");
  });

  it("MOQ 先于倍数：net=5, moq=10, multiple=3 → 12", () => {
    expect(suggestQty({ grossReq: "5", onHand: "0", inTransit: "0", moq: "10", orderMultiple: "3" })).toBe("12.0000");
  });

  it("小数倍数向上取整：net=1, multiple=0.3 → 1.2", () => {
    expect(suggestQty({ grossReq: "1", onHand: "0", inTransit: "0", orderMultiple: "0.3" })).toBe("1.2000");
  });
});

describe("redteam/settlement", () => {
  const baseMat = {
    materialSkuId: 1, qtyPer: "2", issuedQty: "0", returnedQty: "0",
    allowedLossRatePct: "0", avgPrice: "10",
  };

  it("全零输入 → 全零结果，不抛错", () => {
    const r = settle({
      goodQty: "0", concessionQty: "0", spareQty: "0",
      feeSegments: [], concessionPrice: "0", manualAdj: "0",
      materials: [{ ...baseMat }],
    });
    expect(r.effectiveQty).toBe("0.0000");
    expect(r.settleAmount).toBe("0.00");
    expect(r.lines[0].excessLoss).toBe("0.0000");
  });

  it("[INFO] 负数量输入（goodQty=-5）无任何校验，产出负有效完工数——纯函数信任调用方", () => {
    const r = settle({
      goodQty: "-5", concessionQty: "0", spareQty: "0",
      feeSegments: [], concessionPrice: "0", manualAdj: "0",
      materials: [{ ...baseMat, issuedQty: "0" }],
    });
    // 特征化：当前行为 effectiveQty=-5，实际损耗=0-(-10)=+10 → 可被用来伪造扣款
    expect(r.effectiveQty).toBe("-5.0000");
  });

  it("省料不得跨物料轧差：A 超损扣款、B 省料钳零", () => {
    const r = settle({
      goodQty: "10", concessionQty: "0", spareQty: "0",
      feeSegments: [{ qty: "10", rate: "1" }], concessionPrice: "0", manualAdj: "0",
      materials: [
        { materialSkuId: 1, qtyPer: "1", issuedQty: "15", returnedQty: "0", allowedLossRatePct: "10", avgPrice: "10" }, // 实损5 允1 超4 → 扣40
        { materialSkuId: 2, qtyPer: "1", issuedQty: "5", returnedQty: "0", allowedLossRatePct: "10", avgPrice: "10" }, // 省料 → 0
      ],
    });
    expect(r.lines[0].deductAmount).toBe("40.00");
    expect(r.lines[1].excessLoss).toBe("0.0000");
    expect(r.deductionTotal).toBe("40.00");
    expect(r.settleAmount).toBe("-30.00"); // 10 − 40：允许负结算（应付为负=向工厂索赔）
  });

  it("巨量不溢出：1e10 数量 × 1e3 单价", () => {
    const r = settle({
      goodQty: "10000000000", concessionQty: "0", spareQty: "0",
      feeSegments: [{ qty: "10000000000", rate: "1000" }], concessionPrice: "0", manualAdj: "0",
      materials: [],
    });
    expect(r.feePayable).toBe("10000000000000.00");
  });
});
