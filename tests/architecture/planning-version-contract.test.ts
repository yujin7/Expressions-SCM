import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf8");

describe("C122 planning version reachability and boundaries", () => {
  it("connects menu, Suspense page, client, APIs, service, rule, and persisted tables", () => {
    const shell = read("src/components/AppShell.tsx");
    const page = read("src/app/(app)/replenish/versions/page.tsx");
    const client = read("src/app/(app)/replenish/versions/plan-versions-client.tsx");
    const versionsRoute = read("src/app/api/replenish/versions/route.ts");
    const diffRoute = read("src/app/api/replenish/versions/diff/route.ts");
    const service = read("src/server/modules/replenish/plan-versions.ts");
    const schema = read("src/db/schema/planning.ts");
    const postgresVerifier = read("scripts/verify-postgres.ts");

    expect(shell).toContain("/replenish/versions");
    expect(page).toContain("<Suspense>");
    expect(client).toContain("/api/replenish/versions");
    expect(client).toContain("/api/replenish/versions/diff");
    expect(versionsRoute).toContain("capturePlanningVersion");
    expect(diffRoute).toContain("comparePlanningVersions");
    expect(service).toContain("diffPlanVersions");
    expect(schema).toContain("planningVersions");
    expect(schema).toContain("planningVersionLines");
    const migration = read("drizzle/0026_immutable_planning_versions.sql");
    expect(migration).toContain("planning_versions_append_only");
    expect(migration).toContain("planning_version_lines_append_only");
    expect(postgresVerifier).toContain('"planning_versions"');
    expect(postgresVerifier).toContain('"planning_version_lines"');
    expect(postgresVerifier).toContain('"planning_versions:planning_versions_append_only"');
    expect(postgresVerifier).toContain('"planning_version_lines:planning_version_lines_append_only"');
  });

  it("keeps capture fresh-authorized, PMC-only, idempotent, transactional, and audited", () => {
    const route = read("src/app/api/replenish/versions/route.ts");
    const service = read("src/server/modules/replenish/plan-versions.ts");
    expect(route).toContain("guardFreshWrite");
    expect(route).toContain("readJson");
    expect(service).toContain('requireAnyRole(user, "pmc")');
    expect(service).toContain("idempotencyKey");
    expect(service).toContain(".onConflictDoNothing");
    expect(service).toContain("db.transaction");
    expect(service).toContain("writeAudit(tx");
    expect(service).toContain("{ allRows: true }");
  });

  it("keeps the client free of server value imports and exposes honest mixed changes", () => {
    const client = read("src/app/(app)/replenish/versions/plan-versions-client.tsx");
    const rule = read("src/server/rules/plan-version-diff.ts");
    expect(client).not.toMatch(/from ["']@\/server\//);
    expect(client).toContain("ListToolbar");
    expect(client).toContain("保存当前建议为版本");
    expect(rule).toContain('"mixed"');
    expect(rule).toContain("absolute business dates");
  });
});
