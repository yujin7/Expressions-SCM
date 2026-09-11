/**
 * D65 来源分类注册表护栏：
 * - 每个人工上传模板（IMPORT_TEMPLATES）与每条简道云契约（key 与 targetTable）都必须登记来源类；
 * - 契约 key 与其 targetTable 模板名的分类必须一致（同一批数据不能算在两栏）；
 * - 模块零 import（客户端可值导入）。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  IMPORT_TEMPLATE_SOURCE_CLASS, JDY_CONTRACT_SOURCE_CLASS, REVIEWED_SOURCE_CLASSES, SOURCE_CLASS_DEFS, SOURCE_CLASSES,
  sourceClassForContract, sourceClassForTemplate, templatesOfClass,
} from "@/server/core/data-source-class";
import { IMPORT_TEMPLATES } from "@/server/import/template-contract";
import { JIANDAOYUN_FORM_CONTRACTS } from "@/server/integrations/jiandaoyun-contracts";

describe("data-source-class 注册表", () => {
  it("人工上传模板全部登记", () => {
    for (const t of IMPORT_TEMPLATES) {
      expect(IMPORT_TEMPLATE_SOURCE_CLASS[t], t).toBeDefined();
      expect(sourceClassForTemplate(t).registered).toBe(true);
    }
  });

  it("简道云契约 key 与 targetTable 全部登记且分类一致", () => {
    expect(JIANDAOYUN_FORM_CONTRACTS.length).toBeGreaterThan(0);
    for (const c of JIANDAOYUN_FORM_CONTRACTS) {
      const byKey = sourceClassForContract(c.key);
      expect(byKey, c.key).not.toBeNull();
      const byTable = sourceClassForTemplate(c.targetTable);
      expect(byTable.registered, c.targetTable).toBe(true);
      expect(byTable.sourceClass, `${c.key} ↔ ${c.targetTable}`).toBe(byKey);
    }
    // 注册表里不允许出现契约表中不存在的 key（防止拼写漂移）
    const keys = new Set(JIANDAOYUN_FORM_CONTRACTS.map((c) => c.key));
    for (const k of Object.keys(JDY_CONTRACT_SOURCE_CLASS)) expect(keys.has(k), k).toBe(true);
  });

  it("四类定义完整；核对三类均有目标准确率；reference_file 不度量", () => {
    for (const cls of SOURCE_CLASSES) {
      const def = SOURCE_CLASS_DEFS[cls];
      expect(def.key).toBe(cls);
      expect(def.label.length).toBeGreaterThan(0);
      expect(def.freshnessMaxAgeDays).toBeGreaterThan(0);
      expect(templatesOfClass(cls).length).toBeGreaterThan(0);
    }
    for (const cls of REVIEWED_SOURCE_CLASSES) expect(SOURCE_CLASS_DEFS[cls].targetAccuracyPct).not.toBeNull();
    expect(SOURCE_CLASS_DEFS.reference_file.targetAccuracyPct).toBeNull();
  });

  it("准确率口径如实：rpa 栏来源是自有实时仓出库 vs 聚水潭日销（非快照仓）；external 仅覆盖天猫", () => {
    expect(SOURCE_CLASS_DEFS.rpa_warehouse.accuracyBasis).toContain("自有实时仓出库");
    expect(SOURCE_CLASS_DEFS.rpa_warehouse.accuracyBasis).toContain("stock_ledger sales_out");
    expect(SOURCE_CLASS_DEFS.rpa_warehouse.accuracyBasis).toContain("聚水潭日销");
    expect(SOURCE_CLASS_DEFS.external_platform.accuracyBasis).toContain("仅覆盖天猫");
    expect(SOURCE_CLASS_DEFS.external_platform.accuracyBasis).toContain("拼多多/唯品会不度量");
  });

  it("未登记模板按前缀兜底并标 registered=false", () => {
    expect(sourceClassForTemplate("jdy_future_master_observation")).toEqual({ sourceClass: "reference_file", registered: false });
    expect(sourceClassForTemplate("jdy_future_daily_observation")).toEqual({ sourceClass: "external_platform", registered: false });
    expect(sourceClassForTemplate("whatever")).toEqual({ sourceClass: "reference_file", registered: false });
  });

  it("模块零 import（客户端可值导入）", () => {
    const src = readFileSync(path.resolve(__dirname, "../../src/server/core/data-source-class.ts"), "utf8");
    expect([...src.matchAll(/^\s*import\s+/gm)]).toHaveLength(0);
  });
});
