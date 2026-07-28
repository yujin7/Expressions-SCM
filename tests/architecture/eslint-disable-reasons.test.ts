import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const roots = ["src", "tests", "scripts"];

function walk(relative: string, out: string[] = []): string[] {
  for (const entry of readdirSync(path.join(root, relative), { withFileTypes: true })) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) walk(child, out);
    else if (/\.(?:[cm]?[jt]sx?)$/.test(entry.name)) out.push(child);
  }
  return out;
}

describe("ESLint 抑制必须可审计", () => {
  it("每个 eslint-disable 都包含 ` -- 原因`，禁止无解释地关闭规则", () => {
    const offenders: string[] = [];
    for (const file of roots.flatMap((dir) => walk(dir))) {
      const lines = readFileSync(path.join(root, file), "utf8").split("\n");
      lines.forEach((line, index) => {
        const directive = line.trim();
        if (!/^(?:\/\/|\/\*)\s*eslint-disable/.test(directive)) return;
        if (!/eslint-disable(?:-next-line|-line)?(?:\s+\S+)?\s+--\s+\S/.test(directive)) {
          offenders.push(`${file}:${index + 1}`);
        }
      });
    }
    expect(offenders, `以下规则抑制缺少理由：\n${offenders.join("\n")}`).toEqual([]);
  });
});
