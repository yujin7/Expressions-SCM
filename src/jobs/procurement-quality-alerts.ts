/**
 * 采购与质量看门狗（W2 审计 5）——四个「数据早就有、却没人被叫醒」的类别。
 *
 * 全部经 `alerts/engine.upsertAlerts` 落库（`src/` 里不得有第二处 `insert(systemAlerts)`），
 * 责任角色一律读 `rules/task-triggers.ALERT_OWNER_ROLE`（禁止在候选里硬编码 ownerRole 字面量），
 * 每条候选都带 actionHref / sourceRule / paramsSnapshot / why[]。
 *
 * ── 四个类别与各自的关闭语义（`autoCloseAfterDays` 三态，按类别语义选，不是可调参数）──
 *  1. `supplier_license` 供应商证照到期：`jobs/license-alert.ts` **每天都在算，却从来没有消费者**——
 *     算完打一行日志就扔了。证照过期 = 这家供应商开不出合规票、验不了厂，采购却照常下单。
 *     续期是**硬事实**：档案里换了新的到期日，条件当即消失 → `autoCloseAfterDays: 0`。
 *  2. `promise_breach` 交期承诺违约：`po_promise_revisions` 有 previous/promised 两个日期，
 *     供应商每往后推一次都留了痕，可这些痕迹只在到货日历上被动展示，没有任何人被叫醒。
 *     判定：**未收齐**的 PO 行，当前承诺较原始承诺推迟 ≥ `PROMISE_BREACH_MIN_DAYS` 天。
 *     收齐 / 短关 / 作废后条件即消失，是硬事实 → `autoCloseAfterDays: 0`。
 *  3. `otif_collapse` 供应商 OTIF 崩塌：按 `report/purchase-order-metrics` 的**原始承诺**口径
 *     （v3 起主口径，供应商改期洗不白），逐供应商年度累计准时率低于 `OTIF_COLLAPSE_RATE`
 *     且可评样本 ≥ `OTIF_COLLAPSE_MIN_EVALUABLE`。这是**已发生的周期事实**：
 *     某一年的 OTIF 塌了，下一轮不再命中不代表它被处理过 → `autoCloseAfterDays: null`（只能人工带原因关闭）。
 *  4. `quality_case_overdue` 质量案件逾期：`quality_cases.report_due_date` 已过、尚未上报且案件未关闭
 *     （判定复用 `rules/quality-compliance.classifyDueState`）。上报或关闭案件即消失 → `autoCloseAfterDays: 0`。
 *     这同时是审计 4c 要求的「案件逾期要能通过引擎起告警」。
 *
 * 阈值都是本模块导出的常量而非 sys_params：它们决定的是「什么时候叫醒人」，
 * 改动应当被代码评审看见（新增运行参数还要过参数权威门），不适合让人在后台随手调。
 */
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import * as schema from "@/db/schema";
import { shanghaiDayOf } from "@/server/core/business-day";
import { upsertAlerts, type AlertCandidate, type AlertWhy } from "@/server/modules/alerts/engine";
import { loadPurchaseOrderMetrics } from "@/server/modules/report/purchase-order-metrics";
import type { AnyDb } from "@/server/core/svc";
import { classifyDueState } from "@/server/rules/quality-compliance";
import { resolvePromiseBasis } from "@/server/rules/promise-basis";
import { ALERT_OWNER_ROLE } from "@/server/rules/task-triggers";
import { runLicenseAlert, LICENSE_ALERT_WINDOW_DAYS } from "./license-alert";

/** 承诺推迟多少天才算「违约」（少于此值多半是排产微调，叫醒人只会制造噪声） */
export const PROMISE_BREACH_MIN_DAYS = 3;
/** OTIF 崩塌门槛（原始承诺口径的年度累计准时率） */
export const OTIF_COLLAPSE_RATE = 0.7;
/** 低于此可评样本数不出 OTIF 告警（3 单里迟到 1 单不是「崩塌」） */
export const OTIF_COLLAPSE_MIN_EVALUABLE = 5;

/** 未收齐的 PO 状态（收齐/短关/作废后条件即消失） */
const OPEN_PO_STATUSES = ["approved", "in_progress"] as const;

/* 类别常量：必须写成 `const X = "字面量"` 并在 upsertAlerts 调用点显式传
   `category: X`——`tests/architecture/alert-category-labels.test.ts` 从调用实参解析类别，
   用对象简写（`{ category, … }`）会让护栏解析不出来直接判红。 */
export const CATEGORY_SUPPLIER_LICENSE = "supplier_license";
export const CATEGORY_PROMISE_BREACH = "promise_breach";
export const CATEGORY_OTIF_COLLAPSE = "otif_collapse";
export const CATEGORY_QUALITY_CASE_OVERDUE = "quality_case_overdue";

export interface WatchdogResult {
  category: string;
  candidates: number;
  opened: number;
  refreshed: number;
  autoClosed: number;
  stillOpen: number;
  suppressed: number;
  ackReset: number;
}

/* ───────────────────────── 1. 供应商证照到期 ───────────────────────── */

export async function runSupplierLicenseWatchdog(db: AnyDb, now = new Date()): Promise<WatchdogResult> {
  const category = CATEGORY_SUPPLIER_LICENSE;
  const summary = await runLicenseAlert(db, shanghaiDayOf(now));
  const candidates: AlertCandidate[] = summary.alerts.map((a) => {
    const expired = a.daysLeft < 0;
    const why: AlertWhy[] = [
      { label: "营业执照到期日", value: a.licenseExpiry, source: "suppliers.license_expiry" },
      {
        label: expired ? "已过期" : "剩余天数",
        value: expired ? `${-a.daysLeft} 天` : `${a.daysLeft} 天（提醒窗口 ${LICENSE_ALERT_WINDOW_DAYS} 天）`,
        source: "jobs/license-alert",
      },
    ];
    return {
      refKey: a.code,
      dedupeKey: `${category}:${a.supplierId}`,
      title: expired
        ? `供应商 ${a.code} ${a.name} 营业执照已过期 ${-a.daysLeft} 天`
        : `供应商 ${a.code} ${a.name} 营业执照 ${a.daysLeft} 天后到期`,
      detail: `到期日 ${a.licenseExpiry}；过期供应商开不出合规票、验厂资质失效，但系统不会自动拦下单——请先续期或暂停该供应商。`,
      severity: expired ? "high" : "medium",
      ownerRole: ALERT_OWNER_ROLE[category],
      actionHref: `/master/supplier?q=${encodeURIComponent(a.code)}`,
      sourceRule: "jobs/license-alert",
      paramsSnapshot: {
        supplierId: a.supplierId, code: a.code, licenseExpiry: a.licenseExpiry,
        daysLeft: a.daysLeft, windowDays: summary.windowDays, today: summary.today,
      },
      why,
    } satisfies AlertCandidate;
  });
  // 续期 = 硬事实，档案一改条件就没了，没必要迟滞
  const res = await upsertAlerts(db, { category: CATEGORY_SUPPLIER_LICENSE, candidates, now, autoCloseAfterDays: 0 });
  return { category, candidates: candidates.length, ...res };
}

/* ───────────────────────── 2. 交期承诺违约 ───────────────────────── */

export interface PromiseBreachRow {
  poId: number;
  docNo: string;
  poLineId: number;
  supplierId: number;
  supplierCode: string;
  supplierName: string;
  skuCode: string;
  originalPromisedDate: string;
  currentPromisedDate: string;
  delayDays: number;
  revisionCount: number;
  outstandingQty: string;
}

export async function collectPromiseBreaches(db: AnyDb, today: string): Promise<PromiseBreachRow[]> {
  const lines: {
    poId: number; docNo: string; status: string; poLineId: number; supplierId: number;
    supplierCode: string; supplierName: string; skuCode: string;
    lineDate: string | null; headerDate: string | null; qty: string; uomFactor: string; receivedQty: string;
  }[] = await db
    .select({
      poId: schema.poDocs.id,
      docNo: schema.poDocs.docNo,
      status: schema.poDocs.status,
      poLineId: schema.poLines.id,
      supplierId: schema.poDocs.supplierId,
      supplierCode: schema.suppliers.code,
      supplierName: schema.suppliers.name,
      skuCode: schema.skus.code,
      lineDate: schema.poLines.expectedDate,
      headerDate: schema.poDocs.expectedDate,
      qty: schema.poLines.qty,
      uomFactor: schema.poLines.uomFactor,
      receivedQty: schema.poLines.receivedQty,
    })
    .from(schema.poLines)
    .innerJoin(schema.poDocs, eq(schema.poLines.poId, schema.poDocs.id))
    .innerJoin(schema.suppliers, eq(schema.poDocs.supplierId, schema.suppliers.id))
    .innerJoin(schema.skus, eq(schema.poLines.skuId, schema.skus.id))
    .where(inArray(schema.poDocs.status, [...OPEN_PO_STATUSES]));
  if (lines.length === 0) return [];

  const revisionRows: { poLineId: number; sequence: number; promisedDate: string | null; source: string }[] = await db
    .select({
      poLineId: schema.poPromiseRevisions.poLineId,
      sequence: schema.poPromiseRevisions.sequence,
      promisedDate: schema.poPromiseRevisions.promisedDate,
      source: schema.poPromiseRevisions.source,
    })
    .from(schema.poPromiseRevisions)
    .where(inArray(schema.poPromiseRevisions.poLineId, lines.map((l) => l.poLineId)))
    .orderBy(schema.poPromiseRevisions.poLineId, schema.poPromiseRevisions.sequence);
  const byLine = new Map<number, typeof revisionRows>();
  for (const r of revisionRows) {
    const list = byLine.get(r.poLineId) ?? [];
    list.push(r);
    byLine.set(r.poLineId, list);
  }

  const out: PromiseBreachRow[] = [];
  for (const l of lines) {
    const fact = resolvePromiseBasis(byLine.get(l.poLineId) ?? []);
    const original = fact.originalPromisedDate;
    const current = l.lineDate ?? l.headerDate ?? null;
    if (!original || !current || current <= original) continue; // 没有版本链、或没有往后推 → 不是违约
    const delayDays = Math.round((Date.parse(`${current}T00:00:00Z`) - Date.parse(`${original}T00:00:00Z`)) / 86_400_000);
    if (delayDays < PROMISE_BREACH_MIN_DAYS) continue;
    const ordered = Number(l.qty) * Number(l.uomFactor);
    const outstanding = ordered - Number(l.receivedQty);
    if (!(outstanding > 0)) continue; // 已收齐：条件消失，交给引擎自动关闭
    out.push({
      poId: l.poId,
      docNo: l.docNo,
      poLineId: l.poLineId,
      supplierId: l.supplierId,
      supplierCode: l.supplierCode,
      supplierName: l.supplierName,
      skuCode: l.skuCode,
      originalPromisedDate: original,
      currentPromisedDate: current,
      delayDays,
      revisionCount: fact.revisionCount,
      outstandingQty: outstanding.toFixed(4),
    });
  }
  return out.sort((a, b) => b.delayDays - a.delayDays || a.poLineId - b.poLineId).map((r) => ({ ...r, today } as PromiseBreachRow));
}

export async function runPromiseBreachWatchdog(db: AnyDb, now = new Date()): Promise<WatchdogResult> {
  const category = CATEGORY_PROMISE_BREACH;
  const today = shanghaiDayOf(now);
  const rows = await collectPromiseBreaches(db, today);
  const candidates: AlertCandidate[] = rows.map((r) => ({
    refKey: r.docNo,
    dedupeKey: `${category}:po_line:${r.poLineId}`,
    title: `${r.supplierCode} 把 ${r.docNo}（${r.skuCode}）交期推迟 ${r.delayDays} 天且未收齐`,
    detail: `原始承诺 ${r.originalPromisedDate} → 当前承诺 ${r.currentPromisedDate}；未收 ${r.outstandingQty}；`
      + `改期 ${r.revisionCount} 次。改期只影响「当前承诺」口径，OTIF 主口径仍按原始承诺判——但缺料风险是真的，需要跟单。`,
    severity: r.delayDays >= 14 ? "high" : "medium",
    ownerRole: ALERT_OWNER_ROLE[category],
    actionHref: `/outsource/po?q=${encodeURIComponent(r.docNo)}`,
    sourceRule: "rules/promise-basis + po_promise_revisions",
    paramsSnapshot: {
      poId: r.poId, poLineId: r.poLineId, supplierId: r.supplierId, docNo: r.docNo,
      originalPromisedDate: r.originalPromisedDate, currentPromisedDate: r.currentPromisedDate,
      delayDays: r.delayDays, revisionCount: r.revisionCount, outstandingQty: r.outstandingQty,
      minDays: PROMISE_BREACH_MIN_DAYS, today,
      // 待办真实截止日 = 供应商自己给的当前承诺日（不是拍脑袋的 +3 天）
      orderByDate: r.currentPromisedDate,
    },
    why: [
      { label: "原始承诺", value: r.originalPromisedDate, source: "po_promise_revisions（第一条可信修订）" },
      { label: "当前承诺", value: r.currentPromisedDate, source: "coalesce(行交期, 表头交期)" },
      { label: "推迟", value: `${r.delayDays} 天（门槛 ${PROMISE_BREACH_MIN_DAYS} 天）`, source: "rules/promise-basis" },
      { label: "未收量", value: r.outstandingQty, source: "po_lines.received_qty" },
    ],
  } satisfies AlertCandidate));
  // 收齐 / 短关 / 作废后条件即消失，是单据流转的硬事实
  const res = await upsertAlerts(db, { category: CATEGORY_PROMISE_BREACH, candidates, now, autoCloseAfterDays: 0 });
  return { category, candidates: candidates.length, ...res };
}

/* ───────────────────────── 3. 供应商 OTIF 崩塌 ───────────────────────── */

export async function runOtifCollapseWatchdog(db: AnyDb, now = new Date()): Promise<WatchdogResult> {
  const category = CATEGORY_OTIF_COLLAPSE;
  const model = await loadPurchaseOrderMetrics({}, db);
  const candidates: AlertCandidate[] = model.bySupplier
    .filter((s) => s.otif.rate != null && s.otif.evaluable >= OTIF_COLLAPSE_MIN_EVALUABLE && s.otif.rate < OTIF_COLLAPSE_RATE)
    .map((s) => ({
      refKey: s.code,
      // 键带年份：某一年的崩塌是那一年的事实，不该被下一年的同一供应商刷新掉
      dedupeKey: `${category}:${s.supplierId}:${model.year}`,
      title: `${s.code} ${s.name} ${model.year} 年 OTIF ${(s.otif.rate! * 100).toFixed(1)}%（${model.otifBasisLabel}口径）`,
      detail: `可评 ${s.otif.evaluable} 单：命中 ${s.otif.hit} / 未达 ${s.otif.miss}；待评 ${s.otif.pending}、缺承诺日 ${s.otif.unevaluable} 不进分母。`
        + `${model.otifSecondaryBasisLabel}口径 ${s.otifCurrent.rate == null ? "不可评" : `${(s.otifCurrent.rate * 100).toFixed(1)}%`}——`
        + "两者的差额就是改期吃掉的迟到，不作数。",
      severity: s.otif.rate! < 0.5 ? "high" : "medium",
      ownerRole: ALERT_OWNER_ROLE[category],
      actionHref: `/report/purchase-orders?q=${encodeURIComponent(s.code)}`,
      sourceRule: `${model.key} · bySupplier.otif`,
      paramsSnapshot: {
        supplierId: s.supplierId, code: s.code, year: model.year,
        otifBasis: model.otifBasis, rate: s.otif.rate, evaluable: s.otif.evaluable,
        hit: s.otif.hit, miss: s.otif.miss, pending: s.otif.pending, unevaluable: s.otif.unevaluable,
        currentBasisRate: s.otifCurrent.rate, currentBasisEvaluable: s.otifCurrent.evaluable,
        threshold: OTIF_COLLAPSE_RATE, minEvaluable: OTIF_COLLAPSE_MIN_EVALUABLE,
        params: model.params, promiseHistory: model.promiseHistory,
      },
      why: [
        { label: `${model.otifBasisLabel}口径准时率`, value: `${(s.otif.rate! * 100).toFixed(1)}%（门槛 ${(OTIF_COLLAPSE_RATE * 100).toFixed(0)}%）`, source: model.key },
        { label: "可评样本", value: `${s.otif.evaluable} 单（最少 ${OTIF_COLLAPSE_MIN_EVALUABLE} 单才评）`, source: model.key },
        {
          label: `${model.otifSecondaryBasisLabel}口径`,
          value: s.otifCurrent.rate == null ? "不可评" : `${(s.otifCurrent.rate * 100).toFixed(1)}%（改期后的值，不作数）`,
          source: model.key,
        },
      ],
    } satisfies AlertCandidate));
  /* 周期事实：某一年的 OTIF 塌了就是塌了。下一轮不再命中，不代表这一年的问题被处理过——
     只能由人带原因关闭（与 data_quality 同一条纪律）。 */
  const res = await upsertAlerts(db, { category: CATEGORY_OTIF_COLLAPSE, candidates, now, autoCloseAfterDays: null });
  return { category, candidates: candidates.length, ...res };
}

/* ───────────────────────── 4. 质量案件逾期 ───────────────────────── */

export async function runQualityCaseOverdueWatchdog(db: AnyDb, now = new Date()): Promise<WatchdogResult> {
  const category = CATEGORY_QUALITY_CASE_OVERDUE;
  const today = shanghaiDayOf(now);
  const rows: {
    id: number; caseNo: string; kind: string; severity: string; status: string;
    reportDueDate: string | null; reportedAt: Date | null; ownerName: string | null; supplierCode: string | null;
  }[] = await db
    .select({
      id: schema.qualityCases.id,
      caseNo: schema.qualityCases.caseNo,
      kind: schema.qualityCases.kind,
      severity: schema.qualityCases.severity,
      status: schema.qualityCases.status,
      reportDueDate: schema.qualityCases.reportDueDate,
      reportedAt: schema.qualityCases.reportedAt,
      ownerName: schema.users.name,
      supplierCode: schema.suppliers.code,
    })
    .from(schema.qualityCases)
    .leftJoin(schema.users, eq(schema.qualityCases.ownerId, schema.users.id))
    .leftJoin(schema.suppliers, eq(schema.qualityCases.supplierId, schema.suppliers.id))
    .where(and(
      isNotNull(schema.qualityCases.reportDueDate),
      sql`${schema.qualityCases.status} <> 'closed'`,
    ));

  const candidates: AlertCandidate[] = [];
  for (const r of rows) {
    const state = classifyDueState({
      dueDate: r.reportDueDate!,
      asOfDate: today,
      dueSoonThroughDate: today,
      completedDate: r.reportedAt ? today : null,
    });
    if (state !== "overdue") continue;
    const overdueDays = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${r.reportDueDate!}T00:00:00Z`)) / 86_400_000);
    candidates.push({
      refKey: r.caseNo,
      dedupeKey: `${category}:${r.id}`,
      title: `质量案件 ${r.caseNo} 上报已逾期 ${overdueDays} 天`,
      detail: `案件类型 ${r.kind}、严重度 ${r.severity}、状态 ${r.status}；应报日 ${r.reportDueDate}；`
        + `责任人 ${r.ownerName ?? "—"}${r.supplierCode ? `；涉及供应商 ${r.supplierCode}` : ""}。逾期案件同时会扣该供应商的记分卡「质量案件」维度。`,
      severity: r.severity === "critical" || overdueDays >= 7 ? "critical" : "high",
      ownerRole: ALERT_OWNER_ROLE[category],
      actionHref: `/quality?tab=cases&q=${encodeURIComponent(r.caseNo)}`,
      sourceRule: "rules/quality-compliance.classifyDueState",
      paramsSnapshot: {
        caseId: r.id, caseNo: r.caseNo, kind: r.kind, status: r.status, severity: r.severity,
        reportDueDate: r.reportDueDate, overdueDays, today,
        // 已经逾期：待办截止日就是应报日本身，不再往后推
        orderByDate: r.reportDueDate,
      },
      why: [
        { label: "应报日", value: r.reportDueDate!, source: "quality_cases.report_due_date" },
        { label: "逾期", value: `${overdueDays} 天`, source: "rules/quality-compliance.classifyDueState" },
        { label: "上报状态", value: r.reportedAt ? "已上报" : "未上报", source: "quality_cases.reported_at" },
      ],
    });
  }
  // 上报或关闭案件即消失，是单据流转的硬事实
  const res = await upsertAlerts(db, { category: CATEGORY_QUALITY_CASE_OVERDUE, candidates, now, autoCloseAfterDays: 0 });
  return { category, candidates: candidates.length, ...res };
}

/* ───────────────────────── 组合入口（调度器只挂一个任务） ───────────────────────── */

export async function runProcurementQualityAlerts(db: AnyDb, now = new Date()): Promise<WatchdogResult[]> {
  return [
    await runSupplierLicenseWatchdog(db, now),
    await runPromiseBreachWatchdog(db, now),
    await runOtifCollapseWatchdog(db, now),
    await runQualityCaseOverdueWatchdog(db, now),
  ];
}
