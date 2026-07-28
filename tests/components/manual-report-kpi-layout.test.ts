import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (relative: string): string => readFileSync(path.join(root, relative), "utf8");

describe("manual report KPI layouts", () => {
  it("uses the compact KPI row for demand summary statistics", () => {
    const source = read("src/app/(app)/report/demand/demand-client.tsx");

    expect(source).toContain('<Row gutter={[12, 12]} className="compact-kpi-row">');
  });

  it("uses the shared compact statistic strip for funnel stages", () => {
    const source = read("src/app/(app)/report/funnel/funnel-client.tsx");

    expect(source).toContain('<Space className="compact-stat-strip" wrap>');
    expect(source).not.toContain('style={{ minWidth: 150 }}');
  });

  it("uses the responsive dashboard grid for inventory decision metrics", () => {
    const source = read(
      "src/app/(app)/report/inventory-analytics/inventory-analytics-client.tsx",
    );

    expect(source).toContain(
      '<section className="dashboard-kpi-grid" aria-label="库存分析关键指标"',
    );
    expect(source.match(/className="dashboard-kpi-grid__item"/g)).toHaveLength(4);
    expect(source).not.toContain(
      '<Row gutter={[12, 12]} style={{ marginBottom: 12 }}>',
    );
  });
});
