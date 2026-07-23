/**
 * 过账表（《01》§4）——doc-type→过账动作 的唯一权威映射。
 * 库存只能经本目录 post() 过账（CLAUDE.md）；防旁路 DoD 测试由此枚举生成。
 * post() 强制 isRegisteredSource()：未注册的 (sourceDocType, action) 一律拒绝。
 */
export const POSTING_REGISTRY: Record<string, { description: string; allowedActions: string[] }> = {
  sh_purchase_in: {
    description: "采购收货检验后入库：仓库 +合格数（让步另入+打标）",
    allowedActions: ["post"],
  },
  ct_return: {
    description: "采购退货 CT 审批：仓库 −；PO 已收数回冲",
    allowedActions: ["post"],
  },
  fl_issue: {
    description: "委外发料 FL 审批：自有仓 −，委外仓 +（每物料 from−/to+ 两行）",
    allowedActions: ["post"],
  },
  tl_return: {
    description: "委外退料 TL 审批（检验后）：委外仓 −，自有仓 +",
    allowedActions: ["post"],
  },
  sh_outsource_in: {
    description: "委外收货检验后入库：成品仓 +(合格+让步打标)；委外仓 − 净标准用量×(合格+让步+备品)",
    allowedActions: ["post"],
  },
  spare_in: {
    description: "备品入库：成品仓 +（子类型\"委外入-备品\"，零成本）+ 对冲池台账",
    allowedActions: ["post"],
  },
  js_loss_writeoff: {
    description: "JS 审批→损耗核销：委外仓 − 实际损耗；核销后该 JG 委外仓余额必须=0",
    allowedActions: ["post", "writeoff"],
  },
  issue_out: {
    description: "领料出库：自有仓 −（W2 集成新增——原稿遗漏，技术审计 #6 命中）",
    allowedActions: ["post"],
  },
  sales_out: {
    description: "销售出库（聚水潭导入/手工）审批：自有仓 −",
    allowedActions: ["post"],
  },
  transfer: {
    description: "调拨审批：转出仓 −，转入仓 +（out−/in+ 两行）；转入=快照仓时→调拨在途仓 +",
    allowedActions: ["post"],
  },
  opening: {
    description: "期初建账审批：±",
    allowedActions: ["post"],
  },
  count_adjust: {
    description: "盘盈亏调整审批（1.1）：±",
    allowedActions: ["post"],
  },
  reversal: {
    description: "红字冲销审批：原单流水取负（引用原单，审批留痕）",
    allowedActions: ["post"],
  },
  transit_writeoff: {
    description: "调拨核销：快照仓到仓确认后，调拨在途仓 −",
    allowedActions: ["post", "writeoff"],
  },
  /** reverse() 专用载体：红字冲销单（stock_doc, subtype=reversal），流水=原单取负 */
  stock_doc: {
    description: "红字冲销载体（reverse() 生成）：sourceDocId=红字单 id，action=reverse",
    allowedActions: ["reverse"],
  },
};

/** post() 强制的准入守卫：未注册的 (sourceDocType, action) 组合 → 拒绝过账 */
export function isRegisteredSource(sourceDocType: string, action: string): boolean {
  const entry = POSTING_REGISTRY[sourceDocType];
  if (!entry) return false;
  // 红字动作带被冲原单参数（reverse:<type>#<id>，防二次冲销）——按前缀准入
  if (action.startsWith("reverse:")) return entry.allowedActions.includes("reverse");
  return entry.allowedActions.includes(action);
}
