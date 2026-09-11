import { existsSync, lstatSync, mkdirSync, renameSync, realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

const root = realpathSync(process.cwd());
if (!existsSync(path.join(root, ".git")) || !existsSync(path.join(root, "package.json"))) {
  throw new Error("Run from the verified SCM Git root, not a workspace/data directory.");
}
const args = process.argv.slice(2);
const includeBuild = process.argv.includes("--all");
const apply = args.includes("--apply");
const allowedTargets = [
  ".next-dev",
  ".next-webpack",
  ".cache",
  ".next", ".next-live", "tsconfig.tsbuildinfo",
];
const selected: string[] = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--target") {
    const target = args[++i];
    if (!allowedTargets.includes(target)) throw new Error(`Not an allowed cache target: ${target}`);
    selected.push(target);
  } else if (!["--all", "--apply"].includes(args[i])) {
    throw new Error(`Unknown argument: ${args[i]}`);
  }
}
if (apply && (includeBuild || !selected.length)) {
  throw new Error("Apply requires explicit --target <cache>; --all is preview-only. Stop its owner first.");
}
const relativeTargets = [...new Set(selected.length ? selected : allowedTargets.slice(0, includeBuild ? undefined : 3))];
const trashRoot = path.join(root, ".cache-cleanup-trash");
if (existsSync(trashRoot) && (lstatSync(trashRoot).isSymbolicLink() || !lstatSync(trashRoot).isDirectory())) {
  throw new Error("Refusing redirected cleanup quarantine.");
}
const destination = path.join(trashRoot, `${Date.now()}-${process.pid}`);

for (const relative of relativeTargets) {
  const target = path.resolve(root, relative);
  if (!existsSync(target)) continue;
  if (lstatSync(target).isSymbolicLink()) throw new Error(`Refusing symlink: ${relative}`);
  if (!apply) {
    console.log(`preview only: ${relative}`);
    continue;
  }
  // Fail closed if open-file inspection is unavailable or ambiguous. The owner must stay stopped.
  const check = spawnSync("lsof", lstatSync(target).isDirectory() ? ["+D", target, "-Fn"] : [target], { encoding: "utf8" });
  if (check.error || check.status !== 1 || check.stdout.trim() || check.stderr.trim()) {
    throw new Error(`Cache is open or cannot be safely inspected: ${relative}. Stop its owner and inspect before retrying.`);
  }
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  renameSync(target, path.join(destination, relative));
  console.log(`quarantined (recoverable): ${relative} -> ${path.relative(root, destination)}/${relative}`);
}
console.log("Preserved: .artifacts, tmp, databases, uploads, backups, dependencies, and custom build directories. Quarantine is not auto-deleted.");
