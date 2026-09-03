/**
 * D62 路由注册表派生等价：AppShell 侧栏与 CommandPalette 页面表改为从 `src/lib/route-access.ts` 派生后，
 * 菜单外观（顺序/键/标签/分组）与角色可见性必须与 2026-09-03 之前的硬编码表完全一致。
 * 下面的 LEGACY_* 是重构前 AppShell.menuItems / MENU_ROLES / REPORT_GROUPS 与 CommandPalette.PAGES 的逐字快照。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ROLES } from "@/server/core/constants";
import {
  buildMenuTree, isRouteVisible, MENU_SECTIONS, menuRolesFromRegistry, PALETTE_PAGES, ROUTE_ENTRIES, ROUTE_REGISTRY,
  routeGroupForPath, scopedModeForPath,
} from "@/lib/route-access";

const root = path.resolve(__dirname, "../..");
const read = (file: string) => readFileSync(path.join(root, file), "utf8");

type LegacyNode = { key: string; label: string; children?: { key: string; label: string }[] };
const LEGACY_MENU: LegacyNode[] = [
  { key: "/workbench", label: "工作台" },
  { key: "/inbox", label: "我的待办" },
  { key: "messages", label: "消息与告警", children: [
    { key: "/notifications", label: "通知中心" }, { key: "/alerts", label: "系统告警" },
  ] },
  { key: "analytics", label: "经营分析", children: [
    { key: "/report/dashboard", label: "经营驾驶舱" }, { key: "/report/decision-studio", label: "决策工作室" },
    { key: "/report/sales-bridge", label: "销量变化归因" }, { key: "/report/funnel", label: "全链达成漏斗" },
    { key: "/report/inventory-analytics", label: "库存分析" }, { key: "/report/process-mining", label: "流程效率与瓶颈" },
  ] },
  { key: "planning", label: "计划与补货", children: [
    { key: "/replenish", label: "补货建议" }, { key: "/replenish/versions", label: "计划版本与周差异" },
    { key: "/replenish/sop", label: "S&OP 计划周期" }, { key: "/report/demand", label: "需求达成与货盘" },
    { key: "/report/risk", label: "风险库存处置" }, { key: "/report/segmentation", label: "库存分层 ABC/XYZ" },
    { key: "/report/closed-loop", label: "建议闭环追踪" }, { key: "/report/auto-replenish", label: "自动补货候选" },
    { key: "/report/material-demand", label: "物料需求展开 MRP" }, { key: "/report/transfer-suggest", label: "调拨建议" },
    { key: "/report/leadtime-learning", label: "交期学习" }, { key: "/report/forecast-accuracy", label: "预测复盘" },
    { key: "/report/detectors", label: "异动侦测" }, { key: "/outsource/auto-chain", label: "自动链预演" },
  ] },
  { key: "outsourcing", label: "委外生产", children: [
    { key: "/outsource/bh", label: "备货申请" }, { key: "/outsource/wo", label: "委外工单" },
    { key: "/outsource/po", label: "采购订单" }, { key: "/outsource/pc", label: "价格变更" },
    { key: "/outsource/jg", label: "加工通知单" }, { key: "/report/wip", label: "委外在制看板" },
    { key: "/report/transit", label: "在途参考" }, { key: "/report/supplier-scorecard", label: "供应商记分卡" },
    { key: "/report/price-compare", label: "物料比价" },
  ] },
  { key: "matflow", label: "物料收发", children: [
    { key: "/matflow/fl", label: "发料单" }, { key: "/matflow/tl", label: "退料单" },
    { key: "/matflow/sh", label: "收货检验" }, { key: "/matflow/ct", label: "采购退货" },
  ] },
  { key: "inventory", label: "库存", children: [
    { key: "/inventory/balance", label: "库存余额" }, { key: "/inventory/ledger", label: "库存流水" },
    { key: "/inventory/docs", label: "库存单据" }, { key: "/inventory/locations", label: "库位作业" },
    { key: "/inventory/count", label: "盘点任务" }, { key: "/inventory/expiry", label: "效期批次" },
    { key: "/inventory/batch-trace", label: "批次追溯" }, { key: "/report/inbound-calendar", label: "到货日历" },
    { key: "/report/sku-360", label: "SKU 360 事件轴" }, { key: "/report/demand?tab=stock_summary", label: "总库存核对" },
    { key: "/report/jiediao", label: "借调对账" },
  ] },
  { key: "quality", label: "质量与合规", children: [{ key: "/quality", label: "质量与合规" }] },
  { key: "npd", label: "新品开发", children: [
    { key: "/npd", label: "NPD 项目跟踪" }, { key: "/report/npd", label: "NPD 节点参考" },
  ] },
  { key: "finance", label: "财务结算", children: [
    { key: "/settlement/js", label: "结算单" }, { key: "/report/margin", label: "毛利视角" },
    { key: "/report/settlement-summary", label: "结算汇总表" }, { key: "/jobs/recon", label: "对账差异" },
    { key: "/settlement/month-close", label: "月结控制台" },
  ] },
  { key: "master", label: "主数据", children: [
    { key: "/master/spu", label: "SPU 产品" }, { key: "/master/sku", label: "SKU 货品" },
    { key: "/master/category", label: "分类" }, { key: "/master/supplier", label: "供应商" },
    { key: "/master/supplier/lifecycle", label: "供应商准入与整改" }, { key: "/master/warehouse", label: "仓库" },
    { key: "/master/bin", label: "库位" }, { key: "/master/bom", label: "BOM" },
    { key: "/master/feeref", label: "加工费参考价" }, { key: "/report/data-health", label: "主数据健康度" },
  ] },
  { key: "import", label: "数据中心", children: [
    { key: "/import/upload", label: "文件上传" }, { key: "/import/release", label: "导入放行" },
    { key: "/import/jobs", label: "导入任务" }, { key: "/import/exceptions", label: "编码别名认领" },
    { key: "/import/data-quality", label: "数据质量" },
    { key: "/review/checklist", label: "复核清单与提醒" }, { key: "/report/exports", label: "导出任务" },
  ] },
  { key: "admin", label: "系统管理", children: [
    { key: "/admin/users", label: "用户管理" }, { key: "/admin/audit", label: "审计日志" },
    { key: "/admin/params", label: "运行参数" }, { key: "/admin/approval-config", label: "审批节点配置" },
    { key: "/admin/health", label: "运维面板" },
  ] },
];

const LEGACY_MENU_ROLES: Record<string, string[]> = {
  "/import/upload": ["pmc", "finance"],
  "/import/release": ["pmc", "finance"],
  "/import/jobs": ["pmc", "finance"],
  "/import/exceptions": ["pmc", "purchasing", "warehouse"],
  "/import/data-quality": ["pmc", "finance", "warehouse", "purchasing"],
  "/review/checklist": ["pmc", "purchasing", "warehouse", "finance"],
  "/master/feeref": ["purchasing", "pmc", "finance"],
  "/master/supplier/lifecycle": ["purchasing", "pmc", "finance"],
  "/master/bin": ["warehouse"],
  "/inventory/locations": ["warehouse"],
  "/quality": ["quality", "purchasing", "warehouse", "pmc", "ops"],
  "/replenish": ["pmc", "purchasing"],
  "/replenish/versions": ["pmc", "purchasing"],
  "/replenish/sop": ["pmc", "purchasing", "ops", "finance"],
  "/outsource/auto-chain": ["pmc"],
  "/admin/users": [],
  "/admin/audit": ["finance"],
  "/admin/params": ["pmc", "purchasing", "finance"],
  "/admin/approval-config": [],
  "/settlement/js": ["finance", "purchasing"],
  "/report/settlement-summary": ["finance"],
  "/report/process-mining": ["pmc", "finance"],
  "/jobs/recon": ["finance", "pmc"],
  "/settlement/month-close": ["finance", "pmc"],
};

const LEGACY_REPORT_GROUPS: Record<string, string> = {
  "/replenish": "planning", "/replenish/versions": "planning", "/replenish/sop": "planning",
  "/report/dashboard": "analytics", "/report/decision-studio": "analytics", "/report/sales-bridge": "analytics",
  "/report/funnel": "analytics", "/report/inventory-analytics": "analytics", "/report/process-mining": "analytics",
  "/report/demand": "planning", "/report/risk": "planning", "/report/segmentation": "planning",
  "/report/closed-loop": "planning", "/report/auto-replenish": "planning", "/report/material-demand": "planning",
  "/report/transfer-suggest": "planning", "/report/leadtime-learning": "planning", "/report/forecast-accuracy": "planning",
  "/report/detectors": "planning", "/report/wip": "outsourcing", "/report/transit": "outsourcing",
  "/report/supplier-scorecard": "outsourcing", "/report/price-compare": "outsourcing",
  "/report/inbound-calendar": "inventory", "/report/sku-360": "inventory", "/report/jiediao": "inventory",
  "/report/npd": "npd", "/report/margin": "finance", "/report/settlement-summary": "finance",
  "/report/data-health": "master", "/report/exports": "import",
};

/** 旧 CommandPalette.PAGES 的 href 集合（顺序不做断言：面板改为菜单顺序） */
const LEGACY_PALETTE_HREFS = [
  "/workbench", "/inbox", "/report/dashboard", "/replenish", "/replenish/sop", "/report/demand", "/report/risk",
  "/report/segmentation", "/report/sku-360", "/report/data-health", "/outsource/auto-chain", "/outsource/bh",
  "/outsource/wo", "/outsource/po", "/outsource/jg", "/inventory/balance", "/inventory/ledger",
  "/inventory/locations", "/inventory/expiry", "/inventory/count", "/quality", "/npd", "/report/npd",
  "/master/spu", "/master/sku", "/master/supplier", "/master/supplier/lifecycle", "/master/warehouse",
  "/master/bin", "/master/bom", "/import/upload", "/import/release", "/import/data-quality", "/review/checklist", "/admin/users",
  "/admin/params", "/admin/health",
];

/** 旧 AppShell.filterMenuByRoles 的逐字语义，用来对 LEGACY 快照做同样过滤 */
function legacyFilter(items: LegacyNode[], roles: string[]): LegacyNode[] {
  const isAdmin = roles.includes("admin");
  const visible = (key: string): boolean => {
    if (isAdmin) return true;
    const need = LEGACY_MENU_ROLES[key];
    if (need === undefined) return true;
    return need.some((r) => roles.includes(r));
  };
  return items
    .map((item) => {
      if (item.children) {
        const children = item.children.filter((c) => visible(c.key));
        if (children.length === 0) return null;
        return { ...item, children };
      }
      return visible(item.key) ? item : null;
    })
    .filter((x): x is LegacyNode => x !== null);
}

function treeToLegacy(roles: string[]): LegacyNode[] {
  return buildMenuTree(roles).map((n) =>
    n.kind === "route"
      ? { key: n.key, label: n.label }
      : { key: n.key, label: n.label, children: n.children.map((c) => ({ key: c.key, label: c.label })) });
}

describe("D62 路由注册表：菜单派生等价", () => {
  it("注册表是零依赖纯常量模块（客户端可值导入）", () => {
    const src = read("src/lib/route-access.ts");
    expect([...src.matchAll(/^\s*import\s+/gm)]).toHaveLength(0);
  });

  it("path 唯一、以 / 开头；MENU_SECTIONS 引用的 route 都存在且每个分组至少一条", () => {
    const paths = ROUTE_ENTRIES.map((e) => e.path);
    expect(new Set(paths).size).toBe(paths.length);
    for (const p of paths) expect(p.startsWith("/")).toBe(true);
    for (const s of MENU_SECTIONS) {
      if (s.kind === "route") expect(ROUTE_REGISTRY[s.route]).toBeDefined();
      else expect(ROUTE_ENTRIES.some((e) => e.group === s.key)).toBe(true);
    }
    for (const e of ROUTE_ENTRIES) {
      if (e.group === "top") expect(MENU_SECTIONS.some((s) => s.kind === "route" && s.route === e.key)).toBe(true);
      else expect(MENU_SECTIONS.some((s) => s.kind === "group" && s.key === e.group)).toBe(true);
      expect(["public", "channel_scoped", "denied"]).toContain(e.scopedMode);
      for (const r of e.roles ?? []) expect(ROLES).toContain(r);
    }
  });

  it("admin 全量树与旧 menuItems 逐字一致（顺序/键/标签/分组）", () => {
    expect(treeToLegacy(["admin"])).toEqual(LEGACY_MENU);
  });

  it("角色可见性表与旧 MENU_ROLES 完全一致", () => {
    expect(menuRolesFromRegistry()).toEqual(LEGACY_MENU_ROLES);
  });

  it("每个单角色、无角色、双角色组合的过滤结果与旧 filterMenuByRoles 完全一致", () => {
    const combos: string[][] = [[], ...ROLES.map((r) => [r])];
    for (const a of ROLES) for (const b of ROLES) if (a < b) combos.push([a, b]);
    for (const roles of combos) {
      expect(treeToLegacy(roles), `roles=${roles.join(",")}`).toEqual(legacyFilter(LEGACY_MENU, roles));
    }
  });

  it("导航分组：旧 REPORT_GROUPS 的每个路径解析结果一致；顶层项返回 null", () => {
    for (const [p, g] of Object.entries(LEGACY_REPORT_GROUPS)) expect(routeGroupForPath(p), p).toBe(g);
    expect(routeGroupForPath("/workbench")).toBeNull();
    expect(routeGroupForPath("/inbox")).toBeNull();
    expect(routeGroupForPath("/nowhere")).toBeNull();
    // 明确登记的改进：菜单项实际所在分组即导航分组（旧实现靠前缀落到 outsourcing / null）
    expect(routeGroupForPath("/outsource/auto-chain")).toBe("planning");
    expect(routeGroupForPath("/notifications")).toBe("messages");
    expect(scopedModeForPath("/report/dashboard")).toBe("channel_scoped");
    expect(scopedModeForPath("/inventory/expiry")).toBe("public");
    expect(scopedModeForPath("/nowhere")).toBeNull();
  });

  it("命令面板：页面集合与旧 PAGES 一致，角色可见性与侧栏同源", () => {
    expect(new Set(PALETTE_PAGES.map((p) => p.href))).toEqual(new Set(LEGACY_PALETTE_HREFS));
    expect(PALETTE_PAGES).toHaveLength(LEGACY_PALETTE_HREFS.length);
    for (const p of PALETTE_PAGES) {
      expect(p.keywords.length).toBeGreaterThan(0);
      expect(p.roles).toEqual(LEGACY_MENU_ROLES[p.href]);
    }
    expect(isRouteVisible({ roles: [] }, ["ops"])).toBe(false);
    expect(isRouteVisible({ roles: [] }, ["admin"])).toBe(true);
    expect(isRouteVisible({}, ["ops"])).toBe(true);
    expect(isRouteVisible({ roles: ["pmc"] }, ["ops", "pmc"])).toBe(true);
  });

  it("AppShell / CommandPalette 不再持有本地菜单表，只从注册表派生", () => {
    const shell = read("src/components/AppShell.tsx");
    const palette = read("src/components/CommandPalette.tsx");
    expect(shell).toContain('from "@/lib/route-access"');
    expect(palette).toContain('from "@/lib/route-access"');
    expect(shell).not.toContain("const MENU_ROLES");
    expect(shell).not.toContain("const REPORT_GROUPS");
    expect(shell).not.toMatch(/const menuItems\s*:/);
    expect(palette).not.toMatch(/\{ label: "[^"]+", href: "\//);
    // 注册表本身不得被绕过：组件里不得再出现带角色数组的路径字面量
    expect(shell).not.toMatch(/"\/[a-z/-]+":\s*\[/);
  });
});
