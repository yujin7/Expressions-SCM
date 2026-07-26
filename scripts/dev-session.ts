import {
  copyFileSync,
  existsSync,
  mkdirSync,
  realpathSync,
  symlinkSync,
} from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";

function git(args: string[], cwd = process.cwd()): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed`);
  }
  return result.stdout.trim();
}

function safeName(value: string | undefined): string {
  const name = value?.trim().toLowerCase();
  if (!name || !/^[a-z0-9][a-z0-9-]{1,40}$/.test(name)) {
    throw new Error("Usage: npm run dev:session -- <name> [--create-only]");
  }
  return name;
}

function basePort(name: string): number {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return 3100 + (hash % 200);
}

function portAvailable(port: number): boolean {
  const result = spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"], {
    stdio: "ignore",
  });
  if (result.status === 0) return false;
  if (result.status === 1) return true;
  throw new Error("Unable to inspect local ports with lsof");
}

async function main(): Promise<void> {
  const name = safeName(process.argv[2]);
  const createOnly = process.argv.includes("--create-only");
  const repoRoot = git(["rev-parse", "--show-toplevel"]);
  const commonGitDir = realpathSync(git(["rev-parse", "--git-common-dir"]));
  const mainRoot = path.dirname(commonGitDir);
  const worktreesRoot =
    process.env.SCM_WORKTREES_DIR?.trim() ||
    path.join(path.dirname(mainRoot), "worktrees");
  const destination = path.join(worktreesRoot, name);
  const branch = `codex/${name}`;
  mkdirSync(worktreesRoot, { recursive: true });

  if (!existsSync(destination)) {
    const branchExists = spawnSync(
      "git",
      ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
      { cwd: repoRoot },
    ).status === 0;
    git(
      branchExists
        ? ["worktree", "add", destination, branch]
        : ["worktree", "add", "-b", branch, destination, "HEAD"],
      repoRoot,
    );
  }

  const sourceModules = path.join(mainRoot, "node_modules");
  const targetModules = path.join(destination, "node_modules");
  if (!existsSync(targetModules) && existsSync(sourceModules)) {
    symlinkSync(sourceModules, targetModules, "dir");
  }
  const sourceEnv = path.join(mainRoot, ".env");
  const targetEnv = path.join(destination, ".env");
  if (!existsSync(targetEnv) && existsSync(sourceEnv)) {
    copyFileSync(sourceEnv, targetEnv, 0);
  }

  let port = basePort(name);
  while (!portAvailable(port) && port < 3300) port += 1;
  if (port >= 3300 && !portAvailable(port)) {
    throw new Error("No available development port between 3100 and 3300");
  }
  const databasePath = path.join(destination, ".data", "session");
  const session = {
    name,
    branch,
    destination,
    port,
    databaseUrl: `pglite:${databasePath}`,
  };
  console.log(JSON.stringify(session, null, 2));
  if (createOnly) return;

  const child = spawn("npm", ["run", "dev"], {
    cwd: destination,
    stdio: "inherit",
    env: {
      ...process.env,
      PORT: String(port),
      AUTH_URL: `http://127.0.0.1:${port}`,
      DATABASE_URL: session.databaseUrl,
      SCM_RUN_JOBS: "0",
    },
  });
  child.on("exit", (code) => process.exit(code ?? 0));
}

void main();
