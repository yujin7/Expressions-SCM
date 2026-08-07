/** 数据审计不得把生产 PostgreSQL 误标成本地 PGlite。 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

describe("数据审计证据范围", () => {
  it("按实际 DATABASE_URL 驱动标记，且不输出完整连接串", () => {
    const source = readFileSync("scripts/audit-data-lineage.ts", "utf8");
    expect(source).toContain("configuredDatabaseScope()");
    expect(source).toContain('return "configured PostgreSQL database"');
    expect(source).not.toContain('revisionScope: "current working tree + local PGlite .data/dev"');
    expect(source).not.toMatch(/revisionScope:.*DATABASE_URL/);
  });
});
