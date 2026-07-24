/** E2-05 时间分段净需求纯规则测试 */
import { describe, expect, it } from "vitest";
import { timePhasedNetReq } from "@/server/rules/timephased";

const base = {
  today: "2026-08-01",
  onHand: 1000,
  daily: 100,
  arrivals: [] as { date: string; qty: number }[],
  safetyQty: 200,
  coverTargetDays: 30,
  leadDays: 20,
  horizonDays: 120,
};

describe("timePhasedNetReq", () => {
  it("首次跌破安全库存的那期才是需求点（非固定 45 天乘法）", () => {
    const r = timePhasedNetReq(base);
    // 1000 起，日耗 100，第 8 天末 =200 仍不低于安全线；第 9 天末 =100 < 200 → 短缺
    expect(r.shortageDate).toBe("2026-08-09");
    expect(r.daysToShortage).toBe(8);
    expect(r.shortageQty).toBe(100);
  });

  it("补货量 = 补到 安全库存 + 目标覆盖需求", () => {
    const r = timePhasedNetReq(base);
    // 目标水位 = 200 + 100×30 = 3200；短缺期水位 100 → 需 3100
    expect(r.requiredQty).toBe(3100);
    expect(r.explain.some((e) => e.includes("补至目标水位"))).toBe(true);
  });

  it("中途到货推迟短缺期", () => {
    const withArrival = timePhasedNetReq({ ...base, arrivals: [{ date: "2026-08-05", qty: 2000 }] });
    expect(withArrival.daysToShortage!).toBeGreaterThan(8);
  });

  it("最晚下单日 = 短缺日 − 生产周期；已过则标记", () => {
    const r = timePhasedNetReq(base);
    expect(r.orderByDate).toBe("2026-07-20"); // 08-09 减 20 天
    expect(r.orderWindowMissed).toBe(true);   // 早于 today 08-01
  });

  it("库存充足 → 无短缺、无需求", () => {
    const r = timePhasedNetReq({ ...base, onHand: 100000 });
    expect(r.shortageDate).toBeNull();
    expect(r.requiredQty).toBe(0);
  });

  it("安全库存越高，短缺来得越早", () => {
    const lo = timePhasedNetReq({ ...base, safetyQty: 0 });
    const hi = timePhasedNetReq({ ...base, safetyQty: 500 });
    expect(hi.daysToShortage!).toBeLessThan(lo.daysToShortage!);
  });

  it("无动销 → 不产生需求", () => {
    const r = timePhasedNetReq({ ...base, daily: 0 });
    expect(r.requiredQty).toBe(0);
    expect(r.explain[0]).toContain("无动销");
  });

  it("无生产周期 → 无下单日但仍给需求量", () => {
    const r = timePhasedNetReq({ ...base, leadDays: null });
    expect(r.orderByDate).toBeNull();
    expect(r.requiredQty).toBeGreaterThan(0);
    expect(r.explain.some((e) => e.includes("无生产周期"))).toBe(true);
  });
});
