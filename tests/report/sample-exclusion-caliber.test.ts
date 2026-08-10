/**
 * 样品排除口径必须全站一致（口径漂移护栏）。
 *
 * 驾驶舱与风险页早已用共享规则 `participatesInNormalSalesMovement` 把样品/赠品/
 * 试用/内用排除在「无动销/滞销」之外，但 ABC/XYZ 分层页与库存分析页此前直接
 * `active = true and sku_type = 'finished'` 取数，没有排除——同一批 SKU 在两处
 * 会得到不同结论。此前因为实跑库 0 行被分类，这个偏差一直看不出来；
 * 一旦业务开始打标就会立刻表现为「驾驶舱说健康、分层页说滞销」。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const SALES_CALIBER_MODULES = [
  "src/server/modules/report/segmentation.ts",
  "src/server/modules/report/inventory-analytics.ts",
  "src/server/modules/report/risk.ts",
  "src/server/modules/report/dashboard.ts",
];

describe("样品排除口径", () => {
  it.each(SALES_CALIBER_MODULES)("%s 使用共享规则判定，而不是本地重实现", (file) => {
    const src = readFileSync(file, "utf8");
    expect(src, `${file} 未引用共享规则`).toContain("participatesInNormalSalesMovement");
    // 本地重实现是口径漂移的根因：禁止直接硬编码角色集合做排除
    expect(
      /commercialRole\s*!==\s*["']sample["']/.test(src),
      `${file} 出现了硬编码的样品判断，请改用共享规则`,
    ).toBe(false);
  });

  it("共享规则本身的取值边界不变（改这里等于改全站口径）", async () => {
    const { participatesInNormalSalesMovement } = await import("@/server/rules/sku-standardization");
    expect(participatesInNormalSalesMovement("retail")).toBe(true);
    // 未分类保守计入正常销售——这正是"必须尽快把存量打上标"的原因
    expect(participatesInNormalSalesMovement("unclassified")).toBe(true);
    for (const role of ["sample", "gift", "tester", "internal"]) {
      expect(participatesInNormalSalesMovement(role), role).toBe(false);
    }
  });
});
