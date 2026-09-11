/**
 * 告警结果核验任务（智能闭环审计 #3）：断货/低于阈值告警关闭 ≥ 3 天后，回看实时仓流水，
 * 判定"告警说会断货，后来到底断了没有"，写 alert_events(verify, evidence_ref.result)。
 *
 * 口径（只读 stock_ledger，不写库存）：
 *  - 窗口 = [告警开启, 告警关闭 + 宽限 3 天]；只看 accounting_mode='realtime' 的仓（快照仓无流水，不能打分）。
 *  - **覆盖前置（core/stockout-evidence 唯一判定）**：告警本身来自 getOnHandBySku＝
 *    实时仓余额 + 快照仓最新快照。所以只有当该 SKU 在窗口内**没有快照仓在库**时，
 *    每条告警按自己的窗口检查实时账起点证据、逐仓快照基线与期间变化；未知不补零，
 *    才允许按已登记仓证据打真/误的分；不证明未接入仓或日内快照间的轨迹。
 *    （此前只要历史上在实时仓动过一笔就标 coverage=realtime 并打分，
 *    于是"货在快照仓、偶尔有一笔实时仓调拨"的 SKU 被拿去算精确率，而那个数是人调阈值的依据。）
 *  - 期初 = 窗口前全部流水累计；逐笔推演窗口内余额取最小值。
 *  - true_positive  = 窗口内实时仓总余额曾 ≤ 0，且窗口内连同前 30 天有正的销售净出库（扣销售红字）。
 *  - false_positive = 余额从未归零，且窗口内没有任何入库（没人补货、也没断——阈值/日销估高了）。
 *  - unverifiable   = 覆盖不足（无实时仓 / 该 SKU 无实时流水 / 窗口内仍有快照仓在库）；
 *                     或流水看不到正的销售净需求（调拨/发料/盘点等不算销售）；
 *                     或窗口内有入库（可能是告警促成了补货、断货被规避——无法与误报区分，只能弃权）。
 * 每条告警只核验一次（幂等键 `${alertId}:verify`）；旧版本记录不覆盖、不自动重算，
 * 非当前版本不进入当前精确率，另披露历史记录数。结果不回写 system_alerts，不调参数。
 */
import { and, eq, gte, inArray, lt, lte, sql } from "drizzle-orm";
import * as schema from "@/db/schema";
import { dAdd, dCmp, dSub } from "@/server/core/decimal";
import type { AnyDb } from "@/server/core/svc";
import { classifyLedgerCoverage, loadStockUniverseCoverage, type CoverageReason, type LedgerCoverage, type StockUniverseCoverage } from "@/server/core/stockout-evidence";
import { appendAlertEvents, type AlertEventInput } from "@/server/modules/alerts/engine";
import { salesLedgerMovement } from "@/server/core/sales-ledger";

// v3：需求只认销售净出库，不把非销售作业或已冲销的销售学成正确预警；旧证据只保留不重写。
export const ALERT_OUTCOME_VERSION = "alert-outcome/v3";
export const VERIFY_AFTER_DAYS = 3;
export const VERIFY_GRACE_DAYS = 3;
export const DEMAND_LOOKBACK_DAYS = 30;
export const VERIFIED_CATEGORIES = ["inventory_cover"] as const;
const DAY_MS = 86_400_000;

export type AlertOutcomeResult = "true_positive" | "false_positive" | "unverifiable";
export type AlertOutcomeReason = CoverageReason
  | "zero_stock_with_demand"
  | "stock_never_zero"
  | "no_net_sales_demand"
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
  if (m) {
    const id = Number(m[1]);
    // 历史异常键不能把非法整数送入覆盖查询，导致同批正常告警一起失败。
    if (Number.isInteger(id) && id > 0 && id <= 2_147_483_647) return id;
  }
  if (row.refKey && codeToId.has(row.refKey)) return codeToId.get(row.refKey)!;
  return null;
}

async function verifyOne(
  db: AnyDb,
  input: { coverageKey: string; skuId: number; windowStart: Date; windowEnd: Date; realtimeIds: number[]; coverage: StockUniverseCoverage },
): Promise<Omit<AlertOutcomeEvidence, "version" | "skuId" | "windowStart" | "windowEnd" | "realtimeWarehouses">> {
  const l = schema.stockLedger;
  const inRealtime = inArray(l.warehouseId, input.realtimeIds);
  // 覆盖前置：唯一判定在 core/stockout-evidence（与 report/closed-loop 抑制复核同一份）
  const cov = classifyLedgerCoverage(input.coverageKey, input.coverage);
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
    .where(and(eq(l.skuId, input.skuId), inRealtime, salesLedgerMovement(), gte(l.occurredAt, lookbackStart), lt(l.occurredAt, input.windowStart)));
  const moves: { qtyDelta: string; isSale: boolean }[] = await db.select({ qtyDelta: l.qtyDelta, isSale: sql<boolean>`${salesLedgerMovement()}` }).from(l)
    .where(and(eq(l.skuId, input.skuId), inRealtime, gte(l.occurredAt, input.windowStart), lte(l.occurredAt, input.windowEnd)))
    .orderBy(l.occurredAt, l.id);

  let running = opening?.qty ?? "0";
  // 无窗前流水时，覆盖前置只允许首笔恰在起点。那笔之前的未知零不是窗口内的观测最低值。
  // 首笔正向仍计入 inbound，不能借此把真实补货伪装成已验收期初。
  const openingBalance = opening?.qty ?? null;
  let minBalance = openingBalance;
  let demandOut = "0";
  let inbound = "0";
  for (const m of moves) {
    running = dAdd(running, m.qtyDelta, 4);
    if (minBalance == null || dCmp(running, minBalance) < 0) minBalance = running;
    if (m.isSale) demandOut = dSub(demandOut, m.qtyDelta, 4); // 销售负向累加，销售红字正向净减
    if (dCmp(m.qtyDelta, "0") > 0) inbound = dAdd(inbound, m.qtyDelta, 4);
  }
  const lookbackOut = lookback?.qty ?? "0";
  const base = { coverage: "realtime" as const, openingBalance, minBalance, demandOutQty: demandOut, lookbackOutQty: lookbackOut, inboundQty: inbound };
  if (minBalance == null) {
    return { ...base, result: "unverifiable", reason: "snapshot_only_no_realtime_ledger", note: "窗口内未取得可回放的余额证据，弃权不打分" };
  }
  // 同一个连贯窗口净额：前窗销售在后窗被红字冲销，不能各窗取正再 OR 成需求。
  const hasDemand = dCmp(dAdd(demandOut, lookbackOut, 4), "0") > 0;
  if (!hasDemand) {
    return { ...base, result: "unverifiable", reason: "no_net_sales_demand", note: "观察窗及前30天无正的销售净出库证据；非销售作业不算需求，外部需求可能未入此账，弃权" };
  }
  if (dCmp(minBalance, "0") <= 0) {
    return { ...base, result: "true_positive", reason: "zero_stock_with_demand", note: "窗口内实时仓余额归零且有销售净出库需求：断货确实发生" };
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

  // 查询合批，覆盖判定仍按每条告警自己的闭区间；同一 SKU 的不同告警不能互借证据。
  const windowEndOf = (r: CandidateRow) => new Date(new Date(r.resolvedAt ?? now).getTime() + VERIFY_GRACE_DAYS * DAY_MS);
  const coverage = await loadStockUniverseCoverage(db, { windows: rows.flatMap((r) => {
    const skuId = skuIdFromAlert(r, codeToId);
    return skuId == null ? [] : [{ key: `alert:${r.id}`, skuId, from: new Date(r.createdAt), to: windowEndOf(r) }];
  }) });

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
      : await verifyOne(db, { coverageKey: `alert:${r.id}`, skuId, windowStart, windowEnd, realtimeIds, coverage });
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
  /** 当前口径的核验事件数（包含弃权）；旧/缺版本不混入当前结果。 */
  verifiedTotal: number;
  /** 同一时间窗内保留但未按当前口径重验的旧版/缺版本事件数。 */
  legacyVerifiedTotal: number;
  groups: AlertPrecisionGroup[];
  caliber: string;
}

export const ALERT_PRECISION_CALIBER =
  "精确率 = 已核验为真 ÷ (真 + 误报)；弃权（快照仓 SKU / 窗口内仍有快照仓在库 / 窗口内有入库 / 看不到需求）单列不进分母；"
  + "仅按每条告警独立窗口的已登记仓证据打分：实时账起点已存在，逐仓快照期初和期间明确为零；缺失、非零或无效快照弃权；"
  + "需求仅看观察窗连同前30天的销售净出库，销售红字按纠正业务日净减；调拨/发料/盘亏等作业不算需求；"
  + `只纳入 ${ALERT_OUTCOME_VERSION}，非当前/缺版本历史核验另列，不改写、不自动重算；窗口按核验时间；每条告警只核验一次`;

/** 近 N 天已核验告警按 category × sourceRule 的真/误/弃权计数（供后续 UI 块；不给单一总分） */
export async function alertPrecision(db: AnyDb, opts: { days: number; now?: Date }): Promise<AlertPrecisionSummary> {
  const now = opts.now ?? new Date();
  const days = Math.max(1, Math.min(365, Math.floor(opts.days)));
  const since = new Date(now.getTime() - days * DAY_MS);
  const e = schema.alertEvents;
  const a = schema.systemAlerts;
  const rows: { category: string; sourceRule: string | null; result: string | null; version: string | null }[] = await db
    .select({ category: a.category, sourceRule: a.sourceRule, result: sql<string | null>`${e.evidenceRef}->>'result'`, version: sql<string | null>`${e.evidenceRef}->>'version'` })
    .from(e)
    .innerJoin(a, eq(a.id, e.alertId))
    .where(and(eq(e.event, "verify"), gte(e.at, since)));
  const groups = new Map<string, AlertPrecisionGroup>();
  const currentRows = rows.filter((row) => row.version === ALERT_OUTCOME_VERSION);
  for (const r of currentRows) {
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
  return { days, verifiedTotal: currentRows.length, legacyVerifiedTotal: rows.length - currentRows.length, groups: out, caliber: ALERT_PRECISION_CALIBER };
}
