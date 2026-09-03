/**
 * 建议闭环追踪（只读报表层）：补货建议 / NPD 首单 → 生成的 BH 草稿 → 其审批/执行状态。
 *
 * 链路来源（既有审计，不新增口径）：
 * - audit_logs action='draft_bh'（补货建议页 createReplenishDraft，after={docNo,lineCount,source}）；
 * - audit_logs action='first_order_draft'（NPD 首单 createFirstOrder，after={docNo,skuCode,qty}）。
 * 以 after.docNo 关联 bh_docs 取当前状态；createBy 经 users 解析姓名。
 * 采纳率 = 进入审批通过及以后状态（approved/in_progress/completed）÷ 建议草稿总数。
 * 只读不写库、无金额字段免脱敏。
 *
 * 闭环审计 #12(a) 建议准确度（getSuggestionAccuracy）：采纳率量的是"照做了没有"，不是"建议对不对"。
 * 以 planning_version_lines（人工捕获的建议快照，含 decisionEnvelope.outputs.netRequiredBeforeRounding 与 horizonDays）为样本，
 * 逐行对比 净需求 vs 视野期内实际下单（bh_lines + po_lines）vs 视野期内实际出库（stock_ledger 实时仓），
 * 只给分布与样本数，不给单一准确率分数——视野期归因本身有争议，一个数字会把争议藏起来。
 * 「已复核并放弃」（audit_logs action=decline_suggestion，replenish/decline.ts）单独计数，不进采纳率分母。
 */
import { and, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { getDbAsync } from "@/db";
import * as schema from "@/db/schema";
import { dAdd, dCmp, dDiv, dMul, dSub } from "@/server/core/decimal";
import { num, r1 } from "@/server/core/svc";
import { DOC_STATUS_LABELS } from "@/components/labels";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle PGlite/Postgres structural compatibility is narrowed by the surrounding service contract
type AnyDb = any;

/** 单据状态 → 中文标签（兼容 PRD 命名与实际枚举） */
const STATUS_LABEL: Record<string, string> = {
  ...DOC_STATUS_LABELS, // 唯一源（components/labels，纯 TS 可跨层复用）
  done: "已完成", rejected: "已驳回", // PRD 命名兼容
};

/** 采纳类：进入审批通过及以后状态 */
const ADOPTED = new Set(["approved", "in_progress", "completed", "done"]);
/** 待审批类 */
const PENDING = new Set(["draft", "pending"]);

export interface ClosedLoopRow {
  id: number;
  createdAt: string;
  docNo: string;
  source: string;
  lineCount: number;
  createdBy: string;
  /** BH 当前状态码；单据不存在 = '已删除' */
  currentStatus: string;
  /** E3-01：下游实际到货量与到货率（WO→JG→SH 正常行实收，与 wip.ts 同口径） */
  receivedQty: number;
  plannedQty: number;
  receiptRate: number | null;
  statusLabel: string;
  downstreamWo: string;
}

export interface ClosedLoopSummary {
  total: number;
  adopted: number; // 采纳中/已完成
  pending: number; // 待审批
  rejected: number; // 已否决/关闭
  deleted: number; // 已删除
  adoptRate: number; // 采纳率（百分比，1 位小数）——口径=进入审批通过及以后
  /** E3-01：实际到货口径——建议最终有货落地的占比（比采纳率更硬） */
  deliveredRate: number;
  deliveredCount: number;
  /** 闭环审计 #12：已复核并放弃的建议条数（audit decline_suggestion）；不进采纳率分母，单列 */
  declined: number;
}

export interface ClosedLoopResult {
  rows: ClosedLoopRow[];
  total: number;
  summary: ClosedLoopSummary;
  accuracy: SuggestionAccuracy;
}

/* ────────────── 闭环审计 #12(a)：建议准确度分布 ────────────── */

export const SUGGESTION_ACCURACY_VERSION = "closed-loop-accuracy/v1";
export const ACCURACY_BUCKET_KEYS = ["none", "lt50", "50_90", "90_110", "110_150", "gt150"] as const;
export type AccuracyBucketKey = (typeof ACCURACY_BUCKET_KEYS)[number];
export const ACCURACY_BUCKET_LABELS: Record<AccuracyBucketKey, string> = {
  none: "0（没有发生）",
  lt50: "< 50%",
  "50_90": "50%–90%",
  "90_110": "90%–110%",
  "110_150": "110%–150%",
  gt150: "> 150%",
};

export interface AccuracyBucket { key: AccuracyBucketKey; label: string; count: number }

export interface SuggestionAccuracy {
  version: typeof SUGGESTION_ACCURACY_VERSION;
  /** 样本 = 已捕获的建议行（未抑制、净需求 > 0；同 SKU 同业务日只取最新版本） */
  sample: number;
  /** 视野期已走完（业务日 + horizonDays ≤ 今天）——只有这些行进入分布 */
  matured: number;
  immature: number;
  /** 视野期内实际下单量（bh_lines + po_lines 基础单位）÷ 净需求 */
  orderedVsRequired: AccuracyBucket[];
  /** 视野期内实时仓实际出库 ÷ 净需求（快照仓 SKU 无流水 → 不进此分布，见 ledgerCoverage） */
  outboundVsRequired: AccuracyBucket[];
  ledgerCoverage: { withRealtimeLedger: number; snapshotOnly: number };
  caliber: string[];
}

export const SUGGESTION_ACCURACY_CALIBER = [
  "样本来自 planning_version_lines 的人工捕获快照（未抑制、净需求 > 0），同 SKU 同业务日取最新版本；未捕获的日常建议不在样本内",
  "视野期 = 业务日起 decisionEnvelope.inputs.policy.horizonDays 天（缺失按 60）；只对视野期已走完的行做对比",
  "实际下单 = 视野期内创建、非作废的 BH 行 + PO 行（PO 按 uom_factor 折基础单位）；实际出库 = 视野期内实时仓流水出库合计（含调拨/发料，非纯销售）",
  "只给分布与样本数，不给单一准确率——视野期归因有争议；快照仓 SKU 无流水，出库分布弃权并单列覆盖数",
];

function bucketOf(actual: string, required: string): AccuracyBucketKey {
  if (dCmp(actual, "0") <= 0) return "none";
  const pct = num(dMul(dDiv(actual, required, 6), "100", 4));
  if (pct < 50) return "lt50";
  if (pct < 90) return "50_90";
  if (pct <= 110) return "90_110";
  if (pct <= 150) return "110_150";
  return "gt150";
}

function emptyBuckets(): Record<AccuracyBucketKey, number> {
  return { none: 0, lt50: 0, "50_90": 0, "90_110": 0, "110_150": 0, gt150: 0 };
}

function toBucketList(counts: Record<AccuracyBucketKey, number>): AccuracyBucket[] {
  return ACCURACY_BUCKET_KEYS.map((key) => ({ key, label: ACCURACY_BUCKET_LABELS[key], count: counts[key] }));
}

const DAY_MS = 86_400_000;
const DEFAULT_HORIZON_DAYS = 60;
function shanghaiDay(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(d);
}
function shanghaiStart(day: string): Date {
  return new Date(`${day}T00:00:00+08:00`);
}

type EnvelopeLike = {
  businessDate?: unknown;
  inputs?: { policy?: { horizonDays?: unknown } };
  outputs?: { netRequiredBeforeRounding?: unknown };
};

export async function getSuggestionAccuracy(dbArg?: AnyDb, opts?: { now?: Date; limit?: number }): Promise<SuggestionAccuracy> {
  const db: AnyDb = dbArg ?? (await getDbAsync());
  const now = opts?.now ?? new Date();
  const today = shanghaiDay(now);
  const limit = Math.max(1, Math.min(5000, opts?.limit ?? 2000));
  const pl = schema.planningVersionLines;
  const pv = schema.planningVersions;
  const lines: { versionId: number; skuId: number; suggestedQty: string; suppressed: boolean; envelope: unknown; createdAt: Date }[] = await db
    .select({ versionId: pl.versionId, skuId: pl.skuId, suggestedQty: pl.suggestedQty, suppressed: pl.suppressed, envelope: pl.decisionEnvelope, createdAt: pv.createdAt })
    .from(pl)
    .innerJoin(pv, eq(pv.id, pl.versionId))
    .where(eq(pl.suppressed, false))
    .orderBy(desc(pl.versionId), pl.id)
    .limit(limit);

  type Sample = { skuId: number; versionId: number; businessDate: string; horizonDays: number; required: string };
  const latest = new Map<string, Sample>();
  for (const l of lines) {
    const env = (l.envelope ?? {}) as EnvelopeLike;
    const businessDate = typeof env.businessDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(env.businessDate) ? env.businessDate : shanghaiDay(new Date(l.createdAt));
    const horizonRaw = Number(env.inputs?.policy?.horizonDays);
    const horizonDays = Number.isFinite(horizonRaw) && horizonRaw > 0 ? Math.min(365, Math.floor(horizonRaw)) : DEFAULT_HORIZON_DAYS;
    const netRaw = env.outputs?.netRequiredBeforeRounding;
    const required = typeof netRaw === "string" && /^-?\d+(\.\d+)?$/.test(netRaw) ? netRaw : String(l.suggestedQty);
    if (dCmp(required, "0") <= 0) continue;
    const key = `${l.skuId}|${businessDate}`;
    const cur = latest.get(key);
    if (!cur || l.versionId > cur.versionId) latest.set(key, { skuId: l.skuId, versionId: l.versionId, businessDate, horizonDays, required });
  }
  const samples = [...latest.values()];
  const matured = samples.filter((s) => shanghaiDay(new Date(shanghaiStart(s.businessDate).getTime() + s.horizonDays * DAY_MS)) <= today);
  const result: SuggestionAccuracy = {
    version: SUGGESTION_ACCURACY_VERSION,
    sample: samples.length,
    matured: matured.length,
    immature: samples.length - matured.length,
    orderedVsRequired: toBucketList(emptyBuckets()),
    outboundVsRequired: toBucketList(emptyBuckets()),
    ledgerCoverage: { withRealtimeLedger: 0, snapshotOnly: 0 },
    caliber: [...SUGGESTION_ACCURACY_CALIBER],
  };
  if (!matured.length) return result;

  const skuIds = [...new Set(matured.map((s) => s.skuId))];
  const minStart = matured.reduce((m, s) => (s.businessDate < m ? s.businessDate : m), matured[0].businessDate);
  const windowFrom = shanghaiStart(minStart);

  // 实际下单：BH 行（非作废）+ PO 行（非作废，按 uom_factor 折基础单位），按单据创建时间落入视野期
  const bh: { skuId: number; qty: string; createdAt: Date }[] = await db
    .select({ skuId: schema.bhLines.skuId, qty: schema.bhLines.qty, createdAt: schema.bhDocs.createdAt })
    .from(schema.bhLines)
    .innerJoin(schema.bhDocs, eq(schema.bhDocs.id, schema.bhLines.bhId))
    .where(and(inArray(schema.bhLines.skuId, skuIds), gte(schema.bhDocs.createdAt, windowFrom), sql`${schema.bhDocs.status} <> 'void'`));
  const po: { skuId: number; qty: string; createdAt: Date }[] = await db
    .select({ skuId: schema.poLines.skuId, qty: sql<string>`(${schema.poLines.qty} * ${schema.poLines.uomFactor})::text`, createdAt: schema.poDocs.createdAt })
    .from(schema.poLines)
    .innerJoin(schema.poDocs, eq(schema.poDocs.id, schema.poLines.poId))
    .where(and(inArray(schema.poLines.skuId, skuIds), gte(schema.poDocs.createdAt, windowFrom), sql`${schema.poDocs.status} <> 'void'`));
  const orders = [...bh, ...po];

  // 实际出库：实时仓流水（快照仓无流水 → 覆盖弃权）
  const realtime: { id: number }[] = await db.select({ id: schema.warehouses.id }).from(schema.warehouses).where(eq(schema.warehouses.accountingMode, "realtime"));
  const realtimeIds = realtime.map((w) => w.id);
  const l = schema.stockLedger;
  const outs: { skuId: number; qty: string; at: Date }[] = realtimeIds.length
    ? await db
        .select({ skuId: l.skuId, qty: l.qtyDelta, at: l.occurredAt })
        .from(l)
        .where(and(inArray(l.skuId, skuIds), inArray(l.warehouseId, realtimeIds), gte(l.occurredAt, windowFrom), lt(l.qtyDelta, "0")))
    : [];
  const ledgerEver: { skuId: number }[] = realtimeIds.length
    ? await db.selectDistinct({ skuId: l.skuId }).from(l).where(and(inArray(l.skuId, skuIds), inArray(l.warehouseId, realtimeIds)))
    : [];
  const skuWithLedger = new Set(ledgerEver.map((r) => r.skuId));

  const ordered = emptyBuckets();
  const outbound = emptyBuckets();
  for (const s of matured) {
    const from = shanghaiStart(s.businessDate).getTime();
    const to = from + s.horizonDays * DAY_MS;
    let orderedQty = "0";
    for (const o of orders) {
      const t = new Date(o.createdAt).getTime();
      if (o.skuId === s.skuId && t >= from && t < to) orderedQty = dAdd(orderedQty, o.qty, 4);
    }
    ordered[bucketOf(orderedQty, s.required)]++;
    if (!skuWithLedger.has(s.skuId)) { result.ledgerCoverage.snapshotOnly++; continue; }
    result.ledgerCoverage.withRealtimeLedger++;
    let outQty = "0";
    for (const o of outs) {
      const t = new Date(o.at).getTime();
      if (o.skuId === s.skuId && t >= from && t < to) outQty = dSub(outQty, o.qty, 4);
    }
    outbound[bucketOf(outQty, s.required)]++;
  }
  result.orderedVsRequired = toBucketList(ordered);
  result.outboundVsRequired = toBucketList(outbound);
  return result;
}

/** 已复核并放弃的建议条数（audit_logs entity=replenish action=decline_suggestion） */
export async function countDeclinedSuggestions(dbArg?: AnyDb): Promise<number> {
  const db: AnyDb = dbArg ?? (await getDbAsync());
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.auditLogs)
    .where(and(eq(schema.auditLogs.entity, "replenish"), eq(schema.auditLogs.action, "decline_suggestion")));
  return Number(row?.n ?? 0);
}

export async function getClosedLoop(
  query: { page?: number; pageSize?: number },
  dbArg?: AnyDb,
): Promise<ClosedLoopResult> {
  const db: AnyDb = dbArg ?? (await getDbAsync());
  const page = Math.max(1, query.page ?? 1);
  const pageSize = Math.min(500, Math.max(1, query.pageSize ?? 20));

  const al = schema.auditLogs;
  const logs: { id: number; userId: number; action: string; after: unknown; createdAt: Date }[] = await db
    .select({ id: al.id, userId: al.userId, action: al.action, after: al.after, createdAt: al.createdAt })
    .from(al)
    .where(inArray(al.action, ["draft_bh", "first_order_draft"]))
    .orderBy(desc(al.createdAt), desc(al.id));

  // 解析制单人姓名
  const userIds = [...new Set(logs.map((l) => l.userId).filter((v) => v != null))];
  const userRows: { id: number; name: string }[] = userIds.length
    ? await db.select({ id: schema.users.id, name: schema.users.name }).from(schema.users).where(inArray(schema.users.id, userIds))
    : [];
  const nameById = new Map<number, string>(userRows.map((u) => [u.id, u.name]));

  // 关联 BH 当前状态
  const docNos = [
    ...new Set(
      logs
        .map((l) => (l.after as { docNo?: unknown } | null)?.docNo)
        .filter((v): v is string => typeof v === "string" && v.length > 0),
    ),
  ];
  const bhRows: { docNo: string; status: string }[] = docNos.length
    ? await db.select({ docNo: schema.bhDocs.docNo, status: schema.bhDocs.status }).from(schema.bhDocs).where(inArray(schema.bhDocs.docNo, docNos))
    : [];
  const statusByDocNo = new Map<string, string>(bhRows.map((b) => [b.docNo, b.status]));

  // func#3 下游追溯：BH → 子 WO（woDocs.bhId）最远阶段——采纳不等于到货
  const bhIdByDocNo = new Map<string, number>();
  if (docNos.length) {
    const idRows: { id: number; docNo: string }[] = await db.select({ id: schema.bhDocs.id, docNo: schema.bhDocs.docNo }).from(schema.bhDocs).where(inArray(schema.bhDocs.docNo, docNos));
    for (const r of idRows) bhIdByDocNo.set(r.docNo, r.id);
  }
  const bhIds = [...bhIdByDocNo.values()];
  const STAGE_RANK: Record<string, number> = { draft: 0, pending: 1, approved: 2, in_progress: 3, completed: 4, closed: 4, void: -1 };
  const woStageByBhId = new Map<number, string>();
  if (bhIds.length) {
    const woRows: { bhId: number | null; status: string }[] = await db
      .select({ bhId: schema.woDocs.bhId, status: schema.woDocs.status })
      .from(schema.woDocs)
      .where(inArray(schema.woDocs.bhId, bhIds));
    for (const w of woRows) {
      if (w.bhId == null) continue;
      const cur = woStageByBhId.get(w.bhId);
      if (!cur || (STAGE_RANK[w.status] ?? 0) > (STAGE_RANK[cur] ?? 0)) woStageByBhId.set(w.bhId, w.status);
    }
  }

  /* ── E3-01：闭环延伸到入库——采纳≠到货。经 WO→JG→SH(正常行,已生效) 累计实收 ── */
  const woIdsByBh = new Map<number, number[]>();
  const woQtyByBh = new Map<number, number>();
  if (bhIds.length) {
    const woFull: { id: number; bhId: number | null; qty: string }[] = await db
      .select({ id: schema.woDocs.id, bhId: schema.woDocs.bhId, qty: schema.woDocs.qty })
      .from(schema.woDocs)
      .where(inArray(schema.woDocs.bhId, bhIds));
    for (const w of woFull) {
      if (w.bhId == null) continue;
      (woIdsByBh.get(w.bhId) ?? woIdsByBh.set(w.bhId, []).get(w.bhId)!).push(w.id);
      woQtyByBh.set(w.bhId, (woQtyByBh.get(w.bhId) ?? 0) + num(w.qty));
    }
  }
  const allWoIds = [...woIdsByBh.values()].flat();
  const receivedByWo = new Map<number, number>();
  if (allWoIds.length) {
    const jgRows: { id: number; woId: number }[] = await db
      .select({ id: schema.jgDocs.id, woId: schema.jgDocs.woId })
      .from(schema.jgDocs)
      .where(inArray(schema.jgDocs.woId, allWoIds));
    const woByJg = new Map(jgRows.map((j) => [j.id, j.woId]));
    const jgIds = jgRows.map((j) => j.id);
    if (jgIds.length) {
      const recv: { jgId: number; qty: string | null }[] = await db
        .select({ jgId: schema.shDocs.sourceId, qty: sql<string | null>`sum(${schema.shLines.actualQty})` })
        .from(schema.shLines)
        .innerJoin(schema.shDocs, eq(schema.shLines.shId, schema.shDocs.id))
        .where(and(
          eq(schema.shDocs.sourceType, "jg"),
          inArray(schema.shDocs.sourceId, jgIds),
          inArray(schema.shDocs.status, ["approved", "in_progress", "completed"]),
          eq(schema.shLines.lineType, "normal"),
        ))
        .groupBy(schema.shDocs.sourceId);
      for (const r of recv) {
        const woId = woByJg.get(r.jgId);
        if (woId == null) continue;
        receivedByWo.set(woId, (receivedByWo.get(woId) ?? 0) + num(r.qty));
      }
    }
  }
  const receivedByBh = new Map<number, number>();
  for (const [bhId, woIds] of woIdsByBh) {
    receivedByBh.set(bhId, woIds.reduce((a, id) => a + (receivedByWo.get(id) ?? 0), 0));
  }

  const all: ClosedLoopRow[] = logs.map((l) => {
    const after = (l.after ?? {}) as { docNo?: unknown; source?: unknown; lineCount?: unknown };
    const docNo = typeof after.docNo === "string" ? after.docNo : "";
    const source =
      typeof after.source === "string" && after.source
        ? after.source === "replenish_suggestion"
          ? "补货建议"
          : after.source
        : l.action === "first_order_draft"
          ? "NPD首单"
          : "补货建议";
    const lineCount = after.lineCount != null ? num(after.lineCount) : 1;
    const status = docNo ? statusByDocNo.get(docNo) : undefined;
    const currentStatus = status ?? "已删除";
    const statusLabel = status ? STATUS_LABEL[status] ?? status : "已删除";
    const bhId = docNo ? bhIdByDocNo.get(docNo) : undefined;
    const woStage = bhId != null ? woStageByBhId.get(bhId) : undefined;
    const downstreamWo = woStage ? (STATUS_LABEL[woStage] ?? woStage) : (status === "approved" || status === "in_progress" || status === "completed") ? "未开工单" : "—";
    return {
      id: l.id,
      createdAt: (l.createdAt instanceof Date ? l.createdAt : new Date(l.createdAt)).toISOString(),
      docNo,
      source,
      lineCount,
      createdBy: nameById.get(l.userId) ?? `用户#${l.userId}`,
      currentStatus,
      statusLabel,
      downstreamWo,
      receivedQty: bhId != null ? r1(receivedByBh.get(bhId) ?? 0) : 0,
      plannedQty: bhId != null ? r1(woQtyByBh.get(bhId) ?? 0) : 0,
      receiptRate: bhId != null && (woQtyByBh.get(bhId) ?? 0) > 0
        ? r1(((receivedByBh.get(bhId) ?? 0) / (woQtyByBh.get(bhId) ?? 1)) * 100)
        : null,
    };
  });

  // 汇总
  let adopted = 0;
  let pending = 0;
  let rejected = 0;
  let deleted = 0;
  for (const r of all) {
    if (r.currentStatus === "已删除") deleted++;
    else if (ADOPTED.has(r.currentStatus)) adopted++;
    else if (PENDING.has(r.currentStatus)) pending++;
    else rejected++; // rejected/closed/void
  }
  const total = all.length;
  const adoptRate = total > 0 ? r1((adopted / total) * 100) : 0;
  // E3-01：实际到货 = 下游已有正常行实收（>0）
  const deliveredCount = all.filter((r) => r.receivedQty > 0).length;
  const deliveredRate = total > 0 ? r1((deliveredCount / total) * 100) : 0;
  // 已复核并放弃：单列，不进 total/adoptRate 分母（放弃是"看过并判断不需要"，与"草稿被否决"不是一回事）
  const [declined, accuracy] = await Promise.all([countDeclinedSuggestions(db), getSuggestionAccuracy(db)]);

  return {
    rows: all.slice((page - 1) * pageSize, page * pageSize),
    total,
    summary: { total, adopted, pending, rejected, deleted, adoptRate, deliveredRate, deliveredCount, declined },
    accuracy,
  };
}
