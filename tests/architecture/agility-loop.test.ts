import { lstatSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (relative: string): string => readFileSync(path.join(root, relative), "utf8");

describe("agile delivery loop", () => {
  it("keeps development, build, and background-job state isolated", () => {
    const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
    expect(pkg.scripts.dev).toContain("next dev --turbopack");
    expect(pkg.scripts.dev).toContain("NEXT_DIST_DIR=.next-dev");
    expect(pkg.scripts["dev:webpack"]).toContain("NEXT_DIST_DIR=.next-webpack");
    expect(pkg.scripts["dev:jobs"]).toContain("SCM_RUN_JOBS=1");
    expect(read("src/instrumentation.ts")).toContain('process.env.SCM_RUN_JOBS === "1"');
  });

  it("provides distinct fast, PR, and release evidence gates", () => {
    const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
    const workflow = read(".github/workflows/ci.yml");
    expect(pkg.scripts["check:fast"]).toContain("verify-fast.ts");
    expect(pkg.scripts["check:pr"]).toContain("lint:full");
    expect(pkg.scripts["check:release"]).toContain("verify-release.ts");
    expect(pkg.scripts["check:ops"]).toContain("verify-ops.ts");
    expect(workflow).toContain("cancel-in-progress: true");
    expect(workflow).toContain("PostgreSQL migration contract");
    expect(workflow).toContain("docker build --tag supply-chain:ci .");
    expect(workflow).toContain("npm run check:ops");
    expect(workflow).toContain("actions/checkout@v7");
    expect(workflow).toContain("actions/setup-node@v7");
    expect(workflow).not.toContain("actions/checkout@v4");
    expect(workflow).not.toContain("actions/setup-node@v4");
    expect(pkg.scripts["check:postgres"]).toContain("verify-postgres.ts");
    expect(read("scripts/verify-postgres.ts")).toContain("async function main()");
    expect(read("scripts/verify-postgres.ts")).toContain("void main()");
    expect(read("package-lock.json")).toContain(
      "node_modules/@unrs/resolver-binding-wasm32-wasi/node_modules/@emnapi/core",
    );
    expect(read("vitest.config.ts")).toContain("maxWorkers: 4");
  });

  it("keeps local diagnostics honest about oversized build caches", () => {
    const cli = read("scripts/scm.ts");
    expect(cli).toContain("cache exceeds 1 GiB");
    expect(cli).toContain("npm run scm -- clean --all");
  });

  it("does not lint generated output after a normal development session", () => {
    const eslintConfig = read("eslint.config.mjs");
    expect(eslintConfig).toContain('".next-dev/**"');
    expect(eslintConfig).toContain('".next-webpack/**"');
    expect(eslintConfig).toContain('".artifacts/**"');
  });

  it("uses one Node major locally, in CI, and in the production image", () => {
    expect(read(".nvmrc").trim()).toBe("24");
    expect(read("package.json")).toContain('"node": ">=24 <25"');
    expect(read(".github/workflows/ci.yml")).not.toContain("node-version: 22");
    expect(read("Dockerfile")).not.toContain("node:22");
  });

  it("exposes exactly seven canonical project skills through seven links", () => {
    const canonical = readdirSync(path.join(root, ".claude/skills"))
      .filter((name) => lstatSync(path.join(root, ".claude/skills", name, "SKILL.md")).isFile())
      .sort();
    const links = readdirSync(path.join(root, ".agents/skills"))
      .filter((name) => lstatSync(path.join(root, ".agents/skills", name)).isSymbolicLink())
      .sort();
    expect(canonical).toEqual([
      "design-supply-chain-flows",
      "integrate-supply-chain-data",
      "measure-first",
      "parallel-sessions",
      "release-sweep",
      "supply-chain",
      "write-path",
    ]);
    expect(links).toEqual(canonical);
  });
});
