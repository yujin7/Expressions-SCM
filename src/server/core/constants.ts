/** 角色（《01》§6）。同角色内 is_approver=true 者为审批人；系统强制 审批人≠制单人 */
export const ROLES = ["ops", "purchasing", "warehouse", "quality", "pmc", "finance", "admin"] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  ops: "运营",
  purchasing: "采购",
  warehouse: "仓管",
  quality: "质量合规",
  pmc: "生产计划",
  finance: "财务",
  admin: "管理员",
};

/** 单据类型与编号前缀（R8：取号走 doc_counters，禁止 MAX+1） */
export const DOC_TYPES = {
  bh: "BH", // 备货申请单
  wo: "WO", // 委外工单
  po: "PO", // 采购订单
  pc: "PC", // 价格变更申请单
  jg: "JG", // 委外加工通知单
  fl: "FL", // 发料单
  tl: "TL", // 委外退料单
  sh: "SH", // 收货单
  ct: "CT", // 采购退货单
  rk: "RK", // 入库单（stock_doc）
  ck: "CK", // 出库单（stock_doc）
  db: "DB", // 调拨单（stock_doc）
  js: "JS", // 委外结算单
  pd: "PD", // 盘点单（1.1）
  ca: "CA", // 盘点差异调整单
  qi: "QI", // 质量事件/投诉/不良事件
  rc: "RC", // 召回案件
  ga: "GA", // 年度 GMP 自查
} as const;
export type DocType = keyof typeof DOC_TYPES;

/** R9 敏感字段黑名单（dto 唯一收口；运营/仓管不可见，含导出与 RSC 载荷） */
export const SENSITIVE_FIELDS = [
  "price", // 采购价/成本价
  "feeRatePlan", // 加工费计划单价
  "feeRateCurrent", // 加工费现价
  "feePayable", // 应付加工费
  "deductPrice", // 扣款单价
  "deductAmount", // 扣款额
  "deductionTotal",
  "settleAmount", // 结算金额
  "concessionPrice", // 让步单价
  "manualAdj",
  "amount", // offset_pool 金额
  "feeRate", // processing_fee_refs 加工费参考价
  "oldPrice", // PC 基准价
  "newPrice", // PC 新价
  "deviationPct", // PC 偏差（可反推价格）
  "taxRatePct", // 税率（RT4：与含税价互推，随价格同权限）
  "taxIncluded", // 含/未税标志（同上）
  "bankAccount", // 供应商银行账户（合规审计补落）
  "actualTransactionAmount", // 平台实际成交金额
  "totalSalesCost", // 平台销售总成本
  "estimatedGrossProfit", // 平台预估毛利
  "estimatedNetProfit", // 平台预估净利
  "salesAmount", // 月度销售金额（D53：默认仅 finance/admin/pmc 可见）
  "unitFee", // 调拨/加工单位费用（D60 成本基线；可反推价格）
] as const;

/** 可见敏感价格的角色（●）：采购/PMC/财务/管理员 */
export const PRICE_VISIBLE_ROLES: Role[] = ["purchasing", "pmc", "finance", "admin"];

/** sys_param 键 */
export const PARAM_KEYS = {
  priceTolerancePct: "price_tolerance_pct", // 价格异动容差，默认 3
  overReceiveTolerancePct: "over_receive_tolerance_pct", // 超收容差，默认 0
  lossRatePct: "loss_rate_pct", // 品类允许损耗率（scope=品类），包材=5
  concessionPriceRatio: "concession_price_ratio", // 让步默认价率，默认 100（D6 待财务确认）
  slowDaysThreshold: "slow_days_threshold", // 滞销警戒阈值（可销天数>N=滞销），默认 180（D39/0724会议）
  coverAlertDays: "cover_alert_days", // 断货预警阈值（可销天数<N），默认 30
  coverTargetDays: "cover_target_days", // 补货目标覆盖天数，默认 45
} as const;

/** 订单类型（NPD 钩子，05 §5；来源=在途表 下拉选项 订单类型）。N月备货以 "MONTH_STOCK:<n>" 形式存储 */
export const ORDER_TYPES = ["regular", "npd_first", "urgent", "month_stock"] as const;
export const ORDER_TYPE_LABELS: Record<string, string> = {
  regular: "常规备货",
  npd_first: "新品首单",
  urgent: "紧急需求",
  month_stock: "月备货",
};
