import { lstatSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const nodeModules = path.resolve("node_modules");
const legacyRequire = /((?:var|const|let)\s+expand\s*=\s*require\(['"]brace-expansion['"]\))/;
const replacement = [
  "var braceExpansion = require('brace-expansion')",
  "var expand = typeof braceExpansion === 'function' ? braceExpansion : braceExpansion.expand",
].join("\n");

function walk(directory) {
  for (const entry of readdirSync(directory)) {
    if (entry === ".bin") continue;
    const absolute = path.join(directory, entry);
    const stat = lstatSync(absolute, { throwIfNoEntry: false });
    if (!stat || stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) {
      walk(absolute);
      continue;
    }
    if (entry !== "minimatch.js") continue;
    const source = readFileSync(absolute, "utf8");
    if (source.includes("braceExpansion.expand")) continue;
    if (!source.includes("require('brace-expansion')") && !source.includes('require("brace-expansion")')) {
      continue;
    }
    if (!legacyRequire.test(source)) {
      throw new Error(`无法安全修补 minimatch 的 brace-expansion API：${absolute}`);
    }
    writeFileSync(absolute, source.replace(legacyRequire, replacement));
    console.log(`patched legacy brace-expansion API: ${path.relative(process.cwd(), absolute)}`);
  }
}

if (lstatSync(nodeModules, { throwIfNoEntry: false })?.isDirectory()) {
  walk(nodeModules);
}
