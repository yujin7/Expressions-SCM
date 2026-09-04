/**
 * D61 待办触发规则（纯函数）：把系统告警 / 复核项投影为「待办候选」。
 *
 * 只做投影不落库——落库、去重（fingerprint）、指派与 reopen 由 modules/todo/service.ts 负责。
 * fingerprint = `${sourceKind}:${sourceRef}`，与 work_items.source_kind + source_ref 一一对应，
 * 同一告警/复核项无论触发多少轮都只对应一条待办。
 *
 * 责任角色（ownerRole）口径：
 *  - system_alerts：按 category 查表；未知类别落 admin（与 system-alert-notify 的 alertAudience 同向）。
 *  - review_items：按 category 前缀查表；未知类别落 pmc（复核清单主责）。
 * 优先级：severity high/critical → high；medium → normal；其余 low。
 */
import type { Role } from "@/server/core/constants";

export type TodoPriority = "low" | "normal" | "high";
export type TodoSourceKind = "alert" | "review";

export interface AlertTriggerRow {
  id: number;
  category: string;
  refKey: string | null;
  title: string;
  detail: string | null;
  severity: string | null;
  /** 引擎参数快照；断货告警带 orderByDate（最晚下单日）→ 待办真实截止日（闭环审计 #9） */
  paramsSnapshot?: Record<string, unknown> | null;
}

export interface ReviewTriggerRow {
  id: number;
  category: string;
  refType: string | null;
  refKey: string | null;
  title: string;
  detail: string | null;
}

export interface TodoCandidate {
  /** 去重指纹：`${sourceKind}:${sourceRef}` */
  fingerprint: string;
  sourceKind: TodoSourceKind;
  sourceRef: string;
  title: string;
  detail: string | null;
  ownerRole: Role;
  priority: TodoPriority;
  href: string;
  /** 来源给出的真实截止日（YYYY-MM-DD，如断货告警的最晚下单日）；null = 落库时用优先级缺省表 {3,7,14} */
  dueDate: string | null;
}

/** 从 paramsSnapshot 取最晚下单日；非法/缺失 → null（回退缺省表，不臆造日期） */
export function dueDateFromParamsSnapshot(snapshot: unknown): string | null {
  const v = (snapshot as { orderByDate?: unknown } | null | undefined)?.orderByDate;
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
}

/**
 * 告警类别 → 责任角色（D56/D57/SSA-7：爆单/断货指向 pmc；运维类指向 admin）。
 *
 * **本表是责任角色的唯一权威**：看门狗（W1 后全部走 alerts/engine.upsertAlerts）按本表填
 * system_alerts.owner_role，待办投影、人工关闭权限（engine.closeAlert）与通知分派
 * （jobs/system-alert-notify）都读同一个值，不再各自硬编码。
 * data_quality 指向 pmc：与 weekly-dq-pack 飞书摘要的 targetRole=pmc 同向（核对包由 PMC 主责）。
 */
export const ALERT_OWNER_ROLE: Readonly<Record<string, Role>> = {
  data_freshness: "admin",
  doc_aging: "pmc",
  integration_token: "admin",
  job_failure: "admin",
  data_product_gate: "pmc",
  data_quality: "pmc",
  sales_spike: "pmc",
  inventory_cover: "pmc",
  transfer_cost: "warehouse",
  snapshot_quality: "admin",
};

/** 复核类别 → 责任角色（按前缀匹配，先长后短） */
export const REVIEW_OWNER_ROLE: ReadonlyArray<readonly [prefix: string, role: Role]> = [
  ["bom", "pmc"],
  ["spu", "pmc"],
  ["segment", "pmc"],
  ["shell_brand", "pmc"],
  ["blocked", "pmc"],
  ["supplier", "purchasing"],
  ["platform", "ops"],
  ["identity", "ops"],
  ["quality", "quality"],
  ["count", "warehouse"],
  ["finance", "finance"],
];

export function fingerprintOf(sourceKind: TodoSourceKind, sourceRef: string): string {
  return `${sourceKind}:${sourceRef}`;
}

export function priorityFromSeverity(severity: string | null | undefined): TodoPriority {
  const s = (severity ?? "").toLowerCase();
  if (s === "critical" || s === "high") return "high";
  if (s === "medium") return "normal";
  return "low";
}

export function alertOwnerRole(category: string): Role {
  return ALERT_OWNER_ROLE[category] ?? "admin";
}

export function reviewOwnerRole(category: string): Role {
  const c = category.toLowerCase();
  const hit = [...REVIEW_OWNER_ROLE]
    .sort((a, b) => b[0].length - a[0].length)
    .find(([prefix]) => c.startsWith(prefix));
  return hit ? hit[1] : "pmc";
}

/** system_alerts（open）→ 待办候选；sourceRef = 告警 id（稳定，refKey 可能为空） */
export function alertToCandidate(row: AlertTriggerRow): TodoCandidate {
  const sourceRef = String(row.id);
  return {
    fingerprint: fingerprintOf("alert", sourceRef),
    sourceKind: "alert",
    sourceRef,
    title: row.title,
    detail: row.detail,
    ownerRole: alertOwnerRole(row.category),
    priority: priorityFromSeverity(row.severity),
    href: `/alerts?category=${encodeURIComponent(row.category)}`,
    dueDate: dueDateFromParamsSnapshot(row.paramsSnapshot),
  };
}

/** review_items（open）→ 待办候选；sourceRef = 复核项 id */
export function reviewToCandidate(row: ReviewTriggerRow): TodoCandidate {
  const sourceRef = String(row.id);
  return {
    fingerprint: fingerprintOf("review", sourceRef),
    sourceKind: "review",
    sourceRef,
    title: row.title,
    detail: row.detail,
    ownerRole: reviewOwnerRole(row.category),
    priority: row.category.startsWith("blocked") ? "high" : "normal",
    href: `/review/checklist?category=${encodeURIComponent(row.category)}`,
    dueDate: null,
  };
}

/**
 * 批量投影：同指纹只保留第一条（输入本身应当已按主键唯一，这里是防御）。
 * 顺序：告警在前（high 优先）、复核在后；同类按 id 升序，保证多轮运行结果稳定。
 */
export function projectTodoCandidates(input: {
  alerts: readonly AlertTriggerRow[];
  reviews: readonly ReviewTriggerRow[];
}): TodoCandidate[] {
  const seen = new Set<string>();
  const out: TodoCandidate[] = [];
  const push = (c: TodoCandidate) => {
    if (seen.has(c.fingerprint)) return;
    seen.add(c.fingerprint);
    out.push(c);
  };
  [...input.alerts].sort((a, b) => a.id - b.id).forEach((r) => push(alertToCandidate(r)));
  [...input.reviews].sort((a, b) => a.id - b.id).forEach((r) => push(reviewToCandidate(r)));
  return out;
}
