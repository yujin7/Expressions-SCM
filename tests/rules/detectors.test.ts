/** E5-10：三个轻量侦测器的纯规则测试（rules/detectors.ts）——含不判定与 0 除保护 */
import { describe, expect, it } from "vitest";
import { detectChannelShift, detectSalesStop, detectVelocityChange } from "@/server/rules/detectors";

describe("detectSalesStop 销量骤停", () => {
  it("最近一期归零且历史有量 → 命中，reason 说明疑似链接下架", () => {
    const r = detectSalesStop([100, 120, 110, 0]);
    expect(r.stopped).toBe(true);
    expect(r.lastQty).toBe(0);
    expect(r.prevAvg).toBe(110);
    expect(r.dropPct).toBe(1);
    expect(r.reason).toContain("链接下架");
    expect(r.reason).toContain("非需求消失");
  });

  it("跌幅超默认阈值 0.7 → 命中；未超 → 不命中", () => {
    // 前 3 期均值 100，末期 20 → 跌 80% > 70%
    expect(detectSalesStop([100, 100, 100, 20]).stopped).toBe(true);
    // 末期 40 → 跌 60%，未超
    const miss = detectSalesStop([100, 100, 100, 40]);
    expect(miss.stopped).toBe(false);
    expect(miss.dropPct).toBe(0.6);
    expect(miss.reason).toContain("常态");
  });

  it("自定义阈值生效（0.5 时跌 60% 命中）", () => {
    expect(detectSalesStop([100, 100, 100, 40], 0.5).stopped).toBe(true);
  });

  it("增长不命中（dropPct 为负）", () => {
    const r = detectSalesStop([10, 10, 10, 50]);
    expect(r.stopped).toBe(false);
    expect(r.dropPct).toBeLessThan(0);
  });

  it("样本 <3 期不判定（含空序列）", () => {
    for (const s of [[], [0], [100, 0]]) {
      const r = detectSalesStop(s);
      expect(r.stopped).toBe(false);
      expect(r.dropPct).toBeNull();
      expect(r.reason).toContain("样本不足");
    }
  });

  it("历史均值为 0 → 不判定（0 除保护）", () => {
    const r = detectSalesStop([0, 0, 0, 0]);
    expect(r.stopped).toBe(false);
    expect(r.dropPct).toBeNull();
    expect(r.prevAvg).toBe(0);
    expect(r.reason).toContain("历史无销量");
    // 新品首期爆量也不误报
    expect(detectSalesStop([0, 0, 0, 500]).stopped).toBe(false);
  });
});

describe("detectChannelShift 渠道结构迁移", () => {
  it("占比按各期总量分别计算，movements 按 |deltaPct| 降序", () => {
    const prev = new Map([["tmall", 80], ["pdd", 20]]);
    // 本期总量翻倍但结构反转：只看结构不看量级
    const curr = new Map([["tmall", 40], ["pdd", 160]]);
    const r = detectChannelShift(prev, curr);
    expect(r.shifted).toBe(true);
    expect(r.movements.map((m) => m.channel)).toEqual(["pdd", "tmall"]); // 同为 60pp，绝对值降序后按名稳定
    const tmall = r.movements.find((m) => m.channel === "tmall")!;
    expect(tmall.fromPct).toBe(80);
    expect(tmall.toPct).toBe(20);
    expect(tmall.deltaPct).toBe(-60);
    const pdd = r.movements.find((m) => m.channel === "pdd")!;
    expect(pdd.fromPct).toBe(20);
    expect(pdd.toPct).toBe(80);
    expect(pdd.deltaPct).toBe(60);
    expect(r.note).toContain("显著位移");
  });

  it("新渠道从无到有计入（缺席渠道占比按 0 计）", () => {
    const r = detectChannelShift(new Map([["tmall", 100]]), new Map([["tmall", 50], ["douyin", 50]]));
    expect(r.shifted).toBe(true);
    expect(r.movements).toHaveLength(2);
    // |−50| 与 |+50| 并列 → 按渠道名稳定排序（douyin 前于 tmall）
    expect(r.movements.map((m) => m.channel)).toEqual(["douyin", "tmall"]);
    expect(r.movements[0].deltaPct).toBe(50);
    const douyin = r.movements.find((m) => m.channel === "douyin")!;
    expect(douyin.fromPct).toBe(0);
    expect(douyin.toPct).toBe(50);
  });

  it("位移未超阈值 → 不命中", () => {
    const r = detectChannelShift(new Map([["tmall", 50], ["pdd", 50]]), new Map([["tmall", 55], ["pdd", 45]]));
    expect(r.shifted).toBe(false);
    expect(r.note).toContain("无显著位移");
  });

  it("阈值可调（5pp 时 10pp 位移命中）", () => {
    const a = new Map([["tmall", 50], ["pdd", 50]]);
    const b = new Map([["tmall", 60], ["pdd", 40]]);
    expect(detectChannelShift(a, b).shifted).toBe(false);
    expect(detectChannelShift(a, b, 5).shifted).toBe(true);
  });

  it("恰好等于阈值不命中（严格大于才算）", () => {
    const r = detectChannelShift(new Map([["a", 50], ["b", 50]]), new Map([["a", 65], ["b", 35]]), 15);
    expect(r.shifted).toBe(false);
  });

  it("任一期总量为 0 → 不判定（0 除保护）", () => {
    const nonEmpty = new Map([["tmall", 100]]);
    for (const [p, c] of [
      [new Map<string, number>(), nonEmpty],
      [nonEmpty, new Map<string, number>()],
      [new Map([["tmall", 0]]), nonEmpty],
    ] as [Map<string, number>, Map<string, number>][]) {
      const r = detectChannelShift(p, c);
      expect(r.shifted).toBe(false);
      expect(r.movements).toEqual([]);
      expect(r.note).toContain("不判定");
    }
  });
});

describe("detectVelocityChange 速度突变", () => {
  it("提速/降速超阈值 → 命中并给方向", () => {
    const up = detectVelocityChange(2, 1);
    expect(up).toEqual({ changed: true, direction: "up", deviationPct: 100 });
    const down = detectVelocityChange(0.4, 1);
    expect(down).toEqual({ changed: true, direction: "down", deviationPct: -60 });
  });

  it("偏离未超阈值 → flat 不命中，但仍给偏离值", () => {
    const r = detectVelocityChange(1.2, 1);
    expect(r.changed).toBe(false);
    expect(r.direction).toBe("flat");
    expect(r.deviationPct).toBe(20);
  });

  it("恰好等于阈值不命中（严格大于才算）", () => {
    expect(detectVelocityChange(1.4, 1).changed).toBe(false);
    expect(detectVelocityChange(1.41, 1).changed).toBe(true);
  });

  it("阈值可调", () => {
    expect(detectVelocityChange(1.2, 1, 0.1).changed).toBe(true);
  });

  it("基线 ≤0 → 不判定（0 除保护，deviationPct=null）", () => {
    for (const base of [0, -1]) {
      const r = detectVelocityChange(5, base);
      expect(r).toEqual({ changed: false, direction: "flat", deviationPct: null });
    }
  });

  it("本期归零而基线有量 → 命中 down（−100%）", () => {
    expect(detectVelocityChange(0, 3)).toEqual({ changed: true, direction: "down", deviationPct: -100 });
  });
});
