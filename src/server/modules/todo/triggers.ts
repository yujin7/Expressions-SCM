/**
 * D61 待办触发：读取 system_alerts(open) 与 review_items(open)，经 rules/task-triggers 纯函数投影为候选。
 * 只读取，不落库；落库由 service.projectCandidates 负责（jobs/todo-sync 串起来）。
 *
 * 触发范围（参数化，默认值即本波口径）：
 *  - 告警：全部 open 类别（data_freshness / doc_aging / integration_token / job_failure / data_product_gate /
 *    sales_spike / inventory_cover / …）——每条告警最多对应一条待办（指纹 alert:{id}）。
 *  - 复核：open 状态的 review_items；默认只投影 blocked* 与 doc_aging（历史 doc_aging 曾落在 review_items），
 *    其余复核类别量大且已有 /review/checklist 承接，不再复制成待办。
 */
import { and, eq, inArray, like, or, sql } from "drizzle-orm";
import { reviewItems, systemAlerts } from "@/db/schema";
import type { AnyDb } from "@/server/core/svc";
import {
  projectTodoCandidates,
  type AlertTriggerRow,
  type ReviewTriggerRow,
  type TodoCandidate,
} from "@/server/rules/task-triggers";

export interface CollectTriggerOptions {
  /** 只投影这些告警类别；缺省全部 open 告警 */
  alertCategories?: readonly string[];
  /** 复核类别前缀白名单；缺省 ["blocked", "doc_aging"] */
  reviewCategoryPrefixes?: readonly string[];
  /** 单轮最多投影条数（防止告警风暴一次生成上千待办） */
  limit?: number;
}

export const DEFAULT_REVIEW_PREFIXES = ["blocked", "doc_aging"] as const;
export const DEFAULT_TRIGGER_LIMIT = 500;

export async function collectTodoCandidates(db: AnyDb, opts?: CollectTriggerOptions): Promise<TodoCandidate[]> {
  const limit = opts?.limit ?? DEFAULT_TRIGGER_LIMIT;
  const alertWhere = opts?.alertCategories?.length
    ? and(eq(systemAlerts.status, "open"), inArray(systemAlerts.category, [...opts.alertCategories]))
    : eq(systemAlerts.status, "open");
  const alerts: AlertTriggerRow[] = await db
    .select({
      id: systemAlerts.id,
      category: systemAlerts.category,
      refKey: systemAlerts.refKey,
      title: systemAlerts.title,
      detail: systemAlerts.detail,
      severity: systemAlerts.severity,
      paramsSnapshot: systemAlerts.paramsSnapshot,
    })
    .from(systemAlerts)
    .where(alertWhere)
    .orderBy(systemAlerts.id)
    .limit(limit);

  const prefixes = opts?.reviewCategoryPrefixes ?? DEFAULT_REVIEW_PREFIXES;
  const prefixClause = prefixes.length
    ? or(...prefixes.map((p) => like(reviewItems.category, `${p}%`)))
    : sql`false`;
  const reviews: ReviewTriggerRow[] = await db
    .select({
      id: reviewItems.id,
      category: reviewItems.category,
      refType: reviewItems.refType,
      refKey: reviewItems.refKey,
      title: reviewItems.title,
      detail: reviewItems.detail,
    })
    .from(reviewItems)
    .where(and(eq(reviewItems.status, "open"), prefixClause))
    .orderBy(reviewItems.id)
    .limit(Math.max(0, limit - alerts.length));

  return projectTodoCandidates({ alerts, reviews });
}
