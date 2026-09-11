import { lstatSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (relative: string): string => readFileSync(path.join(root, relative), "utf8");
const yaml = createRequire(import.meta.url)("js-yaml") as { load: (text: string) => unknown };

describe("agile delivery loop", () => {
  it("shards the entire test suite without weakening the protected aggregate check", () => {
    const workflow = yaml.load(read(".github/workflows/ci.yml")) as {
      jobs: Record<string, {
        name: string; needs?: string; if?: string; "continue-on-error"?: boolean;
        strategy?: { matrix: { shard: number[] }; "fail-fast": boolean };
        steps: { run?: string; env?: Record<string, string> }[];
      }>;
    };
    const shards = workflow.jobs["test-shards"];
    expect(shards.strategy).toEqual({ matrix: { shard: [1, 2, 3, 4] }, "fail-fast": false });
    expect(shards.steps.some((step) => step.run === "npm test -- --shard=${{ matrix.shard }}/4")).toBe(true);
    expect(shards["continue-on-error"]).not.toBe(true);
    const gate = workflow.jobs.test;
    expect(gate.name).toBe("Full test suite");
    expect(gate.needs).toBe("test-shards");
    expect(gate.if).toBe("${{ always() }}");
    const step = gate.steps[0];
    expect(step.env?.SHARD_RESULT).toBe("${{ needs.test-shards.result }}");
    for (const result of ["success", "failure", "cancelled", "skipped", ""]) {
      const check = spawnSync("bash", ["-c", step.run!], { env: { ...process.env, SHARD_RESULT: result } });
      expect(check.status === 0).toBe(result === "success");
    }
  });
  it("keeps development, build, and background-job state isolated", () => {
    const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
    expect(pkg.scripts.dev).toContain("next dev --turbopack");
    expect(pkg.scripts.dev).toContain("NEXT_DIST_DIR=.next-dev");
    expect(pkg.scripts["dev:webpack"]).toContain("NEXT_DIST_DIR=.next-webpack");
    expect(pkg.scripts["dev:jobs"]).toContain("SCM_RUN_JOBS=1");
    expect(pkg.scripts.build).toContain("normalize-next-env.ts");
    expect(read("scripts/normalize-next-env.ts")).toContain(".next-dev/types/routes.d.ts");
    expect(read(".dockerignore")).toContain("!scripts/normalize-next-env.ts");
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
    expect(workflow).toContain("bash scripts/build-ci-container.sh");
    expect(read("scripts/build-ci-container.sh")).toContain("--tag supply-chain:ci .");
    expect(read("scripts/build-ci-container.sh")).toContain('--build-arg "SCM_BUILD_REVISION=$source_revision"');
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
    expect(read("package-lock.json")).toContain(
      "node_modules/@unrs/resolver-binding-wasm32-wasi/node_modules/@emnapi/runtime",
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
    const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string>; overrides: Record<string, string> };
    const dockerfile = read("Dockerfile");
    const dockerignore = read(".dockerignore");
    expect(eslintConfig).toContain('".next-*/**"');
    expect(eslintConfig).toContain('".artifacts/**"');
    expect(eslintConfig).not.toContain('from "@eslint/eslintrc"');
    expect(pkg.scripts.postinstall).toContain("patch-minimatch-brace-api.mjs");
    expect(pkg.overrides["brace-expansion"]).toBe("5.0.8");
    expect(read("scripts/patch-minimatch-brace-api.mjs")).toContain("braceExpansion.expand");
    expect(dockerignore).toContain("!scripts/patch-minimatch-brace-api.mjs");
    expect(dockerfile).toContain(
      "COPY scripts/patch-minimatch-brace-api.mjs ./scripts/patch-minimatch-brace-api.mjs",
    );
    expect(dockerfile.indexOf("COPY scripts/patch-minimatch-brace-api.mjs"))
      .toBeLessThan(dockerfile.indexOf("RUN npm ci"));
  });

  it("keeps local data, recovery evidence, uploads, and environment files out of standalone", () => {
    const config = read("next.config.ts");
    const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
    const dockerfile = read("Dockerfile");
    const sanitizer = read("scripts/sanitize-standalone.ts");

    for (const excluded of [".data/**/*", "backups/**/*", "uploads/**/*", ".artifacts/**/*", "tmp/**/*"]) {
      expect(config).toContain(excluded);
    }
    expect(pkg.scripts.build).toContain("scripts/sanitize-standalone.ts");
    expect(dockerfile).toContain("RUN npm run build");
    expect(read(".dockerignore")).toContain("!scripts/sanitize-standalone.ts");
    expect(config).toContain('"/**"');
    expect(config).not.toContain('"/*"');
    expect(sanitizer).toContain('name !== ".env"');
    expect(sanitizer).toContain("Sensitive/local directory leaked into standalone");
  });

  it("uses one Node major locally, in CI, and in the production image", () => {
    const pkg = JSON.parse(read("package.json")) as { packageManager?: string };
    expect(read(".nvmrc").trim()).toBe("24");
    expect(read("package.json")).toContain('"node": ">=24 <25"');
    expect(pkg.packageManager).toBe("npm@11.16.0");
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
