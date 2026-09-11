import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf8");

describe("C154 process mining reachability and safety contract", () => {
  it("is reachable from analytics and protected by page, API, and service role checks", () => {
    // D62：菜单分组/条目/角色迁至单一注册表 src/lib/route-access.ts（AppShell 只派生）
    const shell = read("src/lib/route-access.ts");
    const page = read("src/app/(app)/report/process-mining/page.tsx");
    const route = read("src/app/api/report/process-mining/route.ts");
    const service = read("src/server/modules/report/process-mining.ts");

    expect(shell).toContain('path: "/report/process-mining", label: "流程效率与瓶颈", roles: ["pmc", "finance"], group: "analytics"');
    expect(page).toContain("管理员、生产计划或财务");
    expect(route).toContain("getProcessMining(user");
    expect(service).toContain("guardProcessMining(user)");
  });

  it("uses the governed visual contract, exposes coverage, and avoids employee ranking", () => {
    const client = read("src/app/(app)/report/process-mining/process-mining-client.tsx");
    const rules = read("src/server/rules/process-mining.ts");

    expect(client).toContain("<DecisionVisual");
    expect(client).toContain("caseCoverageRate");
    expect(client).toContain("少于 3 个样本");
    expect(client).toContain("慢案例与事件证据");
    expect(client).toContain("只分析流程，不做员工排名");
    expect(rules).not.toContain("userName");
    expect(rules).not.toMatch(/\buserId\b/);
  });

  it("persists versioned canonical identity without mutating historical rows", () => {
    const audit = read("src/server/core/audit.ts");
    const migration = read("drizzle/0024_secret_talon.sql");

    expect(audit).toContain("classifyEvent(i.entity, i.action)");
    expect(audit).toContain('AUDIT_EVENT_VERSION = "event-v1"');
    expect(migration).toContain('ADD COLUMN "canonical_event"');
    expect(migration).not.toMatch(/UPDATE\\s+"audit_logs"/i);
  });
});
