/**
 * 护栏：system_alerts 的每个 category 都要在告警页有中文标签。
 *
 * 事故背景（2026-08-04）：我加了 `integration_token`（凭据到期）与 `job_failure`
 * （任务失败）两个类别，告警页的 CAT 映射却只有原来两个——新告警会以英文 slug
 * 出现在中文界面里。告警是给人看的，标签认不出就等于降低了它被处理的概率。
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../..");
const CLIENT = path.join(ROOT, "src/app/(app)/alerts/alerts-client.tsx");
const JOBS = path.join(ROOT, "src/jobs");

/** 从会写 systemAlerts 的任务源码里收集 category 字面量 */
function alertCategories(): string[] {
  const found = new Set<string>();
  for (const entry of readdirSync(JOBS)) {
    if (!entry.endsWith(".ts")) continue;
    const src = readFileSync(path.join(JOBS, entry), "utf8");
    if (!src.includes("insert(systemAlerts)")) continue;
    for (const m of src.matchAll(/(?:ALERT_CATEGORY\s*=\s*|category:\s*)"([a-z_]+)"/g)) {
      found.add(m[1]);
    }
  }
  return [...found].sort();
}

describe("护栏：告警类别有中文标签", () => {
  it("每个 system_alerts category 都在告警页 CAT 映射里", () => {
    const client = readFileSync(CLIENT, "utf8");
    const block = client.slice(client.indexOf("const CAT"), client.indexOf("const SEV"));
    const categories = alertCategories();
    expect(categories.length, "应能从任务层扫到告警类别").toBeGreaterThan(0);

    const missing = categories.filter((c) => !block.includes(`${c}:`));
    expect(
      missing,
      `以下告警类别在 /alerts 会显示成英文 slug：\n${missing.join("\n")}\n`
        + `告警是给人看的，认不出标签就等于降低了它被处理的概率。`,
    ).toEqual([]);
  });
});
