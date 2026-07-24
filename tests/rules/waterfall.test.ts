/** E7-03：销量变化瀑布分解纯规则测试（rules/waterfall.ts）——核心是首尾恒等式 */
import { describe, expect, it } from "vitest";
import { buildBridge, type BridgeResult } from "@/server/rules/waterfall";

const m = (o: Record<string, number>): Map<string, number> => new Map(Object.entries(o));
const upper = (k: string) => k.toUpperCase();

/** 恒等式：Σitems.delta + othersDelta === total === to − from（瀑布图首尾必须对上） */
function expectBalanced(res: BridgeResult): void {
  const itemsSum = res.items.reduce((a, b) => a + b.delta, 0);
  expect(itemsSum + res.othersDelta).toBe(res.total);
  expect(res.total).toBe(res.to - res.from);
}

describe("buildBridge 首尾恒等式", () => {
  it("常规增减：items 合计 + others = to − from", () => {
    const res = buildBridge(m({ a: 100, b: 50, c: 20 }), m({ a: 130, b: 40, c: 20 }), upper);
    expect(res.from).toBe(170);
    expect(res.to).toBe(190);
    expect(res.total).toBe(20);
    expectBalanced(res);
    // c 无变化不占条目
    expect(res.items.map((i) => i.key)).toEqual(["a", "b"]);
    expect(res.items[0]).toEqual({ key: "a", label: "A", delta: 30 });
    expect(res.othersDelta).toBe(0);
  });

  it("新增项（prev 无）与消失项（curr 无）都正确计入", () => {
    const res = buildBridge(m({ old: 60, keep: 10 }), m({ keep: 10, fresh: 45 }), upper);
    expect(res.from).toBe(70);
    expect(res.to).toBe(55);
    expect(res.total).toBe(-15);
    expectBalanced(res);
    const byKey = new Map(res.items.map((i) => [i.key, i.delta]));
    expect(byKey.get("old")).toBe(-60); // 消失 → 全额负贡献
    expect(byKey.get("fresh")).toBe(45); // 新增 → 全额正贡献
    expect(byKey.has("keep")).toBe(false);
  });

  it("全为负（整体下滑）仍恒等", () => {
    const res = buildBridge(m({ a: 100, b: 80, c: 60 }), m({ a: 70, b: 20, c: 0 }), upper);
    expect(res.total).toBe(-150);
    expect(res.items.every((i) => i.delta < 0)).toBe(true);
    expectBalanced(res);
  });

  it("topN 截断：其余项正确归入 othersDelta，恒等式仍成立", () => {
    // 10 个键，delta 依次 10,9,...,1（均为新增）
    const prev = m({});
    const curr = m(Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`k${i}`, 10 - i])));
    const res = buildBridge(prev, curr, upper, 3);
    expect(res.items.map((i) => i.delta)).toEqual([10, 9, 8]);
    expect(res.othersDelta).toBe(7 + 6 + 5 + 4 + 3 + 2 + 1); // 28
    expect(res.total).toBe(55);
    expectBalanced(res);
  });

  it("topN 截断含正负混合：others 可为净负，恒等式不受影响", () => {
    const res = buildBridge(
      m({ a: 100, b: 100, c: 100, d: 100, e: 100 }),
      m({ a: 150, b: 60, c: 97, d: 98, e: 99 }),
      upper,
      2,
    );
    expect(res.items.map((i) => i.key)).toEqual(["a", "b"]); // |+50| > |−40| > 其余
    expect(res.othersDelta).toBe(-6); // c −3, d −2, e −1
    expect(res.total).toBe(4);
    expectBalanced(res);
  });

  it("topN=0：全部进 others", () => {
    const res = buildBridge(m({ a: 1 }), m({ a: 5, b: 3 }), upper, 0);
    expect(res.items).toEqual([]);
    expect(res.othersDelta).toBe(7);
    expectBalanced(res);
  });

  it("小数（qty 为 decimal(14,4)）：4 位精度内恒等", () => {
    const res = buildBridge(m({ a: 0.1, b: 1.2345 }), m({ a: 0.3, b: 1.0005 }), upper);
    expect(res.total).toBeCloseTo(res.to - res.from, 9);
    const itemsSum = res.items.reduce((a, b) => a + b.delta, 0);
    expect(itemsSum + res.othersDelta).toBeCloseTo(res.total, 9);
    expect(res.items.find((i) => i.key === "a")?.delta).toBe(0.2); // 0.30000000000000004 已收敛
  });
});

describe("buildBridge 边界", () => {
  it("空输入 → from=to=total=0，无条目", () => {
    const res = buildBridge(new Map(), new Map(), upper);
    expect(res).toEqual({ from: 0, to: 0, total: 0, items: [], othersDelta: 0 });
    expectBalanced(res);
  });

  it("两期完全一致 → 无条目且 total=0", () => {
    const res = buildBridge(m({ a: 10, b: 20 }), m({ a: 10, b: 20 }), upper);
    expect(res.items).toEqual([]);
    expect(res.total).toBe(0);
    expectBalanced(res);
  });

  it("label 由 labelOf 生成，排序对同幅度稳定（key 升序）", () => {
    const res = buildBridge(m({}), m({ z: 5, a: 5, k: 5 }), (k) => `品牌${k}`);
    expect(res.items.map((i) => i.key)).toEqual(["a", "k", "z"]);
    expect(res.items.map((i) => i.label)).toEqual(["品牌a", "品牌k", "品牌z"]);
    expectBalanced(res);
  });
});
