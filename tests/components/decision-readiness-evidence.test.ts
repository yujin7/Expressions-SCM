import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  path.join(process.cwd(), "src/components/DecisionReadinessPanel.tsx"),
  "utf8",
);

describe("决策能力页的来源证据", () => {
  it("使用动态来源和动态产品数，不把目录当成已接通", () => {
    expect(source).toContain('title="三方来源证据矩阵"');
    expect(source).toContain("dataSource={dataSources}");
    expect(source).toContain("{DATA_PRODUCTS.length} 个目标契约");
    expect(source).not.toContain("10 个目标契约");
    expect(source).toContain("来源/所需流缺失");
    expect(source).toContain("来源齐·未放行");
    expect(source).toContain("来源已放行");
    expect(source).toContain("所需流已过期");
    expect(source).toContain("RequiredStreamEvidence");
    expect(source).toContain("ProductOperatingContract");
    expect(source).toContain("currentProductAutomation");
    expect(source).toContain("契约 v{product.contractVersion}");
    expect(source).toContain("决策 SLA {product.decisionSlaHours}h");
    expect(source).toContain("UAT 后上限");
    expect(source).toContain("核心指标：");
    expect(source).toContain("自动化护栏：");
    expect(source).toContain("业务截止 / 时效");
    expect(source).toContain("源行 / Staging / 拒收");
    expect(source).toContain("导出决策证据包");
    expect(source).toContain("buildDataProductEvidenceExport");
  });

  it("不把固定契约误报为零契约，也不把源行差额自动当成丢数", () => {
    expect(source).toContain("固定契约·无需手选");
    expect(source).toContain("差额不自动等于丢数");
    expect(source).toContain('timeZone: "Asia/Shanghai"');
    expect(source).toContain("evaluateProductSourceEvidence(row, dataSources)");
    expect(source).toContain("当前 {current} · 过期 {stale} · 未定 {unknown}");
    expect(source).toContain("ellipsis={{ rows: 2, tooltip: row.gate }}");
    expect(source).toContain("ellipsis={{ rows: 2, tooltip: row.nextAction }}");
  });
});
