import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (relative: string): string => readFileSync(path.join(root, relative), "utf8");

describe("governed decision visual contract", () => {
  it("requires source, question, summary, and explicit insufficient-data handling", () => {
    const visual = read("src/components/DecisionVisual.tsx");
    expect(visual).toContain("question: string");
    expect(visual).toContain("source: DecisionVisualSource");
    expect(visual).toContain("summary: string");
    expect(visual).toContain('state === "insufficient"');
    expect(visual).toContain("数据不足，暂不下结论");
    expect(visual).toContain("aria-describedby");
    expect(visual).toContain("显示数据表");
  });

  it("migrates the executive and inventory decision charts onto the shared contract", () => {
    const dashboard = read("src/app/(app)/report/dashboard/dashboard-client.tsx");
    const inventory = read(
      "src/app/(app)/report/inventory-analytics/inventory-analytics-client.tsx",
    );
    expect(dashboard).toContain("<DecisionVisual");
    expect(dashboard).not.toContain("<PieChart");
    expect(dashboard).toContain("useListState");
    expect(inventory).toContain("<DecisionVisual");
    expect(inventory).toContain('defaults: { q: "", windowDays: "90", view: "scatter" }');
  });

  it("maps every historical report route to a real navigation group", () => {
    const shell = read("src/components/AppShell.tsx");
    expect(shell).not.toContain('return ["reports"]');
    expect(shell).toContain('pathname.startsWith("/matflow/")) return "matflow"');
    expect(shell).toContain('pathname.startsWith("/settlement/") || pathname.startsWith("/jobs/")');
    expect(shell).toContain("<Drawer");
  });
});

