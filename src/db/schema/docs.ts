import {
  pgTable, serial, text, integer, numeric, date, timestamp, boolean, unique,
} from "drizzle-orm/pg-core";
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
});

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
  confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
  confirmedBy: integer("confirmed_by").references(() => users.id),
  confirmNote: text("confirm_note"),
}, (t) => [unique("uq_jg_wo").on(t.woId)]); // 一 WO 一 JG（W3 集成补约束，替代先查后插的并发窗口）

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
  createdBy: integer("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
export const qcLines = pgTable("qc_lines", {
  id: serial("id").primaryKey(),
  qcId: integer("qc_id").notNull().references(() => qcRecords.id),
  shLineId: integer("sh_line_id").notNull().references(() => shLines.id),
  passQty: numeric("pass_qty", { precision: 14, scale: 4 }).notNull().default("0"),
  failQty: numeric("fail_qty", { precision: 14, scale: 4 }).notNull().default("0"),
  concessionQty: numeric("concession_qty", { precision: 14, scale: 4 }).notNull().default("0"), // 让步接收
  failHandling: qcHandlingEnum("fail_handling").notNull().default("pending"), // 退厂返工/让步/报废(红字)
});

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
});
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
