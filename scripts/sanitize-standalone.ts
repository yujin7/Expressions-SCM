import { existsSync, lstatSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const distDir = process.env.NEXT_DIST_DIR?.trim() || ".next";
const resolvedDist = path.resolve(root, distDir);
const relativeDist = path.relative(root, resolvedDist);
if (!relativeDist || relativeDist.startsWith("..") || path.isAbsolute(relativeDist)) {
  throw new Error(`Refusing unsafe Next dist directory: ${resolvedDist}`);
}

const standalone = path.join(resolvedDist, "standalone");
if (!existsSync(standalone)) {
  throw new Error(`Next standalone output not found: ${standalone}`);
}

for (const name of readdirSync(standalone)) {
  if (name !== ".env" && !name.startsWith(".env.")) continue;
  const target = path.join(standalone, name);
  const stat = lstatSync(target);
  if (!stat.isFile() && !stat.isSymbolicLink()) {
    throw new Error(`Refusing to remove non-file environment path: ${target}`);
  }
  rmSync(target, { force: true });
  console.log(`removed standalone/${name}`);
}

for (const relative of [".data", "backups", "uploads", ".artifacts", "tmp"]) {
  const target = path.join(standalone, relative);
  if (existsSync(target)) {
    throw new Error(`Sensitive/local directory leaked into standalone: ${relative}`);
  }
}

console.log("standalone safety check passed");
