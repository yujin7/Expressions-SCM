import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (relative: string): string => readFileSync(path.join(root, relative), "utf8");

describe("decision metric layout", () => {
  it("uses a responsive KPI grid instead of compressed fixed columns", () => {
    const dashboard = read("src/app/(app)/report/dashboard/dashboard-client.tsx");
    const styles = read("src/app/globals.css");

    expect(dashboard).toContain('className="dashboard-kpi-grid"');
    expect(dashboard).toContain('className="dashboard-insights__list"');
    expect(dashboard).not.toContain("<Col xs={12} md={8} xl={3}>");
    expect(styles).toContain("repeat(auto-fit, minmax(min(100%, 220px), 1fr))");
    expect(styles).toContain("repeat(auto-fit, minmax(min(100%, 520px), 1fr))");
    expect(styles).toMatch(
      /\.decision-metric\s*\{[^}]*container-type:\s*inline-size;/s,
    );
    expect(styles).toMatch(
      /\.decision-metric__statistic \.ant-statistic-content\s*\{[^}]*font-size:\s*clamp\(20px,\s*11cqi,\s*34px\);/s,
    );
    expect(styles).toMatch(
      /@container app-surface \(max-width:\s*760px\)[\s\S]*\.dashboard-kpi-grid\s*\{[^}]*grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\);/s,
    );
    expect(styles).not.toContain("@container app-surface (min-width: 640px) and (max-width: 760px)");
    expect(styles).toMatch(
      /@container app-surface \(max-width:\s*520px\)[\s\S]*\.dashboard-kpi-grid\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\);/s,
    );
  });

  it("renders metric explanations as bounded copy rather than tags", () => {
    const metric = read("src/components/DecisionMetric.tsx");

    expect(metric).toContain('className="decision-metric__description"');
    expect(metric).not.toContain("<Tag");
    expect(metric).toContain('className="decision-metric__action"');
  });
});
