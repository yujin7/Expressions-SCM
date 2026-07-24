/** NPD 排程纯规则测试（rules/npd-schedule.ts） */
import { describe, expect, it } from "vitest";
import { scheduleNpd, type NpdTemplateNode } from "@/server/rules/npd-schedule";

const n = (name: string, days: number, prev: string | null, nodeNo = name): NpdTemplateNode =>
  ({ nodeNo, name, stage: null, dept: null, days, prev });

describe("scheduleNpd", () => {
  it("串行链：后继 planStart = 前驱 planEnd", () => {
    const out = scheduleNpd([n("A", 5, null), n("B", 3, "A"), n("C", 0, "B")], "2026-08-01");
    expect(out.map((t) => [t.name, t.planStart, t.planEnd])).toEqual([
      ["A", "2026-08-01", "2026-08-06"],
      ["B", "2026-08-06", "2026-08-09"],
      ["C", "2026-08-09", "2026-08-09"], // 0 天=里程碑
    ]);
    expect(out.map((t) => t.seq)).toEqual([1, 2, 3]);
  });

  it("无前驱/链外前驱 → 从启动日开始（并行起点）", () => {
    const out = scheduleNpd([n("A", 2, null), n("X", 4, "不存在的节点")], "2026-08-01");
    expect(out.find((t) => t.name === "X")!.planStart).toBe("2026-08-01");
  });

  it("环兜底：无法拓扑的节点按模板顺序接在最晚 planEnd 后，不丢节点", () => {
    const out = scheduleNpd([n("A", 5, null), n("B", 3, "C"), n("C", 2, "B")], "2026-08-01");
    expect(out.length).toBe(3);
    const b = out.find((t) => t.name === "B")!;
    expect(b.planStart).toBe("2026-08-06"); // 接在 A 的 planEnd 后
    expect(out.find((t) => t.name === "C")!.planStart).toBe(b.planEnd);
  });

  it("负数/小数天数容错（floor 且下限 0）", () => {
    const out = scheduleNpd([n("A", -3, null)], "2026-08-01");
    expect(out[0].planEnd).toBe("2026-08-01");
  });
});
