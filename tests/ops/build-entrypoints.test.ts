import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("build entrypoint ownership", () => {
  it.each(["", "scripts/public-tunnel-daemon.sh", "scripts/app-operation-lock.sh", "scripts/remove-public-tunnel.sh"])("syntax gate checks every named script and propagates failure at %s", failAt => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> };
    // Test loop/exit propagation in one shell, not nine OS startup latencies.
    // check:ops itself still runs the real bash syntax checks in the release gate.
    const r = spawnSync("/bin/sh", ["-c", `
      bash() { printf 'CHECK %s\\n' "$2"; [ "$2" != "$QA_FAIL_AT" ]; }
      node() { echo SEMANTIC_CHECK; }
      python3() { echo PYTHON_CHECK; }
      ${pkg.scripts["check:ops"]}
    `], { encoding: "utf8", timeout: 2000,
      env: { NODE_ENV: "test", PATH: "/usr/bin:/bin", QA_FAIL_AT: failAt } });
    expect(r.error).toBeUndefined();
    expect(r.stdout.match(/^CHECK /gm)).toHaveLength(failAt === "scripts/public-tunnel-daemon.sh" ? 8 : failAt === "scripts/app-operation-lock.sh" ? 9 : 10);
    if (failAt !== "scripts/public-tunnel-daemon.sh") expect(r.stdout).toContain("CHECK scripts/app-operation-lock.sh");
    expect(r.stdout).toContain("CHECK scripts/public-tunnel-daemon.sh");
    expect(r.status).toBe(failAt ? 1 : 0);
    expect(r.stdout.includes("SEMANTIC_CHECK")).toBe(!failAt);
    expect(r.stdout.includes("PYTHON_CHECK")).toBe(!failAt);
  });
  it("CI uses a checked source build, not an anonymous Docker build", () => {
    const ci = readFileSync(".github/workflows/ci.yml", "utf8");
    expect(ci).toContain("bash scripts/build-ci-container.sh");
    expect(ci).not.toContain("run: docker build");
  });
  it("installing public access never builds or deploys application source", () => {
    const installer = readFileSync("scripts/install-public-tunnel.sh", "utf8");
    expect(installer).not.toMatch(/build app|ops\/deploy\.sh\s*$/m);
    expect(installer).toContain("tunnel_capture_app");
    expect(installer).toContain("tunnel-app-guard.sh");
  });
  it.each([0, 1])("installer propagates application admission %i before installing anything (UTF-8 shell)", status => {
    const installer = readFileSync("scripts/install-public-tunnel.sh", "utf8");
    const start = installer.indexOf('echo "==> 2/7');
    const end = installer.indexOf('echo "==> 3/7', start);
    expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
    const r = spawnSync("/bin/bash", ["-c", `set -euo pipefail
      REPO=/synthetic-only
      source() { TUNNEL_APP_REVISION=${"a".repeat(40)}; }
      app_operation_acquire() { return 0; }
      tunnel_capture_app() { return ${status}; }
      ${installer.slice(start, end)}
      echo INSTALL_ALLOWED
    `], { encoding: "utf8", timeout: 2000, env: { NODE_ENV: "test", PATH: "/usr/bin:/bin", LC_ALL: "en_US.UTF-8" } });
    expect(r.status).toBe(status);
    expect(r.stdout.includes("INSTALL_ALLOWED")).toBe(status === 0);
  });

  function build(scenario: string) {
    const dir = mkdtempSync(path.join(tmpdir(), "scm-ci-build-"));
    dirs.push(dir);
    mkdirSync(path.join(dir, "scripts"));
    mkdirSync(path.join(dir, "bin"));
    writeFileSync(path.join(dir, "scripts/build-ci-container.sh"), readFileSync("scripts/build-ci-container.sh"));
    const git = (...args: string[]) => spawnSync("git", args, { cwd: dir, encoding: "utf8" });
    expect(git("init", "-q").status).toBe(0);
    git("config", "user.name", "Synthetic QA"); git("config", "user.email", "qa@example.invalid");
    writeFileSync(path.join(dir, "bin/docker"), `#!/bin/bash
printf '%s\\n' "$*"
case "$QA_SCENARIO" in
  during) printf 'changed' >> scripts/build-ci-container.sh ;;
  head) git -c user.name=QA -c user.email=qa@example.invalid commit --allow-empty -qm changed ;;
  failure) exit 37 ;;
esac
`, { mode: 0o700 });
    git("add", "scripts/build-ci-container.sh", "bin/docker"); git("commit", "-qm", "fixture");
    const revision = git("rev-parse", "HEAD").stdout.trim();
    if (scenario === "dirty") writeFileSync(path.join(dir, "untracked"), "uncommitted source");
    const r = spawnSync("/bin/bash", ["scripts/build-ci-container.sh"], {
      cwd: dir, encoding: "utf8", timeout: 5000,
      env: { NODE_ENV: "test", PATH: `${dir}/bin:/usr/bin:/bin`, LC_ALL: "en_US.UTF-8", QA_SCENARIO: scenario, SCM_BUILD_REVISION: "f".repeat(40) },
    });
    return { ...r, revision };
  }
  it("builds the actual checked-out revision, not caller-supplied metadata", () => {
    const r = build("clean");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`--build-arg SCM_BUILD_REVISION=${r.revision}`);
    expect(r.stdout).not.toContain("f".repeat(40));
  });
  it("refuses uncommitted source before Docker", () => {
    const r = build("dirty");
    expect(r.status).not.toBe(0);
    expect(r.stdout).not.toContain("--build-arg");
  });
  it.each(["during", "head", "failure"])("refuses build success on %s", (scenario) => {
    expect(build(scenario).status).not.toBe(0);
  });
});
