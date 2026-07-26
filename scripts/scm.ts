import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const [command, subcommand, ...rest] = process.argv.slice(2);

function run(script: string, args: string[] = []): never {
  const result = spawnSync("npm", ["run", script, ...(args.length ? ["--", ...args] : [])], {
    stdio: "inherit",
  });
  process.exit(result.status ?? 1);
}

function usage(): never {
  console.error(`Supply-chain developer CLI

  npm run scm -- verify fast|pr|release
  npm run scm -- dev <session-name> [--create-only]
  npm run scm -- clean [--all]
  npm run scm -- doctor`);
  process.exit(2);
}

if (command === "verify") {
  if (subcommand === "fast") run("check:fast", rest);
  if (subcommand === "pr") run("check:pr", rest);
  if (subcommand === "release") run("check:release", rest);
  usage();
}

if (command === "dev") {
  if (!subcommand) usage();
  run("dev:session", [subcommand, ...rest]);
}

if (command === "clean") {
  run("clean:cache", [subcommand, ...rest].filter(Boolean));
}

if (command === "doctor") {
  const checks = [
    ["node", ["--version"]],
    ["npm", ["--version"]],
    ["git", ["status", "--short"]],
  ] as const;
  for (const [binary, args] of checks) {
    console.log(`\n$ ${binary} ${args.join(" ")}`);
    const result = spawnSync(binary, [...args], { stdio: "inherit" });
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
  const cachePath = ".next/cache";
  if (existsSync(cachePath)) {
    const size = spawnSync("du", ["-sk", cachePath], { encoding: "utf8" });
    const kib = Number(size.stdout.trim().split(/\s+/)[0] ?? 0);
    if (Number.isFinite(kib)) {
      const gib = kib / 1024 / 1024;
      console.log(`\nproduction build cache: ${gib.toFixed(2)} GiB`);
      if (gib >= 1) {
        console.warn("cache exceeds 1 GiB; reclaim it with: npm run scm -- clean --all");
      }
    }
  }
  process.exit(0);
}

usage();
