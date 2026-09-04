/**
 * 架构护栏：返回成本/价格字段的报表路由必须有「新鲜身份 + 价格角色」双重门。
 *
 * 事故背景（2026-08-03 独立审计实测）：/api/report/margin 逐行返回 `unitCost`
 * （sku_costs.unit_cost，属 R9 敏感金额），却只有 `guardRead()`——任何登录用户可读。
 * 实测 ops01 拿到 `unitCost: 12.5`，而同类金额报表 /api/report/settlement-summary
 * 对同一账号返回 403。同一套系统里两个金额报表两种口径，是最容易被忽略的越权面。
 *
 * 本护栏钉住：金额报表不得用 guardRead（它只解 JWT，停用/降权在 8h 内不生效），
 * 必须 guardFreshWrite + PRICE_VISIBLE_ROLES 角色判定。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const API = path.resolve(__dirname, "../../src/app/api");

/** 逐行返回成本/单价的金额报表（新增同类报表时补进来） */
const PRICE_REPORT_ROUTES = [
  "report/margin/route.ts",
  "report/settlement-summary/route.ts",
  "report/supplier-price-variance/route.ts",
  "report/channel-observation/route.ts",
  // 2026-09-04 补：物料比价逐行返回供应商采购基准价，此前只有 guardRead（全员可读）
  "report/price-compare/route.ts",
];

/** 这些路由在 route 层直接判 PRICE_VISIBLE_ROLES；settlement-summary 在 service 内判采购/PMC/财务。 */
const DIRECT_PRICE_ROLE_ROUTES = [
  "report/margin/route.ts",
  "report/supplier-price-variance/route.ts",
  "report/channel-observation/route.ts",
  "report/price-compare/route.ts",
];

describe("架构护栏：金额报表的角色门", () => {
  it("金额报表不得只用 guardRead，必须回查新鲜身份", () => {
    const offenders: string[] = [];
    for (const rel of PRICE_REPORT_ROUTES) {
      const src = readFileSync(path.join(API, rel), "utf8");
      const getBlock = src.slice(src.indexOf("export async function GET"));
      if (/\bguardRead\s*\(/.test(getBlock)) offenders.push(`${rel} → GET 用了 guardRead`);
      if (!/guardFreshWrite\s*\(/.test(getBlock)) offenders.push(`${rel} → GET 未回查新鲜身份`);
    }
    expect(
      offenders,
      `金额报表泄露成本价的路径：\n${offenders.join("\n")}\n` +
        `guardRead 只解 JWT——账号停用/降权后旧 token 在 8 小时内仍可读到成本。`,
    ).toEqual([]);
  });

  it("每个金额报表确实做了 PRICE_VISIBLE_ROLES 判定（有门但不判角色等于没门）", () => {
    for (const rel of DIRECT_PRICE_ROLE_ROUTES) {
      const src = readFileSync(path.join(API, rel), "utf8");
      expect(src, rel).toContain("PRICE_VISIBLE_ROLES");
      expect(src, rel).toMatch(/requireAnyRole\s*\(\s*user\s*,\s*\.\.\.PRICE_VISIBLE_ROLES/);
    }
  });

  it("渠道观察与物料比价的成本/价格还必须经过统一脱敏边界", () => {
    for (const rel of ["report/channel-observation/route.ts", "report/price-compare/route.ts"]) {
      const src = readFileSync(path.join(API, rel), "utf8");
      expect(src, rel).toContain("maskSensitive");
      expect(src, rel).toMatch(/maskSensitive\s*\([^;]+user\.roles/);
    }
  });
});
