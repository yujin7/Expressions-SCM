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

/** null 表示读取的是当前状态/主档，非历史快照；有门限的事实必须提供可比较业务时点。 */
export const SCM_EVIDENCE_MAX_AGE_DAYS: Record<ScmEvidenceKey, number | null> = {
  "sku-master": null,
  "sku-identifiers": null,
  "sales-history": 62,
  "stock-ledger": 2,
  "stock-balances": null,
  "purchase-order-lines": null,
  "receipt-lines": 35,
  "sku-costs": 35,
  "supplier-master": null,
  "quality-inspections": 180,
  "sku-planning-params": 180,
  "npd-projects": null,
  "npd-tasks": 30,
  "reconciliation-diffs": 2,
  "planning-lines": 8,
  "sop-cycles": 35,
};
