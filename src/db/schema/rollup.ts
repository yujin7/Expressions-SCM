/**
 * E7-01 预聚合层（物化汇总）+ R7 迁移批次的若干结构补齐。
 *
 * ── 为什么要预聚合 ──
 * 当前每张 BI 报表都实时扫全表（自动补货页要扫两遍全部 SKU），靠 60 秒进程内缓存硬撑。
 * 夜间物化汇总后，BI 从"能看"变"秒开"，也是把**交期波动接进安全库存**的前提
 * （否则补货热路径上要为每个 SKU 扫一遍收货历史）。
 *
 * ── 纪律 ──
 * - 汇总表是**派生数据**，可随时全量重建；绝不作为业务真相来源（真相仍在台账/单据）。
 * - 每张表带 `builtAt`，页面必须能显示"数据截至"，不得让用户误以为是实时值。
 * - 重建幂等：按自然键 upsert，重跑不产生重复行。
 */
import {
  pgTable, serial, integer, text, timestamp, numeric, date, boolean, unique, index,
} from "drizzle-orm/pg-core";
import { skus, suppliers, warehouses, users } from "./masters";

/** SKU × 月 销量汇总（BI 趋势/瀑布/分层/预测回测的共同底表） */
export const rollupSkuMonth = pgTable("rollup_sku_month", {
  id: serial("id").primaryKey(),
  skuId: integer("sku_id").notNull().references(() => skus.id),
  yearMonth: text("year_month").notNull(), // YYYY-MM
  salesQty: numeric("sales_qty", { precision: 14, scale: 4 }).notNull().default("0"),
  /** 该月出库合计（台账口径，含调拨/盘亏等非销售出库） */
  outboundQty: numeric("outbound_qty", { precision: 14, scale: 4 }).notNull().default("0"),
  /** 该月入库合计 */
  inboundQty: numeric("inbound_qty", { precision: 14, scale: 4 }).notNull().default("0"),
  builtAt: timestamp("built_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique("uq_rollup_sku_month").on(t.skuId, t.yearMonth),
  index("ix_rollup_sku_month_ym").on(t.yearMonth),
]);

/** 仓 × SKU 在库汇总（驾驶舱/调拨建议/库存分析的共同底表） */
export const rollupWarehouseSku = pgTable("rollup_warehouse_sku", {
  id: serial("id").primaryKey(),
  warehouseId: integer("warehouse_id").notNull().references(() => warehouses.id),
  skuId: integer("sku_id").notNull().references(() => skus.id),
  onHand: numeric("on_hand", { precision: 14, scale: 4 }).notNull().default("0"),
  /** 该仓该 SKU 近 90 天出库（调拨建议的需求代理信号） */
  outbound90d: numeric("outbound_90d", { precision: 14, scale: 4 }).notNull().default("0"),
  builtAt: timestamp("built_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [unique("uq_rollup_wh_sku").on(t.warehouseId, t.skuId)]);

/**
 * 供应商 × SKU 交期统计（E2-04 交期学习的物化结果）。
 * **关键用途**：把 `leadStdevDays` 接进安全库存（rules/safety-stock 的 leadDaysStdev 参数），
 * 让交期波动真正参与计算——此前因热路径开销未接入。
 */
export const rollupSupplierLead = pgTable("rollup_supplier_lead", {
  id: serial("id").primaryKey(),
  supplierId: integer("supplier_id").notNull().references(() => suppliers.id),
  skuId: integer("sku_id").notNull().references(() => skus.id),
  samples: integer("samples").notNull().default(0),
  leadP50Days: numeric("lead_p50_days", { precision: 8, scale: 2 }),
  leadP90Days: numeric("lead_p90_days", { precision: 8, scale: 2 }),
  /** 交期标准差（天）——安全库存的交期波动项 */
  leadStdevDays: numeric("lead_stdev_days", { precision: 8, scale: 2 }),
  onTimeRate: numeric("on_time_rate", { precision: 5, scale: 4 }),
  builtAt: timestamp("built_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique("uq_rollup_supplier_lead").on(t.supplierId, t.skuId),
  index("ix_rollup_lead_sku").on(t.skuId),
]);

/* ────────────────────────── E4-02 库位（bin） ────────────────────────── */

/**
 * 库位主数据。仓库粒度到 warehouse 为止时，盘点/找货/临期隔离全靠仓管脑内地图。
 * v1 只做**登记与归属**（库位清单、类型、状态），不改过账口径——
 * 库位级余额需与 FEFO/批次一并设计，属独立改动。
 */
export const bins = pgTable("bins", {
  id: serial("id").primaryKey(),
  warehouseId: integer("warehouse_id").notNull().references(() => warehouses.id),
  code: text("code").notNull(), // 库位编码，如 A-01-03
  name: text("name"),
  /** normal=普通存储 / quarantine=隔离位（临期/待检/待报废） / staging=暂存 */
  kind: text("kind").notNull().default("normal"),
  active: boolean("active").notNull().default(true),
  remark: text("remark"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [unique("uq_bin_wh_code").on(t.warehouseId, t.code)]);

/* ────────────────────────── E5-01/E5-02 审批路由与委托 ────────────────────────── */

/**
 * E5-01 审批分级路由：按金额/单据类型条件决定审批层级。
 * 现状是 `node=1` 单级——5 万件的 PO 和 50 件的 PO 走同一个审批人。
 * 本表登记规则；执行由服务层按 docType + 金额匹配最具体的一条。
 */
export const approvalRoutes = pgTable("approval_routes", {
  id: serial("id").primaryKey(),
  docType: text("doc_type").notNull(), // bh/wo/po/jg/js...
  /** 金额下限（含）——null=不限；匹配时取满足条件中门槛最高的一条 */
  minAmount: numeric("min_amount", { precision: 14, scale: 2 }),
  /** 该档需要的审批角色（按顺序逐级） */
  approverRoles: text("approver_roles").notNull(), // JSON 数组字符串，如 ["pmc","finance"]
  label: text("label").notNull(),
  active: boolean("active").notNull().default(true),
  createdBy: integer("created_by").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("ix_approval_route_doc").on(t.docType, t.active)]);

/**
 * E5-02 审批委托：审批人休假时把审批权临时转给他人。
 * 审批人不在流程就死——这是工作流引擎的基本件。
 */
export const approvalDelegations = pgTable("approval_delegations", {
  id: serial("id").primaryKey(),
  fromUserId: integer("from_user_id").notNull().references(() => users.id),
  toUserId: integer("to_user_id").notNull().references(() => users.id),
  startDate: date("start_date").notNull(),
  endDate: date("end_date").notNull(),
  reason: text("reason"),
  active: boolean("active").notNull().default(true),
  createdBy: integer("created_by").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("ix_delegation_from").on(t.fromUserId, t.active)]);
