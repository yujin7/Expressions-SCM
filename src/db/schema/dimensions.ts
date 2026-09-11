/**
 * DW1-core 维度层（《04》§2.1）：品牌/渠道主档 + 通用别名注册表 + 异常认领队列 + staging + 销量维度。
 *
 * 循环依赖决策：skus.brandId 位于 masters.ts，而 brands 定义在本文件；
 * 本文件已 import masters（salesMonthly FK skus）与 system（stagingRows FK import_jobs），
 * 若 masters 再 import 本文件即成环。故 skus.brandId 不加 .references()，
 * 作应用层外键（写入前由 service 校验 brands.id 存在）——见 masters.ts 注释。
 */
import {
  pgTable, serial, text, integer, boolean, date, timestamp, numeric, jsonb, unique, index,
} from "drizzle-orm/pg-core";
import { skus, users } from "./masters";
import { importJobs } from "./system";

/** 品牌主档（数据字典#5；种子 8 品牌见 seed-dimensions.ts） */
export const brands = pgTable("brands", {
  id: serial("id").primaryKey(),
  code: text("code").notNull().unique(), // 拉丁短码：NING/EXP/DEV/B2F/LYUV/ABS/DWS/WC
  nameCn: text("name_cn").notNull(),
  nameEn: text("name_en"),
  sortOrder: integer("sort_order").notNull().default(0),
  active: boolean("active").notNull().default(true),
});

export type ChannelKind = "platform" | "dept";

/** 渠道主档（平台渠道 + 部门渠道） */
export const channels = pgTable("channels", {
  id: serial("id").primaryKey(),
  code: text("code").notNull().unique(), // tmall/pdd/jd/vip/douyin/biz/private/brand/overseas/channel
  name: text("name").notNull(),
  kind: text("kind").$type<ChannelKind>().notNull(),
  active: boolean("active").notNull().default(true),
});

export type AliasType =
  | "warehouse"
  | "channel"
  | "sku_code"
  | "sku_barcode"
  | "supplier_oem"
  | "brand";

/**
 * 别名作用域。
 *
 * GLOBAL 只用于企业内通用别名；外部系统导入必须使用明确的系统作用域
 * （如 JST/JIANDAOYUN/YONYOU），避免不同系统恰好使用同一短码时串货。
 */
export const GLOBAL_ALIAS_SCOPE = "GLOBAL";

/**
 * 通用别名注册表（替代 warehouse_aliases/sku_aliases/supplier_aliases 分表方案）：
 * 一次认领，永久生效。rawValue 存 normalizeAliasText() 归一后的文本；
 * targetId 指向 aliasType 对应主档的 id（多态目标，应用层保证一致性）。
 */
export const aliases = pgTable("aliases", {
  id: serial("id").primaryKey(),
  aliasType: text("alias_type").$type<AliasType>().notNull(),
  scope: text("scope").notNull().default(GLOBAL_ALIAS_SCOPE),
  rawValue: text("raw_value").notNull(),
  targetId: integer("target_id").notNull(),
  note: text("note"),
  createdBy: integer("created_by").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [unique("uq_alias_type_scope_value").on(t.aliasType, t.scope, t.rawValue)]);

export type AliasExceptionStatus = "open" | "resolved" | "ignored";

/** 异常认领队列：解析不到的值进队（UNIQUE 保证同值只排一次），人工认领后写回 aliases */
export const aliasExceptions = pgTable("alias_exceptions", {
  id: serial("id").primaryKey(),
  aliasType: text("alias_type").$type<AliasType>().notNull(),
  scope: text("scope").notNull().default(GLOBAL_ALIAS_SCOPE),
  rawValue: text("raw_value").notNull(),
  context: jsonb("context"), // 来源文件/行 payload，便于人工裁决
  status: text("status").$type<AliasExceptionStatus>().notNull().default("open"),
  resolvedTargetId: integer("resolved_target_id"),
  resolvedBy: integer("resolved_by").references(() => users.id),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [unique("uq_alias_exc_type_scope_value").on(t.aliasType, t.scope, t.rawValue)]);

export type StagingRowStatus = "pending" | "validated" | "error" | "committed";

/** staging 层（《04》§4：staging 先行，绝不直写；按 importJobId 可整体回滚） */
export const stagingRows = pgTable("staging_rows", {
  id: serial("id").primaryKey(),
  importJobId: integer("import_job_id").notNull().references(() => importJobs.id),
  rowNo: integer("row_no").notNull(),
  payload: jsonb("payload").notNull(), // 标准化 JSON 行（含原文快照）
  status: text("status").$type<StagingRowStatus>().notNull().default("pending"),
  errorMsg: text("error_msg"),
  targetTable: text("target_table"), // 放行后写入的正式表
  targetId: integer("target_id"), // 放行后生成的正式记录 id
}, (t) => [index("ix_staging_job_status").on(t.importJobId, t.status)]);

/** 月销量（历史 2023–24 起；来源：销量汇总文件） */
export const salesMonthly = pgTable("sales_monthly", {
  id: serial("id").primaryKey(),
  skuId: integer("sku_id").notNull().references(() => skus.id),
  channelId: integer("channel_id").notNull().references(() => channels.id),
  yearMonth: text("year_month").notNull(), // 'YYYY-MM'
  qty: numeric("qty", { precision: 14, scale: 4 }).notNull(),
}, (t) => [unique("uq_sales_monthly").on(t.skuId, t.channelId, t.yearMonth)]);

/**
 * 销速快照（智能层输入）：channelId NULL = 全渠道汇总。
 *
 * ⚠️ **DEPRECATED — 休眠表，零读取方、零写入方（B9，2026-09-04 裁决）**。
 * 事实：全仓库唯一引用是 `tests/dimensions/resolver.test.ts` 在测它的 UNIQUE NULLS NOT DISTINCT 约束；
 * 日均销速一直由 `core/velocity.ts` 现算，没有任何代码写过这张表。
 * 处置选择「保留 + 标注废弃 + 加护栏」而不是「迁移删表」，理由（证据在 docs/NOW.md）：
 *   1. ~~生产从未取过本表的只读行数~~ → **2026-09-05 已核验：生产 `select count(*)` = 0 行**。
 *      当初「不敢删」的那个证据缺口已经补上；剩下的只是流程要求（出 D 号），不再是事实不明。
 *   2. 备份现状是**同主机可恢复性证据，不是异地灾备**（远端备份目标仍未配置），删错的代价不对称；
 *   3. 仓库既有裁决（docs/engineering/总监需求-现状映射与实施计划-2026-09-03.md 第 18 项）明确写
 *      「保持休眠、不写入，标记『废弃候选』待 D 号」——D 号未出，静默删表等于替业务裁决（CLAUDE.md 禁止）。
 * 因此：**任何新代码都不得读写本表**（销速唯一权威是 `core/velocity.ts`）；
 * 护栏 `tests/release/dead-table-sales-velocity.test.ts` 会在有人接线时变红。
 * 真要删表：行数核验已完成（0 行），只差业务出 D 号；出号后走迁移 + 同步删除本定义、
 * `tests/release/dead-table-sales-velocity.test.ts` 与 `tests/dimensions/resolver.test.ts` 里的约束测试。
 */
export const salesVelocity = pgTable("sales_velocity", {
  id: serial("id").primaryKey(),
  skuId: integer("sku_id").notNull().references(() => skus.id),
  channelId: integer("channel_id").references(() => channels.id), // null=全渠道
  avg7d: numeric("avg_7d", { precision: 14, scale: 4 }),
  avg90d: numeric("avg_90d", { precision: 14, scale: 4 }),
  computedOn: date("computed_on").notNull(),
}, (t) => [unique("uq_sales_velocity").on(t.skuId, t.channelId, t.computedOn).nullsNotDistinct()]);
