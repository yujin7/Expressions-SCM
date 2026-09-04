/**
 * 主数据补录的三个「有能力、没入口」缺陷（2026-09-04 审计 #7 / #9 / #12）。
 *
 * #7 平台身份认领：`report/decision-studio/platform-sku-gap-card.tsx` 是全系统最好的
 *    回填界面（按销售额排队、系统给候选、批量提交带预览），却只能从决策工作室深处点进去，
 *    主数据菜单和 `/import/exceptions` 都到不了——最该用它的人找不到它。
 * #9 `admin_health` 在注册表里没有 `roles`（= 全员可见），而页面与 `/api/admin/health`
 *    都是 admin-only：非管理员在菜单里看得到，点进去只能撞 NoAccess。
 * #12 `/master/sku` 表单有物流/调拨周期却没有加工周期，而两者是 `sku_params` 的**同一行**，
 *    与 `/master/supply-params` 也是同一行：一行数据被两张半张表单维护。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PALETTE_PAGES, ROUTE_REGISTRY, isRouteVisible } from "@/lib/route-access";

const root = path.resolve(__dirname, "../..");
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");

describe("#9 admin_health 的菜单可见性与页面守卫一致", () => {
  it("注册表登记 roles:[\"admin\"]（省略 roles = 全员可见 = 点进去撞 NoAccess）", () => {
    expect(ROUTE_REGISTRY.admin_health.roles).toEqual(["admin"]);
    expect(isRouteVisible(ROUTE_REGISTRY.admin_health, ["pmc"])).toBe(false);
    expect(isRouteVisible(ROUTE_REGISTRY.admin_health, ["finance", "purchasing"])).toBe(false);
    expect(isRouteVisible(ROUTE_REGISTRY.admin_health, ["admin"])).toBe(true);
  });

  it("页面本体确实是 admin-only（守卫与注册表必须说同一句话）", () => {
    const page = read("src/app/(app)/admin/health/page.tsx");
    expect(page).toContain('roles.includes("admin")');
    expect(page).toContain("NoAccess");
  });
});

describe("#7 平台身份认领的入口", () => {
  it("主数据分组里登记了深链条目", () => {
    const entry = ROUTE_REGISTRY.master_platform_identity;
    expect(entry.path).toBe("/report/decision-studio?tab=identity");
    expect(entry.group).toBe("master");
    expect(entry.label).toBe("平台身份认领");
    expect(entry.keywords, "要能被 ⌘K 命令面板搜到").toBeDefined();
    expect(PALETTE_PAGES.some((p) => p.href === "/report/decision-studio?tab=identity")).toBe(true);
  });

  it("决策工作室的 tab 由 URL 参数驱动（否则深链打不开那个页签）", () => {
    const studio = read("src/app/(app)/report/decision-studio/decision-studio-client.tsx");
    expect(studio).toContain('key: "identity"');
    expect(studio, "activeTab 取自 useListState 的 tab 参数").toMatch(/activeKey=\{activeTab\}/);
  });

  it("/import/exceptions 复用同一个组件，而不是复制一份", () => {
    const client = read("src/app/(app)/import/exceptions/exceptions-client.tsx");
    expect(client).toContain("platform-sku-gap-card");
    expect(client).toContain("<PlatformSkuGapCard");
    // 深链：?view=identity 直达该页签
    expect(client).toContain('view: "alias"');
    expect(client).toContain('filters.view === "identity"');
    // 候选/提交逻辑只有一处实现——本页不得出现认领写路径
    expect(client).not.toContain("platform-sku-claim");
  });
});

describe("#12 SKU 主档表单的加工周期", () => {
  const skuClient = read("src/app/(app)/master/sku/sku-client.tsx");
  const skuService = read("src/server/modules/master/sku.ts");

  it("表单同时有加工周期与物流周期，并交叉链到批量补录页", () => {
    expect(skuClient).toContain('name="normalLeadDays"');
    expect(skuClient).toContain('name="logisticsLeadDays"');
    expect(skuClient).toContain("/master/supply-params");
  });

  it("服务端真的把加工周期写进 sku_params（此前 schema 收了字段却静默丢弃）", () => {
    expect(skuService).toContain("v.normalLeadDays !== undefined");
    // 审计的 before/after 都要带上它，否则改了查不出来
    expect(skuService).toMatch(/before: \{ \.\.\.existing, normalLeadDays:/);
  });
});
