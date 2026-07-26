import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";

type Step = { name: string; command: string; args: string[] };

function run(step: Step): number {
  const started = performance.now();
  console.log(`\n▶ ${step.name}`);
  const result = spawnSync(step.command, step.args, {
    stdio: "inherit",
    env: process.env,
  });
  const elapsed = Math.round(performance.now() - started);
  if (result.status !== 0) {
    console.error(`✗ ${step.name} failed after ${elapsed}ms`);
    process.exit(result.status ?? 1);
  }
  console.log(`✓ ${step.name} ${elapsed}ms`);
  return elapsed;
}

function gitLines(args: string[]): string[] {
  const result = spawnSync("git", args, { encoding: "utf8" });
  if (result.status !== 0) return [];
  return result.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
}

const changed = new Set([
  ...gitLines(["diff", "--name-only", "--diff-filter=ACMR", "HEAD"]),
  ...gitLines(["ls-files", "--others", "--exclude-standard"]),
]);
const changedCode = [...changed].filter(
  (file) => /\.(?:[cm]?[jt]sx?)$/.test(file) && existsSync(file),
);
const changedSource = changedCode.filter((file) => file.startsWith("src/"));

const steps: Step[] = [
  { name: "app typecheck", command: "npm", args: ["run", "typecheck"] },
  {
    name: "architecture + pure rules",
    command: "npx",
    args: ["vitest", "run", "tests/rules", "tests/architecture", "tests/components"],
  },
];

if (changedCode.length > 0) {
  steps.splice(1, 0, {
    name: `lint ${changedCode.length} changed files`,
    command: "npx",
    args: [
      "eslint",
      "--cache",
      "--cache-strategy",
      "content",
      "--cache-location",
      ".cache/eslint",
      "--max-warnings=0",
      ...changedCode,
    ],
  });
}

if (changedSource.length > 0) {
  steps.push({
    name: `related tests for ${changedSource.length} source files`,
    command: "npx",
    args: ["vitest", "related", "--run", "--passWithNoTests", ...changedSource],
  });
}

const totalStarted = performance.now();
const timings = steps.map((step) => ({ name: step.name, ms: run(step) }));
const totalMs = Math.round(performance.now() - totalStarted);
console.log(`\nFAST CHECK PASSED in ${(totalMs / 1000).toFixed(2)}s`);
console.log(JSON.stringify({ changed: [...changed], timings, totalMs }, null, 2));
