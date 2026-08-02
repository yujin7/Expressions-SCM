import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const read = (relative: string): string => readFileSync(path.join(process.cwd(), relative), "utf8");

describe("SKU 主数据建档 UI 治理", () => {
  const client = read("src/app/(app)/master/sku/sku-client.tsx");

  it("日常新建只展示系统 S1，历史码例外只对管理员并要求原因", () => {
    expect(client).toContain('const canHistoricalMigration = me?.roles.includes("admin")');
    expect(client).toContain('initialValue="governed_s1"');
    expect(client).toContain('value: "historical_migration"');
    expect(client).toContain('name="historicalMigrationReason"');
    expect(client).toContain("迁移原因至少 10 个字");
    expect(client).toContain("系统将自动生成 S1 编码");
    expect(client).not.toContain("或输入真实历史/外部码");
  });
});
