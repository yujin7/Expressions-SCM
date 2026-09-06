import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { yonyouContractAdmission } from "../../scripts/verify-postgres-yonyou-concurrency";

const cwd = process.platform === "darwin" ? "/private/tmp/expscm-candidate-contract-test" : "/tmp/expscm-candidate-contract-test";
const allowed = "postgres://fixture:synthetic-only@127.0.0.1:50397/scm_contract_test";
const baseline = {
  DATABASE_URL: allowed,
  SCM_ALLOW_MUTATING_PG_CONTRACT: "1",
  NODE_ENV: "test",
  SCM_RUN_JOBS: "0",
  FILE_STORAGE_DIR: `${cwd}/.data/yonyou-pg-evidence`,
};

describe("Yonyou PostgreSQL proof admission (pure; no application import or connection)", () => {
  it.each([undefined, "", "0", "true"])("requires explicit mutating proof consent %s", (consent) => {
    expect(() => yonyouContractAdmission({ ...baseline, SCM_ALLOW_MUTATING_PG_CONTRACT: consent }, cwd))
      .toThrow(/SCM_ALLOW_MUTATING_PG_CONTRACT=1/);
  });

  it.each([
    { NODE_ENV: undefined }, { NODE_ENV: "production" }, { NODE_ENV: "development" },
    { SCM_RUN_JOBS: undefined }, { SCM_RUN_JOBS: "1" }, { SCM_RUN_JOBS: "false" },
  ])("requires test mode and explicitly disabled background jobs %j", (change) => {
    expect(() => yonyouContractAdmission({ ...baseline, ...change }, cwd)).toThrow(/NODE_ENV=test and SCM_RUN_JOBS=0/);
  });

  it.each([
    undefined, "", "pglite:.data/dev",
    "postgres://fixture:synthetic-only@external.example:5432/scm_contract_test",
    "postgres://fixture:synthetic-only@127.0.0.1:15432/scm_contract_test",
    "postgres://fixture:synthetic-only@127.0.0.1:3100/scm_contract_test",
    "postgres://fixture:synthetic-only@127.0.0.1:0/scm_contract_test",
    "postgres://fixture:synthetic-only@127.0.0.1:5432/scm_production",
    "postgres://fixture:synthetic-only@127.0.0.1:5432/scm_contract_",
    "postgres://fixture:synthetic-only@127.0.0.1/scm_contract_test",
    "postgres://fixture@127.0.0.1:5432/scm_contract_test",
    "postgres://127.0.0.1:5432/scm_contract_test",
    `${allowed}?host=external.example`, `${allowed}?options=-c%20session_replication_role%3Dreplica`, `${allowed}#override`,
  ])("rejects unsafe, overridden or implicitly configured database targets %s", (url) => {
    expect(() => yonyouContractAdmission({ ...baseline, DATABASE_URL: url }, cwd)).toThrow();
  });

  it.each([
    allowed,
    "postgresql://fixture:synthetic-only@localhost:5432/scm_contract_ci_42",
    "postgres://fixture:synthetic-only@[::1]:5432/scm_contract_ci",
  ])("accepts explicit disposable loopback configuration %s", (url) => {
    expect(yonyouContractAdmission({ ...baseline, DATABASE_URL: ` ${url} ` }, cwd)).toEqual({
      connectionString: url,
      databaseName: new URL(url).pathname.slice(1),
      candidateRoot: cwd,
      storageRoot: baseline.FILE_STORAGE_DIR,
    });
  });

  it.each(["/", "/tmp", "/private/tmp", "/Users/yj/Downloads/project", "relative-project"])("rejects non-isolated or broad cwd %s", (root) => {
    expect(() => yonyouContractAdmission({ ...baseline, FILE_STORAGE_DIR: `${root}/.data/evidence` }, root)).toThrow();
  });

  it.each([
    undefined, "", "./uploads", cwd, `${cwd}/..`, "/tmp/shared-evidence",
    `${cwd}-sibling/evidence`, `${cwd}/../outside/evidence`, "/Users/yj/Downloads/project/uploads",
  ])("requires explicit evidence storage strictly inside the copied candidate %s", (storage) => {
    expect(() => yonyouContractAdmission({ ...baseline, FILE_STORAGE_DIR: storage }, cwd)).toThrow(/FILE_STORAGE_DIR/);
  });

  it("accepts the canonical macOS /private/tmp candidate spelling", () => {
    const canonical = "/private/tmp/expscm-candidate-contract-test";
    const result = yonyouContractAdmission({ ...baseline, FILE_STORAGE_DIR: `${canonical}/.data/evidence` }, canonical);
    expect(result.candidateRoot).toBe(canonical);
  });

  it("normalizes temporary aliases according to the host platform", () => {
    const root = "/tmp/expscm-candidate-contract-test";
    const result = yonyouContractAdmission({ ...baseline, FILE_STORAGE_DIR: `${root}/.data/evidence` }, root);
    expect(result.storageRoot).toBe(`${cwd}/.data/evidence`);
  });

  it("does not expose supplied credentials in an admission error", () => {
    let message = "";
    try {
      yonyouContractAdmission({ ...baseline, DATABASE_URL: "postgres://fixture:do-not-echo@external.example:5432/scm_contract_test" }, cwd);
    } catch (error) { message = String(error); }
    expect(message).toContain("explicit disposable loopback");
    expect(message).not.toContain("do-not-echo");
    expect(message).not.toContain("external.example");
  });
});

// CI wiring checks are part of this integration contract, not a new architecture control.
const yaml = createRequire(import.meta.url)("js-yaml") as { load(source: string): unknown };
type CiStep = { name?: string; run?: string; env?: Record<string, string>; if?: string; "continue-on-error"?: boolean };
type CiWorkflow = { jobs: Record<string, {
  name?: string; env?: Record<string, string>; steps: CiStep[]; "continue-on-error"?: boolean;
  services?: Record<string, { env?: Record<string, string> }>;
}> };
type PackageScripts = { scripts: Record<string, string> };
const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
const ci = yaml.load(read(".github/workflows/ci.yml")) as CiWorkflow;
const pkg = JSON.parse(read("package.json")) as PackageScripts;
const CI_STEP = "Yonyou retries and concurrency (isolated PostgreSQL)";

function assertCiRegistration(workflow: CiWorkflow, manifest: PackageScripts): void {
  expect(manifest.scripts["check:postgres:yonyou-concurrency"])
    .toBe("node --import tsx scripts/verify-postgres-yonyou-concurrency.ts");
  const job = workflow.jobs.postgres;
  expect(job.name).toBe("PostgreSQL migration contract");
  expect(job["continue-on-error"]).toBeUndefined();
  expect(job.services?.postgres.env?.POSTGRES_DB).toBe("scm_contract_ci");
  const step = job.steps.find((item) => item.name === CI_STEP);
  expect(step, "The proof must run inside the existing required PostgreSQL job").toBeDefined();
  if (!step) throw new Error("Missing Yonyou contract step");
  expect(step.if).toBeUndefined();
  expect(step["continue-on-error"]).toBeUndefined();
  expect(step.env).toMatchObject({ NODE_ENV: "test", SCM_RUN_JOBS: "0", SCM_ALLOW_MUTATING_PG_CONTRACT: "1" });
  const commands = (step.run ?? "").split(/\r?\n/).map((line) => line.trim());
  for (const command of [
    "set -euo pipefail",
    "try { await client.query('CREATE DATABASE scm_contract_yonyou_ci'); }",
    "candidate_dir=$(mktemp -d /tmp/expscm-yonyou-ci.XXXXXX)",
    'cp -R src drizzle scripts "$candidate_dir/"',
    'cp package.json package-lock.json tsconfig.json drizzle.config.ts "$candidate_dir/"',
    'ln -s "$PWD/node_modules" "$candidate_dir/node_modules"',
    'cd "$candidate_dir"',
    'export DATABASE_URL="${DATABASE_URL%/scm_contract_ci}/scm_contract_yonyou_ci"',
    'export FILE_STORAGE_DIR="$candidate_dir/.data/yonyou-evidence"',
    "npm run db:migrate", "npm run check:postgres", "npm run check:postgres:yonyou-concurrency",
  ]) expect(commands, "A commented, masked or skipped command is not CI evidence").toContain(command);
  expect(commands.indexOf("npm run db:migrate")).toBeLessThan(commands.indexOf("npm run check:postgres"));
  expect(commands.indexOf("npm run check:postgres")).toBeLessThan(commands.indexOf("npm run check:postgres:yonyou-concurrency"));
  const database = new URL(job.env?.DATABASE_URL ?? "");
  expect(database.pathname).toBe("/scm_contract_ci");
  database.pathname = "/scm_contract_yonyou_ci";
  expect(() => yonyouContractAdmission({ ...job.env, ...step.env,
    DATABASE_URL: database.href, FILE_STORAGE_DIR: `${cwd}/.data/yonyou-evidence`,
  }, cwd)).not.toThrow();
}

describe("Yonyou PostgreSQL CI registration", () => {
  it("runs after migration/schema checks in the existing required gate with a separate empty database", () => {
    assertCiRegistration(ci, pkg);
    expect(read("scripts/README.md")).toContain("check:postgres:yonyou-concurrency");
  });

  it.each(["remove", "mask-failure", "skip-step", "enable-jobs", "omit-consent", "shared-database"])("rejects CI registration regression: %s", (mutation) => {
    const broken = structuredClone(ci);
    const job = broken.jobs.postgres;
    const step = job.steps.find((item) => item.name === CI_STEP)!;
    if (mutation === "remove") job.steps = job.steps.filter((item) => item !== step);
    if (mutation === "mask-failure") step["continue-on-error"] = true;
    if (mutation === "skip-step") step.if = "false";
    if (mutation === "enable-jobs") step.env!.SCM_RUN_JOBS = "1";
    if (mutation === "omit-consent") delete step.env!.SCM_ALLOW_MUTATING_PG_CONTRACT;
    if (mutation === "shared-database") step.run = step.run!.replace(
      'export DATABASE_URL="${DATABASE_URL%/scm_contract_ci}/scm_contract_yonyou_ci"',
      'export DATABASE_URL="${DATABASE_URL}"',
    );
    expect(() => assertCiRegistration(broken, pkg)).toThrow();
  });

  it("rejects a removed or masked executable probe, not just a surviving job name", () => {
    const broken = structuredClone(ci);
    const step = broken.jobs.postgres.steps.find((item) => item.name === CI_STEP)!;
    step.run = step.run!.replace("npm run check:postgres:yonyou-concurrency", "npm run check:postgres:yonyou-concurrency || true");
    expect(() => assertCiRegistration(broken, pkg)).toThrow();
    expect(() => assertCiRegistration(ci, { scripts: { ...pkg.scripts, "check:postgres:yonyou-concurrency": "echo skipped" } })).toThrow();
  });
});
