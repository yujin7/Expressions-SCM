/** #1 库存未来曲线纯规则测试（rules/projection.ts） */
import { describe, expect, it } from "vitest";
import { projectInventory } from "@/server/rules/projection";

describe("projectInventory", () => {
  it("无到货、匀速消耗 → 断货日 = today + floor(onHand/daily)", () => {
    const r = projectInventory({ today: "2026-08-01", startOnHand: 100, daily: 10, arrivals: [], horizonDays: 30, leadDays: null });
    // day0: 100-10=90 ... day9: 100-100=0 → 断货
    expect(r.stockoutDate).toBe("2026-08-10");
    expect(r.daysToStockout).toBe(9);
    expect(r.points[0].onHand).toBe(90);
  });

  it("到货推迟断货：中途一批到货抬升曲线", () => {
    const r = projectInventory({
      today: "2026-08-01", startOnHand: 50, daily: 10,
      arrivals: [{ date: "2026-08-04", qty: 100 }], horizonDays: 30, leadDays: null,
    });
    // 无到货本应 day4 断货；到货 100 后延后
    expect(r.daysToStockout).toBeGreaterThan(5);
    const p4 = r.points.find((p) => p.date === "2026-08-04")!;
    expect(p4.arrival).toBe(100);
  });

  it("建议下单日 = 断货日 − 生产周期；已过窗口时标记 missed", () => {
    const r = projectInventory({ today: "2026-08-01", startOnHand: 30, daily: 10, arrivals: [], horizonDays: 30, leadDays: 20 });
    // day0:20 day1:10 day2:0 → 断货 2026-08-03，倒推 20 天 = 2026-07-14 < today → missed
    expect(r.stockoutDate).toBe("2026-08-03");
    expect(r.orderByDate).toBe("2026-07-14");
    expect(r.orderWindowMissed).toBe(true);
  });

  it("视野内不断货 → 全 null", () => {
    const r = projectInventory({ today: "2026-08-01", startOnHand: 1000, daily: 1, arrivals: [], horizonDays: 30, leadDays: 10 });
    expect(r.stockoutDate).toBeNull();
    expect(r.orderByDate).toBeNull();
    expect(r.orderWindowMissed).toBe(false);
  });

  it("过去到货并入今天；视野外到货忽略", () => {
    const r = projectInventory({
      today: "2026-08-01", startOnHand: 0, daily: 0,
      arrivals: [{ date: "2026-07-20", qty: 50 }, { date: "2027-01-01", qty: 999 }], horizonDays: 30, leadDays: null,
    });
    expect(r.points[0].arrival).toBe(50); // 过去到货并入 day0
    expect(r.points.every((p) => p.date < "2026-09-01")).toBe(true);
  });

  it("日均为 0（无动销）不产生断货", () => {
    const r = projectInventory({ today: "2026-08-01", startOnHand: 5, daily: 0, arrivals: [], horizonDays: 10, leadDays: null });
    expect(r.stockoutDate).toBeNull();
  });
});
