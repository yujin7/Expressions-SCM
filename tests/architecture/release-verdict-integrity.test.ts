import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";

const script = path.resolve("scripts/verify-release.ts");
const tsxImport = createRequire(import.meta.url).resolve("tsx");
const roots: string[] = [];

type Report = {
  verdict: "READY" | "NOT READY";
  checks: Array<{ name: string; status: string; detail?: string }>;
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function runRelease(options: {
  live?: boolean;
  dirty?: boolean;
  mutateWorktree?: boolean;
  mutateHead?: boolean;
  liveSkip?: boolean;
  wrongExpectedRevision?: boolean;
} = {}): { status: number | null; report: Report; log: string } {
  const root = mkdtempSync(path.join(tmpdir(), "scm-release-verdict-"));
  roots.push(root);
  const repo = path.join(root, "repo");
  const bin = path.join(root, "bin");
  const logPath = path.join(root, "commands.log");
  mkdirSync(repo);
  mkdirSync(bin);
  writeFileSync(path.join(repo, "tracked.txt"), "anchored\n");
  execFileSync("/usr/bin/git", ["init", "-q"], { cwd: repo });
  execFileSync("/usr/bin/git", ["add", "tracked.txt"], { cwd: repo });
  execFileSync(
    "/usr/bin/git",
    ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "initial"],
    { cwd: repo },
  );
  if (options.dirty) writeFileSync(path.join(repo, "dirty.txt"), "uncommitted\n");

  const fakeNpm = path.join(bin, "npm");
  writeFileSync(
    fakeNpm,
    `#!/bin/sh
printf 'npm %s\\n' "$*" >> "$SCM_TEST_LOG"
if [ "\${SCM_TEST_MUTATE_WORKTREE:-}" = "$*" ]; then printf 'changed\\n' >> tracked.txt; fi
if [ "\${SCM_TEST_MUTATE_HEAD:-}" = "$*" ]; then
  /usr/bin/git -c user.name=Test -c user.email=test@example.com commit --allow-empty -qm moved
fi
exit 0
`,
  );
  chmodSync(fakeNpm, 0o755);
  const fakeNode = path.join(bin, "node");
  writeFileSync(
    fakeNode,
    '#!/bin/sh\nprintf \'node %s\\n\' "$*" >> "$SCM_TEST_LOG"\nif [ "$SCM_EXPECTED_REVISION" != "$(/usr/bin/git rev-parse HEAD)" ]; then exit 33; fi\n[ "${SCM_TEST_LIVE_SKIP:-}" = "1" ] && echo "→ [SKIP] missing live evidence"\nexit 0\n',
  );
  chmodSync(fakeNode, 0o755);

  const inheritedEnv = { ...process.env };
  delete inheritedEnv.SCM_VERIFY_LIVE;
  delete inheritedEnv.SCM_TEST_LIVE_SKIP;
  delete inheritedEnv.SCM_TEST_MUTATE_WORKTREE;
  delete inheritedEnv.SCM_TEST_MUTATE_HEAD;

  const result = spawnSync(process.execPath, ["--import", tsxImport, script], {
    cwd: repo,
    encoding: "utf8",
    env: {
      ...inheritedEnv,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      SCM_TEST_LOG: logPath,
      ...(options.live ? { SCM_VERIFY_LIVE: "1" } : {}),
      ...(options.mutateWorktree ? { SCM_TEST_MUTATE_WORKTREE: "run check:postgres" } : {}),
      ...(options.mutateHead ? { SCM_TEST_MUTATE_HEAD: "run check:postgres" } : {}),
      ...(options.liveSkip ? { SCM_TEST_LIVE_SKIP: "1" } : {}),
      ...(options.wrongExpectedRevision ? { SCM_EXPECTED_REVISION: "b".repeat(40) } : {}),
    },
  });
  const artifacts = path.join(repo, ".artifacts", "verification");
  const reportPath = path.join(artifacts, readdirSync(artifacts).at(-1)!);
  return {
    status: result.status,
    report: JSON.parse(readFileSync(reportPath, "utf8")) as Report,
    log: existsSync(logPath) ? readFileSync(logPath, "utf8") : "",
  };
}

describe("release verdict integrity", () => {
  it("fails a dirty candidate before running release commands", () => {
    const result = runRelease({ dirty: true, live: true });
    expect(result.status).not.toBe(0);
    expect(result.report.verdict).toBe("NOT READY");
    expect(result.report.checks.find((check) => check.name === "clean anchored candidate")?.status).toBe("failed");
    expect(result.log).toBe("");
  });

  it("runs the PostgreSQL contract but refuses READY without live verification", () => {
    const result = runRelease();
    expect(result.log).toContain("npm run check:postgres");
    expect(result.status).not.toBe(0);
    expect(result.report.verdict).toBe("NOT READY");
    expect(result.report.checks.find((check) => check.name === "live smoke sweep")?.status).toBe("skipped");
  });

  it("returns READY only when every static and live check passes", () => {
    const result = runRelease({ live: true });
    expect(result.status).toBe(0);
    expect(result.log).toContain("npm run check:postgres");
    expect(result.log).toContain("node --import tsx scripts/smoke-e2e.ts");
    expect(result.report.verdict).toBe("READY");
  });

  it("rejects a live sweep that reports skipped coverage", () => {
    const result = runRelease({ live: true, liveSkip: true });
    expect(result.status).not.toBe(0);
    expect(result.report.verdict).toBe("NOT READY");
    expect(result.report.checks.find((check) => check.name === "live smoke sweep")).toMatchObject({
      status: "failed",
      detail: expect.stringContaining("skipped coverage"),
    });
  });

  it("binds the live check to its anchored HEAD even if inherited env points elsewhere", () => {
    const result = runRelease({ live: true, wrongExpectedRevision: true });
    expect(result.status).toBe(0);
    expect(result.report.verdict).toBe("READY");
  });

  it.each([
    ["worktree", { mutateWorktree: true }],
    ["HEAD", { mutateHead: true }],
  ])("fails when the %s changes during verification", (_label, mutation) => {
    const result = runRelease({ live: true, ...mutation });
    expect(result.status).not.toBe(0);
    expect(result.report.verdict).toBe("NOT READY");
    expect(result.report.checks.find((check) => check.name === "candidate stability")?.status).toBe("failed");
  });
});
