import { mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import path from "node:path";

type Result = {
  name: string;
  command: string;
  status: "passed" | "failed" | "skipped";
  durationMs: number;
};

function git(args: string[]): string {
  const result = spawnSync("git", args, { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : "unknown";
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
  };
}

const candidate = {
  head: git(["rev-parse", "HEAD"]),
  branch: git(["branch", "--show-current"]),
  dirty: git(["status", "--short", "-uall"]),
  startedAt: new Date().toISOString(),
};

const checks: Result[] = [];
const planned: Array<[string, string, string[]]> = [
  ["full lint", "npm", ["run", "lint:full"]],
  ["all TypeScript scopes", "npm", ["run", "typecheck:all"]],
  ["full Vitest suite", "npm", ["test"]],
  ["production build", "npm", ["run", "build"]],
];

for (const [name, command, args] of planned) {
  const result = run(name, command, args);
  checks.push(result);
  if (result.status === "failed") break;
}

if (checks.every((check) => check.status === "passed") && process.env.SCM_VERIFY_LIVE === "1") {
  checks.push(run("live smoke sweep", "node", ["--import", "tsx", "scripts/smoke-e2e.ts"]));
} else {
  checks.push({
    name: "live smoke sweep",
    command: "SCM_VERIFY_LIVE=1 npm run check:release",
    status: "skipped",
    durationMs: 0,
  });
}

const finishedAt = new Date().toISOString();
const verdict = checks.some((check) => check.status === "failed")
  ? "NOT READY"
  : checks.some((check) => check.status === "skipped")
    ? "READY WITH EXPLICIT ACCEPTANCE"
    : "READY";
const report = { candidate, finishedAt, verdict, checks };
const outDir = path.resolve(".artifacts/verification");
mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, `${finishedAt.replace(/[:.]/g, "-")}.json`);
writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(`\n${verdict}\nReport: ${outPath}`);
if (verdict === "NOT READY") process.exit(1);
