import { rmSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const includeBuild = process.argv.includes("--all");
const relativeTargets = [
  ".next-dev",
  ".next-webpack",
  ".cache",
  ...(includeBuild ? [".next"] : []),
];

for (const relative of relativeTargets) {
  const target = path.resolve(root, relative);
  if (path.dirname(target) !== root) {
    throw new Error(`Refusing broad cache deletion: ${target}`);
  }
  rmSync(target, { recursive: true, force: true });
  console.log(`removed ${relative}`);
}
