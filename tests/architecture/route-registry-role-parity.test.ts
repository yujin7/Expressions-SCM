/**
 * 架构护栏：注册表里的 `roles` 必须与 API / 客户端真实门禁一致。
 *
 * 注册表既管侧栏可见性又管 ⌘K 面板，写窄了页面就「找不到」，写宽了菜单里有条目点进去 403。
 * 两个实测缺陷（2026-09-04 审计）：
 * - `/report/settlement-summary` 注册表写 `["finance"]`，而 API（service 内 requireAnyRole）
 *   与客户端 hasAnyRole 都放行 采购/PMC/财务——采购和 PMC 有权限却在菜单里找不到这页；
 * - `/report/price-compare` 注册表**没有 roles**，API 又只有 guardRead——仓管在菜单里看得见、
 *   点进去还真能看到每家供应商的采购价。
 * - `/report/digest` 干脆没登记：只能从工作台的一条链接进入，⌘K 搜「简报」什么都搜不到。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ROUTE_REGISTRY } from "@/lib/route-access";
import { SETTLEMENT_SUMMARY_ROLES } from "@/server/modules/report/settlement-summary";

const root = process.cwd();
const read = (rel: string): string => readFileSync(path.join(root, rel), "utf8");

describe("注册表 roles 与真实门禁一致", () => {
  it("结算汇总表：注册表 = API/客户端放行的采购/PMC/财务", () => {
    expect(ROUTE_REGISTRY.report_settlement_summary.roles).toEqual(["purchasing", "pmc", "finance"]);
    // service 内 requireAnyRole 是唯一权威，注册表必须与它逐字一致
    expect(ROUTE_REGISTRY.report_settlement_summary.roles).toEqual([...SETTLEMENT_SUMMARY_ROLES]);
    expect(read("src/server/modules/report/settlement-summary.ts"))
      .toContain("requireAnyRole(user, ...SETTLEMENT_SUMMARY_ROLES)");
    const client = read("src/app/(app)/report/settlement-summary/settlement-summary-client.tsx");
    expect(client).toMatch(/hasAnyRole\(me,\s*"purchasing",\s*"pmc",\s*"finance"\)/);
  });

  it("物料比价：注册表 roles 与 PRICE_VISIBLE_ROLES（admin 由 isRouteVisible 兜底）对齐", () => {
    expect(ROUTE_REGISTRY.report_price_compare.roles).toEqual(["purchasing", "pmc", "finance"]);
    // 与同类价格页 /master/feeref 一致
    expect(ROUTE_REGISTRY.master_feeref.roles).toEqual(ROUTE_REGISTRY.report_price_compare.roles);
    expect(read("src/app/api/report/price-compare/route.ts")).toContain("PRICE_VISIBLE_ROLES");
  });

  it("每日经营摘要已登记（可从菜单与 ⌘K 进入），且失败态不是一片空白", () => {
    expect(ROUTE_REGISTRY.report_digest.path).toBe("/report/digest");
    expect(ROUTE_REGISTRY.report_digest.group).toBe("analytics");
    expect((ROUTE_REGISTRY.report_digest as { keywords?: string }).keywords ?? "").toContain("digest");
    const client = read("src/app/(app)/report/digest/digest-client.tsx");
    expect(client).toContain("LoadErrorAlert");
    expect(client).not.toMatch(/if\s*\(!data\)\s*return null;/);
  });
});
