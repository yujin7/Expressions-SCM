/**
 * 告警结果核验任务（智能闭环审计 #3）：断货/低于阈值告警关闭 ≥ 3 天后，回看实时仓流水，
 * 判定"告警说会断货，后来到底断了没有"，写 alert_events(verify, evidence_ref.result)。
 *
 * 口径（只读 stock_ledger，不写库存）：
 *  - 窗口 = [告警开启, 告警关闭 + 宽限 3 天]；只看 accounting_mode='realtime' 的仓（快照仓无流水，不能打分）。
 *  - **覆盖前置（红队审计 A3，core/stockout-evidence 唯一判定）**：告警本身来自 getOnHandBySku＝
 *    实时仓余额 + 快照仓最新快照。所以只有当该 SKU 在窗口内**没有快照仓在库**时，
 *    实时仓流水才真的覆盖了告警所指的那批货，才允许打真/误的分；否则一律 unverifiable 并给出覆盖原因。
 *    （此前只要历史上在实时仓动过一笔就标 coverage=realtime 并打分，
 *    于是"货在快照仓、偶尔有一笔实时仓调拨"的 SKU 被拿去算精确率，而那个数是人调阈值的依据。）
 *  - 期初 = 窗口前全部流水累计；逐笔推演窗口内余额取最小值。
 *  - true_positive  = 窗口内实时仓总余额曾 ≤ 0，且窗口内或前 30 天有出库（有需求）。
 *  - false_positive = 余额从未归零，且窗口内没有任何入库（没人补货、也没断——阈值/日销估高了）。
 *  - unverifiable   = 覆盖不足（无实时仓 / 该 SKU 无实时流水 / 窗口内仍有快照仓在库）；
 *                     或余额归零但流水看不到需求；
 *                     或窗口内有入库（可能是告警促成了补货、断货被规避——无法与误报区分，只能弃权）。
 * 每条告警只核验一次（幂等键 `${alertId}:verify`）；结果只进台账，不回写 system_alerts，不调参数。
 */
import { and, eq, gte, inArray, lt, lte, sql } from "drizzle-orm";
import * as schema from "@/db/schema";
import { dAdd, dCmp, dSub } from "@/server/core/decimal";
import type { AnyDb } from "@/server/core/svc";
import { classifyLedgerCoverage, loadStockUniverseCoverage, type LedgerCoverage, type StockUniverseCoverage } from "@/server/core/stockout-evidence";
import { appendAlertEvents, type AlertEventInput } from "@/server/modules/alerts/engine";

export const ALERT_OUTCOME_VERSION = "alert-outcome/v1";
export const VERIFY_AFTER_DAYS = 3;
export const VERIFY_GRACE_DAYS = 3;
export const DEMAND_LOOKBACK_DAYS = 30;
export const VERIFIED_CATEGORIES = ["inventory_cover"] as const;
const DAY_MS = 86_400_000;

export type AlertOutcomeResult = "true_positive" | "false_positive" | "unverifiable";
export type AlertOutcomeReason =
  | "zero_stock_with_demand"
  | "stock_never_zero"
  | "snapshot_only_no_realtime_ledger"
  /** 有实时流水，但窗口内该 SKU 仍有快照仓在库 → 流水覆盖不了告警的在库口径，弃权 */
  | "snapshot_stock_outside_ledger"
  | "zero_stock_no_ledger_demand"
  | "averted_by_inbound"
  | "sku_unresolved";

export interface AlertOutcomeEvidence {
  version: typeof ALERT_OUTCOME_VERSION;
  result: AlertOutcomeResult;
  reason: AlertOutcomeReason;
  skuId: number | null;
  windowStart: string;
  windowEnd: string;
  coverage: LedgerCoverage;
  realtimeWarehouses: number;
  openingBalance: string | null;
  minBalance: string | null;
  demandOutQty: string;
  lookbackOutQty: string;
  inboundQty: string;
  note: string;
}

export interface AlertOutcomeSummary {
  scanned: number;
  verified: number;
  truePositive: number;
  falsePositive: number;
  unverifiable: number;
  realtimeWarehouses: number;
  version: typeof ALERT_OUTCOME_VERSION;
}

type CandidateRow = {
  id: number;
  category: string;
  refKey: string | null;
  dedupeKey: string | null;
  createdAt: Date;
  resolvedAt: Date | null;
};

function skuIdFromAlert(row: CandidateRow, codeToId: Map<string, number>): number | null {
  const m = /^inventory_cover:(\d+)$/.exec(row.dedupeKey ?? "");
  if (m) return Number(m[1]);
  if (row.refKey && codeToId.has(row.refKey)) return codeToId.get(row.refKey)!;
  return null;
}

async function verifyOne(
  db: AnyDb,
  input: { skuId: number; windowStart: Date; windowEnd: Date; realtimeIds: number[]; coverage: StockUniverseCoverage },
): Promise<Omit<AlertOutcomeEvidence, "version" | "skuId" | "windowStart" | "windowEnd" | "realtimeWarehouses">> {
  const l = schema.stockLedger;
  const inRealtime = inArray(l.warehouseId, input.realtimeIds);
  // 覆盖前置：唯一判定在 core/stockout-evidence（与 report/closed-loop 抑制复核同一份）
  const cov = classifyLedgerCoverage(input.skuId, input.coverage);
  if (!cov.covered) {
    return {
      coverage: cov.coverage, openingBalance: null, minBalance: null, demandOutQty: "0", lookbackOutQty: "0", inboundQty: "0",
      result: "unverifiable", reason: cov.reason ?? "snapshot_only_no_realtime_ledger", note: cov.note,
    };
  }
  const [opening] = await db.select({ qty: sql<string | null>`sum(${l.qtyDelta})` }).from(l)
    .where(and(eq(l.skuId, input.skuId), inRealtime, lt(l.occurredAt, input.windowStart)));
  const lookbackStart = new Date(input.windowStart.getTime() - DEMAND_LOOKBACK_DAYS * DAY_MS);
  const [lookback] = await db.select({ qty: sql<string | null>`sum(-${l.qtyDelta})` }).from(l)
    .where(and(eq(l.skuId, input.skuId), inRealtime, lt(l.qtyDelta, "0"), gte(l.occurredAt, lookbackStart), lt(l.occurredAt, input.windowStart)));
  const moves: { qtyDelta: string }[] = await db.select({ qtyDelta: l.qtyDelta }).from(l)
    .where(and(eq(l.skuId, input.skuId), inRealtime, gte(l.occurredAt, input.windowStart), lte(l.occurredAt, input.windowEnd)))
    .orderBy(l.occurredAt, l.id);

  let running = opening?.qty ?? "0";
  const openingBalance = running;
  let minBalance = running;
  let demandOut = "0";
  let inbound = "0";
  for (const m of moves) {
    running = dAdd(running, m.qtyDelta, 4);
    if (dCmp(running, minBalance) < 0) minBalance = running;
    if (dCmp(m.qtyDelta, "0") < 0) demandOut = dSub(demandOut, m.qtyDelta, 4); // 出库为负，减负即累加出库量
    else inbound = dAdd(inbound, m.qtyDelta, 4);
  }
  const lookbackOut = lookback?.qty ?? "0";
  const base = { coverage: "realtime" as const, openingBalance, minBalance, demandOutQty: demandOut, lookbackOutQty: lookbackOut, inboundQty: inbound };
  const hasDemand = dCmp(demandOut, "0") > 0 || dCmp(lookbackOut, "0") > 0;
  if (dCmp(minBalance, "0") <= 0) {
    return hasDemand
      ? { ...base, result: "true_positive", reason: "zero_stock_with_demand", note: "窗口内实时仓余额归零且有出库需求：断货确实发生" }
      : { ...base, result: "unverifiable", reason: "zero_stock_no_ledger_demand", note: "余额归零但流水看不到需求（需求可能在外部渠道），弃权" };
  }
  if (dCmp(inbound, "0") > 0) {
    return { ...base, result: "unverifiable", reason: "averted_by_inbound", note: "窗口内有入库、余额未归零：可能是告警促成补货规避了断货，无法与误报区分，弃权" };
  }
  return { ...base, result: "false_positive", reason: "stock_never_zero", note: "窗口内无入库且余额从未归零：告警预期的断货没有发生" };
}

/** 核验一批已关闭 ≥ VERIFY_AFTER_DAYS 天、尚未核验的 inventory_cover 告警。 */
export async function runAlertOutcome(db: AnyDb, opts?: { now?: Date; limit?: number }): Promise<AlertOutcomeSummary> {
  const now = opts?.now ?? new Date();
  const limit = Math.max(1, Math.min(2000, opts?.limit ?? 500));
  const cutoff = new Date(now.getTime() - VERIFY_AFTER_DAYS * DAY_MS);
  const a = schema.systemAlerts;
  const rows: CandidateRow[] = await db
    .select({ id: a.id, category: a.category, refKey: a.refKey, dedupeKey: a.dedupeKey, createdAt: a.createdAt, resolvedAt: a.resolvedAt })
    .from(a)
    .where(and(
      inArray(a.category, [...VERIFIED_CATEGORIES]),
      eq(a.status, "resolved"),
      lte(a.resolvedAt, cutoff),
      sql`NOT EXISTS (SELECT 1 FROM alert_events e WHERE e.alert_id = ${a.id} AND e.event = 'verify')`,
    ))
    .orderBy(a.resolvedAt, a.id)
    .limit(limit);

  const realtime: { id: number }[] = await db.select({ id: schema.warehouses.id }).from(schema.warehouses)
    .where(eq(schema.warehouses.accountingMode, "realtime"));
  const realtimeIds = realtime.map((w) => w.id);
  const summary: AlertOutcomeSummary = {
    scanned: rows.length, verified: 0, truePositive: 0, falsePositive: 0, unverifiable: 0,
    realtimeWarehouses: realtimeIds.length, version: ALERT_OUTCOME_VERSION,
  };
  if (!rows.length) return summary;

  const codes = [...new Set(rows.map((r) => r.refKey).filter((v): v is string => !!v))];
  const skuRows: { id: number; code: string }[] = codes.length
    ? await db.select({ id: schema.skus.id, code: schema.skus.code }).from(schema.skus).where(inArray(schema.skus.code, codes))
    : [];
  const codeToId = new Map(skuRows.map((s) => [s.code, s.id]));

  /* 覆盖事实一次性载入（本轮全部 SKU × 最晚窗口末）：判定偏保守——
     "窗口内还有快照仓在库"就弃权，不去逐条精算快照日，多弃权好过多打错分。 */
  const windowEndOf = (r: CandidateRow) => new Date(new Date(r.resolvedAt ?? now).getTime() + VERIFY_GRACE_DAYS * DAY_MS);
  const skuIdsInRun = rows.map((r) => skuIdFromAlert(r, codeToId)).filter((v): v is number => v != null);
  const latestWindowEnd = rows.reduce((m, r) => Math.max(m, windowEndOf(r).getTime()), 0);
  const coverage = await loadStockUniverseCoverage(db, { skuIds: skuIdsInRun, asOf: new Date(latestWindowEnd || now.getTime()) });

  const events: AlertEventInput[] = [];
  for (const r of rows) {
    const windowStart = new Date(r.createdAt);
    const windowEnd = windowEndOf(r);
    const skuId = skuIdFromAlert(r, codeToId);
    const verdict = skuId == null
      ? {
          result: "unverifiable" as const, reason: "sku_unresolved" as const, coverage: "none" as const,
          openingBalance: null, minBalance: null, demandOutQty: "0", lookbackOutQty: "0", inboundQty: "0",
          note: "无法从 dedupeKey/refKey 解析 SKU",
        }
      : await verifyOne(db, { skuId, windowStart, windowEnd, realtimeIds, coverage });
    const evidence: AlertOutcomeEvidence = {
      version: ALERT_OUTCOME_VERSION, skuId, windowStart: windowStart.toISOString(), windowEnd: windowEnd.toISOString(),
      realtimeWarehouses: realtimeIds.length, ...verdict,
    };
    events.push({
      alertId: r.id, event: "verify", at: now, evidenceRef: { ...evidence }, note: evidence.note,
      idempotencyKey: `${r.id}:verify`,
    });
    if (verdict.result === "true_positive") summary.truePositive++;
    else if (verdict.result === "false_positive") summary.falsePositive++;
    else summary.unverifiable++;
  }
  summary.verified = await appendAlertEvents(db, events);
  return summary;
}

export interface AlertPrecisionGroup {
  category: string;
  sourceRule: string | null;
  verified: number;
  truePositive: number;
  falsePositive: number;
  unverifiable: number;
  /** 精确率 = TP ÷ (TP + FP)，弃权不进分母；TP+FP = 0 → null（样本不足不给数） */
  precisionPct: number | null;
}

export interface AlertPrecisionSummary {
  days: number;
  verifiedTotal: number;
  groups: AlertPrecisionGroup[];
  caliber: string;
}

export const ALERT_PRECISION_CALIBER =
  "精确率 = 已核验为真 ÷ (真 + 误报)；弃权（快照仓 SKU / 窗口内仍有快照仓在库 / 窗口内有入库 / 看不到需求）单列不进分母；"
  + "只有实时仓流水覆盖了告警所指的那批货才打分（在库口径含快照仓，流水只有实时仓）；窗口按核验时间；每条告警只核验一次";

/** 近 N 天已核验告警按 category × sourceRule 的真/误/弃权计数（供后续 UI 块；不给单一总分） */
export async function alertPrecision(db: AnyDb, opts: { days: number; now?: Date }): Promise<AlertPrecisionSummary> {
  const now = opts.now ?? new Date();
  const days = Math.max(1, Math.min(365, Math.floor(opts.days)));
  const since = new Date(now.getTime() - days * DAY_MS);
  const e = schema.alertEvents;
  const a = schema.systemAlerts;
  const rows: { category: string; sourceRule: string | null; result: string | null }[] = await db
    .select({ category: a.category, sourceRule: a.sourceRule, result: sql<string | null>`${e.evidenceRef}->>'result'` })
    .from(e)
    .innerJoin(a, eq(a.id, e.alertId))
    .where(and(eq(e.event, "verify"), gte(e.at, since)));
  const groups = new Map<string, AlertPrecisionGroup>();
  for (const r of rows) {
    const key = `${r.category}|${r.sourceRule ?? ""}`;
    let g = groups.get(key);
    if (!g) {
      g = { category: r.category, sourceRule: r.sourceRule, verified: 0, truePositive: 0, falsePositive: 0, unverifiable: 0, precisionPct: null };
      groups.set(key, g);
    }
    g.verified++;
    if (r.result === "true_positive") g.truePositive++;
    else if (r.result === "false_positive") g.falsePositive++;
    else g.unverifiable++;
  }
  const out = [...groups.values()].map((g) => {
    const denom = g.truePositive + g.falsePositive;
    return { ...g, precisionPct: denom > 0 ? Math.round((g.truePositive / denom) * 1000) / 10 : null };
  }).sort((x, y) => x.category.localeCompare(y.category) || (x.sourceRule ?? "").localeCompare(y.sourceRule ?? ""));
  return { days, verifiedTotal: rows.length, groups: out, caliber: ALERT_PRECISION_CALIBER };
}
