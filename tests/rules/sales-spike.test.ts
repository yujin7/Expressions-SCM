/** D56 爆单规则（rules/sales-spike.ts）：正常爆单 / 基线不足 / 缺天 / 断货恢复 / 第 3 天回落 / 自动关闭窗口 */
import { describe, expect, it } from "vitest";
import { detectSalesSpike } from "@/server/rules/sales-spike";

function series(start: string, qtys: (number | string)[]) {
  const t0 = Date.parse(`${start}T00:00:00Z`);
  return qtys.map((qty, i) => ({ date: new Date(t0 + i * 86_400_000).toISOString().slice(0, 10), qty }));
}

describe("detectSalesSpike", () => {
  it("正常爆单：前 7 日日均 10，最近 3 天 16/20/30 全部 ≥ 15 → 命中", () => {
    const r = detectSalesSpike(series("2026-08-20", [10, 10, 10, 10, 10, 10, 10, 16, 20, 30]));
    expect(r.hit).toBe(true);
    expect(r.anchorDate).toBe("2026-08-29");
    expect(r.baseline).toBe("10.0000");
    expect(r.threshold).toBe("15.0000");
    expect(r.gaps).toBe(0);
    expect(r.days.map((d) => d.date)).toEqual(["2026-08-27", "2026-08-28", "2026-08-29"]);
    expect(r.days.map((d) => d.risePct)).toEqual(["60.00", "100.00", "200.00"]);
    expect(r.days.every((d) => d.hit)).toBe(true);
  });
  it("第 3 天回落到门槛以下 → 不命中（3 天须全部命中）", () => {
    const r = detectSalesSpike(series("2026-08-20", [10, 10, 10, 10, 10, 10, 10, 16, 20, 14.99]));
    expect(r.hit).toBe(false);
    expect(r.days[2]).toMatchObject({ qty: "14.9900", hit: false });
    expect(r.reason).toContain("1 天未达门槛");
  });
  it("基线低于最小基数（0→5、3→5 小基数放大）不命中", () => {
    expect(detectSalesSpike(series("2026-08-20", [0, 0, 0, 0, 0, 0, 0, 5, 5, 5])).hit).toBe(false);
    const r = detectSalesSpike(series("2026-08-20", [3, 3, 3, 3, 3, 3, 3, 5, 5, 5]));
    expect(r.hit).toBe(false);
    expect(r.baseline).toBe("3.0000");
    expect(r.reason).toContain("低于最小基数");
    // 调低最小基数则命中：说明是护栏而非算式问题
    expect(detectSalesSpike(series("2026-08-20", [3, 3, 3, 3, 3, 3, 3, 5, 5, 5]), { minBaseQty: 1 }).hit).toBe(true);
  });
  it("缺天按 0 计并记 gaps（基线被稀释）", () => {
    // 基线窗口只有 4 天有数（各 20 → 80/7≈11.43），3 天缺失
    const pts = [
      ...series("2026-08-20", [20, 20, 20, 20]),
      ...series("2026-08-27", [30, 30, 30]),
    ];
    const r = detectSalesSpike(pts);
    expect(r.gaps).toBe(3);
    expect(r.baseline).toBe("11.4286");
    expect(r.hit).toBe(true);
  });
  it("asOf 锚定：连续 3 天不再命中（锚点后无数据）→ 不命中，可作自动关闭依据", () => {
    const pts = series("2026-08-20", [10, 10, 10, 10, 10, 10, 10, 16, 20, 30]);
    expect(detectSalesSpike(pts, { asOf: "2026-08-29" }).hit).toBe(true);
    const later = detectSalesSpike(pts, { asOf: "2026-09-01" });
    expect(later.hit).toBe(false);
    expect(later.days.map((d) => d.qty)).toEqual(["0.0000", "0.0000", "0.0000"]);
  });
  it("同日多条累加；ISO 时间串取前 10 位；参数化连续天数与涨幅", () => {
    const pts = [
      ...series("2026-08-20", [10, 10, 10, 10, 10, 10, 10]),
      { date: "2026-08-27T00:00:00.000Z", qty: "8" }, { date: "2026-08-27", qty: "8" },
      { date: "2026-08-28", qty: 20 }, { date: "2026-08-29", qty: 20 },
    ];
    const r = detectSalesSpike(pts, { consecutiveDays: 2, risePct: 50 });
    expect(r.hit).toBe(true);
    const r3 = detectSalesSpike(pts, { consecutiveDays: 3, risePct: 50 });
    expect(r3.days[0]).toMatchObject({ date: "2026-08-27", qty: "16.0000", hit: true });
    expect(r3.hit).toBe(true);
    expect(detectSalesSpike(pts, { consecutiveDays: 3, risePct: 80 }).hit).toBe(false);
  });
  it("空序列 → 不命中、anchorDate null", () => {
    expect(detectSalesSpike([])).toMatchObject({ hit: false, anchorDate: null, days: [], gaps: 0 });
  });
});
