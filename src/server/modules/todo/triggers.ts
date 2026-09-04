/**
 * D61 待办触发：读取 system_alerts(open) 与 review_items(open)，经 rules/task-triggers 纯函数投影为候选。
 * 只读取，不落库；落库由 service.projectCandidates 负责（jobs/todo-sync 串起来）。
 *
 * 触发范围（参数化，默认值即本波口径）：
 *  - 告警：全部 open 类别（data_freshness / doc_aging / integration_token / job_failure / data_product_gate /
 *    sales_spike / inventory_cover / …）——每条告警最多对应一条待办（指纹 alert:{id}）。
 *  - 复核：open 状态的 review_items；默认只投影 blocked* 与 doc_aging（历史 doc_aging 曾落在 review_items），
 *    其余复核类别量大且已有 /review/checklist 承接，不再复制成待办。
 *
 * ── 预算与排序（红队审计 A1：投影会饿死） ──
 * 原实现两个致命细节叠在一起：告警按 `id` **升序**（最老的在前）取 500 条，复核只拿
 * `limit − alerts.length` 个名额。于是 open 告警一旦攒够 500 条：
 *  ① 窗口被最老的、早就投影过的告警长期占满，**新告警永远排不进来**；
 *  ② 复核项（含 blocked*）名额恒为 0，一条都投影不出去；
 *  ③ 汇总还报 `scanned: 500, matched: 500`——看起来完全正常，饿死是静默的。
 * 现在：
 *  - **两条来源各有独立预算**（alertLimit / reviewLimit），谁也饿不死谁；
 *  - 排序改成「**还没有在办待办的排前面** → 严重度高的在前 → id 倒序（新的在前）」，
 *    保证新增/未投影/更严重的行先进窗口，已经有在办待办的老行只在还有余额时才占位；
 *  - 预算打满时在汇总里显式给出 `truncated: true`（含各来源实际取数），让饿死变成看得见的信号。
 */
import { and, eq, inArray, like, or, sql, type SQL } from "drizzle-orm";
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
  /** 单来源预算（告警与复核**各自**上限）；缺省 DEFAULT_TRIGGER_LIMIT */
  limit?: number;
  /** 只覆盖告警预算（缺省取 limit） */
  alertLimit?: number;
  /** 只覆盖复核预算（缺省取 limit） */
  reviewLimit?: number;
}

export const DEFAULT_REVIEW_PREFIXES = ["blocked", "doc_aging"] as const;
export const DEFAULT_TRIGGER_LIMIT = 500;

export interface CollectTriggerResult {
  candidates: TodoCandidate[];
  /** 本轮取到的告警 / 复核行数 */
  alertsScanned: number;
  reviewsScanned: number;
  /** 任一来源打满预算：还有行没被本轮看到（老的告警风暴会持续遮住新行，需要人处理存量） */
  truncated: boolean;
  alertLimit: number;
  reviewLimit: number;
}

/** 严重度排序（数字越大越先进窗口）；未知/空按最低 */
const SEVERITY_ORDER = sql`CASE lower(coalesce(${systemAlerts.severity}, '')) WHEN 'critical' THEN 3 WHEN 'high' THEN 2 WHEN 'medium' THEN 1 ELSE 0 END`;

/** 该来源行是否已经有一条在办（open/in_progress）待办——已有的排到最后，把预算让给没投影过的 */
function hasOpenWorkItem(sourceKind: "alert" | "review", idColumn: SQL | ReturnType<typeof sql>): SQL {
  return sql`EXISTS (
    SELECT 1 FROM work_items w
    WHERE w.source_kind = ${sourceKind} AND w.source_ref = ${idColumn} AND w.status IN ('open', 'in_progress')
  )`;
}

export async function collectTodoCandidatesDetailed(db: AnyDb, opts?: CollectTriggerOptions): Promise<CollectTriggerResult> {
  const base = opts?.limit ?? DEFAULT_TRIGGER_LIMIT;
  const alertLimit = Math.max(0, opts?.alertLimit ?? base);
  const reviewLimit = Math.max(0, opts?.reviewLimit ?? base);

  const alertWhere = opts?.alertCategories?.length
    ? and(eq(systemAlerts.status, "open"), inArray(systemAlerts.category, [...opts.alertCategories]))
    : eq(systemAlerts.status, "open");
  const alertProjected = hasOpenWorkItem("alert", sql`${systemAlerts.id}::text`);
  const alerts: AlertTriggerRow[] = alertLimit === 0 ? [] : await db
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
    // 未投影优先 → 严重度高优先 → 新的优先（id DESC）
    .orderBy(sql`${alertProjected} ASC`, sql`${SEVERITY_ORDER} DESC`, sql`${systemAlerts.id} DESC`)
    .limit(alertLimit);

  const prefixes = opts?.reviewCategoryPrefixes ?? DEFAULT_REVIEW_PREFIXES;
  const prefixClause = prefixes.length
    ? or(...prefixes.map((p) => like(reviewItems.category, `${p}%`)))
    : sql`false`;
  const reviewProjected = hasOpenWorkItem("review", sql`${reviewItems.id}::text`);
  const reviews: ReviewTriggerRow[] = reviewLimit === 0 ? [] : await db
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
    .orderBy(sql`${reviewProjected} ASC`, sql`${reviewItems.id} DESC`)
    .limit(reviewLimit);

  return {
    candidates: projectTodoCandidates({ alerts, reviews }),
    alertsScanned: alerts.length,
    reviewsScanned: reviews.length,
    truncated: (alertLimit > 0 && alerts.length >= alertLimit) || (reviewLimit > 0 && reviews.length >= reviewLimit),
    alertLimit,
    reviewLimit,
  };
}

/** 只要候选列表（保留既有签名；需要预算/截断信号时用 collectTodoCandidatesDetailed） */
export async function collectTodoCandidates(db: AnyDb, opts?: CollectTriggerOptions): Promise<TodoCandidate[]> {
  return (await collectTodoCandidatesDetailed(db, opts)).candidates;
}
