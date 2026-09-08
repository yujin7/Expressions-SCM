/**
 * E8-05 审计事件分类法（解释层）。
 *
 * 问题：`audit_logs.action` 是自由字符串，随手起名（draft_bh / register_batch / gen_confirm_token…）。
 * 事件命名不标准，流程挖掘（E3-07）挖出来的就是噪音。
 *
 * ── 本模块是解释层，不改写历史数据 ──
 * 历史 action 字符串一律保持原样；本表把它们**映射**为规范名（域.对象.动作）与中文标签。
 * 新代码应逐步改用 canonical 命名，但存量不迁移（改历史审计=毁证据链）。
 *
 * ── 为什么 fallback 是必需而非防御性冗余 ──
 * 本系统的 action 有三类**动态来源**，任何静态清单都不可能穷举：
 *  1. 单据审批路径把 `v.action` 直接透传 writeAudit（bh/wo/jg/po/pc/sh/fl/tl/ct/pd/stock-doc/js 共 12 处），
 *     `docflow/approval.ts` 将其类型化为 "approve" | "reject" —— **reject 不在任何字面量里**；
 *  2. `review/checklist.ts` 计算出 review_done / review_overrule / review_reopen；
 *  3. 导入、任务、集成等扩展模块会按连接器/动作生成新的 action 字符串。
 * 因此 `classifyEvent` **绝不抛错**：未登记一律降级为 system 域 + 原文标签。
 * 分类法若成为新的故障源，就会让审计写入本身失败——那是比分类不全严重得多的问题。
 */

export type EventDomain = "doc" | "master" | "plan" | "data" | "system";

export interface EventDef {
  action: string;
  domain: EventDomain;
  /** 中文标签（用户可见） */
  label: string;
  /** 规范名：域.对象.动作 */
  canonical: string;
  /** 是否是单据状态流转（流程挖掘只关心这类） */
  isStateChange: boolean;
}

const DOMAIN_LABEL: Record<EventDomain, string> = {
  doc: "单据",
  master: "主数据",
  plan: "计划",
  data: "数据",
  system: "系统",
};

/** action → 定义（不含 entity；canonical 由 canonicalOf 结合 entity 生成） */
interface CatalogEntry {
  domain: EventDomain;
  label: string;
  verb: string;
  isStateChange: boolean;
}

const CATALOG: Record<string, CatalogEntry> = {
  /* ── 单据状态流转（流程挖掘的核心事件） ── */
  create: { domain: "doc", label: "创建", verb: "create", isStateChange: true },
  submit: { domain: "doc", label: "提交审批", verb: "submit", isStateChange: true },
  approve: { domain: "doc", label: "审批通过", verb: "approve", isStateChange: true },
  reject: { domain: "doc", label: "驳回", verb: "reject", isStateChange: true },
  confirm: { domain: "doc", label: "确认", verb: "confirm", isStateChange: true },
  complete: { domain: "doc", label: "完成", verb: "complete", isStateChange: true },
  close: { domain: "doc", label: "关闭", verb: "close", isStateChange: true },
  withdraw: { domain: "doc", label: "撤回", verb: "withdraw", isStateChange: true },
  void: { domain: "doc", label: "作废", verb: "void", isStateChange: true },
  short_close: { domain: "doc", label: "短关", verb: "shortClose", isStateChange: true },
  period_close: { domain: "system", label: "会计期间关账", verb: "periodClose", isStateChange: true },
  period_reopen: { domain: "system", label: "会计期间重开", verb: "periodReopen", isStateChange: true },
  quarantine: { domain: "doc", label: "隔离", verb: "quarantine", isStateChange: false },
  accept: { domain: "doc", label: "接收", verb: "accept", isStateChange: true },
  inbound: { domain: "doc", label: "入库", verb: "inbound", isStateChange: true },
  post: { domain: "doc", label: "过账", verb: "post", isStateChange: true },
  post_and_complete: { domain: "doc", label: "过账并完成", verb: "postComplete", isStateChange: true },
  writeoff: { domain: "doc", label: "核销", verb: "writeoff", isStateChange: true },
  reverse_create: { domain: "doc", label: "红字冲销", verb: "reverse", isStateChange: true },
  spare_in: { domain: "doc", label: "备品入库", verb: "spareIn", isStateChange: true },
  delete: { domain: "doc", label: "删除", verb: "delete", isStateChange: true },
  update: { domain: "doc", label: "修改", verb: "update", isStateChange: false },
  update_status: { domain: "doc", label: "状态变更", verb: "updateStatus", isStateChange: true },
  update_counts: { domain: "doc", label: "录入盘点数", verb: "updateCounts", isStateChange: false },
  revise_due: { domain: "doc", label: "修改交期", verb: "reviseDue", isStateChange: false },
  fee_change: { domain: "doc", label: "加工费变更", verb: "feeChange", isStateChange: false },
  plan_update: { domain: "doc", label: "计划调整", verb: "planUpdate", isStateChange: false },
  supplier_confirm: { domain: "doc", label: "供应商确认交期", verb: "supplierConfirm", isStateChange: true },
  gen_confirm_token: { domain: "doc", label: "生成供应商确认链接", verb: "genConfirmToken", isStateChange: false },

  /* ── 计划域（建议/自动链/NPD） ── */
  draft_bh: { domain: "plan", label: "由补货建议生成草稿", verb: "draftFromSuggestion", isStateChange: false },
  first_order_draft: { domain: "plan", label: "生成 NPD 首单草稿", verb: "draftFirstOrder", isStateChange: false },
  auto_wo: { domain: "plan", label: "自动建工单", verb: "autoWo", isStateChange: true },
  auto_wo_failed: { domain: "plan", label: "自动建工单失败", verb: "autoWoFailed", isStateChange: false },
  auto_jg_failed: { domain: "plan", label: "自动建加工单失败", verb: "autoJgFailed", isStateChange: false },
  batch_jg: { domain: "plan", label: "批量建加工单", verb: "batchJg", isStateChange: true },
  reschedule: { domain: "plan", label: "重排计划", verb: "reschedule", isStateChange: false },
  apply_leadtime_suggestion: { domain: "plan", label: "采纳交期建议", verb: "applyLeadtime", isStateChange: false },
  apply_scorecard_level: { domain: "plan", label: "采纳供应商评级", verb: "applyScorecardLevel", isStateChange: false },

  /* ── 主数据 ── */
  upsert: { domain: "master", label: "新增/更新", verb: "upsert", isStateChange: false },
  activate: { domain: "master", label: "启用", verb: "activate", isStateChange: false },
  activate_forced: { domain: "master", label: "强制启用", verb: "activateForced", isStateChange: false },
  regroup: { domain: "master", label: "重组归属", verb: "regroup", isStateChange: false },
  set_sku_code: { domain: "master", label: "设置 SKU 编码", verb: "setSkuCode", isStateChange: false },
  register: { domain: "master", label: "登记", verb: "register", isStateChange: false },
  follow_up: { domain: "master", label: "工作项跟进", verb: "followUp", isStateChange: false },
  register_batch: { domain: "master", label: "批量登记", verb: "registerBatch", isStateChange: false },
  change_password: { domain: "master", label: "修改密码", verb: "changePassword", isStateChange: false },
  bind_feishu_identity: { domain: "master", label: "绑定飞书身份", verb: "bindFeishuIdentity", isStateChange: false },
  unbind_feishu_identity: { domain: "master", label: "解绑飞书身份", verb: "unbindFeishuIdentity", isStateChange: false },

  /* ── 数据域（导入/放行/复核） ── */
  import: { domain: "data", label: "导入", verb: "import", isStateChange: false },
  upload: { domain: "data", label: "上传文件", verb: "upload", isStateChange: false },
  release: { domain: "data", label: "放行", verb: "release", isStateChange: false },
  record: { domain: "data", label: "登记真实结果", verb: "record", isStateChange: false },
  correct: { domain: "data", label: "纠正真实结果", verb: "correct", isStateChange: false },
  snapshot: { domain: "data", label: "快照", verb: "snapshot", isStateChange: false },
  claim: { domain: "data", label: "认领别名", verb: "claim", isStateChange: false },
  ignore: { domain: "data", label: "忽略", verb: "ignore", isStateChange: false },
  review_bulk: { domain: "data", label: "批量复核", verb: "reviewBulk", isStateChange: false },
  review_done: { domain: "data", label: "复核完成", verb: "reviewDone", isStateChange: false },
  review_overrule: { domain: "data", label: "复核驳回", verb: "reviewOverrule", isStateChange: false },
  review_reopen: { domain: "data", label: "复核重开", verb: "reviewReopen", isStateChange: false },
  feedback: { domain: "system", label: "用户反馈", verb: "feedback", isStateChange: false },

  /* ── 工作台例外（W9：打盹只影响展示，不改任何业务事实，故 isStateChange=false） ── */
  snooze: { domain: "system", label: "例外打盹", verb: "snooze", isStateChange: false },
  snooze_clear: { domain: "system", label: "取消例外打盹", verb: "snoozeClear", isStateChange: false },
};

/** 只读目录（供 UI 列出全部已登记事件） */
export const EVENT_CATALOG: Readonly<Record<string, CatalogEntry>> = CATALOG;

/** 已登记 action 数量（测试与运维面板用） */
export function catalogSize(): number {
  return Object.keys(CATALOG).length;
}

function normalizeEntity(entity: string): string {
  const e = String(entity ?? "").trim();
  return e === "" ? "unknown" : e;
}

/**
 * 分类一个审计事件。**永不抛错**——未登记的 action 降级为 system 域并保留原文，
 * 因为 action 有动态来源（见文件头），静态清单不可能穷举。
 */
export function classifyEvent(entity: string, action: string): EventDef {
  const a = String(action ?? "").trim();
  const ent = normalizeEntity(entity);
  const hit = CATALOG[a];
  if (hit) {
    return {
      action: a,
      domain: hit.domain,
      label: hit.label,
      canonical: `${hit.domain}.${ent}.${hit.verb}`,
      isStateChange: hit.isStateChange,
    };
  }
  return {
    action: a || "(空)",
    domain: "system",
    label: a || "(未命名事件)",
    canonical: `system.${ent}.${a || "unknown"}`,
    isStateChange: false,
  };
}

/** 规范名快捷方式 */
export function canonicalOf(entity: string, action: string): string {
  return classifyEvent(entity, action).canonical;
}

/** 域的中文名 */
export function domainLabel(d: EventDomain): string {
  return DOMAIN_LABEL[d] ?? String(d);
}

/** 是否为状态流转事件（流程挖掘只取这类） */
export function isStateChange(entity: string, action: string): boolean {
  return classifyEvent(entity, action).isStateChange;
}
