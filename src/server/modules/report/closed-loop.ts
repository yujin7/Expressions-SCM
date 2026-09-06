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
 *
 * 闭环审计 #12(b) 抑制复核（getSuppressionReview）：覆盖缺口闸门扣住的量（代码注释里那 115,391 件）此前从无回看。
 * 以 planning_version_lines 中 suppressed=true 的行为样本，在各自视野期内用实时仓流水判断「随后是否真的断货」，
 * 同样只给分布与样本数；快照仓 SKU 无流水一律弃权，不当作「抑制正确」。
 */
import { and, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { getDbAsync } from "@/db";
import * as schema from "@/db/schema";
import { shanghaiDayOf } from "@/server/core/business-day";
import { dAdd, dCmp, dDiv, dMul, dSub } from "@/server/core/decimal";
import { classifyLedgerCoverage, loadStockUniverseCoverage, type CoverageReason } from "@/server/core/stockout-evidence";
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
  /**
   * 采纳率（百分比，1 位小数）——口径=进入审批通过及以后。
   * **无建议草稿时为 null，不是 0**：0% 读作「建议全被无视」，与「还没有建议」是两回事，
   * 本轮其余新指标（otifRatePct / completionRate / passRatePct…）一律如此。
   */
  adoptRate: number | null;
  /** E3-01：实际到货口径——建议最终有货落地的占比（比采纳率更硬）；空总体 = null */
  deliveredRate: number | null;
  deliveredCount: number;
  /** 闭环审计 #12：已复核并放弃的建议条数（audit decline_suggestion）；不进采纳率分母，单列 */
  declined: number;
}

export interface ClosedLoopResult {
  rows: ClosedLoopRow[];
  total: number;
  summary: ClosedLoopSummary;
  accuracy: SuggestionAccuracy;
  /** 闭环审计 #12(b)：ref-gap 抑制闸门的回看（被扣住的建议后来断货了没有） */
  suppression: SuppressionReview;
}

/* ────────────── 闭环审计 #12(a)：建议准确度分布 ────────────── */

/**
 * v3：保留 v2 的引擎版本分组，出库统计资格改为逐样本 [from,to) 覆盖。
 * 不再以“未来某天曾有实时流水”证明历史可见；快照混合、起点缺失等单列原因，不算零出库。
 *
 * `planning_version_lines` 横跨所有历史版本，而 `planning_versions.engine_version` 在本波从
 * `time-phased-v2`（账面在库）换成了 `time-phased-v3`（可用在库＝账面在库扣临期净额）。
 * 一个不分版本的准确度数字于是横跨两套引擎口径：v3 把净需求量抬高之后，同样的实际下单量
 * 会落进更靠近 100% 的桶——**准确度看起来变好了，其实只是分母换了个算法**。而这个数字
 * 自己的版本串 `/v1` 一动不动，读者无从发现。
 *
 * 现在：总分布仍给（读者要的是"我们整体准不准"），但同时给 `byEngineVersion` 逐版本分布与
 * `engineMix`（各版本样本数），caliber 里明说混了几套引擎。键随口径升版。
 */
export const SUGGESTION_ACCURACY_VERSION = "closed-loop-accuracy/v3";
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

/** 逐引擎版本的样本与分布——总分布横跨多套引擎时，这里才看得出哪一套贡献了什么 */
export interface AccuracyByEngineVersion {
  /** planning_versions.engine_version 原值；捕获行缺该值时为 "(未记录)" */
  engineVersion: string;
  sample: number;
  matured: number;
  orderedVsRequired: AccuracyBucket[];
  outboundVsRequired: AccuracyBucket[];
}

/** 引擎版本未记录时的占位（旧快照可能没有该列值） */
export const UNKNOWN_ENGINE_VERSION = "(未记录)";

export interface SuggestionAccuracy {
  version: typeof SUGGESTION_ACCURACY_VERSION;
  /** 取数上限（planning_version_lines 按 versionId 倒序取的行数上限） */
  rowLimit: number;
  /**
   * 取数已被上限截断：样本只覆盖**最近的** rowLimit 行捕获记录，更早的版本没进分布。
   * 不暴露这个标志，一张「全部样本」的分布图其实只画了最新 2000 行——读者无从判断。
   */
  truncated: boolean;
  /** 样本 = 已捕获的建议行（未抑制、净需求 > 0；同 SKU 同业务日只取最新版本） */
  sample: number;
  /** 视野期已走完（业务日 + horizonDays ≤ 今天）——只有这些行进入分布 */
  matured: number;
  immature: number;
  /** 视野期内实际下单量（bh_lines + po_lines 基础单位）÷ 净需求 */
  orderedVsRequired: AccuracyBucket[];
  /** 视野期内实时仓实际出库 ÷ 净需求；仅逐样本覆盖合格者进入，未知不当作零 */
  outboundVsRequired: AccuracyBucket[];
  /** 仅计成熟样本：qualified + excluded = matured；原因计数之和 = excluded */
  ledgerCoverage: {
    qualified: number;
    excluded: number;
    reasons: { reason: CoverageReason; note: string; count: number }[];
  };
  /**
   * 样本里出现的引擎版本及其成熟样本数（按样本数降序）。
   * `engineMix.length > 1` = 上面的总分布**横跨多套引擎口径**，不能当成同一把尺子上的改善。
   */
  engineMix: { engineVersion: string; sample: number; matured: number }[];
  /** 逐引擎版本的分布（与总分布同法，只是样本被限定在该版本内） */
  byEngineVersion: AccuracyByEngineVersion[];
  caliber: string[];
}

export const SUGGESTION_ACCURACY_CALIBER = [
  "样本来自 planning_version_lines 的人工捕获快照（未抑制、净需求 > 0），同 SKU 同业务日取最新版本；未捕获的日常建议不在样本内",
  "视野期 = 业务日起 decisionEnvelope.inputs.policy.horizonDays 天（缺失按 60）；只对视野期已走完的行做对比",
  "实际下单 = 视野期内创建、非作废的 BH 行 + PO 行（PO 按 uom_factor 折基础单位）；实际出库 = 视野期内实时仓流水出库合计（含调拨/发料，非纯销售）",
  "只给分布与样本数，不给单一准确率——视野期归因有争议；出库仅统计逐样本覆盖合格者，覆盖不足按原因单列，不进出库分母；实际下单分布仍计全部成熟样本",
  "覆盖按每条成熟样本自己的上海业务日 [起点, 截止) 判断：起点已有实时流水，已登记快照仓期初及期间均明确为零；缺失、非零、无效快照或晚起点流水均弃权，不推断为零出库",
  "已覆盖且窗口内无出库才计 0 桶；覆盖仅证明当前已登记仓和已记录日快照，不代表未接入仓、日内快照之间轨迹或期初盘点已验收",
  "取数按版本倒序设有行上限（rowLimit）：命中上限时 truncated=true，样本只覆盖最近若干版本，更早的捕获记录不在分布内",
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
function shanghaiStart(day: string): Date {
  return new Date(`${day}T00:00:00+08:00`);
}

type EnvelopeLike = {
  businessDate?: unknown;
  inputs?: { policy?: { horizonDays?: unknown } };
  outputs?: { netRequiredBeforeRounding?: unknown };
};

/** 捕获样本：同 SKU 同业务日取最新版本后的一行；`qty` 的含义由取数方决定（净需求 / 被扣住的量） */
interface CapturedSample {
  skuId: number;
  versionId: number;
  businessDate: string;
  horizonDays: number;
  qty: string;
  /** planning_versions.engine_version（准确度必须能按引擎口径分组，否则跨口径的改善不可见） */
  engineVersion: string;
}

/**
 * 建议准确度（#12a）与抑制复核（#12b）的**共同前置**：db 解析、业务日与视野期换算、
 * 同 SKU 同业务日取最新版本、成熟度过滤。两者只在两处不同：读 suppressed=false 还是 true，
 * 以及取哪个数量字段。此前是两段逐字复制的 28 行——改一处漏一处，两张图的分母就会静默分叉。
 */
async function loadCapturedSamples(
  dbArg: AnyDb | undefined,
  opts: { now?: Date; limit?: number } | undefined,
  suppressed: boolean,
  qtyOf: (env: EnvelopeLike, suggestedQty: string) => string,
): Promise<{ db: AnyDb; limit: number; truncated: boolean; samples: CapturedSample[]; matured: CapturedSample[] }> {
  const db: AnyDb = dbArg ?? (await getDbAsync());
  const today = shanghaiDayOf(opts?.now ?? new Date());
  const limit = Math.max(1, Math.min(5000, opts?.limit ?? 2000));
  const pl = schema.planningVersionLines;
  const pv = schema.planningVersions;
  const lines: { versionId: number; skuId: number; suggestedQty: string; envelope: unknown; createdAt: Date; engineVersion: string | null }[] = await db
    .select({ versionId: pl.versionId, skuId: pl.skuId, suggestedQty: pl.suggestedQty, envelope: pl.decisionEnvelope, createdAt: pv.createdAt, engineVersion: pv.engineVersion })
    .from(pl)
    .innerJoin(pv, eq(pv.id, pl.versionId))
    .where(eq(pl.suppressed, suppressed))
    .orderBy(desc(pl.versionId), pl.id)
    .limit(limit);

  const latest = new Map<string, CapturedSample>();
  for (const l of lines) {
    const env = (l.envelope ?? {}) as EnvelopeLike;
    const businessDate = typeof env.businessDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(env.businessDate)
      ? env.businessDate
      : shanghaiDayOf(new Date(l.createdAt));
    const horizonRaw = Number(env.inputs?.policy?.horizonDays);
    const horizonDays = Number.isFinite(horizonRaw) && horizonRaw > 0 ? Math.min(365, Math.floor(horizonRaw)) : DEFAULT_HORIZON_DAYS;
    const qty = qtyOf(env, String(l.suggestedQty));
    if (dCmp(qty, "0") <= 0) continue;
    const key = `${l.skuId}|${businessDate}`;
    const cur = latest.get(key);
    if (!cur || l.versionId > cur.versionId) {
      latest.set(key, {
        skuId: l.skuId, versionId: l.versionId, businessDate, horizonDays, qty,
        engineVersion: (l.engineVersion ?? "").trim() || UNKNOWN_ENGINE_VERSION,
      });
    }
  }
  const samples = [...latest.values()];
  const matured = samples.filter((s) => shanghaiDayOf(new Date(shanghaiStart(s.businessDate).getTime() + s.horizonDays * DAY_MS)) <= today);
  return { db, limit, truncated: lines.length >= limit, samples, matured };
}

export async function getSuggestionAccuracy(dbArg?: AnyDb, opts?: { now?: Date; limit?: number }): Promise<SuggestionAccuracy> {
  const { db, limit, truncated, samples, matured } = await loadCapturedSamples(dbArg, opts, false, (env, suggestedQty) => {
    // 净需求优先取决策信封里的未取整值；缺失/非数才回落到建议量
    const netRaw = env.outputs?.netRequiredBeforeRounding;
    return typeof netRaw === "string" && /^-?\d+(\.\d+)?$/.test(netRaw) ? netRaw : suggestedQty;
  });
  const result: SuggestionAccuracy = {
    version: SUGGESTION_ACCURACY_VERSION,
    rowLimit: limit,
    truncated,
    sample: samples.length,
    matured: matured.length,
    immature: samples.length - matured.length,
    orderedVsRequired: toBucketList(emptyBuckets()),
    outboundVsRequired: toBucketList(emptyBuckets()),
    ledgerCoverage: { qualified: 0, excluded: 0, reasons: [] },
    engineMix: engineMixOf(samples, matured),
    byEngineVersion: [],
    caliber: [...SUGGESTION_ACCURACY_CALIBER, engineMixCaliber(engineMixOf(samples, matured))],
  };
  if (!matured.length) return result;

  const skuIds = [...new Set(matured.map((s) => s.skuId))];
  const minStart = matured.reduce((m, s) => (s.businessDate < m ? s.businessDate : m), matured[0].businessDate);
  const windowFrom = shanghaiStart(minStart);
  /* 红队审计 A8：上界也要有——只取真正落在**任何一条样本视野期**内的行；
     再按 SKU 建索引，避免"样本 × 全部行"的嵌套扫（本函数与抑制复核在每次页面加载时都跑）。
     窗口与索引都不改判定：逐条仍按各自 [from, to) 过滤，桶分布逐字不变。 */
  const windowTo = new Date(matured.reduce((m, s) => Math.max(m, shanghaiStart(s.businessDate).getTime() + s.horizonDays * DAY_MS), 0));

  // 实际下单：BH 行（非作废）+ PO 行（非作废，按 uom_factor 折基础单位），按单据创建时间落入视野期
  const bh: { skuId: number; qty: string; createdAt: Date }[] = await db
    .select({ skuId: schema.bhLines.skuId, qty: schema.bhLines.qty, createdAt: schema.bhDocs.createdAt })
    .from(schema.bhLines)
    .innerJoin(schema.bhDocs, eq(schema.bhDocs.id, schema.bhLines.bhId))
    .where(and(inArray(schema.bhLines.skuId, skuIds), gte(schema.bhDocs.createdAt, windowFrom), lt(schema.bhDocs.createdAt, windowTo), sql`${schema.bhDocs.status} <> 'void'`));
  const po: { skuId: number; qty: string; createdAt: Date }[] = await db
    .select({ skuId: schema.poLines.skuId, qty: sql<string>`(${schema.poLines.qty} * ${schema.poLines.uomFactor})::text`, createdAt: schema.poDocs.createdAt })
    .from(schema.poLines)
    .innerJoin(schema.poDocs, eq(schema.poDocs.id, schema.poLines.poId))
    .where(and(inArray(schema.poLines.skuId, skuIds), gte(schema.poDocs.createdAt, windowFrom), lt(schema.poDocs.createdAt, windowTo), sql`${schema.poDocs.status} <> 'void'`));
  const ordersBySku = new Map<number, { qty: string; t: number }[]>();
  for (const o of [...bh, ...po]) {
    const arr = ordersBySku.get(o.skuId) ?? [];
    arr.push({ qty: o.qty, t: new Date(o.createdAt).getTime() });
    ordersBySku.set(o.skuId, arr);
  }

  // 与告警/抑制复核共用覆盖权威；查询合批但窗口与样本身份独立，不借用其他样本证据。
  const coverageKey = (s: CapturedSample) => `accuracy:${s.versionId}:${s.skuId}:${s.businessDate}`;
  const coverage = await loadStockUniverseCoverage(db, { windows: matured.map((s) => ({
    key: coverageKey(s), skuId: s.skuId, from: shanghaiStart(s.businessDate),
    to: new Date(shanghaiStart(s.businessDate).getTime() + s.horizonDays * DAY_MS), endExclusive: true,
  })) });
  const realtimeIds = coverage.realtimeWarehouseIds;
  const l = schema.stockLedger;
  const outs: { skuId: number; qty: string; at: Date }[] = realtimeIds.length
    ? await db
        .select({ skuId: l.skuId, qty: l.qtyDelta, at: l.occurredAt })
        .from(l)
        .where(and(inArray(l.skuId, skuIds), inArray(l.warehouseId, realtimeIds), gte(l.occurredAt, windowFrom), lt(l.occurredAt, windowTo), lt(l.qtyDelta, "0")))
    : [];
  const outsBySku = new Map<number, { qty: string; t: number }[]>();
  for (const o of outs) {
    const arr = outsBySku.get(o.skuId) ?? [];
    arr.push({ qty: o.qty, t: new Date(o.at).getTime() });
    outsBySku.set(o.skuId, arr);
  }
  const ordered = emptyBuckets();
  const outbound = emptyBuckets();
  const coverageReasons = new Map<CoverageReason, { reason: CoverageReason; note: string; count: number }>();
  /* 逐引擎版本同步累计：总分布回答"整体准不准"，逐版本分布回答"这次改善是同一把尺子上的吗"。 */
  const perEngine = new Map<string, { ordered: ReturnType<typeof emptyBuckets>; outbound: ReturnType<typeof emptyBuckets> }>();
  const bucketsFor = (v: string) => {
    const cur = perEngine.get(v) ?? { ordered: emptyBuckets(), outbound: emptyBuckets() };
    perEngine.set(v, cur);
    return cur;
  };
  for (const s of matured) {
    const per = bucketsFor(s.engineVersion);
    const from = shanghaiStart(s.businessDate).getTime();
    const to = from + s.horizonDays * DAY_MS;
    let orderedQty = "0";
    for (const o of ordersBySku.get(s.skuId) ?? []) {
      if (o.t >= from && o.t < to) orderedQty = dAdd(orderedQty, o.qty, 4);
    }
    const ob = bucketOf(orderedQty, s.qty);
    ordered[ob]++;
    per.ordered[ob]++;
    const verdict = classifyLedgerCoverage(coverageKey(s), coverage);
    if (!verdict.covered) {
      if (verdict.reason == null) throw new Error("Suggestion coverage exclusion must have a reason");
      result.ledgerCoverage.excluded++;
      const reason = coverageReasons.get(verdict.reason) ?? { reason: verdict.reason, note: verdict.note, count: 0 };
      reason.count++;
      coverageReasons.set(verdict.reason, reason);
      continue;
    }
    result.ledgerCoverage.qualified++;
    let outQty = "0";
    for (const o of outsBySku.get(s.skuId) ?? []) {
      if (o.t >= from && o.t < to) outQty = dSub(outQty, o.qty, 4);
    }
    const xb = bucketOf(outQty, s.qty);
    outbound[xb]++;
    per.outbound[xb]++;
  }
  result.orderedVsRequired = toBucketList(ordered);
  result.outboundVsRequired = toBucketList(outbound);
  result.ledgerCoverage.reasons = [...coverageReasons.values()].sort((a, b) => a.reason < b.reason ? -1 : a.reason > b.reason ? 1 : 0);
  result.byEngineVersion = result.engineMix.map((m) => {
    const per = perEngine.get(m.engineVersion) ?? { ordered: emptyBuckets(), outbound: emptyBuckets() };
    return {
      engineVersion: m.engineVersion,
      sample: m.sample,
      matured: m.matured,
      orderedVsRequired: toBucketList(per.ordered),
      outboundVsRequired: toBucketList(per.outbound),
    };
  });
  return result;
}

/** 样本里出现过的引擎版本及其样本数（按成熟样本数、再按总样本数降序，版本名兜底稳定） */
function engineMixOf(samples: CapturedSample[], matured: CapturedSample[]): { engineVersion: string; sample: number; matured: number }[] {
  const mix = new Map<string, { sample: number; matured: number }>();
  for (const s of samples) {
    const e = mix.get(s.engineVersion) ?? { sample: 0, matured: 0 };
    e.sample += 1;
    mix.set(s.engineVersion, e);
  }
  for (const s of matured) {
    const e = mix.get(s.engineVersion) ?? { sample: 0, matured: 0 };
    e.matured += 1;
    mix.set(s.engineVersion, e);
  }
  return [...mix.entries()]
    .map(([engineVersion, v]) => ({ engineVersion, ...v }))
    .sort((a, b) => b.matured - a.matured || b.sample - a.sample || a.engineVersion.localeCompare(b.engineVersion));
}

/** 口径行：混了几套引擎必须写在脸上，否则"准确度改善"可能只是分母换了算法 */
function engineMixCaliber(mix: { engineVersion: string; sample: number; matured: number }[]): string {
  if (mix.length === 0) return "引擎版本：暂无捕获样本。";
  const detail = mix.map((m) => `${m.engineVersion}（成熟 ${m.matured}/${m.sample}）`).join("、");
  return mix.length === 1
    ? `引擎版本：全部样本来自 ${detail}，总分布是同一套引擎口径。`
    : `引擎版本：样本横跨 ${mix.length} 套引擎口径——${detail}。**总分布不是同一把尺子**（如 time-phased-v3 用可用在库、v2 用账面在库，净需求分母算法不同），跨版本的"改善"须逐版本对比 byEngineVersion 后才成立。`;
}

/* ────────────── W5 / 闭环审计 #12(b)：抑制复核（被抑制的建议后来断货了吗） ────────────── */

export const SUPPRESSION_REVIEW_VERSION = "closed-loop-suppression/v2";
export const SUPPRESSION_OUTCOME_KEYS = ["stockout_followed", "no_stockout", "unverifiable"] as const;
export type SuppressionOutcomeKey = (typeof SUPPRESSION_OUTCOME_KEYS)[number];
export const SUPPRESSION_OUTCOME_LABELS: Record<SuppressionOutcomeKey, string> = {
  stockout_followed: "随后断货（抑制可能是错的）",
  no_stockout: "未断货（抑制看起来是对的）",
  unverifiable: "无法核验（快照仓无流水 / 货仍在快照仓）",
};

export interface SuppressionOutcomeBucket {
  key: SuppressionOutcomeKey;
  label: string;
  /** 样本行数 */
  count: number;
  /** 该桶内被扣住的量合计（基础单位，decimal 字符串） */
  heldQty: string;
}

export interface SuppressionReview {
  version: typeof SUPPRESSION_REVIEW_VERSION;
  /** 取数上限（planning_version_lines 按 versionId 倒序取的行数上限） */
  rowLimit: number;
  /** 取数已被上限截断：样本只覆盖最近 rowLimit 行捕获记录 */
  truncated: boolean;
  /** 样本 = 已捕获的抑制行（同 SKU 同业务日取最新版本） */
  sample: number;
  matured: number;
  immature: number;
  /**
   * 被扣住的量合计——**全部样本**（含视野期未走完的行）。
   * 下面 `outcomes` 只覆盖已成熟样本，两者分母不同却并排显示过：
   * 「扣住 115,391 件」与三个结果桶之和对不上，读者会以为漏了。
   * 故并列给出 `heldQtyMatured`（= Σ outcomes.heldQty）与 `heldQtyImmature`，关系写死在读模型里。
   */
  heldQtyTotal: string;
  /** 其中视野期已走完的量（= 结果分布三个桶之和，与 outcomes 同分母） */
  heldQtyMatured: string;
  /** 其中视野期未走完、尚不判定的量（heldQtyTotal − heldQtyMatured） */
  heldQtyImmature: string;
  /** 已成熟样本的结果分布 */
  outcomes: SuppressionOutcomeBucket[];
  caliber: string[];
}

export const SUPPRESSION_REVIEW_CALIBER = [
  "样本来自 planning_version_lines 中 suppressed=true 的人工捕获快照（其 suggested_qty 即被扣住的 heldQty），同 SKU 同业务日取最新版本；未捕获的日常抑制不在样本内",
  "视野期 = 业务日起 decisionEnvelope.inputs.policy.horizonDays 天（缺失按 60）；只对视野期已走完的行判定",
  "视野期内实时仓合计余额曾 ≤ 0 且窗口内有出库 = 随后断货；结果分布不等同于告警命中率或抑制的因果正确率",
  "快照仓 SKU 在实时仓无流水，一律弃权计入「无法核验」，不当作「未断货」——把弃权算成成功正是抑制闸门最容易自我背书的地方",
  "覆盖判定与告警结果核验同源（core/stockout-evidence）：逐样本按自己的 [起点, 终点) 核验，起点或之前已有实时流水；逐仓检查期初及期间快照，仍有快照仓在库或缺明确零库存基线时弃权，不以窗口末清零或跨仓轧差冒充全窗覆盖",
  "覆盖只针对已登记仓与上海业务日快照，不证明未接入仓、日内快照间轨迹或实时账期初盘点完整性；不回写库存或抑制参数",
  "只给分布与样本数，不给单一「抑制正确率」：断货可能另有原因（外部渠道需求、后续补货已到），一个分数会把这些歧义藏起来",
  "heldQtyTotal 覆盖全部样本，结果分布只覆盖已成熟样本：两者分母不同，故并列 heldQtyMatured（= 三个结果桶之和）与 heldQtyImmature",
  "取数按版本倒序设有行上限（rowLimit）：命中上限时 truncated=true，更早的抑制记录不在样本内",
];

/**
 * 抑制复核：覆盖缺口（ref-gap）闸门扣住的建议，后来到底断货了没有。
 *
 * 代码注释里那句「实测 18 条、合计 115,391 件被抑制」一直没有下文——闸门是否正确从未被回看。
 * 本函数把每条被扣住的行放到它自己的视野期里，用实时仓流水判定断货是否发生，按分布给出。
 */
export async function getSuppressionReview(dbArg?: AnyDb, opts?: { now?: Date; limit?: number }): Promise<SuppressionReview> {
  // 被扣住的量就是建议量本身（抑制行不进净需求换算）
  const { db, limit, truncated, samples, matured } = await loadCapturedSamples(dbArg, opts, true, (_env, suggestedQty) => suggestedQty);
  const counts: Record<SuppressionOutcomeKey, { count: number; heldQty: string }> = {
    stockout_followed: { count: 0, heldQty: "0" },
    no_stockout: { count: 0, heldQty: "0" },
    unverifiable: { count: 0, heldQty: "0" },
  };
  const heldQtyTotal = samples.reduce((acc, s) => dAdd(acc, s.qty, 4), "0");
  const heldQtyMatured = matured.reduce((acc, s) => dAdd(acc, s.qty, 4), "0");
  const result: SuppressionReview = {
    version: SUPPRESSION_REVIEW_VERSION,
    rowLimit: limit,
    truncated,
    sample: samples.length,
    matured: matured.length,
    immature: samples.length - matured.length,
    heldQtyTotal,
    heldQtyMatured,
    heldQtyImmature: dSub(heldQtyTotal, heldQtyMatured, 4),
    outcomes: SUPPRESSION_OUTCOME_KEYS.map((key) => ({ key, label: SUPPRESSION_OUTCOME_LABELS[key], count: 0, heldQty: "0" })),
    caliber: [...SUPPRESSION_REVIEW_CALIBER],
  };
  if (!matured.length) return result;

  const skuIds = [...new Set(matured.map((s) => s.skuId))];
  /* 视野期窗口：本轮所有样本的 [最早业务日, 最晚视野期末)。
     红队审计 A8：原实现把这批 SKU 的**全部 stock_ledger 历史**读进内存（无任何时间界），
     每次页面加载都来一遍。现在窗口内的流水逐笔读、窗口之前的只读一个聚合期初，
     判定结果逐字不变（期初 = 窗口前累计，本来就只被当成一个起始水位）。 */
  const windowFromMs = matured.reduce((m, s) => Math.min(m, shanghaiStart(s.businessDate).getTime()), Number.POSITIVE_INFINITY);
  const windowToMs = matured.reduce((m, s) => Math.max(m, shanghaiStart(s.businessDate).getTime() + s.horizonDays * DAY_MS), 0);
  const windowFrom = new Date(windowFromMs);
  const windowTo = new Date(windowToMs);

  /* 覆盖判定与告警结果核验同一份实现（core/stockout-evidence）：
     红队审计 A3——原实现 level 从 0 起算、只累计实时仓流水，
     于是一个**收货进快照仓、只在实时仓发货**的 SKU 水位天生为负，恒判「随后断货」，
     抑制闸门被系统性判成"错了"。现在该 SKU 一律弃权。 */
  const coverageKey = (s: (typeof matured)[number]) => `suppression:${s.versionId}:${s.skuId}:${s.businessDate}`;
  const coverage = await loadStockUniverseCoverage(db, { windows: matured.map((s) => {
    const from = shanghaiStart(s.businessDate);
    return { key: coverageKey(s), skuId: s.skuId, from, to: new Date(from.getTime() + s.horizonDays * DAY_MS), endExclusive: true };
  }) });
  const realtimeIds = coverage.realtimeWarehouseIds;
  const l = schema.stockLedger;
  const opening: { skuId: number; qty: string | null }[] = realtimeIds.length
    ? await db
        .select({ skuId: l.skuId, qty: sql<string | null>`sum(${l.qtyDelta})` })
        .from(l)
        .where(and(inArray(l.skuId, skuIds), inArray(l.warehouseId, realtimeIds), lt(l.occurredAt, windowFrom)))
        .groupBy(l.skuId)
    : [];
  const openingBySku = new Map<number, string>(opening.map((r) => [r.skuId, r.qty ?? "0"]));
  const moves: { skuId: number; qtyDelta: string; at: Date }[] = realtimeIds.length
    ? await db
        .select({ skuId: l.skuId, qtyDelta: l.qtyDelta, at: l.occurredAt })
        .from(l)
        .where(and(inArray(l.skuId, skuIds), inArray(l.warehouseId, realtimeIds), gte(l.occurredAt, windowFrom), lt(l.occurredAt, windowTo)))
        .orderBy(l.occurredAt, l.id)
    : [];
  const bySku = new Map<number, { qtyDelta: string; t: number }[]>();
  for (const m of moves) {
    const arr = bySku.get(m.skuId) ?? [];
    arr.push({ qtyDelta: m.qtyDelta, t: new Date(m.at).getTime() });
    bySku.set(m.skuId, arr);
  }

  for (const s of matured) {
    const from = shanghaiStart(s.businessDate).getTime();
    const to = from + s.horizonDays * DAY_MS;
    let key: SuppressionOutcomeKey;
    const cov = classifyLedgerCoverage(coverageKey(s), coverage);
    if (!cov.covered) {
      key = "unverifiable"; // 无实时流水 / 货还在快照仓：没有能覆盖这批货的证据，弃权而不是判「没断货」
    } else {
      const rows = bySku.get(s.skuId) ?? [];
      let level = openingBySku.get(s.skuId) ?? "0";
      let hasOpening = openingBySku.has(s.skuId);
      for (const m of rows) if (m.t < from) {
        level = dAdd(level, m.qtyDelta, 4);
        hasOpening = true;
      }
      // 首笔恰在窗口起点时，无窗前记录不是观测到的 0；从首笔之后的余额开始取最低值。
      let minLevel: string | null = hasOpening ? level : null;
      let outQty = "0";
      for (const m of rows) {
        if (m.t < from || m.t >= to) continue;
        level = dAdd(level, m.qtyDelta, 4);
        if (minLevel == null || dCmp(level, minLevel) < 0) minLevel = level;
        if (dCmp(m.qtyDelta, "0") < 0) outQty = dSub(outQty, m.qtyDelta, 4);
      }
      key = minLevel == null ? "unverifiable"
        : dCmp(minLevel, "0") <= 0 && dCmp(outQty, "0") > 0 ? "stockout_followed" : "no_stockout";
    }
    counts[key].count += 1;
    counts[key].heldQty = dAdd(counts[key].heldQty, s.qty, 4);
  }
  result.outcomes = SUPPRESSION_OUTCOME_KEYS.map((k) => ({ key: k, label: SUPPRESSION_OUTCOME_LABELS[k], count: counts[k].count, heldQty: counts[k].heldQty }));
  return result;
}

/** 已复核并放弃的建议条数（audit_logs entity=replenish action=decline_suggestion） */
export async function countDeclinedSuggestions(dbArg?: AnyDb): Promise<number> {
  const db: AnyDb = dbArg ?? (await getDbAsync());
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.auditLogs)
    .where(and(eq(schema.auditLogs.entity, "replenish"), eq(schema.auditLogs.action, "decline_suggestion")));
  return Number(row?.n ?? 0);
}

/**
 * 闭环页读模型的**请求级记忆**（红队审计 A8）。
 *
 * getClosedLoop 每次调用都要跑：全量 draft_bh/first_order_draft 审计 + BH/WO/JG/SH 追溯
 * + getSuggestionAccuracy + getSuppressionReview（两者各自还要读一段流水），
 * 而这些数据一天之内不会变几次。缺省**不记忆**（测试与写后读一致性优先，与 workbench/focus 同纪律），
 * 由路由显式传 `memoMs: CLOSED_LOOP_MEMO_MS` 打开——记忆是进程内的，不落 report_read_model_cache，
 * 因此不需要 /vN 缓存键（口径改了随进程重启自然失效，不会把新线索藏在旧行里）。
 */
export const CLOSED_LOOP_MEMO_MS = 60_000;
const closedLoopMemo = new WeakMap<object, Map<string, { at: number; value: Promise<ClosedLoopResult> }>>();

export async function getClosedLoop(
  query: { page?: number; pageSize?: number },
  dbArg?: AnyDb,
  opts?: { memoMs?: number },
): Promise<ClosedLoopResult> {
  const db: AnyDb = dbArg ?? (await getDbAsync());
  const page = Math.max(1, query.page ?? 1);
  const pageSize = Math.min(500, Math.max(1, query.pageSize ?? 20));
  const memoMs = opts?.memoMs ?? 0;
  if (memoMs > 0) {
    const memoKey = `${page}|${pageSize}`;
    const perDb = closedLoopMemo.get(db as object) ?? new Map<string, { at: number; value: Promise<ClosedLoopResult> }>();
    closedLoopMemo.set(db as object, perDb);
    const hit = perDb.get(memoKey);
    if (hit && Date.now() - hit.at < memoMs) return hit.value;
    const value = computeClosedLoop(db, page, pageSize);
    perDb.set(memoKey, { at: Date.now(), value });
    value.catch(() => perDb.delete(memoKey));
    return value;
  }
  return computeClosedLoop(db, page, pageSize);
}

async function computeClosedLoop(db: AnyDb, page: number, pageSize: number): Promise<ClosedLoopResult> {

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
  // 百分比换算走 decimal（禁 float）；空总体给 null，不给 0%
  const adoptRate = total > 0 ? Number(dMul(dDiv(adopted, total, 6), 100, 1)) : null;
  // E3-01：实际到货 = 下游已有正常行实收（>0）
  const deliveredCount = all.filter((r) => r.receivedQty > 0).length;
  const deliveredRate = total > 0 ? Number(dMul(dDiv(deliveredCount, total, 6), 100, 1)) : null;
  // 已复核并放弃：单列，不进 total/adoptRate 分母（放弃是"看过并判断不需要"，与"草稿被否决"不是一回事）
  const [declined, accuracy, suppression] = await Promise.all([countDeclinedSuggestions(db), getSuggestionAccuracy(db), getSuppressionReview(db)]);

  return {
    rows: all.slice((page - 1) * pageSize, page * pageSize),
    total,
    summary: { total, adopted, pending, rejected, deleted, adoptRate, deliveredRate, deliveredCount, declined },
    accuracy,
    suppression,
  };
}
