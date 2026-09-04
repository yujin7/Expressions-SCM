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

  /* W2：简报与工作台控制塔渲染的是同一份 workbench/focus 例外（report/digest.ts 自称"纯装配"），
     两个"登录第一屏"已并为一个——摘要成为 /workbench?view=digest 的一个视图，
     /report/digest 保留 302。注册表条目保留为深链，⌘K 搜「简报」仍然能到。 */
  it("每日经营摘要已并入工作台简报视图（深链仍登记，旧路径保留跳转），且失败态不是一片空白", () => {
    expect(ROUTE_REGISTRY.report_digest.path).toBe("/workbench?view=digest");
    expect(ROUTE_REGISTRY.report_digest.group).toBe("analytics");
    expect((ROUTE_REGISTRY.report_digest as { keywords?: string }).keywords ?? "").toContain("digest");
    expect(read("src/app/(app)/report/digest/page.tsx")).toContain('redirect("/workbench?view=digest")');
    const client = read("src/app/(app)/workbench/digest-view.tsx");
    expect(client).toContain("LoadErrorAlert");
    expect(client).not.toMatch(/if\s*\(!data\)\s*return null;/);
  });

  /* W2：NPD 节点参考就是 /npd 建项目时实例化用的那套模板，却与它并排成两个菜单项；
     已并入 /npd 的「节点模板」页签，页签标签的硬编码计数（69/19）改为按实际行数渲染。 */
  it("NPD 节点模板已并入 /npd 页签（旧路径保留跳转），标签不再写死条数", () => {
    expect(ROUTE_REGISTRY.report_npd.path).toBe("/npd?tab=templates");
    expect(read("src/app/(app)/report/npd/page.tsx")).toContain('redirect("/npd?tab=templates")');
    const tab = read("src/app/(app)/npd/node-template-tab.tsx");
    expect(tab).not.toContain("节点标准（69）");
    expect(tab).not.toContain("角色分配（19）");
    expect(tab).toContain("countLabel");
  });

  /* W2：能力解锁面板此前在 data-health 与 decision-studio 各渲染一次，
     而 data-health 那份是**空参版**（不传数据源/发布/结果/外部佐证），全部深链又都指向决策工作室。 */
  it("决策能力解锁只在决策工作室渲染一次，主数据健康度只留指路", () => {
    const dataHealth = read("src/app/(app)/report/data-health/data-health-client.tsx");
    expect(dataHealth, "不得再 import 该面板").not.toMatch(/import DecisionReadinessPanel/);
    expect(dataHealth, "不得再渲染该面板").not.toMatch(/<DecisionReadinessPanel\b/);
    expect(dataHealth).toContain("/report/decision-studio?tab=readiness");
    expect(read("src/app/(app)/report/decision-studio/decision-studio-client.tsx")).toContain("DecisionReadinessPanel");
  });

  /* W2 先挪后买：新页面必须登记（否则又是一个"只能从别处点链接进来"的孤儿页），
     可见角色与 /replenish 一致——它是补货建议的另一种读法，不是新权限面。 */
  it("先挪后买决策表已登记，且角色与补货建议一致", () => {
    expect(ROUTE_REGISTRY.replenish_move_or_buy.path).toBe("/replenish/move-or-buy");
    expect(ROUTE_REGISTRY.replenish_move_or_buy.group).toBe("planning");
    expect(ROUTE_REGISTRY.replenish_move_or_buy.roles).toEqual([...ROUTE_REGISTRY.replenish.roles]);
    expect((ROUTE_REGISTRY.replenish_move_or_buy as { keywords?: string }).keywords ?? "").toContain("先挪后买");
  });
});
