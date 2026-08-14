/**
 * E7-01 预聚合层（物化汇总）+ R7 迁移批次的若干结构补齐。
 *
 * ── 立项理由的订正（2026-07-25）──
 * 本层最初的理由写的是「BI 报表实时扫全表、靠 60 秒进程内缓存硬撑」。
 * 事后核实：那个「60s 缓存」（report/auto-replenish.ts）**从未生效**——只有读取没有赋值；
 * 提交信息里的 15× 提速是同进程 call#1 与 call#2 之差。实测三支被怀疑慢的报表
 * 分别是 32ms / 105ms / 23ms（1026 在售成品），**根本不存在要解决的性能问题**。
 * 据此保留的只有 `rollup_supplier_lead`——它有真实读取方（补货安全库存的交期波动项），
 * 且那个计算确实不宜放进热路径（需逐 SKU 扫收货历史）。
 * 另两张（sku_month / warehouse_sku）建了 8 轮、零读取方，已随迁移 0018 删除；
 * 汇总表是派生数据、可随时重建，将来真有性能证据再加回来（先按 skill `measure-first` 拿基线）。
 *
 * ── 纪律 ──
 * - 汇总表是**派生数据**，可随时全量重建；绝不作为业务真相来源（真相仍在台账/单据）。
 * - 每张表带 `builtAt`，页面必须能显示"数据截至"，不得让用户误以为是实时值。
 * - 重建幂等：按自然键 upsert，重跑不产生重复行。
 */
import {
  pgTable, serial, integer, text, timestamp, numeric, date, boolean, unique, index, check, jsonb,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { skus, suppliers, warehouses, users } from "./masters";

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

/**
 * 外部观察型 BI 的可重建读模型缓存。
 *
 * staging 永远是证据权威；本表只保存经过门禁计算后的最终读模型和精确来源批次绑定。
 * 连接器每次成功刷新后重建，页面只读匹配当前绑定的缓存，避免在请求热路径重复解析
 * 10 万级 JSON staging。来源批次变化时旧缓存自动失效，绝不以旧值冒充当前值。
 */
export const reportReadModelCache = pgTable("report_read_model_cache", {
  key: text("key").primaryKey(),
  sourceBinding: text("source_binding").notNull(),
  payload: jsonb("payload").$type<unknown>().notNull(),
  builtAt: timestamp("built_at", { withTimezone: true }).notNull().defaultNow(),
});

/* ────────────────────────── E4-02 库位（bin） ────────────────────────── */

/**
 * 库位主数据。仓库粒度到 warehouse 为止时，盘点/找货/临期隔离全靠仓管脑内地图。
 * 仓库台账仍是唯一财务真相；`bin_balances/bin_movements` 是受总账余额约束的定位子账。
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
}, (t) => [
  unique("uq_bin_wh_code").on(t.warehouseId, t.code),
  check("ck_bin_kind", sql`${t.kind} IN ('normal', 'quarantine', 'staging')`),
]);

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
