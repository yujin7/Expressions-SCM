/** D58 四级分层 S/A/B/C（rules/abc.ts classifyTier / tierToAbc）——既有 classifyAbc 口径不变 */
import { describe, expect, it } from "vitest";
import { DEFAULT_TIER_CUTS, classifyAbc, classifyTier, tierDistribution, tierToAbc } from "@/server/rules/abc";

describe("classifyTier", () => {
  it("缺省切点 50/80/95：按加入本项前累计占比切分", () => {
    // 总量 100：45/30/15/5/5 → prev 0%=S；45%=S；75%=A；90%=B；95%=C
    const m = classifyTier([
      { id: 1, value: 45 }, { id: 2, value: 30 }, { id: 3, value: 15 }, { id: 4, value: 5 }, { id: 5, value: 5 },
    ]);
    expect([1, 2, 3, 4, 5].map((i) => m.get(i))).toEqual(["S", "S", "A", "B", "C"]);
    expect(DEFAULT_TIER_CUTS).toEqual({ sPct: 50, aPct: 80, bPct: 95 });
  });

  it("零/负值恒 C，且不吃累计份额", () => {
    const m = classifyTier([{ id: "a", value: 100 }, { id: "b", value: 0 }, { id: "c", value: -3 }]);
    expect(m.get("a")).toBe("S");
    expect(m.get("b")).toBe("C");
    expect(m.get("c")).toBe("C");
  });

  it("value 可为金额或数量：只做排名，输入无需预排序", () => {
    const asc = classifyTier([{ id: 3, value: 5.5 }, { id: 2, value: 10.25 }, { id: 1, value: 84.25 }]);
    const desc = classifyTier([{ id: 1, value: 84.25 }, { id: 2, value: 10.25 }, { id: 3, value: 5.5 }]);
    expect([...asc.entries()].sort()).toEqual([...desc.entries()].sort());
    expect(asc.get(1)).toBe("S");
  });

  it("自定义切点生效；非法切点抛错", () => {
    const m = classifyTier([{ id: 1, value: 60 }, { id: 2, value: 40 }], { sPct: 70, aPct: 90, bPct: 99 });
    expect(m.get(1)).toBe("S");
    expect(m.get(2)).toBe("S"); // prev 60% < 70
    expect(() => classifyTier([], { sPct: 80, aPct: 50, bPct: 95 })).toThrow(/invalid tier cuts/);
    expect(() => classifyTier([], { sPct: 50, aPct: 80, bPct: 101 })).toThrow(/invalid tier cuts/);
  });

  it("不变量：tierToAbc(classifyTier) 与 classifyAbc 逐项一致（含边界 80/95）", () => {
    const items = [80, 10, 5, 3, 2, 0, 7, 1, 15, 20].map((qty, i) => ({ id: i + 1, qty }));
    const abc = classifyAbc(items);
    const tiers = classifyTier(items.map((i) => ({ id: i.id, value: i.qty })));
    for (const i of items) expect(tierToAbc(tiers.get(i.id)!)).toBe(abc.get(i.id));
    expect(tierToAbc("S")).toBe("A");
    expect(tierToAbc("B")).toBe("B");
    expect(tierToAbc("C")).toBe("C");
  });

  it("tierDistribution 给出各级 SKU 数与占比（校准 S 边界用）", () => {
    const d = tierDistribution([
      { id: 1, value: 45 }, { id: 2, value: 30 }, { id: 3, value: 15 }, { id: 4, value: 5 }, { id: 5, value: 5 }, { id: 6, value: 0 },
    ]);
    expect(d.S).toEqual({ count: 2, value: 75, valueSharePct: 75 });
    expect(d.A).toEqual({ count: 1, value: 15, valueSharePct: 15 });
    expect(d.B).toEqual({ count: 1, value: 5, valueSharePct: 5 });
    expect(d.C).toEqual({ count: 2, value: 5, valueSharePct: 5 });
  });

  it("空输入 → 空表", () => {
    expect(classifyTier([]).size).toBe(0);
  });
});
