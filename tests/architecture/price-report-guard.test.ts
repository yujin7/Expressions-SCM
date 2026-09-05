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
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
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

/**
 * 派生补全（2026-09-06）：上面的 PRICE_REPORT_ROUTES 是**手抄名单**——与曾经漏掉 CLOSED_PERIOD 的
 * errorResponse 放行名单是同一种东西。手抄名单的失败方式不是「写错」，是「新增了没人补」。
 * 这条测试从代码本身推导候选：凡 report 路由导入的服务模块在**导出接口**里声明了
 * SENSITIVE_FIELDS 中的字段名，该路由就必须要么在名单里、要么过 maskSensitive、要么判 PRICE_VISIBLE_ROLES。
 * 能零误报落地，是因为 sensitive-name-collision 门先把「借用敏感名的非金额字段」清掉了。
 */
function derivedMoneyReportRoutes(): string[] {
  const constants = readFileSync(path.resolve(__dirname, "../../src/server/core/constants.ts"), "utf8");
  const fields = [...constants.matchAll(/"([A-Za-z0-9_]+)"/g)]
    .map((m) => m[1])
    .filter((_, i, all) => {
      const start = constants.indexOf("export const SENSITIVE_FIELDS");
      const end = constants.indexOf("] as const;", start);
      const block = constants.slice(start, end);
      return block.includes(`"${all[i]}"`);
    });
  const reportApi = path.join(API, "report");
  const modsDir = path.resolve(__dirname, "../../src/server/modules/report");
  const out: string[] = [];
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => {
    const p = path.join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : n === "route.ts" ? [p] : [];
  });
  for (const file of walk(reportApi)) {
    const src = readFileSync(file, "utf8");
    if (/maskSensitive|PRICE_VISIBLE_ROLES/.test(src)) continue;
    let money = false;
    for (const m of src.matchAll(/from "@\/server\/modules\/report\/([A-Za-z0-9_-]+)"/g)) {
      const modPath = path.join(modsDir, `${m[1]}.ts`);
      if (!existsSync(modPath)) continue;
      const mod = readFileSync(modPath, "utf8");
      for (const iface of mod.matchAll(/export interface \w+[^{]*\{([\s\S]*?)\n\}/g)) {
        if (fields.some((f) => new RegExp(`^\\s*${f}\\??:`, "m").test(iface[1]))) money = true;
      }
    }
    if (money) out.push(path.relative(API, file));
  }
  return out.sort();
}

describe("架构护栏：金额报表名单不得手抄漏项", () => {
  it("凡服务接口带敏感字段的 report 路由，必须在名单里或已脱敏/判角色", () => {
    const missing = derivedMoneyReportRoutes().filter((r) => !PRICE_REPORT_ROUTES.includes(r));
    expect(
      missing,
      "这些路由的服务会返回金额字段，却既不在 PRICE_REPORT_ROUTES、也没 maskSensitive/PRICE_VISIBLE_ROLES：\n"
        + missing.join("\n"),
    ).toEqual([]);
  });
});

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
