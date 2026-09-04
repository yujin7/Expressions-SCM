/**
 * E5-06 供应商记分卡（只读报表 + 人工采纳分级）。
 *
 * 背景：suppliers.level（S–D）是采购**凭印象手工填**的，而算分所需的原料全在库里躺着——
 * 交期履约、质检结果、价格异动。本模块把三路数据按供应商聚合，交给 rules/scorecard.ts
 * 算出可解释的综合分与建议等级；写档案只有一条路 applySupplierLevel（人工点「采纳」才写）。
 *
 * ── 取数口径（全部沿用既有模块的口径，不新造）──
 * 1) 准时率：完全复用 rules/leadtime-stats.ts 的 leadTimeStats，样本取法与
 *    report/leadtime-learning.ts 一致——
 *      起算日 = po_docs.created_at（Asia/Shanghai 日界）；
 *      承诺到货日（W2 起**主口径 = 原始承诺**，口径唯一权威 rules/promise-basis.ts）：
 *        原始承诺 = 该 PO 行第一条可信 po_promise_revisions 的承诺日；无可信版本链回落当前承诺；
 *        当前承诺 = coalesce(po_lines.expected_date, po_docs.expected_date)（两者皆空 → 不进准时率分母）。
 *      为什么换：当前承诺是供应商自己能改的——经确认门户把交期往后挪一次，准时率立刻变好看，
 *      「改期越勤分数越高」。原始承诺进综合分，当前承诺作为并列副列（onTimeRateCurrent）只展示不计分。
 *      实际收货日 = 该 (PO, SKU) 最早一张生效 SH 的 created_at（生效 = approved/in_progress/completed，
 *      与 report/wip.ts 的 ACTIVE_SH_STATUSES 同集合）；
 *      负交期（收货早于制单，多为历史补录）丢弃。
 *      与 leadtime-learning 的唯一差别：那边按 (供应商 × SKU) 出行，这里把同一供应商的样本**汇总成一条**。
 *    局限：委外加工（JG）没有「承诺交期 vs 收货」的等价链路（dueDate 在 JG 上、收货走 SH sourceType='jg'），
 *    1.0 阶段准时率只覆盖采购 PO；纯加工厂该维度无数据 → 权重归一（见 rules/scorecard.ts）。
 * 2) 质检：qc_lines（一单一检，pass/fail/concession 三桶互斥、合计 ≤ 实收）。
 *    合格 = passQty；让步 = concessionQty + failHandling='concession' 的 failQty；
 *    报废 = failHandling='scrap' 的 failQty；返工 = 'rework'；待判定 = 'pending'。
 *    分母 = 判定总量 = pass + fail + concession（**不是**实收量——未检验的量不该进合格率分母）。
 *    PO 与 JG 两种收货都算（都是供应商交付质量），供应商分别取自 po_docs / jg_docs。
 * 3) 价格变更次数：pc_docs 窗口内**生效**（approved/in_progress/completed）单数；
 *    target='po_line' → po_lines→po_docs.supplier_id；target='jg_fee' → jg_docs.supplier_id。
 *    草稿/待审/驳回不算——没生效的调价不是调价。
 * 4) 样本数 sampleN = 窗口内该供应商的**生效收货单张数**（PO+JG 去重），作为置信度依据。
 *    选「收货单张数」而非「交期样本对数」：后者按 SKU 展开会高估样本量，
 *    且加工厂没有 PO 交期样本却有真实收货批次，用单张数才不会把它们一律打成低置信。
 *
 * 5) 质量案件（W2 审计 4b）：`quality_cases` 挂 supplier_id 的**未关闭**案件数与其中的**逾期**数
 *    （逾期 = reportDueDate < 今日 且未上报，判定复用 rules/quality-compliance.classifyDueState）。
 *    仅对**有案件**的供应商加进评分维度；无案件者维度不适用、分数与本次改动前逐位相同。
 *    窗口口径（W2 修复：此前只写在注释里，实现与页面标签都没兑现）：本维度**不受窗口限制**——
 *    取全部未关闭案件，一件 2023 年立案至今没结的案件在 2026 年照样扣分（久拖不决正是最该扣的）。
 *    但页面标着「近 180 天」，读者会以为这几件案子发生在窗口内。因此现在把**窗口外的陈年未结案件**
 *    单独计数（行上 `legacyQualityCases`、汇总 `qualityCaseScope`），并在标签里明说这一维不按窗口裁。
 *
 * 6) 平均准时率（W2 修复）：改为**样本加权（pooled）**——Σ准时批次 ÷ Σ有承诺交期的批次。
 *    此前是「各供应商准时率的算术平均」：9 家各 1 单 100% + 1 家 200 单 50%，算术平均 95.0%，
 *    而真实的整体准时率是 (9 + 100) / 209 ≈ 52.2%。一个只用来回答「我们整体准不准」的数，
 *    被样本量最小的那些供应商主导。副口径（当前承诺）同法。
 *    未评供应商（无承诺交期样本）**不进分母也不进分子**，其数量单列 `onTimeExcludedSuppliers`。
 *
 * 窗口：默认近 180 天（半年）——太短样本不够，太长会把早已改进的历史问题算进当期。
 * 只列窗口内**有信号**（有收货 / 有质检 / 有调价）的供应商；全无往来的供应商不占版面。
 */
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { getDbAsync } from "@/db";
import * as schema from "@/db/schema";
import { writeAudit } from "@/server/core/audit";
import { ApiError, todayShanghai, type SessionUser } from "@/server/modules/master/common";
import { SUPPLIER_LEVELS } from "@/server/modules/master/schemas";
import { requireAnyRole } from "@/server/modules/outsource/common";
import { leadTimeStats, type LeadTimeSample } from "@/server/rules/leadtime-stats";
import { classifyDueState } from "@/server/rules/quality-compliance";
import {
  countPromiseHistory, emptyPromiseHistoryCoverage, PROMISE_BASIS_LABELS,
  promiseDateForBasis, resolvePromiseBasis, type PromiseHistoryCoverage,
} from "@/server/rules/promise-basis";
import { scoreSupplier, type ScoreBreakdownItem, type SupplierGrade } from "@/server/rules/scorecard";
import { num } from "@/server/core/svc";
import { shanghaiDayOf } from "@/server/core/business-day";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle PGlite/Postgres structural compatibility is narrowed by the surrounding service contract
type AnyDb = any;
/** drizzle 表对象（po_docs / jg_docs 结构不同但都含 id + supplier_id，此处按鸭子类型传参） */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle PGlite/Postgres structural compatibility is narrowed by the surrounding service contract
type AnyTable = any;

/** 生效收货状态（照抄 report/wip.ts ACTIVE_SH_STATUSES） */
const ACTIVE_SH_STATUSES = ["approved", "in_progress", "completed"] as const;
/** 生效价格变更单状态（草稿/待审/驳回不算「发生过调价」） */
const EFFECTIVE_PC_STATUSES = ["approved", "in_progress", "completed"] as const;

/** 默认窗口天数 / 最小样本数 */
export const DEFAULT_WINDOW_DAYS = 180;
export const MIN_SAMPLES = 3;

const r4 = (v: number): number => Math.round(v * 10000) / 10000;

const shanghaiDate = shanghaiDayOf;
/** 日界差（日期串直减） */
function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);
}

export interface ScorecardRow {
  supplierId: number;
  code: string;
  name: string;
  /** 档案现有等级（人工维护值） */
  currentLevel: string | null;
  score: number | null;
  grade: SupplierGrade | null;
  confidence: "high" | "medium" | "low";
  /** 主口径准时率（原始承诺）——进综合分 */
  onTimeRate: number | null;
  /** 主口径准时率的**分母**：该供应商有承诺交期的收货批次数（0 = 该维度无数据，不参与汇总） */
  onTimeSampleN: number;
  /** 主口径准时率的**分子**：其中按时到货的批次数 */
  onTimeHitN: number;
  /** 副口径（当前承诺）准时率的分母/分子 */
  onTimeSampleNCurrent: number;
  onTimeHitNCurrent: number;
  /** 副口径准时率（当前承诺，供应商改期后的值）——只展示不计分 */
  onTimeRateCurrent: number | null;
  /** 该供应商窗口内未关闭质量案件数 / 其中逾期数；无案件 → null（维度不适用） */
  openQualityCases: number | null;
  /** 其中立案早于窗口起点的未结案件数（窗口标签管不到这一部分，行上必须写明） */
  legacyQualityCases: number | null;
  overdueQualityCases: number | null;
  qcPassRate: number | null;
  concessionRate: number | null;
  scrapRate: number | null;
  priceChangeCount: number;
  /** 窗口内生效收货单张数 */
  sampleN: number;
  breakdown: ScoreBreakdownItem[];
  /** 建议等级 ≠ 档案等级 且 置信度不低 → 值得人工复核 */
  suggestLevelChange: boolean;
  /** 评分理由（可解释） */
  reason: string;
}

export interface SupplierScorecard {
  rows: ScorecardRow[];
  total: number;
  minSamples: number;
  summary: {
    /** 窗口内有信号的供应商数 */
    suppliers: number;
    /** 其中已评级（样本足够）的数量 */
    rated: number;
    /** 建议调整等级的数量 */
    suggestChanges: number;
    /**
     * 整体准时率 0~1（主口径=原始承诺），**样本加权（pooled）**：Σ准时批次 ÷ Σ有承诺交期的批次。
     * 不是各供应商准时率的算术平均——那会让 9 家各 1 单的小供应商压过 1 家 200 单的大供应商
     * （9×100% + 1×50% 算术平均 95.0%，而真实整体 ≈ 52.2%）。无样本 → null。
     */
    avgOnTimeRate: number | null;
    /** 整体准时率（副口径=当前承诺，同为 pooled）——与主口径的差就是改期吃掉的迟到 */
    avgOnTimeRateCurrent: number | null;
    /** pooled 的分母/分子（主口径）：读者能自己复核这个比率 */
    onTimeSamples: number;
    onTimeHits: number;
    onTimeSamplesCurrent: number;
    onTimeHitsCurrent: number;
    /** 参与主口径 pooled 的供应商数 */
    onTimeSuppliers: number;
    /** 无承诺交期样本、被排除在准时率之外的供应商数（缺数据 ≠ 差，不按 0 计入） */
    onTimeExcludedSuppliers: number;
    /** 汇总口径标签（页面必须原样展示，不得自写一份） */
    onTimeAggregationLabel: string;
    /** 未关闭质量案件里立案早于窗口起点的件数（本维度不按窗口裁，标签必须说出来） */
    legacyQualityCases: number;
    /** 质量案件维度的口径标签（说明它**不**受 windowDays 限制） */
    qualityCaseScope: string;
    windowDays: number;
  };
  /** 准时率主/副口径标签（中文界面必须两个都标，只标一个读者就不知道自己看的是哪一版） */
  onTimeBasisLabel: string;
  onTimeSecondaryBasisLabel: string;
  /** 承诺版本链覆盖（按交期样本计）：missing/backfilled 的「原始承诺」是回落的当前承诺 */
  promiseHistory: PromiseHistoryCoverage;
}

/** 窗口内 (供应商 → 生效收货单张数)；PO/JG 两种来源各查一次后合并 */
async function receiptCountsBySupplier(db: AnyDb, cutoff: Date): Promise<Map<number, Set<number>>> {
  const out = new Map<number, Set<number>>();
  const fetch = async (sourceType: string, doc: AnyTable): Promise<{ supplierId: number; shId: number }[]> =>
    db
      .select({ supplierId: doc.supplierId, shId: schema.shDocs.id })
      .from(schema.shDocs)
      .innerJoin(doc, eq(schema.shDocs.sourceId, doc.id))
      .where(
        and(
          eq(schema.shDocs.sourceType, sourceType),
          inArray(schema.shDocs.status, [...ACTIVE_SH_STATUSES]),
          gte(schema.shDocs.createdAt, cutoff),
        ),
      );
  for (const r of [...(await fetch("po", schema.poDocs)), ...(await fetch("jg", schema.jgDocs))]) {
    const set = out.get(r.supplierId) ?? new Set<number>();
    set.add(r.shId);
    out.set(r.supplierId, set);
  }
  return out;
}

/** 质检桶（数量） */
interface QcBuckets {
  pass: number;
  rework: number;
  concession: number;
  scrap: number;
  pending: number;
  /** 判定总量 = pass + fail + concession */
  graded: number;
}
const emptyQc = (): QcBuckets => ({ pass: 0, rework: 0, concession: 0, scrap: 0, pending: 0, graded: 0 });

/** 把一行 qc_lines 的三桶数量按 failHandling 归入五类 */
export function accumulateQc(
  b: QcBuckets,
  line: { pass: number; fail: number; concession: number; handling: string },
): void {
  b.pass += line.pass;
  b.concession += line.concession; // 显式让步接收桶
  switch (line.handling) {
    case "rework":
      b.rework += line.fail;
      break;
    case "concession":
      b.concession += line.fail; // 不合格但走让步放行
      break;
    case "scrap":
      b.scrap += line.fail;
      break;
    default:
      b.pending += line.fail; // pending：尚未判定去向
  }
  b.graded += line.pass + line.fail + line.concession;
}

/** 窗口内 (供应商 → 质检桶)；按 (supplier, failHandling) 分组聚合 */
async function qcBySupplier(db: AnyDb, cutoff: Date): Promise<Map<number, QcBuckets>> {
  const out = new Map<number, QcBuckets>();
  const fetch = async (
    sourceType: string,
    doc: AnyTable,
  ): Promise<{ supplierId: number; handling: string; pass: string | null; fail: string | null; concession: string | null }[]> =>
    db
      .select({
        supplierId: doc.supplierId,
        handling: schema.qcLines.failHandling,
        pass: sql<string | null>`sum(${schema.qcLines.passQty})`,
        fail: sql<string | null>`sum(${schema.qcLines.failQty})`,
        concession: sql<string | null>`sum(${schema.qcLines.concessionQty})`,
      })
      .from(schema.qcLines)
      .innerJoin(schema.qcRecords, eq(schema.qcLines.qcId, schema.qcRecords.id))
      .innerJoin(schema.shDocs, eq(schema.qcRecords.shId, schema.shDocs.id))
      .innerJoin(doc, eq(schema.shDocs.sourceId, doc.id))
      .where(
        and(
          eq(schema.shDocs.sourceType, sourceType),
          inArray(schema.shDocs.status, [...ACTIVE_SH_STATUSES]),
          gte(schema.qcRecords.createdAt, cutoff),
        ),
      )
      .groupBy(doc.supplierId, schema.qcLines.failHandling);

  for (const r of [...(await fetch("po", schema.poDocs)), ...(await fetch("jg", schema.jgDocs))]) {
    const b = out.get(r.supplierId) ?? emptyQc();
    accumulateQc(b, { pass: num(r.pass), fail: num(r.fail), concession: num(r.concession), handling: r.handling });
    out.set(r.supplierId, b);
  }
  return out;
}

/** 窗口内 (供应商 → 生效价格变更单数) */
async function priceChangesBySupplier(db: AnyDb, cutoff: Date): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  const add = (rows: { supplierId: number; cnt: number }[]) => {
    for (const r of rows) out.set(r.supplierId, (out.get(r.supplierId) ?? 0) + Number(r.cnt));
  };

  // target='po_line'：pc → po_lines → po_docs
  add(
    await db
      .select({ supplierId: schema.poDocs.supplierId, cnt: sql<number>`count(*)::int` })
      .from(schema.pcDocs)
      .innerJoin(schema.poLines, eq(schema.pcDocs.poLineId, schema.poLines.id))
      .innerJoin(schema.poDocs, eq(schema.poLines.poId, schema.poDocs.id))
      .where(
        and(
          eq(schema.pcDocs.target, "po_line"),
          inArray(schema.pcDocs.status, [...EFFECTIVE_PC_STATUSES]),
          gte(schema.pcDocs.createdAt, cutoff),
        ),
      )
      .groupBy(schema.poDocs.supplierId),
  );

  // target='jg_fee'：pc.jg_id → jg_docs（该 FK 由应用层保证，见 schema/docs.ts 注释）
  add(
    await db
      .select({ supplierId: schema.jgDocs.supplierId, cnt: sql<number>`count(*)::int` })
      .from(schema.pcDocs)
      .innerJoin(schema.jgDocs, eq(schema.pcDocs.jgId, schema.jgDocs.id))
      .where(
        and(
          eq(schema.pcDocs.target, "jg_fee"),
          inArray(schema.pcDocs.status, [...EFFECTIVE_PC_STATUSES]),
          gte(schema.pcDocs.createdAt, cutoff),
        ),
      )
      .groupBy(schema.jgDocs.supplierId),
  );
  return out;
}

/** 一个供应商的双口径交期样本 */
interface LeadSamplePair {
  /** 主口径：原始承诺 */
  original: LeadTimeSample[];
  /** 副口径：当前承诺 */
  current: LeadTimeSample[];
}

/** 窗口内 (供应商 → 双口径交期样本)；口径见文件头注释 1) */
async function leadSamplesBySupplier(
  db: AnyDb,
  cutoff: Date,
): Promise<{ samples: Map<number, LeadSamplePair>; promiseHistory: PromiseHistoryCoverage }> {
  const receipts = db
    .select({
      poId: schema.shDocs.sourceId,
      skuId: schema.shLines.skuId,
      receivedAt: sql<Date>`min(${schema.shDocs.createdAt})`.as("received_at"),
    })
    .from(schema.shDocs)
    .innerJoin(schema.shLines, eq(schema.shLines.shId, schema.shDocs.id))
    .where(and(eq(schema.shDocs.sourceType, "po"), inArray(schema.shDocs.status, [...ACTIVE_SH_STATUSES])))
    .groupBy(schema.shDocs.sourceId, schema.shLines.skuId)
    .as("receipts");

  const rows: { supplierId: number; poLineId: number; orderedAt: Date; promisedDate: string | null; receivedAt: Date }[] = await db
    .select({
      supplierId: schema.poDocs.supplierId,
      poLineId: schema.poLines.id,
      orderedAt: schema.poDocs.createdAt,
      promisedDate: sql<string | null>`coalesce(${schema.poLines.expectedDate}, ${schema.poDocs.expectedDate})`,
      receivedAt: receipts.receivedAt,
    })
    .from(schema.poLines)
    .innerJoin(schema.poDocs, eq(schema.poLines.poId, schema.poDocs.id))
    .innerJoin(receipts, and(eq(receipts.poId, schema.poLines.poId), eq(receipts.skuId, schema.poLines.skuId)));

  /* 承诺版本链：逐 PO 行取原始承诺（口径唯一权威 rules/promise-basis.ts） */
  const revisionRows: { poLineId: number; sequence: number; promisedDate: string | null; source: string }[] = rows.length > 0
    ? await db
      .select({
        poLineId: schema.poPromiseRevisions.poLineId,
        sequence: schema.poPromiseRevisions.sequence,
        promisedDate: schema.poPromiseRevisions.promisedDate,
        source: schema.poPromiseRevisions.source,
      })
      .from(schema.poPromiseRevisions)
      .where(inArray(schema.poPromiseRevisions.poLineId, [...new Set(rows.map((r) => r.poLineId))]))
      .orderBy(schema.poPromiseRevisions.poLineId, schema.poPromiseRevisions.sequence)
    : [];
  const revisionsByLine = new Map<number, typeof revisionRows>();
  for (const rev of revisionRows) {
    const list = revisionsByLine.get(rev.poLineId) ?? [];
    list.push(rev);
    revisionsByLine.set(rev.poLineId, list);
  }

  const samples = new Map<number, LeadSamplePair>();
  const promiseHistory = emptyPromiseHistoryCoverage();
  for (const r of rows) {
    const received = new Date(r.receivedAt);
    if (received < cutoff) continue; // 窗口外的历史履约不参与本期评分
    const orderedStr = shanghaiDate(new Date(r.orderedAt));
    const actualDays = daysBetween(orderedStr, shanghaiDate(received));
    if (!Number.isFinite(actualDays) || actualDays < 0) continue; // 收货早于制单 = 补录脏数据
    const fact = resolvePromiseBasis(revisionsByLine.get(r.poLineId) ?? []);
    countPromiseHistory(promiseHistory, fact);
    const pair = samples.get(r.supplierId) ?? { original: [], current: [] };
    for (const [basis, list] of [["original", pair.original], ["current", pair.current]] as const) {
      const date = promiseDateForBasis(basis, fact, r.promisedDate);
      const promisedDays = date ? daysBetween(orderedStr, date) : null;
      list.push({ promisedDays: promisedDays != null && promisedDays >= 0 ? promisedDays : null, actualDays });
    }
    samples.set(r.supplierId, pair);
  }
  return { samples, promiseHistory };
}

/**
 * 窗口内 (供应商 → 质量案件桶)。
 * 口径：quality_cases.supplier_id 非空、status <> 'closed'，且（created_at ≥ cutoff 或至今仍未关闭）；
 * 逾期 = 有 report_due_date 且 classifyDueState 判 overdue（未上报）。
 */
interface QualityCaseBuckets {
  open: number;
  overdue: number;
  /** 其中立案早于本次窗口起点的未结案件数（本维度不按窗口裁，但必须让读者看见这一部分） */
  legacy: number;
}
async function qualityCasesBySupplier(db: AnyDb, today: string, cutoff: Date): Promise<Map<number, QualityCaseBuckets>> {
  const rows: { supplierId: number | null; reportDueDate: string | null; reportedAt: Date | null; createdAt: Date }[] = await db
    .select({
      supplierId: schema.qualityCases.supplierId,
      reportDueDate: schema.qualityCases.reportDueDate,
      reportedAt: schema.qualityCases.reportedAt,
      createdAt: schema.qualityCases.createdAt,
    })
    .from(schema.qualityCases)
    .where(and(
      sql`${schema.qualityCases.supplierId} is not null`,
      sql`${schema.qualityCases.status} <> 'closed'`,
    ));
  const out = new Map<number, QualityCaseBuckets>();
  for (const r of rows) {
    if (r.supplierId == null) continue;
    const b = out.get(r.supplierId) ?? { open: 0, overdue: 0, legacy: 0 };
    b.open += 1;
    /* 立案早于窗口起点的未结案件：本维度故意不按窗口裁（久拖不决要继续扣分），
       但页面标着「近 N 天」，必须把这部分单独数出来，否则读者会以为案子发生在窗口内。 */
    if (new Date(r.createdAt) < cutoff) b.legacy += 1;
    if (r.reportDueDate) {
      const state = classifyDueState({
        dueDate: r.reportDueDate,
        asOfDate: today,
        dueSoonThroughDate: today,
        completedDate: r.reportedAt ? today : null,
      });
      if (state === "overdue") b.overdue += 1;
    }
    out.set(r.supplierId, b);
  }
  return out;
}

/**
 * 准时率的**分子/分母**（pooled 汇总需要计数，而 `leadTimeStats` 只返回比率）。
 * 判定与 `rules/leadtime-stats.leadTimeStats` **逐字相同**：
 * 分母 = 有承诺交期（promisedDays 有限）的有效样本；分子 = 其中 `actualDays <= promisedDays`。
 * 两处判定必须同源——一旦分叉，页面上的比率和它自己的分子分母会对不上。
 */
export function onTimeCounts(samples: readonly LeadTimeSample[]): { n: number; hits: number } {
  const promised = samples.filter(
    (x) => Number.isFinite(x.actualDays) && x.promisedDays != null && Number.isFinite(x.promisedDays),
  );
  return {
    n: promised.length,
    hits: promised.filter((x) => x.actualDays <= (x.promisedDays as number)).length,
  };
}

/** 准时率汇总口径标签（唯一权威；页面原样展示，不得自写一份） */
export const ON_TIME_AGGREGATION_LABEL =
  "整体准时率 = Σ准时批次 ÷ Σ有承诺交期的批次（样本加权 pooled，不是各供应商准时率的算术平均）；无承诺交期样本的供应商既不进分子也不进分母";

/** 质量案件维度的窗口口径标签（唯一权威） */
export function qualityCaseScopeLabel(windowDays: number, legacy: number): string {
  return `未关闭质量案件**不按 ${windowDays} 天窗口裁**：只要没结案就继续扣分（久拖不决正是最该扣的）。其中 ${legacy} 件立案于窗口之外——页面上的「近 ${windowDays} 天」不覆盖这部分。`;
}

export async function getSupplierScorecard(
  query: { q?: string; page?: number; pageSize?: number; windowDays?: number },
  dbArg?: AnyDb,
): Promise<SupplierScorecard> {
  const db: AnyDb = dbArg ?? (await getDbAsync());
  const page = Math.max(1, query.page ?? 1);
  const pageSize = Math.min(500, Math.max(1, query.pageSize ?? 20));
  const windowDays = Math.min(1095, Math.max(30, query.windowDays ?? DEFAULT_WINDOW_DAYS));
  const q = (query.q ?? "").trim().toLowerCase();
  const cutoff = new Date(Date.now() - windowDays * 86_400_000);

  const today = todayShanghai();
  const [receipts, qc, priceChanges, lead, qualityCases] = await Promise.all([
    receiptCountsBySupplier(db, cutoff),
    qcBySupplier(db, cutoff),
    priceChangesBySupplier(db, cutoff),
    leadSamplesBySupplier(db, cutoff),
    qualityCasesBySupplier(db, today, cutoff),
  ]);
  const leadSamples = lead.samples;

  /** 窗口内有任一信号的供应商（W2：未关闭质量案件也是信号——案件不该因为没收货就消失在版面外） */
  const active = new Set<number>([
    ...receipts.keys(), ...qc.keys(), ...priceChanges.keys(), ...leadSamples.keys(), ...qualityCases.keys(),
  ]);
  if (active.size === 0) {
    return {
      rows: [],
      total: 0,
      minSamples: MIN_SAMPLES,
      summary: {
        suppliers: 0, rated: 0, suggestChanges: 0,
        avgOnTimeRate: null, avgOnTimeRateCurrent: null,
        onTimeSamples: 0, onTimeHits: 0, onTimeSamplesCurrent: 0, onTimeHitsCurrent: 0,
        onTimeSuppliers: 0, onTimeExcludedSuppliers: 0,
        onTimeAggregationLabel: ON_TIME_AGGREGATION_LABEL,
        legacyQualityCases: 0,
        qualityCaseScope: qualityCaseScopeLabel(windowDays, 0),
        windowDays,
      },
      onTimeBasisLabel: PROMISE_BASIS_LABELS.original,
      onTimeSecondaryBasisLabel: PROMISE_BASIS_LABELS.current,
      promiseHistory: lead.promiseHistory,
    };
  }

  const supRows: { id: number; code: string; name: string; level: string | null }[] = await db
    .select({ id: schema.suppliers.id, code: schema.suppliers.code, name: schema.suppliers.name, level: schema.suppliers.level })
    .from(schema.suppliers)
    .where(inArray(schema.suppliers.id, [...active]));

  const all: ScorecardRow[] = [];
  for (const sup of supRows) {
    const b = qc.get(sup.id);
    const graded = b?.graded ?? 0;
    const qcPassRate = graded > 0 ? r4((b as QcBuckets).pass / graded) : null;
    const concessionRate = graded > 0 ? r4((b as QcBuckets).concession / graded) : null;
    const scrapRate = graded > 0 ? r4((b as QcBuckets).scrap / graded) : null;
    const pair = leadSamples.get(sup.id) ?? { original: [], current: [] };
    const stats = leadTimeStats(pair.original);
    const statsCurrent = leadTimeStats(pair.current);
    /* pooled 汇总需要**分子与分母**，而 leadTimeStats 只给比率与全部有效样本数 n
       （n 含没有承诺交期的样本，不能当准时率分母）。这里按同一条判定重数一遍：
       分母 = 有承诺交期的样本；分子 = 其中 actualDays ≤ promisedDays 的样本。 */
    const onTime = onTimeCounts(pair.original);
    const onTimeCurrent = onTimeCounts(pair.current);
    const priceChangeCount = priceChanges.get(sup.id) ?? 0;
    const sampleN = receipts.get(sup.id)?.size ?? 0;
    const cases = qualityCases.get(sup.id) ?? null;

    const res = scoreSupplier(
      {
        onTimeRate: stats.onTimeRate,
        qcPassRate,
        concessionRate,
        scrapRate,
        priceChangeCount,
        sampleN,
        qualityCase: cases ? { openCases: cases.open, overdueCases: cases.overdue } : null,
      },
      MIN_SAMPLES,
    );
    all.push({
      supplierId: sup.id,
      code: sup.code,
      name: sup.name,
      currentLevel: sup.level,
      score: res.score,
      grade: res.grade,
      confidence: res.confidence,
      onTimeRate: stats.onTimeRate,
      onTimeSampleN: onTime.n,
      onTimeHitN: onTime.hits,
      onTimeRateCurrent: statsCurrent.onTimeRate,
      onTimeSampleNCurrent: onTimeCurrent.n,
      onTimeHitNCurrent: onTimeCurrent.hits,
      openQualityCases: cases ? cases.open : null,
      legacyQualityCases: cases ? cases.legacy : null,
      overdueQualityCases: cases ? cases.overdue : null,
      qcPassRate,
      concessionRate,
      scrapRate,
      priceChangeCount,
      sampleN,
      breakdown: res.breakdown,
      suggestLevelChange: res.grade != null && res.confidence !== "low" && res.grade !== sup.level,
      reason: res.reason,
    });
  }

  /* ── 搜索 / 汇总 / 排序 / 分页 ── */
  let filtered = all;
  if (q) filtered = filtered.filter((r) => r.code.toLowerCase().includes(q) || r.name.toLowerCase().includes(q));
  const withOnTime = filtered.filter((r) => r.onTimeRate != null);
  /* pooled（样本加权）：先把批次数加起来，再相除。
     算术平均会让 9 家各 1 单的小供应商压过 1 家 200 单的大供应商——
     那个数回答的是「供应商的平均分」，不是「我们整体准不准」，而页面问的是后者。 */
  const onTimeSamples = filtered.reduce((a, r) => a + r.onTimeSampleN, 0);
  const onTimeHits = filtered.reduce((a, r) => a + r.onTimeHitN, 0);
  const onTimeSamplesCurrent = filtered.reduce((a, r) => a + r.onTimeSampleNCurrent, 0);
  const onTimeHitsCurrent = filtered.reduce((a, r) => a + r.onTimeHitNCurrent, 0);
  const legacyQualityCases = filtered.reduce((a, r) => a + (r.legacyQualityCases ?? 0), 0);
  const summary = {
    suppliers: filtered.length,
    rated: filtered.filter((r) => r.score != null).length,
    suggestChanges: filtered.filter((r) => r.suggestLevelChange).length,
    avgOnTimeRate: onTimeSamples > 0 ? r4(onTimeHits / onTimeSamples) : null,
    avgOnTimeRateCurrent: onTimeSamplesCurrent > 0 ? r4(onTimeHitsCurrent / onTimeSamplesCurrent) : null,
    onTimeSamples,
    onTimeHits,
    onTimeSamplesCurrent,
    onTimeHitsCurrent,
    onTimeSuppliers: withOnTime.length,
    // 缺数据 ≠ 差：这些供应商既不进分子也不进分母，但它们的存在必须可见
    onTimeExcludedSuppliers: filtered.length - withOnTime.length,
    onTimeAggregationLabel: ON_TIME_AGGREGATION_LABEL,
    legacyQualityCases,
    qualityCaseScope: qualityCaseScopeLabel(windowDays, legacyQualityCases),
    windowDays,
  };
  // 差的在前（最值得处理）；未评级的排最后——没数据不等于差，别抢占注意力
  filtered = [...filtered].sort(
    (a, b) => (a.score ?? Number.POSITIVE_INFINITY) - (b.score ?? Number.POSITIVE_INFINITY) || a.code.localeCompare(b.code),
  );

  return {
    rows: filtered.slice((page - 1) * pageSize, page * pageSize),
    total: filtered.length,
    minSamples: MIN_SAMPLES,
    summary,
    onTimeBasisLabel: PROMISE_BASIS_LABELS.original,
    onTimeSecondaryBasisLabel: PROMISE_BASIS_LABELS.current,
    promiseHistory: lead.promiseHistory,
  };
}

const applySchema = z.object({
  supplierId: z.number().int().positive(),
  level: z.enum(SUPPLIER_LEVELS),
});

/**
 * 采纳记分卡建议等级 → 写 suppliers.level。
 * 人工闸：只有点「采纳」才走到这里，系统绝不自动改主数据（评分是建议，不是判决）。
 */
export async function applySupplierLevel(
  user: SessionUser,
  input: { supplierId: number; level: string },
  dbArg?: AnyDb,
): Promise<{ ok: true; supplierId: number; level: string }> {
  requireAnyRole(user, "purchasing");
  const v = applySchema.parse(input);
  const db: AnyDb = dbArg ?? (await getDbAsync());

  const [sup]: { id: number; code: string; level: string | null }[] = await db
    .select({ id: schema.suppliers.id, code: schema.suppliers.code, level: schema.suppliers.level })
    .from(schema.suppliers)
    .where(eq(schema.suppliers.id, v.supplierId));
  if (!sup) throw new ApiError(404, `供应商不存在: #${v.supplierId}`);

  await db.transaction(async (tx: AnyDb) => {
    await tx
      .update(schema.suppliers)
      .set({ level: v.level, updatedAt: new Date() })
      .where(eq(schema.suppliers.id, v.supplierId));
    await writeAudit(tx, {
      userId: user.id,
      entity: "supplier",
      entityId: v.supplierId,
      action: "apply_scorecard_level",
      before: { supplierId: v.supplierId, code: sup.code, level: sup.level },
      after: { supplierId: v.supplierId, code: sup.code, level: v.level, source: "supplier_scorecard" },
    });
  });
  return { ok: true, supplierId: v.supplierId, level: v.level };
}
