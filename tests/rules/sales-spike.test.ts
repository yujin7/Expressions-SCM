/** D56 爆单规则（rules/sales-spike.ts）：正常爆单 / 基线不足 / 缺天 / 断货恢复 / 第 3 天回落 / 自动关闭窗口 */
import { describe, expect, it } from "vitest";
import { detectSalesSpike, matchExpectedPromo, salesSpikeEvidenceCurrent } from "@/server/rules/sales-spike";

function series(start: string, qtys: (number | string)[]) {
  const t0 = Date.parse(`${start}T00:00:00Z`);
  return qtys.map((qty, i) => ({ date: new Date(t0 + i * 86_400_000).toISOString().slice(0, 10), qty }));
}

describe("detectSalesSpike", () => {
  it("T+1 资格按上海日界；未来、非法日期及两日前不更新当前告警", () => {
    const before = new Date("2026-09-02T15:59:59Z");
    const midnight = new Date("2026-09-02T16:00:00Z");
    expect(salesSpikeEvidenceCurrent("2026-09-01", before)).toBe(true);
    expect(salesSpikeEvidenceCurrent("2026-09-01", midnight)).toBe(false);
    expect(salesSpikeEvidenceCurrent("2026-09-02", midnight)).toBe(true);
    expect(salesSpikeEvidenceCurrent("2026-09-03", midnight)).toBe(true);
    expect(salesSpikeEvidenceCurrent("2026-09-04", midnight)).toBe(false);
    expect(salesSpikeEvidenceCurrent("2026-02-30", midnight)).toBe(false);
    expect(salesSpikeEvidenceCurrent(null, midnight)).toBe(false);
  });
  it("删掉平稳销量的三天基线不能制造爆单；缺日是未知而非零", () => {
    const full = series("2026-08-20", Array(10).fill(20));
    expect(detectSalesSpike(full).hit).toBe(false);
    const incomplete = detectSalesSpike(full.filter((_, i) => i < 4 || i >= 7));
    expect(incomplete).toMatchObject({ hit: null, baseline: null, threshold: null, gaps: 3 });
  });
  it("真实零有观测资格，缺失判定日无资格；不存在的日历日不算观测", () => {
    const full = series("2026-08-20", [20, 20, 20, 20, 20, 20, 20, 0, 0, 0]);
    expect(detectSalesSpike(full)).toMatchObject({ hit: false, gaps: 0 });
    expect(detectSalesSpike(full.slice(0, 7), { asOf: "2026-08-29" }).hit).toBeNull();
    expect(detectSalesSpike([{ date: "2026-02-30", qty: "100" }]).hit).toBeNull();
  });
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
  it("基线缺天返回未知，不能用已知天数稀释基线", () => {
    // 基线窗口只有 4 天有数（各 20 → 80/7≈11.43），3 天缺失
    const pts = [
      ...series("2026-08-20", [20, 20, 20, 20]),
      ...series("2026-08-27", [30, 30, 30]),
    ];
    const r = detectSalesSpike(pts);
    expect(r.gaps).toBe(3);
    expect(r.baseline).toBeNull();
    expect(r.hit).toBeNull();
  });
  it("asOf 锚点后无数据不能作自动关闭依据", () => {
    const pts = series("2026-08-20", [10, 10, 10, 10, 10, 10, 10, 16, 20, 30]);
    expect(detectSalesSpike(pts, { asOf: "2026-08-29" }).hit).toBe(true);
    const later = detectSalesSpike(pts, { asOf: "2026-09-01" });
    expect(later.hit).toBeNull();
    expect(later.days.map((d) => d.qty)).toEqual([null, null, null]);
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
  it("空序列 → 未知、anchorDate null", () => {
    expect(detectSalesSpike([])).toMatchObject({ hit: null, anchorDate: null, days: [], gaps: 0 });
  });
});

describe("matchExpectedPromo（审计 #7：判定窗口与大促事件重叠 → 预期内）", () => {
  const win = { start: "2026-08-31", end: "2026-09-02" };
  it("重叠 → expected + planEventRef + expectedUpliftPct + 窗口文案；不重叠 → 全空", () => {
    const r = matchExpectedPromo(win, [{ id: 7, startDate: "2026-09-01", endDate: "2026-09-05", expectedUpliftPct: 80 }]);
    expect(r).toEqual({ expected: true, planEventRef: 7, expectedUpliftPct: 80, planEventWindow: "大促 2026-09-01–2026-09-05" });
    expect(matchExpectedPromo(win, [{ id: 8, startDate: "2026-09-03", endDate: "2026-09-05", expectedUpliftPct: 80 }]).expected).toBe(false);
    expect(matchExpectedPromo(win, [{ id: 9, startDate: "2026-08-20", endDate: "2026-08-30", expectedUpliftPct: null }]).expected).toBe(false);
    expect(matchExpectedPromo(win, [])).toEqual({ expected: false, planEventRef: null, expectedUpliftPct: null, planEventWindow: null });
  });
  it("边界含端点；未定结束（endDate null）视为持续；多事件取预期涨幅最大者", () => {
    expect(matchExpectedPromo(win, [{ id: 1, startDate: "2026-09-02", endDate: "2026-09-09", expectedUpliftPct: null }]).expected).toBe(true);
    expect(matchExpectedPromo(win, [{ id: 2, startDate: "2026-08-01", endDate: "2026-08-31", expectedUpliftPct: null }]).expected).toBe(true);
    const open = matchExpectedPromo(win, [{ id: 3, startDate: "2026-08-01", endDate: null, expectedUpliftPct: 20 }]);
    expect(open).toMatchObject({ expected: true, planEventRef: 3, planEventWindow: "大促 2026-08-01 起" });
    const multi = matchExpectedPromo(win, [
      { id: 4, startDate: "2026-08-30", endDate: "2026-09-03", expectedUpliftPct: 30 },
      { id: 5, startDate: "2026-09-01", endDate: "2026-09-01", expectedUpliftPct: 120 },
      { id: 6, startDate: "2026-09-01", endDate: "2026-09-01", expectedUpliftPct: null },
    ]);
    expect(multi).toMatchObject({ planEventRef: 5, expectedUpliftPct: 120 });
  });
  it("非法窗口（起 > 止 / 格式错）→ 不判", () => {
    expect(matchExpectedPromo({ start: "2026-09-02", end: "2026-08-31" }, [{ id: 1, startDate: "2026-09-01", endDate: null, expectedUpliftPct: 1 }]).expected).toBe(false);
    expect(matchExpectedPromo({ start: "bad", end: "2026-09-02" }, [{ id: 1, startDate: "2026-09-01", endDate: null, expectedUpliftPct: 1 }]).expected).toBe(false);
  });
});
