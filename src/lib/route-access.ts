/**
 * 路由/菜单注册表（D62）——侧栏菜单、⌘K 命令面板、导航分组与角色可见性的**唯一**来源。
 *
 * 零依赖纯常量模块：`"use client"` 组件（AppShell / CommandPalette）可直接值导入，
 * 服务端（页面守卫、数据范围裁剪）同样可用。**禁止在本文件 import 任何模块**
 * （`tests/architecture/route-registry-derivation.test.ts` 钉住）。
 *
 * ── 新增页面怎么登记（各领域实现方只往这里加条目，不改 AppShell / CommandPalette）──
 *   1. 在 `ROUTE_REGISTRY` 里按**菜单显示顺序**插入一条：
 *        cockpit: { path: "/cockpit", label: "驾驶舱", group: "analytics", scopedMode: "channel_scoped",
 *                   roles: ["pmc", "purchasing", "warehouse", "finance", "ops"], keywords: "cockpit jiashicang" },
 *      - `roles` 省略 = 全员可见；`[]` = 仅管理员；admin 恒通过（与既有 MENU_ROLES 语义一致）。
 *      - `keywords` 存在 = 同时进入命令面板（拼音/英文/中文关键词，空格分隔，小写）。
 *      - `group` 决定落在哪个侧栏分组（`MENU_SECTIONS` 顺序）；`"top"` = 顶层独立项（如工作台）。
 *      - `scopedMode`（D62 受限用户裁剪口径，本波仅登记，下一波页面按此过滤）：
 *          public          非渠道维内容（库存总量/临期/到货日历等），受限用户原样可见；
 *          channel_scoped  渠道维内容，受限用户按 user_data_scopes 裁剪；
 *          denied          受限用户不可见（销售金额/财务/系统管理等）。
 *   2. 同一 `path` 只能登记一次（含 `?tab=` 变体视为不同条目）。
 *   3. 需要顶层新项或新分组时追加 `MENU_SECTIONS`（图标在 AppShell 的 GROUP_ICONS 映射里补）。
 */

export type RouteGroup =
  | "top"
  | "messages"
  | "analytics"
  | "planning"
  | "outsourcing"
  | "matflow"
  | "inventory"
  | "quality"
  | "npd"
  | "finance"
  | "master"
  | "import"
  | "admin";

export type ScopedMode = "public" | "channel_scoped" | "denied";

export interface RouteEntry {
  /** 菜单 key / 命令面板 href / 路由路径（可带 `?tab=`） */
  path: string;
  label: string;
  /** 可见角色：undefined = 全员；[] = 仅管理员；admin 恒通过 */
  roles?: readonly string[];
  group: RouteGroup;
  /** D62 受限用户（有 channel 范围记录的 ops）对该页的裁剪口径 */
  scopedMode: ScopedMode;
  /** 命令面板搜索关键词；缺省 = 不进命令面板 */
  keywords?: string;
}

/** 侧栏顶层结构（顺序即显示顺序）：独立路由项 或 分组 */
export type MenuSection =
  | { kind: "route"; route: RouteKey }
  | { kind: "group"; key: Exclude<RouteGroup, "top">; label: string };

export const ROUTE_REGISTRY = {
  /* ── 顶层 ── */
  workbench: { path: "/workbench", label: "工作台", group: "top", scopedMode: "public", keywords: "workbench home shouye" },
  inbox: { path: "/inbox", label: "我的待办", group: "top", scopedMode: "public", keywords: "inbox daiban todo" },
  todo: { path: "/todo", label: "待办任务", group: "top", scopedMode: "public", keywords: "todo renwu daiban work item 待办任务" },
  goals: { path: "/goals", label: "供应链目标", group: "top", scopedMode: "channel_scoped", keywords: "goals mubiao kpi 部门目标 供应链目标" },

  /* ── 消息与告警 ── */
  notifications: { path: "/notifications", label: "通知中心", group: "messages", scopedMode: "public" },
  alerts: { path: "/alerts", label: "系统告警", group: "messages", scopedMode: "channel_scoped" },

  /* ── 经营分析 ── */
  cockpit: { path: "/cockpit", label: "驾驶舱四屏", group: "analytics", scopedMode: "channel_scoped", keywords: "cockpit jiashicang siping four screens" },
  report_dashboard: { path: "/report/dashboard", label: "经营驾驶舱", group: "analytics", scopedMode: "channel_scoped", keywords: "dashboard jiashicang bi" },
  report_decision_studio: { path: "/report/decision-studio", label: "决策工作室", group: "analytics", scopedMode: "channel_scoped" },
  report_sales_bridge: { path: "/report/sales-bridge", label: "销量变化归因", group: "analytics", scopedMode: "channel_scoped" },
  report_funnel: { path: "/report/funnel", label: "全链达成漏斗", group: "analytics", scopedMode: "channel_scoped" },
  report_inventory_analytics: { path: "/report/inventory-analytics", label: "库存分析", group: "analytics", scopedMode: "public" },
  report_process_mining: { path: "/report/process-mining", label: "流程效率与瓶颈", roles: ["pmc", "finance"], group: "analytics", scopedMode: "denied" },

  /* ── 计划与补货 ── */
  replenish: { path: "/replenish", label: "补货建议", roles: ["pmc", "purchasing"], group: "planning", scopedMode: "public", keywords: "replenish buhuo" },
  replenish_versions: { path: "/replenish/versions", label: "计划版本与周差异", roles: ["pmc", "purchasing"], group: "planning", scopedMode: "public" },
  replenish_sop: { path: "/replenish/sop", label: "S&OP 计划周期", roles: ["pmc", "purchasing", "ops", "finance"], group: "planning", scopedMode: "channel_scoped", keywords: "sop consensus freeze execute 共识 冻结 执行" },
  replenish_reconcile: { path: "/replenish/reconcile", label: "运营提报核对", roles: ["pmc", "ops", "purchasing", "finance"], group: "planning", scopedMode: "channel_scoped", keywords: "reconcile ops demand tibao hedui 提报 核对" },
  replenish_pilot: { path: "/replenish/pilot", label: "补货试点候选", roles: ["pmc", "purchasing", "ops", "finance"], group: "planning", scopedMode: "public", keywords: "pilot shidian tier ownership 试点 分层 权责" },
  report_demand: { path: "/report/demand", label: "需求达成与货盘", group: "planning", scopedMode: "channel_scoped", keywords: "demand xuqiu huopan" },
  report_risk: { path: "/report/risk", label: "风险库存处置", group: "planning", scopedMode: "public", keywords: "risk fengxian chuzhi" },
  report_segmentation: { path: "/report/segmentation", label: "库存分层 ABC/XYZ", group: "planning", scopedMode: "public", keywords: "abc xyz fenceng segmentation" },
  report_closed_loop: { path: "/report/closed-loop", label: "建议闭环追踪", group: "planning", scopedMode: "public" },
  report_auto_replenish: { path: "/report/auto-replenish", label: "自动补货候选", group: "planning", scopedMode: "public" },
  report_material_demand: { path: "/report/material-demand", label: "物料需求展开 MRP", group: "planning", scopedMode: "public" },
  report_transfer_suggest: { path: "/report/transfer-suggest", label: "调拨建议", group: "planning", scopedMode: "public" },
  report_leadtime_learning: { path: "/report/leadtime-learning", label: "交期学习", group: "planning", scopedMode: "public" },
  report_forecast_accuracy: { path: "/report/forecast-accuracy", label: "预测复盘", group: "planning", scopedMode: "channel_scoped" },
  report_detectors: { path: "/report/detectors", label: "异动侦测", group: "planning", scopedMode: "channel_scoped" },
  outsource_auto_chain: { path: "/outsource/auto-chain", label: "自动链预演", roles: ["pmc"], group: "planning", scopedMode: "public", keywords: "auto chain zidonglian" },

  /* ── 委外生产 ── */
  // D62（W2-E）：受限 ops 的列表只见本人制单或本渠道制单人的单据（outsource/bh.listBhs）
  outsource_bh: { path: "/outsource/bh", label: "备货申请", group: "outsourcing", scopedMode: "channel_scoped", keywords: "bh beihuo" },
  outsource_wo: { path: "/outsource/wo", label: "委外工单", group: "outsourcing", scopedMode: "public", keywords: "wo weiwai gongdan" },
  outsource_po: { path: "/outsource/po", label: "采购订单", group: "outsourcing", scopedMode: "public", keywords: "po caigou" },
  outsource_pc: { path: "/outsource/pc", label: "价格变更", group: "outsourcing", scopedMode: "denied" },
  outsource_jg: { path: "/outsource/jg", label: "加工通知单", group: "outsourcing", scopedMode: "public", keywords: "jg jiagong" },
  report_wip: { path: "/report/wip", label: "委外在制看板", group: "outsourcing", scopedMode: "public" },
  report_transit: { path: "/report/transit", label: "在途参考", group: "outsourcing", scopedMode: "public" },
  report_supplier_scorecard: { path: "/report/supplier-scorecard", label: "供应商记分卡", group: "outsourcing", scopedMode: "public" },
  report_price_compare: { path: "/report/price-compare", label: "物料比价", group: "outsourcing", scopedMode: "denied" },

  /* ── 物料收发 ── */
  matflow_fl: { path: "/matflow/fl", label: "发料单", group: "matflow", scopedMode: "public" },
  matflow_tl: { path: "/matflow/tl", label: "退料单", group: "matflow", scopedMode: "public" },
  matflow_sh: { path: "/matflow/sh", label: "收货检验", group: "matflow", scopedMode: "public" },
  matflow_ct: { path: "/matflow/ct", label: "采购退货", group: "matflow", scopedMode: "public" },

  /* ── 库存 ── */
  inventory_balance: { path: "/inventory/balance", label: "库存余额", group: "inventory", scopedMode: "public", keywords: "balance yue kucun" },
  inventory_ledger: { path: "/inventory/ledger", label: "库存流水", group: "inventory", scopedMode: "public", keywords: "ledger liushui" },
  inventory_docs: { path: "/inventory/docs", label: "库存单据", group: "inventory", scopedMode: "public" },
  inventory_locations: { path: "/inventory/locations", label: "库位作业", roles: ["warehouse"], group: "inventory", scopedMode: "public", keywords: "bin location kuwei zuoye" },
  inventory_count: { path: "/inventory/count", label: "盘点任务", group: "inventory", scopedMode: "public", keywords: "count pandian" },
  inventory_expiry: { path: "/inventory/expiry", label: "效期批次", group: "inventory", scopedMode: "public", keywords: "expiry xiaoqi pici" },
  inventory_batch_trace: { path: "/inventory/batch-trace", label: "批次追溯", group: "inventory", scopedMode: "public" },
  report_inbound_calendar: { path: "/report/inbound-calendar", label: "到货日历", group: "inventory", scopedMode: "public" },
  report_sku_360: { path: "/report/sku-360", label: "SKU 360 事件轴", group: "inventory", scopedMode: "public", keywords: "sku360 timeline shijianzhou" },
  report_stock_summary: { path: "/report/demand?tab=stock_summary", label: "总库存核对", group: "inventory", scopedMode: "public" },
  report_jiediao: { path: "/report/jiediao", label: "借调对账", group: "inventory", scopedMode: "public" },
  // D51/D52 库存日级 / 月级走向（inventory-position/v1；数量公开内容，金额按 PRICE_VISIBLE_ROLES 服务端剥离）
  inventory_position: { path: "/inventory/position", label: "库存日级走向", group: "inventory", scopedMode: "public", keywords: "position daily zoushi rijikucun kucun yueme monthend" },
  inventory_alerts: { path: "/inventory/alerts", label: "库存预警与爆单", group: "inventory", scopedMode: "channel_scoped", keywords: "alerts yujing baodan duanhuo spike cover" },

  /* ── 质量与合规 ── */
  quality: { path: "/quality", label: "质量与合规", roles: ["quality", "purchasing", "warehouse", "pmc", "ops"], group: "quality", scopedMode: "public", keywords: "quality compliance zhiliang hegui" },

  /* ── 新品开发 ── */
  npd: { path: "/npd", label: "NPD 项目跟踪", group: "npd", scopedMode: "public", keywords: "npd xinpin project" },
  report_npd: { path: "/report/npd", label: "NPD 节点参考", group: "npd", scopedMode: "public", keywords: "npd jiedian node" },

  /* ── 财务结算 ── */
  settlement_js: { path: "/settlement/js", label: "结算单", roles: ["finance", "purchasing"], group: "finance", scopedMode: "denied" },
  report_margin: { path: "/report/margin", label: "毛利视角", group: "finance", scopedMode: "denied" },
  report_settlement_summary: { path: "/report/settlement-summary", label: "结算汇总表", roles: ["finance"], group: "finance", scopedMode: "denied" },
  jobs_recon: { path: "/jobs/recon", label: "对账差异", roles: ["finance", "pmc"], group: "finance", scopedMode: "denied" },
  settlement_month_close: { path: "/settlement/month-close", label: "月结控制台", roles: ["finance", "pmc"], group: "finance", scopedMode: "denied" },

  /* ── 主数据 ── */
  master_spu: { path: "/master/spu", label: "SPU 产品", group: "master", scopedMode: "public", keywords: "spu chanpin" },
  master_sku: { path: "/master/sku", label: "SKU 货品", group: "master", scopedMode: "public", keywords: "sku huopin" },
  master_category: { path: "/master/category", label: "分类", group: "master", scopedMode: "public" },
  master_supplier: { path: "/master/supplier", label: "供应商", group: "master", scopedMode: "public", keywords: "supplier gongyingshang" },
  master_supplier_lifecycle: { path: "/master/supplier/lifecycle", label: "供应商准入与整改", roles: ["purchasing", "pmc", "finance"], group: "master", scopedMode: "public", keywords: "supplier onboarding corrective gongyingshang zhunru zhenggai" },
  master_warehouse: { path: "/master/warehouse", label: "仓库", group: "master", scopedMode: "public", keywords: "warehouse cangku" },
  master_bin: { path: "/master/bin", label: "库位", roles: ["warehouse"], group: "master", scopedMode: "public", keywords: "bin location kuwei" },
  master_bom: { path: "/master/bom", label: "BOM", group: "master", scopedMode: "public", keywords: "bom wuliaoqingdan" },
  master_feeref: { path: "/master/feeref", label: "加工费参考价", roles: ["purchasing", "pmc", "finance"], group: "master", scopedMode: "denied" },
  report_data_health: { path: "/report/data-health", label: "主数据健康度", group: "master", scopedMode: "public", keywords: "health jiankang zhiliang quality" },
  master_supply_params: { path: "/master/supply-params", label: "周期主数据补录", roles: ["pmc", "purchasing"], group: "master", scopedMode: "denied", keywords: "supply params lead time zhouqi bulu 周期 补录" },

  /* ── 数据中心 ── */
  import_upload: { path: "/import/upload", label: "文件上传", roles: ["pmc", "finance"], group: "import", scopedMode: "denied", keywords: "upload import shangchuan" },
  import_release: { path: "/import/release", label: "导入放行", roles: ["pmc", "finance"], group: "import", scopedMode: "denied", keywords: "release import fangxing" },
  import_jobs: { path: "/import/jobs", label: "导入任务", roles: ["pmc", "finance"], group: "import", scopedMode: "denied" },
  import_exceptions: { path: "/import/exceptions", label: "编码别名认领", roles: ["pmc", "purchasing", "warehouse"], group: "import", scopedMode: "denied" },
  review_checklist: { path: "/review/checklist", label: "复核清单与提醒", roles: ["pmc", "purchasing", "warehouse", "finance"], group: "import", scopedMode: "denied", keywords: "review fuhe checklist tixing" },
  report_exports: { path: "/report/exports", label: "导出任务", group: "import", scopedMode: "public" },

  /* ── 系统管理 ── */
  admin_users: { path: "/admin/users", label: "用户管理", roles: [], group: "admin", scopedMode: "denied", keywords: "users yonghu admin" },
  admin_audit: { path: "/admin/audit", label: "审计日志", roles: ["finance"], group: "admin", scopedMode: "denied" },
  admin_params: { path: "/admin/params", label: "运行参数", roles: ["pmc", "purchasing", "finance"], group: "admin", scopedMode: "denied", keywords: "params canshu" },
  // 空数组=仅管理员（同 /admin/users）：这是 maker-checker 闸本身的配置
  admin_approval_config: { path: "/admin/approval-config", label: "审批节点配置", roles: [], group: "admin", scopedMode: "denied" },
  admin_health: { path: "/admin/health", label: "运维面板", group: "admin", scopedMode: "denied", keywords: "health yunwei ops" },
} satisfies Record<string, RouteEntry>;

export type RouteKey = keyof typeof ROUTE_REGISTRY;

/** 侧栏顶层顺序（与 2026-09-03 之前 AppShell 硬编码 menuItems 完全一致） */
export const MENU_SECTIONS: readonly MenuSection[] = [
  { kind: "route", route: "workbench" },
  { kind: "route", route: "inbox" },
  { kind: "route", route: "todo" },
  { kind: "route", route: "goals" },
  { kind: "group", key: "messages", label: "消息与告警" },
  { kind: "group", key: "analytics", label: "经营分析" },
  { kind: "group", key: "planning", label: "计划与补货" },
  { kind: "group", key: "outsourcing", label: "委外生产" },
  { kind: "group", key: "matflow", label: "物料收发" },
  { kind: "group", key: "inventory", label: "库存" },
  { kind: "group", key: "quality", label: "质量与合规" },
  { kind: "group", key: "npd", label: "新品开发" },
  { kind: "group", key: "finance", label: "财务结算" },
  { kind: "group", key: "master", label: "主数据" },
  { kind: "group", key: "import", label: "数据中心" },
  { kind: "group", key: "admin", label: "系统管理" },
];

export interface RegisteredRoute extends RouteEntry {
  key: RouteKey;
}

/** 注册表按登记顺序展开（菜单顺序 = 登记顺序） */
export const ROUTE_ENTRIES: readonly RegisteredRoute[] = (Object.keys(ROUTE_REGISTRY) as RouteKey[]).map((key) => ({
  key,
  ...(ROUTE_REGISTRY[key] as RouteEntry),
}));

/** 角色可见性：admin 恒通过；roles 缺省 = 全员；[] = 仅管理员 */
export function isRouteVisible(entry: Pick<RouteEntry, "roles">, roles: readonly string[]): boolean {
  if (roles.includes("admin")) return true;
  if (entry.roles === undefined) return true;
  return entry.roles.some((r) => roles.includes(r));
}

/** 等价于旧 AppShell.MENU_ROLES：只列出登记了 roles 的路径 */
export function menuRolesFromRegistry(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const e of ROUTE_ENTRIES) if (e.roles !== undefined) out[e.path] = [...e.roles];
  return out;
}

export interface MenuLeaf {
  key: string;
  label: string;
  routeKey: RouteKey;
}
export type MenuNode =
  | (MenuLeaf & { kind: "route" })
  | { kind: "group"; key: Exclude<RouteGroup, "top">; label: string; children: MenuLeaf[] };

/**
 * 按角色过滤后的侧栏树（不含图标；AppShell 按 group/route key 贴图标）。
 * 与旧 filterMenuByRoles 语义一致：分组内无可见子项则整组不渲染。
 */
export function buildMenuTree(roles: readonly string[]): MenuNode[] {
  const out: MenuNode[] = [];
  for (const s of MENU_SECTIONS) {
    if (s.kind === "route") {
      const e = ROUTE_REGISTRY[s.route] as RouteEntry;
      if (isRouteVisible(e, roles)) out.push({ kind: "route", key: e.path, label: e.label, routeKey: s.route });
      continue;
    }
    const children = ROUTE_ENTRIES.filter((e) => e.group === s.key && isRouteVisible(e, roles)).map((e) => ({
      key: e.path,
      label: e.label,
      routeKey: e.key,
    }));
    if (children.length === 0) continue;
    out.push({ kind: "group", key: s.key, label: s.label, children });
  }
  return out;
}

export interface PalettePage {
  label: string;
  href: string;
  keywords: string;
  roles?: readonly string[];
}

/** 命令面板页面表：登记了 keywords 的条目，按登记顺序 */
export const PALETTE_PAGES: readonly PalettePage[] = ROUTE_ENTRIES.filter((e) => e.keywords !== undefined).map((e) => ({
  label: e.label,
  href: e.path,
  keywords: e.keywords as string,
  roles: e.roles,
}));

const stripQuery = (p: string): string => {
  const i = p.indexOf("?");
  return i >= 0 ? p.slice(0, i) : p;
};

/** 按路径（忽略 query）找第一条登记项；`/report/demand` 命中 planning 那条而非 `?tab=stock_summary` 变体 */
export function routeByPath(pathname: string): RegisteredRoute | null {
  const p = stripQuery(pathname);
  for (const e of ROUTE_ENTRIES) if (stripQuery(e.path) === p) return e;
  return null;
}

/** 导航分组（精确路径命中）；顶层项与未登记路径返回 null，由 AppShell 的前缀规则兜底 */
export function routeGroupForPath(pathname: string): Exclude<RouteGroup, "top"> | null {
  const e = routeByPath(pathname);
  if (!e || e.group === "top") return null;
  return e.group;
}

/** D62 裁剪口径（下一波页面据此过滤）；未登记路径返回 null */
export function scopedModeForPath(pathname: string): ScopedMode | null {
  return routeByPath(pathname)?.scopedMode ?? null;
}
