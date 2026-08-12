/**
 * 数据产品可引用的 SCM 内部事实键。键只说明“存在受控行”，不替代产品级口径、
 * 时效、控制总量或 UAT；所有自动化仍由数据产品门禁决定。
 */
export const SCM_EVIDENCE_LABEL = {
  "sku-master": "SKU 主档",
  "sku-identifiers": "SKU 身份标识",
  "sales-history": "正式销售历史",
  "stock-ledger": "库存流水",
  "stock-balances": "库存余额",
  "purchase-order-lines": "采购订单行",
  "receipt-lines": "收货行",
  "sku-costs": "SKU 成本",
  "supplier-master": "供应商主档",
  "quality-inspections": "质检明细",
  "sku-planning-params": "SKU 计划参数",
  "npd-projects": "新品项目",
  "npd-tasks": "新品任务",
  "reconciliation-diffs": "对账差异",
  "planning-lines": "计划版本行",
  "sop-cycles": "S&OP 周期",
} as const;

export type ScmEvidenceKey = keyof typeof SCM_EVIDENCE_LABEL;
