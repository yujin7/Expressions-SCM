import {
  pgTable, serial, text, integer, numeric, date, timestamp, boolean, unique, jsonb, index, check,
  type AnyPgColumn } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import {
  docStatusEnum, poLineTypeEnum, shLineTypeEnum, qcHandlingEnum,
  pcTargetEnum, pcScopeEnum, stockDocSubtypeEnum, tlReasonEnum,
} from "./enums";
import { skus, suppliers, warehouses, users } from "./masters";
import { boms } from "./bom";

/** 单据公共列（《01》§3）：doc_no 唯一、状态机、乐观锁、维度字段（B12 会议 BI 要求预置）
 *  必须是工厂函数——drizzle 列构建器不可跨表复用，否则约束命名冲突 */
const docColumns = () => ({
  docNo: text("doc_no").notNull().unique(),
  status: docStatusEnum("status").notNull().default("draft"),
  remark: text("remark"),
  company: text("company"),
  dept: text("dept"),
  project: text("project"),
  version: integer("version").notNull().default(1), // 乐观锁（R10）
  closedReason: text("closed_reason"), // 短关原因
  createdBy: integer("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/* ── 备货申请单 BH ───────────────────────────── */
export const bhDocs = pgTable("bh_docs", {
  id: serial("id").primaryKey(),
  ...docColumns(),
  purpose: text("purpose"),
  orderType: text("order_type"), // NPD 钩子（W3 集成补列——此前暂存 purpose）
});
export const bhLines = pgTable("bh_lines", {
  id: serial("id").primaryKey(),
  bhId: integer("bh_id").notNull().references(() => bhDocs.id),
  skuId: integer("sku_id").notNull().references(() => skus.id),
  qty: numeric("qty", { precision: 14, scale: 4 }).notNull(),
  expectDate: date("expect_date"),
});

/** Immutable receipt shared by manual and live-replenishment creation. */
export const bhCreateRequests = pgTable("bh_create_requests", {
  id: serial("id").primaryKey(),
  requestedBy: integer("requested_by").notNull().references(() => users.id),
  requestKey: text("request_key").notNull(),
  source: text("source").notNull(),
  requestHash: text("request_hash").notNull(),
  bhId: integer("bh_id").notNull().references(() => bhDocs.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [
  unique("uq_bh_create_request").on(t.requestedBy, t.requestKey),
  unique("uq_bh_create_request_doc").on(t.bhId),
  check("ck_bh_create_request_hash", sql`${t.requestHash} ~ '^[0-9a-f]{64}$'`),
  check("ck_bh_create_request_source", sql`${t.source} IN ('manual', 'replenish')`),
]);

/* ── 委外工单 WO ─────────────────────────────── */
export const woDocs = pgTable("wo_docs", {
  id: serial("id").primaryKey(),
  ...docColumns(),
  bhId: integer("bh_id").references(() => bhDocs.id),
  productSkuId: integer("product_sku_id").notNull().references(() => skus.id),
  qty: numeric("qty", { precision: 14, scale: 4 }).notNull(),
  supplierId: integer("supplier_id").notNull().references(() => suppliers.id), // 加工厂
  feeRatePlan: numeric("fee_rate_plan", { precision: 14, scale: 2 }).notNull(), // 计划参考价（结算取价=JG现价）
  orderType: text("order_type"), // NPD 钩子（05 §5）：常规备货/新品首单/紧急需求/N月备货（ORDER_TYPES）
  dueDate: date("due_date"),
  bomId: integer("bom_id").notNull().references(() => boms.id),
  // ── 04 §2 W3 增列批（合规审计补落）：包材齐套跟踪 + 计划属性 ──
  pkgRequiredDate: date("pkg_required_date"), // 包材需求日期
  pkgSupplierReplyDate: date("pkg_supplier_reply_date"), // 供应商回复日期
  pkgReadyDate: date("pkg_ready_date"), // 包材齐套日期
  pkgRefNos: jsonb("pkg_ref_nos"), // 关联包材采购单号数组
  urgentFlag: boolean("urgent_flag").notNull().default(false), // 紧急标记
  priority: text("priority"), // 优先级（高/中/低，展示用）
  isPaused: boolean("is_paused").notNull().default(false), // 暂停执行（挂起）
  revisedDates: jsonb("revised_dates"), // 交期修改历史 [{date, by, reason}]
});
/** WO 审批时按生效 BOM 快照复制（B15：引用≠快照，改版不影响本单）；含 R11 净需求建议 */
export const woLines = pgTable("wo_lines", {
  id: serial("id").primaryKey(),
  woId: integer("wo_id").notNull().references(() => woDocs.id),
  materialSkuId: integer("material_sku_id").notNull().references(() => skus.id),
  qtyPer: numeric("qty_per", { precision: 14, scale: 4 }).notNull(), // 净单位用量快照
  planLossRatePct: numeric("plan_loss_rate_pct", { precision: 5, scale: 2 }).notNull().default("0"),
  grossReq: numeric("gross_req", { precision: 14, scale: 4 }).notNull(), // 毛需求
  onHandAt: numeric("on_hand_at", { precision: 14, scale: 4 }).notNull().default("0"), // 生成时点可用
  inTransitAt: numeric("in_transit_at", { precision: 14, scale: 4 }).notNull().default("0"),
  suggestedQty: numeric("suggested_qty", { precision: 14, scale: 4 }).notNull(), // R11（MOQ/倍数取整后）
});

/** Immutable manual creation receipt. Business drafts may change; request identity must not. */
export const woCreateRequests = pgTable("wo_create_requests", {
  id: serial("id").primaryKey(),
  requestedBy: integer("requested_by").notNull().references(() => users.id),
  requestKey: text("request_key").notNull(),
  requestHash: text("request_hash").notNull(),
  woId: integer("wo_id").notNull().references(() => woDocs.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [
  unique("uq_wo_create_request").on(t.requestedBy, t.requestKey),
  unique("uq_wo_create_request_doc").on(t.woId),
  check("ck_wo_create_request_hash", sql`${t.requestHash} ~ '^[0-9a-f]{64}$'`),
]);

/** One automatic draft per original BH line, shared across users/devices/hooks. Never infer historical mappings. */
export const bhWoGenerations = pgTable("bh_wo_generations", {
  id: serial("id").primaryKey(),
  bhLineId: integer("bh_line_id").notNull().references(() => bhLines.id),
  sourceVersion: integer("source_version").notNull(),
  woId: integer("wo_id").notNull().references(() => woDocs.id),
  createdBy: integer("created_by").notNull().references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [
  unique("uq_bh_wo_generation_line").on(t.bhLineId),
  unique("uq_bh_wo_generation_wo").on(t.woId),
  check("ck_bh_wo_generation_version", sql`${t.sourceVersion} > 0`),
]);

/* ── 采购订单 PO（仅原料/包材行；加工费应付唯一载体=JS） ── */
export const poDocs = pgTable("po_docs", {
  id: serial("id").primaryKey(),
  ...docColumns(),
  woId: integer("wo_id").references(() => woDocs.id), // 可空=独立采购
  supplierId: integer("supplier_id").notNull().references(() => suppliers.id),
  expectedDate: date("expected_date"),
  // 供应商确认（内部代录，已审批→执行中的门；P1 供应商门户）
  confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
  confirmedBy: integer("confirmed_by").references(() => users.id),
  confirmNote: text("confirm_note"),
  // #13 供应商确认门户：不可猜 token（买手生成、外发链接），供应商凭链接确认交期
  confirmToken: text("confirm_token"),
  // struct#3 token 生命周期：过期时间 + 已用时间（确认即失效，防链接外泄后被反复改期）
  confirmTokenExpiresAt: timestamp("confirm_token_expires_at", { withTimezone: true }),
  confirmTokenUsedAt: timestamp("confirm_token_used_at", { withTimezone: true }),
});
export const poLines = pgTable("po_lines", {
  id: serial("id").primaryKey(),
  poId: integer("po_id").notNull().references(() => poDocs.id),
  skuId: integer("sku_id").notNull().references(() => skus.id),
  lineType: poLineTypeEnum("line_type").notNull(),
  purchaseUom: text("purchase_uom").notNull(),
  uomFactor: numeric("uom_factor", { precision: 14, scale: 4 }).notNull().default("1"),
  qty: numeric("qty", { precision: 14, scale: 4 }).notNull(), // 采购单位数量
  price: numeric("price", { precision: 14, scale: 2 }).notNull(), // 采购单位单价
  taxIncluded: boolean("tax_included").notNull().default(true),
  taxRatePct: numeric("tax_rate_pct", { precision: 5, scale: 2 }).notNull().default("13"),
  receivedQty: numeric("received_qty", { precision: 14, scale: 4 }).notNull().default("0"), // 基础单位累计已收（CT 回冲）
  // func#11 供应商按行回交期（同单不同物料交期不同）
  expectedDate: date("expected_date"),
});

/**
 * 采购承诺版本事件：每次有效承诺日改变只追加一行，禁止覆盖历史。
 *
 * 以 PO 行为粒度记录“有效承诺日”（行交期优先，否则继承表头）；迁移前遗留数据只能作为
 * legacy_backfill 当前快照，不能冒充原始承诺。未来简道云/聚水潭/用友只可作为独立来源事件
 * 或对照证据写入，不能直接覆盖 SCM 当前字段。
 */
export const poPromiseRevisions = pgTable("po_promise_revisions", {
  id: serial("id").primaryKey(),
  poId: integer("po_id").notNull().references(() => poDocs.id),
  poLineId: integer("po_line_id").notNull().references(() => poLines.id),
  sequence: integer("sequence").notNull(),
  previousDate: date("previous_date"),
  promisedDate: date("promised_date"),
  source: text("source").notNull(),
  actorType: text("actor_type").notNull(),
  recordedBy: integer("recorded_by").references(() => users.id),
  reason: text("reason"),
  externalSource: text("external_source"),
  externalRef: text("external_ref"),
  idempotencyKey: text("idempotency_key").notNull(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique("uq_po_promise_line_sequence").on(t.poLineId, t.sequence),
  unique("uq_po_promise_idempotency").on(t.idempotencyKey),
  index("ix_po_promise_po_occurred").on(t.poId, t.occurredAt),
  index("ix_po_promise_line_occurred").on(t.poLineId, t.occurredAt),
  check("ck_po_promise_sequence", sql`${t.sequence} > 0`),
  check(
    "ck_po_promise_source",
    sql`${t.source} IN ('supplier_confirm', 'buyer_revision', 'legacy_backfill', 'external_observation')`,
  ),
  check(
    "ck_po_promise_actor_type",
    sql`${t.actorType} IN ('supplier_token', 'internal_user', 'system_backfill', 'external_system')`,
  ),
  /**
   * 「一条修订 = 日期真的变了」——**除了承诺建立行**（C5）。
   *
   * 供应商第一次确认时，即使确认的日期与买手下单时预填的一模一样，也必须留一条行：
   * 不留就出现一个洗白缺口——确认 03-01（无行）→ 重发 token → 改到 03-30（成了第一条行）→
   * `rules/promise-basis` 把 03-30 当作「原始承诺」且标 trusted，03-28 到货算 OTIF 命中。
   * 承诺建立（sequence=1 且来源是供应商本人）因此是本约束的唯一例外；
   * 其余任何一条行仍必须代表一次**真实的改期**。
   */
  check(
    "ck_po_promise_date_changed",
    sql`${t.previousDate} IS DISTINCT FROM ${t.promisedDate}
      OR (${t.sequence} = 1 AND ${t.source} = 'supplier_confirm')`,
  ),
]);

/* ── 价格变更申请单 PC ──────────────────────── */
export const pcDocs = pgTable("pc_docs", {
  id: serial("id").primaryKey(),
  ...docColumns(),
  target: pcTargetEnum("target").notNull(),
  poLineId: integer("po_line_id").references(() => poLines.id),
  jgId: integer("jg_id"), // FK 加在下方 jgDocs 定义后由应用层保证
  oldPrice: numeric("old_price", { precision: 14, scale: 2 }).notNull(), // 基础单位未税基准价
  newPrice: numeric("new_price", { precision: 14, scale: 2 }).notNull(),
  deviationPct: numeric("deviation_pct", { precision: 7, scale: 2 }).notNull(),
  scope: pcScopeEnum("scope").notNull(), // 生效范围：仅未收/含已收追溯（A5）
});

/* ── 委外加工通知单 JG ──────────────────────── */
export const jgDocs = pgTable("jg_docs", {
  batchSeq: integer("batch_seq").notNull().default(1), // 批次序号（D33；既有单据=1）
  feeType: text("fee_type").notNull().default("OEM填充"), // D34（0724）：OEM填充/保税加工/保税仓操作费/其他
  id: serial("id").primaryKey(),
  ...docColumns(),
  woId: integer("wo_id").notNull().references(() => woDocs.id),
  supplierId: integer("supplier_id").notNull().references(() => suppliers.id),
  productSkuId: integer("product_sku_id").notNull().references(() => skus.id),
  qty: numeric("qty", { precision: 14, scale: 4 }).notNull(),
  dueDate: date("due_date"),
  feeRateCurrent: numeric("fee_rate_current", { precision: 14, scale: 2 }).notNull(), // 结算取价来源（PC 可改，分段计价）
  orderType: text("order_type"), // 同 WO（NPD 钩子）
  inProduction: boolean("in_production").notNull().default(false), // 生产中标记
  /** E4-05 工厂扫码回报：JG 打印带码，工厂扫码开公开页报开工/完工（复用供应商门户 token 模式） */
  reportToken: text("report_token"),
  reportTokenExpiresAt: timestamp("report_token_expires_at", { withTimezone: true }),
  confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
  confirmedBy: integer("confirmed_by").references(() => users.id),
  confirmNote: text("confirm_note"),
  // ── 04 §2 W3 增列批（合规审计补落）：包材齐套跟踪 + 计划属性 ──
  pkgRequiredDate: date("pkg_required_date"), // 包材需求日期
  pkgSupplierReplyDate: date("pkg_supplier_reply_date"), // 供应商回复日期
  pkgReadyDate: date("pkg_ready_date"), // 包材齐套日期
  pkgRefNos: jsonb("pkg_ref_nos"), // 关联包材采购单号数组
  urgentFlag: boolean("urgent_flag").notNull().default(false), // 紧急标记
  priority: text("priority"), // 优先级（高/中/低，展示用）
  isPaused: boolean("is_paused").notNull().default(false), // 暂停执行（挂起）
  revisedDates: jsonb("revised_dates"), // 交期修改历史 [{date, by, reason}]
}, (t) => [
  // D33 schema-first（0724 齐套自动触发链）：一 WO 多批——UNIQUE 升为 (woId, batchSeq)；既有单据 batchSeq=1
  unique("uq_jg_wo_batch").on(t.woId, t.batchSeq),
]);

/** JG 加工费分段（收货时点分段计价的依据；PC 追溯时重算段） */
export const jgFeeSegments = pgTable("jg_fee_segments", {
  id: serial("id").primaryKey(),
  jgId: integer("jg_id").notNull().references(() => jgDocs.id),
  rate: numeric("rate", { precision: 14, scale: 2 }).notNull(),
  effectiveFrom: timestamp("effective_from", { withTimezone: true }).notNull(),
});

/* ── 发料单 FL ──────────────────────────────── */
export const flDocs = pgTable("fl_docs", {
  id: serial("id").primaryKey(),
  ...docColumns(),
  jgId: integer("jg_id").notNull().references(() => jgDocs.id),
  fromWarehouseId: integer("from_warehouse_id").notNull().references(() => warehouses.id),
  toWarehouseId: integer("to_warehouse_id").notNull().references(() => warehouses.id), // 委外仓
});
export const flLines = pgTable("fl_lines", {
  id: serial("id").primaryKey(),
  flId: integer("fl_id").notNull().references(() => flDocs.id),
  skuId: integer("sku_id").notNull().references(() => skus.id),
  qty: numeric("qty", { precision: 14, scale: 4 }).notNull(),
  batchId: integer("batch_id"),
});

/* ── 委外退料单 TL（R5"退回量"唯一数据源） ───── */
export const tlDocs = pgTable("tl_docs", {
  id: serial("id").primaryKey(),
  ...docColumns(),
  jgId: integer("jg_id").notNull().references(() => jgDocs.id),
  fromWarehouseId: integer("from_warehouse_id").notNull().references(() => warehouses.id), // 委外仓
  toWarehouseId: integer("to_warehouse_id").notNull().references(() => warehouses.id),
});
export const tlLines = pgTable("tl_lines", {
  id: serial("id").primaryKey(),
  tlId: integer("tl_id").notNull().references(() => tlDocs.id),
  skuId: integer("sku_id").notNull().references(() => skus.id),
  qty: numeric("qty", { precision: 14, scale: 4 }).notNull(),
  batchId: integer("batch_id"),
  reason: tlReasonEnum("reason").notNull(),
});

/* ── 收货单 SH（分次；行类型 正常/返工重交/备品） ── */
export const shDocs = pgTable("sh_docs", {
  id: serial("id").primaryKey(),
  ...docColumns(),
  sourceType: text("source_type").notNull(), // 'po' | 'jg'
  sourceId: integer("source_id").notNull(),
  warehouseId: integer("warehouse_id").notNull().references(() => warehouses.id),
});
export const shLines = pgTable("sh_lines", {
  id: serial("id").primaryKey(),
  shId: integer("sh_id").notNull().references(() => shDocs.id),
  skuId: integer("sku_id").notNull().references(() => skus.id),
  // PO来源逐行身份；JG及尚未核实的历史SH为null，不自动分摊同SKU多行。
  poLineId: integer("po_line_id").references(() => poLines.id),
  lineType: shLineTypeEnum("line_type").notNull().default("normal"),
  expectedQty: numeric("expected_qty", { precision: 14, scale: 4 }),
  actualQty: numeric("actual_qty", { precision: 14, scale: 4 }).notNull(),
  batchNo: text("batch_no"),
  prodDate: date("prod_date"),
});

/* ── 检验记录 QC（收货必检后方可入库） ─────────── */
export const qcRecords = pgTable("qc_records", {
  id: serial("id").primaryKey(),
  shId: integer("sh_id").notNull().references(() => shDocs.id),
  conclusion: text("conclusion"),
  /**
   * W2 审计 3：检验不合格的**去向留痕**。此前 `qc_lines.fail_handling` 存了 rework/scrap
   * 却什么都不会发生——没有退货单、没有质量案件、没有扣款依据，不合格量就地蒸发。
   * 这两列是「这次检验最终怎么处理的」的正向链接（反向链接在 quality_cases.qc_record_id）。
   *
   * quality_case_id 的**外键**写在迁移 SQL 里、不写在 drizzle schema：
   * quality_cases 在 schema/quality.ts，而 quality.ts 已经 import 了本文件的 qcRecords，
   * 在此加 drizzle 引用会形成 import 环。唯一键则可以在这里声明。
   *
   * 两把唯一键是 `qc-outcome.ts` 里那道读-改-写守卫的数据库背书（2026-09-04 安全审计 S5）：
   * 一次检验只能挂一个质量案件、一张退货单。此前只有应用层「先查后写」，
   * 并发两次「登记不合格后果」会开出两个 QI 案件（两个单号、记分卡双计）与两张 CT 草稿，
   * 而只有一个被链回来——另一个成了没有出处的孤儿单。
   * NULL 在 Postgres 唯一键里互不相等，所以未挂接的检验记录可以有任意多条。
   */
  qualityCaseId: integer("quality_case_id"),
  returnCtId: integer("return_ct_id").references((): AnyPgColumn => ctDocs.id),
  createdBy: integer("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique("uq_qc_record_sh").on(t.shId),
  unique("uq_qc_record_quality_case").on(t.qualityCaseId),
  unique("uq_qc_record_return_ct").on(t.returnCtId),
]);
export const qcLines = pgTable("qc_lines", {
  id: serial("id").primaryKey(),
  qcId: integer("qc_id").notNull().references(() => qcRecords.id),
  shLineId: integer("sh_line_id").notNull().references(() => shLines.id),
  passQty: numeric("pass_qty", { precision: 14, scale: 4 }).notNull().default("0"),
  failQty: numeric("fail_qty", { precision: 14, scale: 4 }).notNull().default("0"),
  concessionQty: numeric("concession_qty", { precision: 14, scale: 4 }).notNull().default("0"), // 让步接收
  failHandling: qcHandlingEnum("fail_handling").notNull().default("pending"), // 退厂返工/让步/报废(红字)
}, (t) => [unique("uq_qc_line_receipt_line").on(t.qcId, t.shLineId)]);

/* ── 采购退货单 CT（B9：库存−、PO 已收数回冲） ── */
export const ctDocs = pgTable("ct_docs", {
  id: serial("id").primaryKey(),
  ...docColumns(),
  poId: integer("po_id").notNull().references(() => poDocs.id),
  warehouseId: integer("warehouse_id").notNull().references(() => warehouses.id),
});
export const ctLines = pgTable("ct_lines", {
  id: serial("id").primaryKey(),
  ctId: integer("ct_id").notNull().references(() => ctDocs.id),
  poLineId: integer("po_line_id").notNull().references(() => poLines.id),
  skuId: integer("sku_id").notNull().references(() => skus.id),
  qty: numeric("qty", { precision: 14, scale: 4 }).notNull(), // 基础单位
  batchId: integer("batch_id"),
  reason: text("reason"),
});

/* ── 库存单据（一张表，子类型+三前缀 RK/CK/DB；含红字/核销） ── */
export const stockDocs = pgTable("stock_docs", {
  id: serial("id").primaryKey(),
  ...docColumns(),
  subtype: stockDocSubtypeEnum("subtype").notNull(),
  sourceDocType: text("source_doc_type"), // 来源单据（红字=被冲原单）
  sourceDocId: integer("source_doc_id"),
  reversalOfId: integer("reversal_of_id"), // 红字：引用原 stock_doc
  reason: text("reason"), // R16 借调等业务原因（04 §2；渠道占用由逻辑仓表达，不加渠道字段）
  /** D60 调拨类型（仅 subtype=transfer 有意义；清单权威 `src/lib/transfer-types.ts`，存量单可空） */
  transferType: text("transfer_type"),
}, (t) => [
  check(
    "ck_stock_docs_transfer_type",
    sql`${t.transferType} IS NULL OR ${t.transferType} IN ('factory_to_warehouse', 'bonded_transfer', 'inter_warehouse', 'borrow', 'return_to_factory', 'other')`,
  ),
]);
export const stockDocLines = pgTable("stock_doc_lines", {
  id: serial("id").primaryKey(),
  stockDocId: integer("stock_doc_id").notNull().references(() => stockDocs.id),
  skuId: integer("sku_id").notNull().references(() => skus.id),
  warehouseId: integer("warehouse_id").notNull().references(() => warehouses.id),
  toWarehouseId: integer("to_warehouse_id").references(() => warehouses.id), // 调拨转入仓
  batchId: integer("batch_id"),
  qty: numeric("qty", { precision: 14, scale: 4 }).notNull(), // 正数；方向由子类型决定；红字存负
  price: numeric("price", { precision: 14, scale: 2 }),
});

/* ── 委外结算单 JS（1:1 于 JG；逐物料 js_line，R5） ── */
export const jsDocs = pgTable("js_docs", {
  id: serial("id").primaryKey(),
  ...docColumns(),
  jgId: integer("jg_id").notNull().references(() => jgDocs.id).unique(),
  goodQty: numeric("good_qty", { precision: 14, scale: 4 }).notNull(),
  concessionQty: numeric("concession_qty", { precision: 14, scale: 4 }).notNull().default("0"),
  spareQty: numeric("spare_qty", { precision: 14, scale: 4 }).notNull().default("0"),
  feePayable: numeric("fee_payable", { precision: 14, scale: 2 }).notNull(), // 分段合计
  concessionPrice: numeric("concession_price", { precision: 14, scale: 2 }).notNull().default("0"), // D6 审批
  deductionTotal: numeric("deduction_total", { precision: 14, scale: 2 }).notNull().default("0"),
  manualAdj: numeric("manual_adj", { precision: 14, scale: 2 }).notNull().default("0"), // 需审批留痕
  settleAmount: numeric("settle_amount", { precision: 14, scale: 2 }).notNull(),
});
export const jsLines = pgTable("js_lines", {
  id: serial("id").primaryKey(),
  jsId: integer("js_id").notNull().references(() => jsDocs.id),
  materialSkuId: integer("material_sku_id").notNull().references(() => skus.id),
  issuedQty: numeric("issued_qty", { precision: 14, scale: 4 }).notNull(), // 累计发料
  returnedQty: numeric("returned_qty", { precision: 14, scale: 4 }).notNull().default("0"), // 累计退料(TL)
  stdQty: numeric("std_qty", { precision: 14, scale: 4 }).notNull(), // 净标准用量=qtyPer×(合格+让步+备品)
  allowedLoss: numeric("allowed_loss", { precision: 14, scale: 4 }).notNull(),
  actualLoss: numeric("actual_loss", { precision: 14, scale: 4 }).notNull(),
  excessLoss: numeric("excess_loss", { precision: 14, scale: 4 }).notNull(), // 逐物料 max(0,·)，禁止轧差
  deductPrice: numeric("deduct_price", { precision: 14, scale: 2 }).notNull().default("0"), // 当月加权平均价
  deductAmount: numeric("deduct_amount", { precision: 14, scale: 2 }).notNull().default("0"),
});

/* ── 盘点单 PD（1.1；表结构预留） ─────────────── */
export const pdDocs = pgTable("pd_docs", {
  id: serial("id").primaryKey(),
  ...docColumns(),
  warehouseId: integer("warehouse_id").notNull().references(() => warehouses.id),
  mode: text("mode").notNull().default("full"), // full 定期全盘 / partial 抽盘
  /**
   * 盘点期（业务日期）。0727 会议行动项要「7 月底盘点期的小样库存明细」，
   * 而此前 pd_docs 只有 created_at——按创建时间筛等于按录入时间筛，
   * 补录/次月才录的盘点会落到错误的期间里。可空：存量单据没有这个事实，不臆造。
   */
  bizDate: date("biz_date"),
});
export const pdLines = pgTable("pd_lines", {
  id: serial("id").primaryKey(),
  pdId: integer("pd_id").notNull().references(() => pdDocs.id),
  skuId: integer("sku_id").notNull().references(() => skus.id),
  batchId: integer("batch_id"),
  bookQty: numeric("book_qty", { precision: 14, scale: 4 }).notNull(),
  countedQty: numeric("counted_qty", { precision: 14, scale: 4 }).notNull(),
  adjustDocId: integer("adjust_doc_id"), // 差异调整 stock_doc
});
