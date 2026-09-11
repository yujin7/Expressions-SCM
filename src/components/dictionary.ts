/**
 * E6-P2 全站术语与文案字典（唯一权威）。
 *
 * 背景（直觉性审计结论）：同一概念在不同页面有不同说法，用户要学好几遍——
 * - "参考"一词背着四种含义（在途参考=外部登记别当真 / 加工费参考价=计价基准要当真 /
 *   节点参考=只读标准 / 参考口径=不入账层）；
 * - "全网口径"(系统内所有仓，可信账面) 与 "全口径"(含系统外海外仓，文件参考) 一字之差、信任方向相反；
 * - "pending" 在 12 处 schema 里是四种意思（待审批/未开始/待发送/待校验），界面各自翻译；
 * - 同一动作四个名字（生成备货申请草稿/批量生成补货草稿/生成首单 BH/生成草稿）。
 *
 * 纪律：**新代码的用户可见文案必须引用本字典**，不得手写同义词。
 * 存量页面逐步迁移（改文案零风险，但需逐页人工核对上下文，故不做批量替换）。
 */

/* ────────────────────────── 一、口径与信任层级 ────────────────────────── */

/** 数据信任层级——决定用户该多信这个数字 */
export const TIER = {
  /** 过账台账/实时账：权威，可用于对账 */
  ledger: { label: "记账", full: "记账层（过账台账，权威可对账）", color: "#52c41a" },
  /** 期初/快照导入：时点权威 */
  snapshot: { label: "快照", full: "快照层（外部导入的时点数据，时点权威）", color: "#1677ff" },
  /** 外部文件登记：只提示不入账 */
  registry: { label: "登记", full: "登记层（外部文件登记，只提示不入账）", color: "#fa8c16" },
  /** 由上述计算得出 */
  derived: { label: "推导", full: "推导层（由上述数据计算得出）", color: "#8c8c8c" },
} as const;
export type TierKey = keyof typeof TIER;

/**
 * 库存口径命名——终结"全网 vs 全口径"的一字之差。
 * 规则：**系统内一律叫「系统库存」，系统外文件一律叫「外部登记库存」**，不再用"全网/全口径"。
 */
export const STOCK_SCOPE = {
  system: {
    label: "系统库存",
    hint: "本系统所有仓合计（实时记账账 + 快照仓最新快照）——可对账口径",
    tier: "ledger" as TierKey,
  },
  external: {
    label: "外部登记库存",
    hint: "总库存明细文件口径（含海外/其他部门仓，系统未接管）——只作核对参考，不入账",
    tier: "registry" as TierKey,
  },
  pipeline: {
    label: "全管道",
    hint: "系统库存与外部登记取高者 + 各类未结供给（PO在途/在制/存量单/在订）− 借出未还",
    tier: "derived" as TierKey,
  },
} as const;

/** 可销天数的三种口径——统一命名，避免三列同名 */
export const COVER_SCOPE = {
  system: { label: "可销天数（系统）", hint: "系统库存 ÷ 近3月日均销" },
  pipeline: { label: "可销天数（全管道）", hint: "全管道口径 ÷ 近3月日均销——含未结供给与外部登记" },
  file: { label: "可销天数（文件）", hint: "外部文件自带的计划可销天数，仅作交叉核对" },
} as const;

/* ────────────────────────── 二、状态词表（按域消歧） ────────────────────────── */

/** 单据状态（BH/WO/PO/PC/JG/SH/…）——唯一中文表 */
/** 单据状态中文（唯一数据源 = labels.DOC_STATUS_LABELS；此处仅作术语门面重导出） */
import { DOC_STATUS_LABELS } from "./labels";
export const DOC_STATUS = DOC_STATUS_LABELS;

/** 任务/节点状态（NPD 等）——与单据状态区分，避免 pending 歧义 */
export const TASK_STATUS: Record<string, string> = {
  pending: "未开始",
  doing: "进行中",
  done: "已完成",
  skipped: "已跳过",
};

/** 通知/告警状态 */
export const ALERT_STATUS: Record<string, string> = {
  pending: "待发送",
  sent: "已发送",
  skipped: "仅站内",
  failed: "发送失败",
  open: "待处理",
  resolved: "已解决",
};

/** 导入任务状态 */
export const IMPORT_STATUS: Record<string, string> = {
  pending: "待校验",
  validating: "校验中",
  failed: "校验失败",
  done: "已完成",
  superseded: "已被重导覆盖",
};

/** 严重度（终结通知页英文裸奔） */
export const SEVERITY: Record<string, { label: string; color: string }> = {
  critical: { label: "紧急", color: "#cf1322" },
  high: { label: "高", color: "#fa8c16" },
  medium: { label: "中", color: "#faad14" },
  info: { label: "提示", color: "#1677ff" },
};

/* ────────────────────────── 三、动作动词（同一动作全站同名） ────────────────────────── */

export const ACTION = {
  /** 所有"生成 BH 草稿"的入口统一叫这个——不再有四种说法 */
  createBhDraft: "生成备货草稿",
  createBhDraftHint: "生成的是草稿，不自动提交；提交与审批在备货申请页完成（人工闸）",
  approve: "通过",
  reject: "驳回",
  submit: "提交审批",
  registerDisposal: "登记处置",
  closeDisposal: "标记处置完成",
  adopt: "采纳",
  preview: "预演",
  export: "导出",
  /** 系统告警的人工关闭（必须带原因码，进 alert_events 台账）——与"标记处置完成"不是一回事 */
  closeAlert: "关闭",
  closeAlertHint: "带原因关闭并写入台账；不删除告警，条件仍成立时引擎下一轮会另开一条新告警",
  /** 控制塔例外「压后再看」统一叫打盹——不叫"忽略/隐藏/屏蔽"（那些听起来像永久删除） */
  snoozeException: "打盹",
  snoozeExceptionHint: "按日期压后，对所有人生效并写审计，到期自动恢复显示；只影响控制塔展示，不改告警/待办/单据",
  unsnoozeException: "取消打盹",
} as const;

/* ────────────────────────── 四、单据类型（代码↔中文，含流转顺序） ────────────────────────── */

export const DOC_TYPE: Record<string, { label: string; desc: string }> = {
  BH: { label: "备货申请", desc: "需求发起：运营/PMC 提出成品备货需求" },
  WO: { label: "委外工单", desc: "生产组织：按 BOM 快照对加工厂下达生产" },
  PO: { label: "采购订单", desc: "物料采购：原料/包材向供应商下单" },
  PC: { label: "价格变更", desc: "价格调整：采购价/加工费变更审批" },
  JG: { label: "加工通知单", desc: "加工批次：一张工单可拆多批加工" },
  FL: { label: "发料单", desc: "物料发出至加工厂" },
  TL: { label: "退料单", desc: "加工厂退回剩余物料" },
  SH: { label: "收货检验", desc: "成品/物料到货与质检" },
  CT: { label: "采购退货", desc: "不合格物料退回供应商" },
  RK: { label: "入库单", desc: "库存增加" },
  CK: { label: "出库单", desc: "库存减少" },
  DB: { label: "调拨单", desc: "仓间转移" },
  JS: { label: "结算单", desc: "加工费/货款结算" },
  PD: { label: "盘点单", desc: "账实核对与调整" },
};

/** 主链路流转顺序（用于流程图与 Stepper） */
export const MAIN_FLOW = ["BH", "WO", "JG", "SH"] as const;

/* ────────────────────────── 五、取词助手 ────────────────────────── */

export function docStatusLabel(s: string | null | undefined): string {
  return s ? (DOC_STATUS[s] ?? s) : "—";
}
export function taskStatusLabel(s: string | null | undefined): string {
  return s ? (TASK_STATUS[s] ?? s) : "—";
}
export function severityLabel(s: string | null | undefined): string {
  return s ? (SEVERITY[s]?.label ?? s) : "—";
}
export function severityColor(s: string | null | undefined): string {
  return s ? (SEVERITY[s]?.color ?? "#8c8c8c") : "#8c8c8c";
}
export function docTypeLabel(t: string | null | undefined): string {
  return t ? (DOC_TYPE[t.toUpperCase()]?.label ?? t) : "—";
}

/* ────────────────────────── 六、数据来源 / 目标来源 / 告警类别（驾驶舱、目标页、告警页） ────────────────────────── */

/** 数据来源就绪状态（data-source-readiness.state）——驾驶舱屏 1 表格 */
export const SOURCE_STATE: Record<string, { label: string; color: string }> = {
  operational: { label: "正式", color: "success" },
  observation: { label: "观察", color: "blue" },
  blocked: { label: "阻断", color: "error" },
  contract_only: { label: "仅契约", color: "default" },
};
export function sourceStateLabel(s: string | null | undefined): string {
  return s ? (SOURCE_STATE[s]?.label ?? "仅契约") : "—";
}
export function sourceStateColor(s: string | null | undefined): string {
  return s ? (SOURCE_STATE[s]?.color ?? "default") : "default";
}

/** 部门目标实际值来源（goals：actualSource × autoStatus） */
export const GOAL_SOURCE: Record<string, { label: string; color: string }> = {
  auto: { label: "自动取值", color: "blue" },
  manual: { label: "手工填报", color: "gold" },
  auto_pending: { label: "自动·来源未就绪", color: "default" },
  manual_pending: { label: "手工·待填报", color: "default" },
  withheld: { label: "金额·无权限", color: "default" },
};
export function goalSourceKey(actualSource: string | null | undefined, autoStatus: string | null | undefined): keyof typeof GOAL_SOURCE {
  // 金额型指标对非价格角色一律先判 withheld：值被服务端扣住（不是没取到、也不是待填）
  if (autoStatus === "withheld") return "withheld";
  if (actualSource === "auto") return "auto";
  if (actualSource === "manual") return "manual";
  return autoStatus === "unavailable" ? "auto_pending" : "manual_pending";
}

/** 角色中文（客户端可用；服务端权威在 core/constants.ROLE_LABELS） */
export const ROLE_LABEL: Record<string, string> = {
  ops: "运营", purchasing: "采购", warehouse: "仓管", quality: "质量合规", pmc: "生产计划", finance: "财务", admin: "管理员",
};
export function roleLabel(r: string | null | undefined): string {
  return r ? (ROLE_LABEL[r] ?? r) : "—";
}
