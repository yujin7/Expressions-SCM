/** E2-01 安全库存纯规则测试 */
import { describe, expect, it } from "vitest";
import { safetyStock, stdev, SERVICE_LEVEL_Z } from "@/server/rules/safety-stock";

describe("stdev", () => {
  it("样本标准差（n-1）", () => {
    expect(stdev([2, 4, 4, 4, 5, 5, 7, 9])!).toBeCloseTo(2.138, 2);
  });
  it("样本<2 → null", () => {
    expect(stdev([5])).toBeNull();
  });
});

describe("safetyStock", () => {
  const base = { daily: 100, leadDays: 30, monthly: [3000, 3200, 2800, 3400, 3000, 3100] };

  it("统计法：波动越大安全库存越高", () => {
    const stable = safetyStock({ ...base, monthly: [3000, 3010, 2990, 3005, 2995, 3000] });
    const volatile = safetyStock({ ...base, monthly: [1000, 5000, 2000, 6000, 1500, 4500] });
    expect(stable.method).toBe("statistical");
    expect(volatile.method).toBe("statistical");
    expect(volatile.safetyQty).toBeGreaterThan(stable.safetyQty);
  });

  it("统计法：服务水平越高安全库存越高", () => {
    const s95 = safetyStock({ ...base, serviceLevel: "95" });
    const s99 = safetyStock({ ...base, serviceLevel: "99" });
    expect(s99.safetyQty).toBeGreaterThan(s95.safetyQty);
    expect(s99.detail.z).toBe(SERVICE_LEVEL_Z["99"]);
  });

  it("交期波动推高安全库存", () => {
    const fixed = safetyStock({ ...base, leadDaysStdev: 0 });
    const varying = safetyStock({ ...base, leadDaysStdev: 10 });
    expect(varying.safetyQty).toBeGreaterThan(fixed.safetyQty);
    expect(varying.reason).toContain("交期波动");
  });

  it("样本不足 → fallback 且注明原因（不假装统计）", () => {
    const r = safetyStock({ ...base, monthly: [3000, 3100], fallbackDays: 7 });
    expect(r.method).toBe("fallback");
    expect(r.safetyQty).toBe(700); // 100/日 × 7 天
    expect(r.reason).toContain("样本不足");
  });

  it("缺生产周期 → fallback 并注明", () => {
    const r = safetyStock({ ...base, leadDays: null, fallbackDays: 5 });
    expect(r.method).toBe("fallback");
    expect(r.reason).toContain("缺生产周期");
  });

  it("无动销 → 不设安全库存", () => {
    expect(safetyStock({ ...base, daily: 0 }).method).toBe("none");
  });

  it("无兜底天数且统计不可用 → 0 且说明", () => {
    const r = safetyStock({ ...base, leadDays: null, fallbackDays: 0 });
    expect(r.safetyQty).toBe(0);
    expect(r.method).toBe("none");
  });
});
