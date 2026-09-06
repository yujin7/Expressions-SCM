import { mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import path from "node:path";

type Result = {
  name: string;
  command: string;
  status: "passed" | "failed" | "skipped";
  durationMs: number;
  detail?: string;
};

type GitResult = {
  ok: boolean;
  value: string;
  error?: string;
};

function git(args: string[]): GitResult {
  const result = spawnSync("git", args, { encoding: "utf8" });
  if (result.status === 0) {
    return { ok: true, value: result.stdout.trim() };
  }
  return {
    ok: false,
    value: "unknown",
    error: result.stderr.trim() || result.error?.message || `git ${args.join(" ")} failed`,
  };
}

function run(name: string, command: string, args: string[]): Result {
  const started = performance.now();
  console.log(`\n▶ ${name}`);
  const result = spawnSync(command, args, {
    stdio: "inherit",
    env: process.env,
  });
  const durationMs = Math.round(performance.now() - started);
  return {
    name,
    command: [command, ...args].join(" "),
    status: result.status === 0 ? "passed" : "failed",
    durationMs,
    ...(result.error ? { detail: result.error.message } : {}),
  };
}

function runLiveSmoke(expectedRevision: string): Result {
  const name = "live smoke sweep";
  const command = "node --import tsx scripts/smoke-e2e.ts";
  const started = performance.now();
  console.log(`\n▶ ${name}`);
  const result = spawnSync("node", ["--import", "tsx", "scripts/smoke-e2e.ts"], {
    encoding: "utf8",
    // The caller's environment must not override the anchored candidate identity.
    env: { ...process.env, SCM_EXPECTED_REVISION: expectedRevision },
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  const containsSkip = /(?:\[SKIP\]|^SKIP\s)/m.test(result.stdout);
  return {
    name,
    command,
    status: result.status === 0 && !containsSkip ? "passed" : "failed",
    durationMs: Math.round(performance.now() - started),
    ...(result.error
      ? { detail: result.error.message }
      : containsSkip
        ? { detail: "live smoke reported skipped coverage; READY requires complete live evidence" }
        : {}),
  };
}

function skipped(name: string, command: string, detail: string): Result {
  return { name, command, status: "skipped", durationMs: 0, detail };
}

const startedHead = git(["rev-parse", "HEAD"]);
const startedBranch = git(["branch", "--show-current"]);
const startedDirty = git(["status", "--short", "-uall"]);
const candidate = {
  head: startedHead.value,
  branch: startedBranch.value,
  dirty: startedDirty.value,
  startedAt: new Date().toISOString(),
};

const checks: Result[] = [];
const planned: Array<[string, string, string[]]> = [
  ["operations contracts", "npm", ["run", "check:ops"]],
  ["PostgreSQL migration contract", "npm", ["run", "check:postgres"]],
  ["full lint", "npm", ["run", "lint:full"]],
  ["all TypeScript scopes", "npm", ["run", "typecheck:all"]],
  ["full Vitest suite", "npm", ["test"]],
  ["production build", "npm", ["run", "build"]],
];

const anchorErrors = [
  !startedHead.ok ? `HEAD unavailable: ${startedHead.error}` : "",
  !startedBranch.ok ? `branch unavailable: ${startedBranch.error}` : "",
  !startedDirty.ok ? `worktree unavailable: ${startedDirty.error}` : "",
  startedDirty.ok && startedDirty.value
    ? `candidate is dirty:\n${startedDirty.value}`
    : "",
].filter(Boolean);
checks.push({
  name: "clean anchored candidate",
  command: "git rev-parse HEAD && git status --short -uall",
  status: anchorErrors.length === 0 ? "passed" : "failed",
  durationMs: 0,
  ...(anchorErrors.length ? { detail: anchorErrors.join("\n") } : {}),
});

if (anchorErrors.length === 0) {
  for (const [index, [name, command, args]] of planned.entries()) {
    const result = run(name, command, args);
    checks.push(result);
    if (result.status === "failed") {
      for (const [remainingName, remainingCommand, remainingArgs] of planned.slice(index + 1)) {
        checks.push(
          skipped(
            remainingName,
            [remainingCommand, ...remainingArgs].join(" "),
            `not run because ${name} failed`,
          ),
        );
      }
      break;
    }
  }
} else {
  for (const [name, command, args] of planned) {
    checks.push(
      skipped(name, [command, ...args].join(" "), "not run because candidate anchoring failed"),
    );
  }
}

if (checks.every((check) => check.status === "passed") && process.env.SCM_VERIFY_LIVE === "1") {
  checks.push(runLiveSmoke(startedHead.value));
} else {
  checks.push(
    skipped(
      "live smoke sweep",
      "SCM_VERIFY_LIVE=1 npm run check:release",
      process.env.SCM_VERIFY_LIVE === "1"
        ? "not run because an earlier release check failed"
        : "live verification is mandatory for a READY verdict",
    ),
  );
}

const finishedHead = git(["rev-parse", "HEAD"]);
const finishedBranch = git(["branch", "--show-current"]);
const finishedDirty = git(["status", "--short", "-uall"]);
const stabilityErrors = [
  !finishedHead.ok ? `final HEAD unavailable: ${finishedHead.error}` : "",
  !finishedBranch.ok ? `final branch unavailable: ${finishedBranch.error}` : "",
  !finishedDirty.ok ? `final worktree unavailable: ${finishedDirty.error}` : "",
  startedHead.ok && finishedHead.ok && startedHead.value !== finishedHead.value
    ? `HEAD changed: ${startedHead.value} -> ${finishedHead.value}`
    : "",
  startedBranch.ok && finishedBranch.ok && startedBranch.value !== finishedBranch.value
    ? `branch changed: ${startedBranch.value || "(detached)"} -> ${finishedBranch.value || "(detached)"}`
    : "",
  startedDirty.ok && finishedDirty.ok && startedDirty.value !== finishedDirty.value
    ? `worktree changed during verification:\nstarted:\n${startedDirty.value || "(clean)"}\nfinished:\n${finishedDirty.value || "(clean)"}`
    : "",
].filter(Boolean);
checks.push({
  name: "candidate stability",
  command: "git rev-parse HEAD && git status --short -uall (before/after)",
  status: stabilityErrors.length === 0 ? "passed" : "failed",
  durationMs: 0,
  ...(stabilityErrors.length ? { detail: stabilityErrors.join("\n") } : {}),
});

const finishedAt = new Date().toISOString();
const verdict = checks.every((check) => check.status === "passed") ? "READY" : "NOT READY";
const report = {
  candidate: {
    ...candidate,
    finishedHead: finishedHead.value,
    finishedBranch: finishedBranch.value,
    finishedDirty: finishedDirty.value,
  },
  finishedAt,
  liveVerificationRequired: true,
  liveVerificationRequested: process.env.SCM_VERIFY_LIVE === "1",
  verdict,
  checks,
};
const outDir = path.resolve(".artifacts/verification");
mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, `${finishedAt.replace(/[:.]/g, "-")}.json`);
writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(`\n${verdict}\nReport: ${outPath}`);
if (verdict !== "READY") process.exitCode = 1;
