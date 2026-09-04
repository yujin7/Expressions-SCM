/** D58 四级分层 S/A/B/C（rules/abc.ts classifyTier / tierToAbc）——既有 classifyAbc 口径不变 */
import { describe, expect, it } from "vitest";
import { DEFAULT_TIER_CUTS, classifyAbc, classifyTier, tierDistribution, tierMigrationMatrix, tierToAbc, type Tier } from "@/server/rules/abc";

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

describe("W12 金额口径并列分层（classifyTier 的 value = 销量 × 单位成本）", () => {
  /*
   * 立项证据：件数口径下便宜的大流量品会压过贵的战略品。
   * BULK 6000 件 × 1 元 = 6000；STRAT 300 件 × 80 元 = 24000。
   * 数量口径 BULK 是 S、STRAT 是 C；金额口径正好倒过来——这就是 W12 要让人看见的那件事。
   */
  const qty = [
    { id: "BULK", value: 6000 },
    { id: "MID", value: 1200 },
    { id: "STRAT", value: 300 },
    { id: "DEAD", value: 0 },
  ];
  const cost: Record<string, number> = { BULK: 1, MID: 4, STRAT: 80, DEAD: 500 };
  const value = qty.map((q) => ({ id: q.id, value: q.value * cost[q.id] }));

  it("同一切点、同一函数，只是换了 value：两套分层给出不同答案", () => {
    const byQty = classifyTier(qty);
    const byValue = classifyTier(value);
    expect(byQty.get("BULK")).toBe("S");
    expect(byQty.get("STRAT")).toBe("C");
    expect(byValue.get("STRAT")).toBe("S");
    expect(byValue.get("BULK")).toBe("A"); // 件数第一名掉到 A
    expect(byValue.get("MID")).toBe("B");
    // 无销量的品在两套口径下都恒 C：单位成本再高也不会因为「贵」上移
    expect(byQty.get("DEAD")).toBe("C");
    expect(byValue.get("DEAD")).toBe("C");
  });

  it("小数金额可直接入 value（本函数只排名，不做金额运算）", () => {
    const m = classifyTier([{ id: 1, value: 1234.56 }, { id: 2, value: 1234.55 }]);
    expect(m.get(1)).toBe("S"); // 加入本项前累计 0%
    expect(m.get(2)).toBe("A"); // 加入本项前累计 50.0002% ≥ 50，标准帕累托边界照旧
  });
});

describe("tierMigrationMatrix：数量口径 × 金额口径", () => {
  it("对角线记一致、异格记迁移，4×5 全格都出（零格也出）", () => {
    const m = tierMigrationMatrix([
      { qtyTier: "S", valueTier: "S" },
      { qtyTier: "S", valueTier: "B" },
      { qtyTier: "A", valueTier: "A" },
      { qtyTier: "C", valueTier: "S" },
    ]);
    expect(m.total).toBe(4);
    expect(m.agree).toBe(2);
    expect(m.disagree).toBe(2);
    expect(m.insufficient).toBe(0);
    expect(m.agreePct).toBe(50);
    expect(m.cells).toHaveLength(20);
    const at = (q: Tier, v: Tier | null) => m.cells.find((c) => c.qtyTier === q && c.valueTier === v)?.count;
    expect(at("S", "S")).toBe(1);
    expect(at("S", "B")).toBe(1);
    expect(at("C", "S")).toBe(1);
    expect(at("B", "B")).toBe(0);
  });

  it("valueTier=null 单列为「不可用」，既不算一致也不并进 C", () => {
    const m = tierMigrationMatrix([
      { qtyTier: "C", valueTier: null },
      { qtyTier: "C", valueTier: null },
      { qtyTier: "A", valueTier: "A" },
    ]);
    expect(m.insufficient).toBe(2);
    expect(m.agree).toBe(1);
    expect(m.disagree).toBe(0);
    expect(m.agreePct).toBe(100); // 分母只含两边都判出等级的项
    expect(m.cells.find((c) => c.qtyTier === "C" && c.valueTier === null)?.count).toBe(2);
    expect(m.cells.find((c) => c.qtyTier === "C" && c.valueTier === "C")?.count).toBe(0);
  });

  it("全部不可用 → 一致率 null（不冒充 0%）", () => {
    const m = tierMigrationMatrix([{ qtyTier: "S", valueTier: null }]);
    expect(m.agreePct).toBeNull();
    expect(m.insufficient).toBe(1);
  });

  it("空输入 → 全零矩阵", () => {
    const m = tierMigrationMatrix([]);
    expect(m.total).toBe(0);
    expect(m.agreePct).toBeNull();
    expect(m.cells.every((c) => c.count === 0)).toBe(true);
  });
});
