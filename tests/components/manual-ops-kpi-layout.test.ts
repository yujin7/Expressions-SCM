import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (relative: string): string => readFileSync(path.join(root, relative), "utf8");

describe("manual operations KPI layouts", () => {
  it("uses the shared compact KPI grid for the batch-posting readiness summary", () => {
    const source = read(
      "src/app/(app)/admin/params/BatchPostingRolloutCard.tsx",
    );

    expect(source).toContain(
      '<Row gutter={[10, 10]} className="compact-kpi-row">',
    );
  });

  it("keeps workbench focus, loading, and queue metrics compact", () => {
    const source = read("src/app/(app)/workbench/workbench-client.tsx");

    expect(source.match(/className="compact-kpi-row"/g)).toHaveLength(3);
  });

  it("renders the S&OP plan evidence as compact statistics", () => {
    const source = read("src/app/(app)/replenish/sop/sop-client.tsx");
    const planEvidence = source.slice(source.indexOf('title="冻结计划证据"'));

    expect(planEvidence).toContain('className="compact-kpi-row"');
    expect(planEvidence).toContain('<Statistic title="全量行"');
    expect(planEvidence).toContain('<Statistic title="建议"');
    expect(planEvidence).toContain('<Statistic title="抑制"');
    expect(planEvidence).not.toContain(
      '<Typography.Title level={4}>{cycle.plan.lineCount}</Typography.Title>',
    );
  });

  it("leaves the daily digest bounded because its three-column KPIs are not oversized", () => {
    const source = read("src/app/(app)/report/digest/digest-client.tsx");

    expect(source).toContain("maxWidth: 960");
    expect(source).toContain(
      '<Col key={h.href} xs={12} sm={8} md={8} lg={8}>',
    );
  });
});
