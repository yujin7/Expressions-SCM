import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf8");

describe("C123 scenario-management reachability and evidence boundaries", () => {
  it("connects the drawer, API, service, schema, migration, and PostgreSQL verifier", () => {
    const drawer = read("src/components/ProjectionDrawer.tsx");
    const route = read("src/app/api/replenish/scenarios/route.ts");
    const service = read("src/server/modules/replenish/scenarios.ts");
    const schema = read("src/db/schema/planning.ts");
    const migration = read("drizzle/0027_romantic_random.sql");
    const postgresVerifier = read("scripts/verify-postgres.ts");

    expect(drawer).toContain("/api/replenish/scenarios");
    expect(drawer).toContain("选择最多两个情景并排比较");
    expect(route).toContain("guardFreshWrite");
    expect(route).toContain("guardRead");
    expect(service).toContain('requireAnyRole(user, "pmc")');
    expect(service).toContain(".onConflictDoNothing");
    expect(service).toContain("writeAudit(tx");
    expect(schema).toContain("projectionScenarios");
    expect(migration).toContain("projection_scenarios_append_only");
    expect(postgresVerifier).toContain('"projection_scenarios"');
    expect(postgresVerifier).toContain(
      '"projection_scenarios:projection_scenarios_append_only"',
    );
  });

  it("stores baseline, assumptions, and scenario output rather than recalculating history", () => {
    const schema = read("src/db/schema/planning.ts");
    const service = read("src/server/modules/replenish/scenarios.ts");
    expect(schema).toContain('baselineResult: jsonb("baseline_result").notNull()');
    expect(schema).toContain('scenarioResult: jsonb("scenario_result").notNull()');
    expect(schema).toContain('inputs: jsonb("inputs").notNull()');
    expect(service).toContain("baselineResult: baseline");
    expect(service).toContain("scenarioResult: projected");
  });
});
