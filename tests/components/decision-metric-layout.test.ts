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
  });

  it("renders metric explanations as bounded copy rather than tags", () => {
    const metric = read("src/components/DecisionMetric.tsx");

    expect(metric).toContain('className="decision-metric__description"');
    expect(metric).not.toContain("<Tag");
    expect(metric).toContain('className="decision-metric__action"');
  });
});
