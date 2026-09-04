/**
 * W2 修复（T13）：采购订单指标页的排序不得把「没数据」当成「差」。
 *
 * 事故形态：OTIF 用 `(a.otif.rate ?? -1)`、周期用 `(a.cycle.firstP50 ?? MAX_SAFE_INTEGER)` 参与比较。
 * 一个**没有可评 PO** 的供应商于是被排成「−100% 准时率」「周期最长」——升序时它顶在最差的位置，
 * 被当成最该处理的对象。这与本仓库自己的规则直接冲突：`rules/scorecard.ts` 写着
 * 「缺数据 ≠ 零分」，缺数据的维度不计分，因为那是数据质量问题不是供应商问题。
 *
 * 另一个方向同样要防：把 null 顶到降序的第一位就是把「没数据」排成「最好」。
 * AntD 对 `descend` 会把比较结果整体取反，所以比较器必须消费第三个参数 `sortOrder`。
 */
import { describe, expect, it } from "vitest";
import { compareNullLast } from "@/app/(app)/report/purchase-orders/purchase-orders-client";

/** 模拟 AntD：ascend 直接用比较结果，descend 取反 */
function antdSort<T>(rows: T[], cmp: (a: T, b: T, order: "ascend" | "descend") => number, order: "ascend" | "descend"): T[] {
  return [...rows].sort((a, b) => {
    const r = cmp(a, b, order);
    return order === "ascend" ? r : -r;
  });
}

describe("采购订单指标：没数据不等于差", () => {
  const rows = [
    { name: "好", rate: 0.95 },
    { name: "差", rate: 0.20 },
    { name: "没数据", rate: null as number | null },
    { name: "中", rate: 0.60 },
  ];
  const cmp = (a: typeof rows[number], b: typeof rows[number], order: "ascend" | "descend") =>
    compareNullLast(a.rate, b.rate, order);

  it("升序（差的在前）：没数据的排最后，不冒充最差的那个", () => {
    const sorted = antdSort(rows, cmp, "ascend").map((r) => r.name);
    expect(sorted, "`?? -1` 会把「没数据」排到第一位，读者据此去追一个我们自己没记录的供应商")
      .toEqual(["差", "中", "好", "没数据"]);
  });

  it("降序（好的在前）：没数据的仍排最后，不冒充最好的那个", () => {
    const sorted = antdSort(rows, cmp, "descend").map((r) => r.name);
    expect(sorted, "只把 null 沉底而不管方向，降序时它会浮到第一位 = 把「没数据」排成「最好」")
      .toEqual(["好", "中", "差", "没数据"]);
  });

  it("周期（越小越好）同一条规则：没数据不排成「周期最长」", () => {
    const cycles = [
      { name: "快", p50: 7 as number | null },
      { name: "没数据", p50: null as number | null },
      { name: "慢", p50: 60 as number | null },
    ];
    const sorted = antdSort(cycles, (a, b, o) => compareNullLast(a.p50, b.p50, o), "ascend").map((r) => r.name);
    expect(sorted, "`?? MAX_SAFE_INTEGER` 让「没数据」永远是最慢的那家").toEqual(["快", "慢", "没数据"]);
  });

  it("两边都没数据时保持稳定（不制造抖动）", () => {
    expect(compareNullLast(null, null, "ascend")).toBe(0);
    expect(compareNullLast(undefined, null, "descend")).toBe(0);
  });

  it("页面确实用的是这个比较器（不得再出现 ?? -1 / MAX_SAFE_INTEGER 的排序写法）", async () => {
    const { readFileSync } = await import("node:fs");
    const path = await import("node:path");
    const src = readFileSync(
      path.resolve(process.cwd(), "src/app/(app)/report/purchase-orders/purchase-orders-client.tsx"),
      "utf8",
    );
    expect(src).not.toMatch(/sorter:\s*\([^)]*\)\s*=>\s*\([^)]*\?\?\s*-1\)/);
    expect(src).not.toMatch(/sorter:[^\n]*MAX_SAFE_INTEGER/);
    expect(src.match(/compareNullLast\(/g)?.length ?? 0).toBeGreaterThanOrEqual(4);
  });
});
