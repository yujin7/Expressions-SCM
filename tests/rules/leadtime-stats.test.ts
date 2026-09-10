/** E2-04 交期学习纯规则测试 */
import { describe, expect, it } from "vitest";
import { leadTimeStats, quantile, suggestLeadDays } from "@/server/rules/leadtime-stats";

const s = (actualDays: number, promisedDays: number | null = null) => ({ promisedDays, actualDays });

describe("quantile（线性插值 R type-7）", () => {
  it("1..10 的 P50 = 5.5、P90 = 9.1", () => {
    const v = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(quantile(v, 0.5)).toBeCloseTo(5.5, 6);
    expect(quantile(v, 0.9)).toBeCloseTo(9.1, 6);
  });
  it("空数组 → null；单点 → 该点", () => {
    expect(quantile([], 0.5)).toBeNull();
    expect(quantile([7], 0.9)).toBe(7);
  });
});

describe("leadTimeStats", () => {
  it("p50/p90 走插值而非取第 k 个", () => {
    // 实际交期 10,20,30,40 → h(P50)=1.5 → 25；h(P90)=2.7 → 30+0.7*10=37
    const r = leadTimeStats([s(10), s(30), s(20), s(40)]);
    expect(r.n).toBe(4);
    expect(r.p50).toBeCloseTo(25, 6);
    expect(r.p90).toBeCloseTo(37, 6);
    expect(r.mean).toBeCloseTo(25, 6);
    expect(r.stdev).toBeCloseTo(12.91, 1);
  });

  it("准时率只统计有承诺交期的样本", () => {
    // 有承诺的 4 条：8≤10 准时、12>10 延误、10≤10 准时、15>10 延误 → 2/4=0.5
    // 另有 3 条无承诺样本（不得进入准时率分母，否则会被稀释）
    const r = leadTimeStats([
      s(8, 10), s(12, 10), s(10, 10), s(15, 10),
      s(99), s(1), s(50),
    ]);
    expect(r.n).toBe(7);
    expect(r.onTimeRate).toBeCloseTo(0.5, 6);
  });

  it("无承诺交期样本时 准时率/平均延误 = null（但 p50 仍可算）", () => {
    const r = leadTimeStats([s(10), s(20), s(30)]);
    expect(r.onTimeRate).toBeNull();
    expect(r.avgDelayDays).toBeNull();
    expect(r.p50).toBe(20);
  });

  it("平均延误符号：延误为正、提前为负", () => {
    // (14-10)=+4, (18-10)=+8 → 平均 +6
    expect(leadTimeStats([s(14, 10), s(18, 10)]).avgDelayDays).toBeCloseTo(6, 6);
    // (7-10)=-3, (9-10)=-1 → 平均 -2
    expect(leadTimeStats([s(7, 10), s(9, 10)]).avgDelayDays).toBeCloseTo(-2, 6);
    // 混合：+5 与 -5 抵消 → 0，但准时率 0.5
    const mix = leadTimeStats([s(15, 10), s(5, 10)]);
    expect(mix.avgDelayDays).toBeCloseTo(0, 6);
    expect(mix.onTimeRate).toBeCloseTo(0.5, 6);
  });

  it("空样本 → n=0 且各项全 null", () => {
    const r = leadTimeStats([]);
    expect(r).toEqual({ n: 0, p50: null, p90: null, mean: null, stdev: null, onTimeRate: null, avgDelayDays: null });
  });

  it("单样本：σ 不可信 → null，其余可算", () => {
    const r = leadTimeStats([s(12, 10)]);
    expect(r.n).toBe(1);
    expect(r.p50).toBe(12);
    expect(r.stdev).toBeNull();
    expect(r.onTimeRate).toBe(0);
    expect(r.avgDelayDays).toBe(2);
  });
});

describe("suggestLeadDays", () => {
  const stats = (arr: number[]) => leadTimeStats(arr.map((d) => s(d)));

  it("不可采纳的0天和超一年样本只观察，不发出必被接口拒绝的建议", () => {
    expect(suggestLeadDays(30, stats([0, 0, 0])).suggest).toBeNull();
    expect(suggestLeadDays(null, stats([366, 366, 366])).suggest).toBeNull();
  });

  it("样本不足（<minSamples）→ 不建议", () => {
    const r = suggestLeadDays(10, stats([30, 30]));
    expect(r.suggest).toBeNull();
    expect(r.reason).toContain("样本不足");
  });

  it("偏差在容差内 → 不建议", () => {
    // P50=21，档案 20 → 偏差 5% ≤ 20%
    const r = suggestLeadDays(20, stats([21, 21, 21, 21]));
    expect(r.suggest).toBeNull();
    expect(r.reason).toContain("容差");
  });

  it("偏差超容差 → 建议 P50 四舍五入值", () => {
    // P50=30，档案 20 → 偏差 50% > 20%
    const r = suggestLeadDays(20, stats([30, 30, 30, 30, 30]));
    expect(r.suggest).toBe(30);
    expect(r.reason).toContain("低估");
  });

  it("档案交期高估时也给建议（方向为高估）", () => {
    const r = suggestLeadDays(40, stats([20, 20, 20, 20]));
    expect(r.suggest).toBe(20);
    expect(r.reason).toContain("高估");
  });

  it("无档案值（null/0）→ 直接建议 P50", () => {
    expect(suggestLeadDays(null, stats([12, 14, 16])).suggest).toBe(14);
    expect(suggestLeadDays(null, stats([12, 14, 16])).reason).toContain("档案未设");
    expect(suggestLeadDays(0, stats([12, 14, 16])).suggest).toBe(14);
  });

  it("容差/最小样本可调", () => {
    // 偏差 25%：容差 20% 时建议、容差 30% 时不建议
    expect(suggestLeadDays(20, stats([25, 25, 25]), 3, 20).suggest).toBe(25);
    expect(suggestLeadDays(20, stats([25, 25, 25]), 3, 30).suggest).toBeNull();
    // minSamples=5 时 3 个样本不够
    expect(suggestLeadDays(20, stats([25, 25, 25]), 5, 20).suggest).toBeNull();
  });

  it("四舍五入后与档案一致 → 不建议（避免无效改档）", () => {
    // P50=1.4，档案 1 → 偏差 40% 超容差，但 round(1.4)=1 与档案相同
    const r = suggestLeadDays(1, leadTimeStats([s(1), s(1.4), s(1.4), s(2)]));
    expect(r.suggest).toBeNull();
    expect(r.reason).toContain("无需调整");
  });
});
