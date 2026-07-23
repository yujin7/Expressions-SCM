import { pgEnum } from "drizzle-orm/pg-core";

/** 统一单据状态机（《01》§4）：草稿→待审批→已审批→执行中→已完成/已关闭/已作废 */
export const docStatusEnum = pgEnum("doc_status", [
  "draft", // 草稿
  "pending", // 待审批
  "approved", // 已审批（PO/JG 需供应商确认后才进入 in_progress）
  "in_progress", // 执行中
  "completed", // 已完成
  "closed", // 已关闭（短关，留原因，可管理员重开）
  "void", // 已作废
]);

export const skuTypeEnum = pgEnum("sku_type", ["finished", "raw", "packaging"]); // 成品/原料/包材

export const warehouseKindEnum = pgEnum("warehouse_kind", [
  "finished", // 成品仓
  "raw", // 原料仓
  "packaging", // 包材仓
  "outsource", // 委外仓（按供应商，允许负余额=垫料）
  "transit", // 调拨在途（虚拟仓）
  "snapshot", // 快照仓：保税/E/云（1.1 启用）
]);

export const accountingModeEnum = pgEnum("accounting_mode", ["realtime", "snapshot"]);

export const supplierStatusEnum = pgEnum("supplier_status", ["pending", "qualified", "blacklisted"]);

export const bomStatusEnum = pgEnum("bom_status", ["draft", "active", "retired"]);

/** PO 行类型——加工费不进 PO（《00》A4），应付以 JS 为唯一载体 */
export const poLineTypeEnum = pgEnum("po_line_type", ["raw", "packaging"]);

/** 收货行类型（《01》§3 SH）：返工重交冲抵不合格不占累计；备品不占 JG 数量 */
export const shLineTypeEnum = pgEnum("sh_line_type", ["normal", "rework", "spare"]);

/** 不合格三路径 */
export const qcHandlingEnum = pgEnum("qc_handling", ["pending", "rework", "concession", "scrap"]);

export const pcTargetEnum = pgEnum("pc_target", ["po_line", "jg_fee"]);
export const pcScopeEnum = pgEnum("pc_scope", ["unreceived_only", "retroactive"]); // 生效范围

/** 库存单据子类型 = 过账表的唯一入口清单（《01》§4） */
export const stockDocSubtypeEnum = pgEnum("stock_doc_subtype", [
  "purchase_in", // 采购入
  "outsource_in", // 委外入
  "outsource_in_spare", // 委外入-备品（零成本+对冲池）
  "sales_out", // 销售出（聚水潭导入/手工）
  "issue_out", // 领料出
  "transfer", // 调拨
  "opening", // 期初
  "count_adjust", // 盘盈亏（1.1）
  "reversal", // 红字冲销（引用原单，负数流水）
  "loss_writeoff", // 损耗核销（JS 审批触发）
  "transit_writeoff", // 调拨核销（快照仓到仓确认）
]);

export const offsetPoolKindEnum = pgEnum("offset_pool_kind", ["spare", "loss", "resend"]); // 备品/损耗/补送

export const approvalActionEnum = pgEnum("approval_action", ["approve", "reject"]);

export const tlReasonEnum = pgEnum("tl_reason", ["surplus_return", "defect_exchange"]); // 剩料退回/不合格料退换

export const importStatusEnum = pgEnum("import_status", ["pending", "validating", "failed", "done"]);

export const reconStatusEnum = pgEnum("recon_status", ["open", "explained", "resolved"]);

/** 货品生命周期（字段枚举权威 4 态；《04》§2.A 行为矩阵）。两段迁移：DW1 建列，行为切换随 DW2 */
export const skuLifecycleEnum = pgEnum("sku_lifecycle", ["on_sale", "trial", "halted", "retired"]);
