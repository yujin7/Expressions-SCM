/** D60 调拨成本/数量/零散规则（rules/transfer-cost.ts）：单点 alert 必中、σ=0 不报、n<8 只出 watch、掩蔽场景 MAD 命中 */
import { describe, expect, it } from "vitest";
import { deviation, laneBaseline, qtyAnomaly, scatteredLane, unitFee } from "@/server/rules/transfer-cost";

const day = (i: number) => new Date(Date.parse("2026-08-01T00:00:00Z") + i * 86_400_000).toISOString().slice(0, 10);

describe("unitFee / laneBaseline", () => {
  it("单位费用 = 费用 ÷ 件数（scale 4）；件数 ≤ 0 → null", () => {
    expect(unitFee({ feeTotal: "300.00", qty: "120" })).toBe("2.5000");
    expect(unitFee({ feeTotal: "300.00", qty: 0 })).toBeNull();
  });
  it("数量加权均价 Σfee/Σqty（不是单价平均），窗口 (asOf−window, asOf]，负费用/零件数不计", () => {
    const b = laneBaseline([
      { date: day(0), qty: "100", feeTotal: "100.00" }, // 1.0/件
      { date: day(1), qty: "10", feeTotal: "30.00" },   // 3.0/件
      { date: day(2), qty: "0", feeTotal: "50.00" },    // 不计
      { date: day(3), qty: "10", feeTotal: "-5.00" },   // 不计
      { date: "2025-01-01", qty: "10", feeTotal: "100.00" }, // 窗口外
    ], 180, day(10));
    expect(b.samples).toBe(2);
    expect(b.avgUnitFee).toBe("1.1818"); // 130/110
    expect(b.median).toBe("2.0000");     // (1+3)/2
    expect(b.unitFees).toEqual(["1.0000", "3.0000"]);
    expect(b.windowStart).toBe(new Date(Date.parse(`${day(10)}T00:00:00Z`) - 179 * 86_400_000).toISOString().slice(0, 10));
  });
  it("无样本 → avg/median null", () => {
    expect(laneBaseline([], 180, day(0))).toMatchObject({ avgUnitFee: null, median: null, samples: 0 });
  });
});

describe("deviation", () => {
  const stable = Array.from({ length: 10 }, (_, i) => ({ date: day(i), qty: "100", feeTotal: `${200 + (i % 3) * 2}.00` })); // 2.00/2.02/2.04
  it("n<8：超阈值只出 watch 并标样本不足，永不 alert", () => {
    const b = laneBaseline(stable.slice(0, 5), 180, day(20));
    const r = deviation("10.0000", b, { thresholdPct: 20 });
    expect(r.level).toBe("watch");
    expect(r.insufficient).toBe(true);
    expect(r.z).toBeNull();
    expect(deviation("2.1000", b, { thresholdPct: 20 }).level).toBe("ok");
  });
  it("n≥8：单点越 3σ 必中 alert；2–3σ watch；带内 ok", () => {
    const b = laneBaseline(stable, 180, day(20));
    expect(b.samples).toBe(10);
    const alert = deviation("10.0000", b, { thresholdPct: 20 });
    expect(alert.level).toBe("alert");
    expect(alert.z).not.toBeNull();
    expect(Math.abs(alert.z!)).toBeGreaterThan(3);
    // center=2.02, MAD=0.02 → σ≈0.02965；2.09 ≈ +2.4σ → watch
    expect(deviation("2.0900", b, { thresholdPct: 20 }).level).toBe("watch");
    expect(deviation("2.0300", b, { thresholdPct: 20 }).level).toBe("ok");
  });
  it("n≥8 统计带内但偏离基线超阈值 → 仍 watch（D60 提醒不阻断）", () => {
    const b = laneBaseline(stable, 180, day(20));
    const r = deviation("2.0400", b, { thresholdPct: 0.5 });
    expect(r.level).toBe("watch");
    expect(r.z).not.toBeNull();
    expect(Math.abs(r.z!)).toBeLessThanOrEqual(2);
  });
  it("σ=0（历史恒定）不出统计信号：超阈值 watch，否则 ok", () => {
    const flat = Array.from({ length: 9 }, (_, i) => ({ date: day(i), qty: "100", feeTotal: "200.00" }));
    const b = laneBaseline(flat, 180, day(20));
    expect(deviation("2.0000", b, { thresholdPct: 20 }).level).toBe("ok");
    const r = deviation("3.0000", b, { thresholdPct: 20 });
    expect(r.level).toBe("watch");
    expect(r.reason).toContain("σ=0");
  });
  it("掩蔽场景：历史含一个大离群点，MAD 仍能命中新的离群单", () => {
    const hist = [
      ...Array.from({ length: 9 }, (_, i) => ({ date: day(i), qty: "100", feeTotal: `${200 + (i % 2)}.00` })),
      { date: day(9), qty: "100", feeTotal: "2000.00" }, // 历史离群
    ];
    const b = laneBaseline(hist, 180, day(20));
    expect(deviation("6.0000", b, { thresholdPct: 20 }).level).toBe("alert");
  });
  it("无基线或本单无单位费用 → ok 并说明", () => {
    expect(deviation("2.0", laneBaseline([], 180, day(0)), { thresholdPct: 20 })).toMatchObject({ level: "ok", pctDev: null, insufficient: true });
    expect(deviation(null, laneBaseline(stable, 180, day(20)), { thresholdPct: 20 }).level).toBe("ok");
  });
});

describe("qtyAnomaly / scatteredLane", () => {
  it("样本 <8 → insufficient（明示不判定）", () => {
    const r = qtyAnomaly("1000", Array.from({ length: 7 }, () => ({ qty: "100" })));
    expect(r.level).toBe("insufficient");
    expect(r.median).toBe("100.0000");
    expect(r.ratio).toBe("10.00");
  });
  it("本单 > 中位数 × 3 → watch；否则 ok；零件数历史不计", () => {
    const hist = [...Array.from({ length: 8 }, (_, i) => ({ qty: String(90 + i * 3) })), { qty: "0" }];
    expect(qtyAnomaly("400", hist).level).toBe("watch");
    expect(qtyAnomaly("300", hist).level).toBe("ok");
    expect(qtyAnomaly("250", hist, 2).level).toBe("watch");
  });
  it("30 天同线路 > maxDocs 单 → 零散", () => {
    expect(scatteredLane(5)).toEqual({ scattered: true, docs: 5, maxDocs: 4 });
    expect(scatteredLane([1, 2, 3, 4])).toEqual({ scattered: false, docs: 4, maxDocs: 4 });
    expect(scatteredLane(3, 2).scattered).toBe(true);
  });
});
