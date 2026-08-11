import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { METRICS } from "@/components/metrics";

const SRC = path.resolve(__dirname, "../../src");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const file = path.join(dir, name);
    if (statSync(file).isDirectory()) walk(file, out);
    else if (/\.tsx$/.test(name)) out.push(file);
  }
  return out;
}

describe("指标注册表引用完整性", () => {
  it("所有 DecisionVisual 的字面量 metricId 都必须有唯一口径定义", () => {
    const missing: string[] = [];
    for (const file of walk(SRC)) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(/metricId=["']([^"']+)["']/g)) {
        if (!METRICS[match[1]]) missing.push(`${path.relative(SRC, file)} -> ${match[1]}`);
      }
    }
    expect(missing, `图表引用了未登记的指标：\n${missing.join("\n")}`).toEqual([]);
  });

  it("注册表键、id 一致且所有指标都有可读说明", () => {
    for (const [key, definition] of Object.entries(METRICS)) {
      expect(definition.id).toBe(key);
      expect(definition.label.trim()).not.toBe("");
      expect(definition.short.trim()).not.toBe("");
    }
  });
});
