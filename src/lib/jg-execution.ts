/** Display-only interpretation of existing JG facts; never changes workflow or receipt quantities. */
export interface JgExecutionFacts {
  status: string;
  inProduction?: boolean;
  urgentFlag?: boolean;
  isPaused?: boolean;
}

export function jgExecutionView(facts: JgExecutionFacts) {
  const terminal = ["completed", "closed", "void"].includes(facts.status);
  const known = ["draft", "pending", "approved", "in_progress"].includes(facts.status) || terminal;
  let phase = "状态待核对";
  let warning = !known;
  let explanation = "无法识别当前单据状态，请先核对来源单据，不能推断生产进度。";
  if (terminal) {
    phase = facts.status === "completed" ? "流程已完成" : facts.status === "closed" ? "流程已关闭" : "单据已作废";
    explanation = "流程已结束，历史加工确认标记不表示当前仍在生产，也不能据此判断从未开始。实际收货、质检与入库数量请核对单据链。";
  } else if (known) {
    const active = facts.status === "in_progress";
    warning = facts.inProduction === undefined || (active ? !facts.inProduction : facts.inProduction);
    if (warning) {
      phase = "确认信息待核对";
      explanation = "单据状态与加工确认标记缺失或不一致。请核对确认记录及来源工单，不把它解释为未开始或真实生产进度。";
    } else {
      phase = facts.status === "draft" ? "待提交" : facts.status === "pending" ? "待审批"
        : active ? "已确认加工" : "待加工确认";
      explanation = active ? "系统已登记加工厂确认；这是流程确认口径，不是现场开工、完工或已收货数量。请继续核对收货与质检。"
        : "按单据流程显示下一环节；未登记加工厂确认不等于已核实工厂尚未开工。";
    }
  }
  const historical = terminal || !known;
  const flags: { text: string; color: "default" | "red" | "orange" }[] = [];
  if (facts.urgentFlag) flags.push({ text: historical ? "历史加急" : "计划加急", color: historical ? "default" : "red" });
  if (facts.isPaused) flags.push({ text: historical ? "历史暂停" : "计划暂停", color: historical ? "default" : "orange" });
  return { terminal, phase, warning, flags, explanation,
    flagExplanation: historical ? "保留原计划标记供追溯，不作为当前催单或暂停信号。"
      : "加急/暂停由计划人员登记，不是自动逾期判断，也不是工厂实时状态。" };
}
