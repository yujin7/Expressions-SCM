import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const read = (relative: string): string => readFileSync(path.join(process.cwd(), relative), "utf8");

describe("admin connector run layout contract", () => {
  it("uses one compact responsive table and only the safe run DTO", () => {
    const client = read("src/app/(app)/admin/health/health-client.tsx");
    const service = read("src/server/modules/admin/health.ts");
    const dto = service.slice(
      service.indexOf("export interface ConnectorRunHealthRow"),
      service.indexOf("export interface OpsHealth"),
    );
    const connectorCard = client.slice(
      client.indexOf('title="连接器最近运行与检查点"'),
      client.indexOf('title={`最近错误'),
    );

    expect(connectorCard).toContain('title="连接器最近运行与检查点"');
    expect(connectorCard).toContain("dataSource={data.connectorRuns}");
    expect(connectorCard).toContain('size="small"');
    expect(connectorCard).toContain('tableLayout="fixed"');
    expect(connectorCard).toContain("scroll={{ x: 1_270 }}");
    expect(client).toContain("行数（源 / 暂存 / 拒绝）");
    expect(client).toContain("作用域待裁决");
    expect(client).toContain("保留上次成功位点");
    expect(client).toContain("空观察，旧批次保留");
    expect(client).toContain("仅观察，不可放行");
    expect(client).toContain("字段结构变化，阻止放行");
    expect(client).toContain("字段结构");
    expect(client).toContain("配置 / UAT 就绪");
    expect(client).toContain("connectorRuntimeState(connectorRuns)");
    expect(client).toContain("data.connectorRuns.filter");
    expect(client).not.toContain("data.connectorRuns.find((row) => row.connector === connector.key)");
    expect(client).toContain("当前发送路径");

    expect(dto).toContain("errorSummary: string | null");
    expect(dto).toContain("emptySource: boolean");
    expect(dto).toContain("releaseBlocked: boolean");
    expect(dto).toContain("schemaDrift: boolean");
    expect(dto).toContain("fieldProfile:");
    expect(dto).not.toContain("evidencePath");
    expect(dto).not.toContain("evidenceHash");
    expect(dto).not.toMatch(/\berror:/);
    expect(dto).not.toContain("requestScope");
  });
});
