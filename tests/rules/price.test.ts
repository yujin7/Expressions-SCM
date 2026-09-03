import { describe, it, expect } from "vitest";
import { normalizeToBaseNet, checkPriceDeviation, normalizeLineNetGross } from "@/server/rules/price";

describe("R1 normalizeToBaseNet（基础单位未税比价口径）", () => {
  it("120元/箱、12个/箱、含税13% → ≈8.85 元/个（未税）", () => {
    const v = normalizeToBaseNet({
      price: "120",
      taxIncluded: true,
      taxRatePct: "13",
      uomFactor: "12",
    });
    expect(v).toBe("8.85"); // 120 ÷ 1.13 ÷ 12
  });

  it("未税报价不做税剥离，仅做单位换算", () => {
    const v = normalizeToBaseNet({
      price: "120",
      taxIncluded: false,
      taxRatePct: "13",
      uomFactor: "12",
    });
    expect(v).toBe("10.00"); // 120 ÷ 12
  });

  it("基础单位未税报价原样落金额口径", () => {
    const v = normalizeToBaseNet({
      price: "9.5",
      taxIncluded: false,
      taxRatePct: "13",
      uomFactor: "1",
    });
    expect(v).toBe("9.50");
  });
});

describe("R1 checkPriceDeviation（容差与首购免检）", () => {
  it("8.85 → 9.50，容差3% → 偏差 +7.34%，需 PC（符号为正）", () => {
    const baseline = normalizeToBaseNet({
      price: "120",
      taxIncluded: true,
      taxRatePct: "13",
      uomFactor: "12",
    });
    const r = checkPriceDeviation({
      baselineBaseNet: baseline,
      newBaseNet: "9.50",
      tolerancePct: "3",
    });
    expect(r.deviationPct).toBe("7.34"); // (9.50−8.85)/8.85×100
    expect(r.deviationPct!.startsWith("-")).toBe(false);
    expect(r.requiresPc).toBe(true);
  });

  it("降价方向：10 → 9，容差3% → 偏差 −10.00%，需 PC（符号为负）", () => {
    const r = checkPriceDeviation({
      baselineBaseNet: "10.00",
      newBaseNet: "9.00",
      tolerancePct: "3",
    });
    expect(r.deviationPct).toBe("-10.00");
    expect(r.requiresPc).toBe(true);
  });

  it("换算后同价 → 偏差 0.00，不触发 PC", () => {
    const newBaseNet = normalizeToBaseNet({
      price: "120",
      taxIncluded: true,
      taxRatePct: "13",
      uomFactor: "12",
    });
    const r = checkPriceDeviation({
      baselineBaseNet: "8.85",
      newBaseNet,
      tolerancePct: "3",
    });
    expect(r.deviationPct).toBe("0.00");
    expect(r.requiresPc).toBe(false);
  });

  it("偏差恰好等于容差 → 不触发 PC（严格大于才触发）", () => {
    const r = checkPriceDeviation({
      baselineBaseNet: "100.00",
      newBaseNet: "103.00",
      tolerancePct: "3",
    });
    expect(r.deviationPct).toBe("3.00");
    expect(r.requiresPc).toBe(false);
  });

  it("首购（基准价为 null）→ 免检，不触发 PC", () => {
    const r = checkPriceDeviation({
      baselineBaseNet: null,
      newBaseNet: "9.50",
      tolerancePct: "3",
    });
    expect(r.deviationPct).toBeNull();
    expect(r.requiresPc).toBe(false);
  });
});

describe("normalizeLineNetGross（D63/D64 行未税/含税并列，采购订单口径唯一实现）", () => {
  it("含税报价：113.00 × 10、13% → 未税 1000.00 / 含税 1130.00", () => {
    expect(normalizeLineNetGross({ price: "113.00", qty: "10", taxIncluded: true, taxRatePct: "13" })).toEqual({ net: "1000.00", gross: "1130.00" });
  });

  it("未税报价：20.00 × 5、13% → 未税 100.00 / 含税 113.00", () => {
    expect(normalizeLineNetGross({ price: "20.00", qty: "5", taxIncluded: false, taxRatePct: "13" })).toEqual({ net: "100.00", gross: "113.00" });
  });

  it("含税去税按 scale 6 中间量半进位落金额 scale 2", () => {
    expect(normalizeLineNetGross({ price: "124.30", qty: "20", taxIncluded: true, taxRatePct: "13" })).toEqual({ net: "2200.00", gross: "2486.00" });
    expect(normalizeLineNetGross({ price: "101.70", qty: "10", taxIncluded: true, taxRatePct: "13" })).toEqual({ net: "900.00", gross: "1017.00" });
  });

  it("零税率：未税 = 含税；小数数量不丢精度", () => {
    expect(normalizeLineNetGross({ price: "9.99", qty: "3.5", taxIncluded: false, taxRatePct: "0" })).toEqual({ net: "34.97", gross: "34.97" });
    expect(normalizeLineNetGross({ price: "9.99", qty: "3.5", taxIncluded: true, taxRatePct: "0" })).toEqual({ net: "34.97", gross: "34.97" });
  });
});
