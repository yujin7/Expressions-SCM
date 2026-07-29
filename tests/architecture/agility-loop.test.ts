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
