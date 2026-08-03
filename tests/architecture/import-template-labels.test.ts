/**
 * 护栏：三方连接器产生的导入任务必须有中文标签。
 *
 * 事故背景（2026-08-04）：导入任务页的 TEMPLATE_LABELS 里**一个集成模板都没有**——
 * 聚水潭/简道云/用友自动产生的任务，在一列中文标签里显示成 `jst_daily_sales`
 * 这样的英文 slug。功能不坏，但正是"系统看着毛糙、像没做完"的来源之一，
 * 而且业务同事分不清哪些是人工上传、哪些是连接器观测。
 *
 * 新增连接器/数据流时若忘了配标签，本护栏会红。
 *
 * ⚠ 第一版正则只匹配 `TARGET_TABLE` 与 `template`，**漏掉了 `targetTable:`**——
 * 而简道云那批模板正是在 jiandaoyun-contracts.ts 里用 `targetTable:` 声明的。
 * 于是护栏一直是绿的，却从未真正保护过那 9 个模板（当时的标签是我手工用更宽的
 * grep 收集后补上的，属侥幸）。2026-08-04 新增两条天猫销量契约时才暴露：
 * 模板没标签、护栏照样绿。已补上 `targetTable`。
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../..");
const CLIENT = path.join(ROOT, "src/app/(app)/import/jobs/jobs-client.tsx");
const INTEGRATIONS = path.join(ROOT, "src/server/integrations");

/** 从集成层源码里收集用作 import job template 的字面量 */
function integrationTemplates(): string[] {
  const found = new Set<string>();
  for (const entry of readdirSync(INTEGRATIONS)) {
    if (!entry.endsWith(".ts")) continue;
    const src = readFileSync(path.join(INTEGRATIONS, entry), "utf8");
    for (const m of src.matchAll(/(?:TARGET_TABLE|targetTable|template)\s*[:=]\s*"([a-z0-9_]+)"/g)) {
      found.add(m[1]);
    }
  }
  return [...found].sort();
}

describe("护栏：集成产生的导入任务有中文标签", () => {
  it("每个连接器模板都在 TEMPLATE_LABELS 里配了标签", () => {
    const labels = readFileSync(CLIENT, "utf8");
    const block = labels.slice(
      labels.indexOf("const TEMPLATE_LABELS"),
      labels.indexOf("const TABLE_LABELS"),
    );
    const templates = integrationTemplates();
    expect(templates.length, "应能从集成层扫到模板名").toBeGreaterThan(0);

    const missing = templates.filter((name) => !block.includes(`${name}:`));
    expect(
      missing,
      `以下连接器模板在导入任务页会显示成英文 slug：\n${missing.join("\n")}\n`
        + `请在 TEMPLATE_LABELS 补中文标签（观测类建议带「·观测」后缀，与人工上传区分）。`,
    ).toEqual([]);
  });

  it("观测类标签带「·观测」后缀，业务同事一眼区分人工上传与连接器数据", () => {
    const block = readFileSync(CLIENT, "utf8");
    for (const name of ["jst_daily_sales", "yonyou_observation", "jdy_product_observation"]) {
      const m = new RegExp(`${name}:\\s*"([^"]+)"`).exec(block);
      expect(m, `${name} 应有标签`).toBeTruthy();
      expect(m![1], `${name} 的标签应标明是观测数据`).toContain("观测");
    }
  });
});
