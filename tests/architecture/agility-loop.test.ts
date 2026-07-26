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
    expect(pkg.scripts["check:fast"]).toContain("verify-fast.ts");
    expect(pkg.scripts["check:pr"]).toContain("lint:full");
    expect(pkg.scripts["check:release"]).toContain("verify-release.ts");
    expect(read(".github/workflows/ci.yml")).toContain("cancel-in-progress: true");
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
