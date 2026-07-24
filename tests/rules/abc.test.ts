/** ABC 分层唯一权威测试（rules/abc.ts）——含两页原本不一致的边界用例 */
import { describe, expect, it } from "vitest";
import { classifyAbc } from "@/server/rules/abc";

describe("classifyAbc", () => {
  it("标准帕累托：加入本项前累计<80% 记 A，<95% 记 B，其余 C", () => {
    // 总量 100：80/10/5/5 —— 第1项(prev 0%)=A；第2项(prev 80%)=B；第3项(prev 90%)=B；第4项(prev 95%)=C
    const m = classifyAbc([{ id: 1, qty: 80 }, { id: 2, qty: 10 }, { id: 3, qty: 5 }, { id: 4, qty: 5 }]);
    expect([m.get(1), m.get(2), m.get(3), m.get(4)]).toEqual(["A", "B", "B", "C"]);
  });

  it("边界分歧用例：单一 SKU 占 100%——含本项口径会误判为 A 之外，标准口径恒 A", () => {
    const m = classifyAbc([{ id: 1, qty: 500 }]);
    expect(m.get(1)).toBe("A"); // prevPct=0 <80
  });

  it("零销量恒 C，且不吃累计份额", () => {
    const m = classifyAbc([{ id: 1, qty: 100 }, { id: 2, qty: 0 }, { id: 3, qty: -5 }]);
    expect(m.get(1)).toBe("A");
    expect(m.get(2)).toBe("C");
    expect(m.get(3)).toBe("C");
  });

  it("输入无需预排序，结果与排序后一致", () => {
    const asc = classifyAbc([{ id: 3, qty: 5 }, { id: 2, qty: 10 }, { id: 1, qty: 85 }]);
    const desc = classifyAbc([{ id: 1, qty: 85 }, { id: 2, qty: 10 }, { id: 3, qty: 5 }]);
    expect([...asc.entries()].sort()).toEqual([...desc.entries()].sort());
  });

  it("空输入 → 空表", () => {
    expect(classifyAbc([]).size).toBe(0);
  });
});
