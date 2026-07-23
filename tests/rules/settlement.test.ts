import { describe, it, expect } from "vitest";
import { settle, type SettleInput } from "@/server/rules/settlement";

/** 便捷构造：单物料默认输入 */
function base(over: Partial<SettleInput> = {}): SettleInput {
  return {
    goodQty: "10000",
    concessionQty: "0",
    spareQty: "0",
    feeSegments: [{ qty: "10000", rate: "2.00" }],
    concessionPrice: "0",
    manualAdj: "0",
    materials: [
      {
        materialSkuId: 1,
        qtyPer: "1",
        issuedQty: "11000",
        returnedQty: "0",
        allowedLossRatePct: "5",
        avgPrice: "1.50",
      },
    ],
    ...over,
  };
}

describe("R5 委外结算 settle()", () => {
  it("审计反例：发料11000/退料0/合格10000/损耗率5% → 超损=500（旧公式算出0即为错）", () => {
    const r = settle(base());
    const line = r.lines[0]!;
    expect(r.effectiveQty).toBe("10000.0000");
    expect(line.stdQty).toBe("10000.0000");
    expect(line.allowedLoss).toBe("500.0000");
    expect(line.actualLoss).toBe("1000.0000");
    // 关键断言：超损 = max(0, 实际损耗1000 − 允许损耗500) = 500，绝不能是 0
    expect(line.excessLoss).toBe("500.0000");
    expect(line.deductAmount).toBe("750.00"); // 500 × 1.50
    expect(r.feePayable).toBe("20000.00");
    expect(r.deductionTotal).toBe("750.00");
    expect(r.settleAmount).toBe("19250.00");
  });

  it("损耗恰好等于允许值（边界）→ 超损为 0", () => {
    const r = settle(
      base({
        materials: [
          {
            materialSkuId: 1,
            qtyPer: "1",
            issuedQty: "10500", // 实际损耗 500 = 允许损耗 500
            returnedQty: "0",
            allowedLossRatePct: "5",
            avgPrice: "1.50",
          },
        ],
      }),
    );
    expect(r.lines[0]!.actualLoss).toBe("500.0000");
    expect(r.lines[0]!.excessLoss).toBe("0.0000");
    expect(r.lines[0]!.deductAmount).toBe("0.00");
    expect(r.deductionTotal).toBe("0.00");
  });

  it("超过允许值 1 个单位 → 超损为正", () => {
    const r = settle(
      base({
        materials: [
          {
            materialSkuId: 1,
            qtyPer: "1",
            issuedQty: "10501", // 实际损耗 501，允许 500
            returnedQty: "0",
            allowedLossRatePct: "5",
            avgPrice: "1.50",
          },
        ],
      }),
    );
    expect(r.lines[0]!.excessLoss).toBe("1.0000");
    expect(r.lines[0]!.deductAmount).toBe("1.50");
  });

  it("多物料禁止轧差：纸箱省料（负损耗）不得冲抵薄膜超损", () => {
    const r = settle(
      base({
        materials: [
          {
            // 薄膜：超损 500 → 扣 1000.00
            materialSkuId: 1,
            qtyPer: "1",
            issuedQty: "11000",
            returnedQty: "0",
            allowedLossRatePct: "5",
            avgPrice: "2.00",
          },
          {
            // 纸箱：标准用量 5000，仅发 4000 → 实际损耗 -1000（省料）
            materialSkuId: 2,
            qtyPer: "0.5",
            issuedQty: "4000",
            returnedQty: "0",
            allowedLossRatePct: "5",
            avgPrice: "3.00",
          },
        ],
      }),
    );
    const film = r.lines.find((l) => l.materialSkuId === 1)!;
    const carton = r.lines.find((l) => l.materialSkuId === 2)!;
    expect(film.excessLoss).toBe("500.0000");
    expect(film.deductAmount).toBe("1000.00");
    expect(carton.actualLoss).toBe("-1000.0000");
    expect(carton.excessLoss).toBe("0.0000"); // 逐行钳零
    expect(carton.deductAmount).toBe("0.00");
    // 合计只含薄膜，省料绝不抵扣
    expect(r.deductionTotal).toBe("1000.00");
  });

  it("备品+让步计入有效完工数（消耗物料），但备品不计加工费、让步按让步单价", () => {
    const r = settle(
      base({
        goodQty: "9000",
        concessionQty: "1000",
        spareQty: "200",
        feeSegments: [{ qty: "9000", rate: "2.00" }], // 仅合格数分段计费
        concessionPrice: "1.50",
        materials: [
          {
            materialSkuId: 1,
            qtyPer: "1",
            issuedQty: "10200",
            returnedQty: "0",
            allowedLossRatePct: "5",
            avgPrice: "1.00",
          },
        ],
      }),
    );
    expect(r.effectiveQty).toBe("10200.0000"); // 9000+1000+200
    expect(r.lines[0]!.stdQty).toBe("10200.0000"); // 标准用量按 10200 计
    expect(r.lines[0]!.actualLoss).toBe("0.0000");
    // 加工费 = 9000×2.00 + 1000×1.50 = 19500；备品 200 分文不取（若误计则为 19900）
    expect(r.feePayable).toBe("19500.00");
  });

  it("加工费分段：4000@2.00 + 5500@2.20 + 让步 500@3.00 → 8000+12100+1500", () => {
    const r = settle(
      base({
        goodQty: "9500",
        concessionQty: "500",
        spareQty: "0",
        feeSegments: [
          { qty: "4000", rate: "2.00" },
          { qty: "5500", rate: "2.20" },
        ],
        concessionPrice: "3.00",
        materials: [
          {
            materialSkuId: 1,
            qtyPer: "1",
            issuedQty: "10000",
            returnedQty: "0",
            allowedLossRatePct: "5",
            avgPrice: "1.00",
          },
        ],
      }),
    );
    expect(r.feePayable).toBe("21600.00");
    expect(r.settleAmount).toBe("21600.00"); // 无超损、无调整
  });

  it("手工调整为正 → 结算金额相应增加", () => {
    const r = settle(base({ manualAdj: "100" }));
    expect(r.settleAmount).toBe("19350.00"); // 20000 − 750 + 100
  });

  it("手工调整为负 → 结算金额相应减少", () => {
    const r = settle(base({ manualAdj: "-100" }));
    expect(r.settleAmount).toBe("19150.00"); // 20000 − 750 − 100
  });

  it("零损耗边界：发料 = 退料 + 标准用量 → 实际损耗 0、无扣款", () => {
    const r = settle(
      base({
        materials: [
          {
            materialSkuId: 1,
            qtyPer: "1",
            issuedQty: "10200",
            returnedQty: "200", // 10200 − 200 − 10000 = 0
            allowedLossRatePct: "5",
            avgPrice: "1.50",
          },
        ],
      }),
    );
    expect(r.lines[0]!.actualLoss).toBe("0.0000");
    expect(r.lines[0]!.excessLoss).toBe("0.0000");
    expect(r.deductionTotal).toBe("0.00");
    expect(r.settleAmount).toBe("20000.00");
  });
});
