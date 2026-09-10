/**
 * E2-04 交期学习与供应商准时率（只读报表 + 人工采纳建议）。
 *
 * 采购样本只可提议原料/包材的 purchase_lead_days，不能写成品/半成品的加工周期。
 * 系统里其实躺着算真实交期所需的全部原料——PO 的承诺交期 + 实际收货时间——本模块把它算出来，
 * 按 (供应商, SKU) 给出交期分布（P50/P90/σ）、准时率、平均延误，并对偏差大的档案**提议**更新。
 *
 * ── 样本口径（重要，全部用真实存在的字段）──
 * 起算日（下单日）：po_docs.created_at（制单时间，Asia/Shanghai 日界）。
 *   局限：非「审批日/供应商确认日」；PO 若长期停在草稿，会把交期算长。
 * 承诺到货日：coalesce(po_lines.expected_date, po_docs.expected_date)
 *   （func#11 供应商按行回交期优先，回落单头承诺；两者皆空 → 该样本 promisedDays=null，
 *    仅进入交期分布，不进准时率/延误分母）。
 * 实际收货日：**sh_docs.created_at**，取该 (PO, SKU) 上最早一张生效收货单（status ∈ approved/
 *   in_progress/completed）。选此口径的原因与局限：
 *   - sh_docs 没有业务收货日期字段（docColumns 只有 created_at/updated_at），created_at =
 *     仓库录单时刻，是系统内离「物理到货」最近的时间戳；仓库补录会使其滞后。
 *   - 不用 stock_ledger 的入库过账时间（sourceDocType='sh_purchase_in'）：那是「检验合格后
 *     确认入库」的时刻，天然晚于到货，且未过 QC 的收货会整条丢失样本，口径更偏。
 *   - SH↔PO 只在单头关联（sh_docs.source_type='po' / source_id=po_id），行级只能靠 SKU 匹配，
 *     故聚合粒度 = (po_id, sku_id)，拆行不增加样本。行承诺缺失/不一致则不评准时率。
 *   - 仅生效PO（含短关）与正数量正常SH；分次收货取首批，不代表收齐或OTIF。
 * 负交期（收货早于制单，多为历史数据补录）直接丢弃。
 *
 * 写路径只有一条：applyLeadTimeSuggestion——人工点「采纳」才写 sku_params，绝不自动改主数据。
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { getDbAsync } from "@/db";
import * as schema from "@/db/schema";
import { writeAudit } from "@/server/core/audit";
import { ApiError, type SessionUser } from "@/server/modules/master/common";
import { requireAnyRole } from "@/server/modules/outsource/common";
import { leadTimeStats, suggestLeadDays, type LeadTimeSample } from "@/server/rules/leadtime-stats";
import { shanghaiDayOf } from "@/server/core/business-day";
import { createHash } from "node:crypto";
import { leadFieldsFor } from "@/server/modules/master/sku-supply-params-fill";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle PGlite/Postgres structural compatibility is narrowed by the surrounding service contract
type AnyDb = any;

/** 生效单据状态（与 matflow 收货口径一致：草稿/待审/驳回不算数） */
const EFFECTIVE_STATUSES = ["approved", "in_progress", "completed"] as const;

/** 最小样本数 / 偏差容差（与 rules 默认一致，集中在此便于日后参数化） */
const MIN_SAMPLES = 3;
const DEVIATION_PCT = 20;

export interface LeadTimeRow {
  supplierId: number;
  supplierName: string;
  skuId: number;
  code: string;
  name: string;
  /** 样本数（该供应商-SKU 的历史履约次数） */
  samples: number;
  promiseSamples: number;
  /** 当前SKU类型允许PO建议写入的字段；成品/半成品仅观察。 */
  targetField: "purchaseLeadDays" | null;
  evidenceKey: string;
  p50: number | null;
  p90: number | null;
  stdev: number | null;
  /** 准时率 0~1；无承诺交期样本 → null */
  onTimeRate: number | null;
  avgDelayDays: number | null;
  /** 档案采购周期（sku_params.purchase_lead_days）；非适用类型为空 */
  currentLeadDays: number | null;
  suggestLeadDays: number | null;
  suggestReason: string;
}

export interface LeadTimeLearning {
  rows: LeadTimeRow[];
  total: number;
  minSamples: number;
  leadDeviationTolerancePct: number;
  summary: {
    /** 有样本的 供应商-SKU 对数 */
    pairCount: number;
    /** 其中给出建议的对数 */
    withSuggestion: number;
    /** 平均准时率 0~1（仅有承诺交期样本的对参与平均）；无 → null */
    avgOnTimeRate: number | null;
  };
}

const shanghaiDate = shanghaiDayOf;
/** 日界差（日期串直减） */
function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);
}

export async function getLeadTimeLearning(
  query: { q?: string; page?: number; pageSize?: number },
  dbArg?: AnyDb,
): Promise<LeadTimeLearning> {
  const db: AnyDb = dbArg ?? (await getDbAsync());
  return db.transaction((tx: AnyDb) => buildLearning(query, tx), { isolationLevel: "repeatable read", accessMode: "read only" });
}

async function buildLearning(
  query: { q?: string; page?: number; pageSize?: number; supplierId?: number; skuId?: number },
  db: AnyDb,
): Promise<LeadTimeLearning> {
  const page = Math.max(1, query.page ?? 1);
  const pageSize = Math.min(500, Math.max(1, query.pageSize ?? 20));
  const q = (query.q ?? "").trim().toLowerCase();

  /* ── 实际收货：逐 (PO, SKU) 取最早一张生效 SH 的制单时间 ── */
  const receipts = db
    .select({
      poId: schema.shDocs.sourceId,
      skuId: schema.shLines.skuId,
      receivedAt: sql<Date>`min(${schema.shDocs.createdAt})`.as("received_at"),
    })
    .from(schema.shDocs)
    .innerJoin(schema.shLines, eq(schema.shLines.shId, schema.shDocs.id))
    .where(and(eq(schema.shDocs.sourceType, "po"), inArray(schema.shDocs.status, [...EFFECTIVE_STATUSES]),
      eq(schema.shLines.lineType, "normal"), sql`${schema.shLines.actualQty} > 0`))
    .groupBy(schema.shDocs.sourceId, schema.shLines.skuId)
    .as("receipts");

  const sampleRows: {
    poId: number;
    supplierId: number;
    skuId: number;
    orderedAt: Date;
    promisedDate: string | null;
    receivedAt: Date;
  }[] = await db
    .select({
      poId: schema.poDocs.id,
      supplierId: schema.poDocs.supplierId,
      skuId: schema.poLines.skuId,
      orderedAt: schema.poDocs.createdAt,
      promisedDate: sql<string | null>`coalesce(${schema.poLines.expectedDate}, ${schema.poDocs.expectedDate})`,
      receivedAt: receipts.receivedAt,
    })
    .from(schema.poLines)
    .innerJoin(schema.poDocs, eq(schema.poLines.poId, schema.poDocs.id))
    .innerJoin(receipts, and(eq(receipts.poId, schema.poLines.poId), eq(receipts.skuId, schema.poLines.skuId)))
    .where(and(inArray(schema.poDocs.status, [...EFFECTIVE_STATUSES, "closed"]), sql`${schema.poLines.qty} > 0`,
      query.supplierId === undefined ? undefined : eq(schema.poDocs.supplierId, query.supplierId),
      query.skuId === undefined ? undefined : eq(schema.poLines.skuId, query.skuId)));

  /* ── 按 (供应商, SKU) 归集样本 ── */
  const byOrder = new Map<string, { row: typeof sampleRows[number]; promises: Set<string | null> }>();
  for (const r of sampleRows) {
    const key = `${r.poId}|${r.skuId}`;
    const group = byOrder.get(key) ?? { row: r, promises: new Set<string | null>() };
    group.promises.add(r.promisedDate);
    byOrder.set(key, group);
  }
  const byPair = new Map<string, { supplierId: number; skuId: number; samples: (LeadTimeSample & { poId: number; ordered: string; received: string; promises: (string | null)[] })[] }>();
  for (const { row: r, promises } of byOrder.values()) {
    const ordered = shanghaiDate(new Date(r.orderedAt));
    const received = shanghaiDate(new Date(r.receivedAt));
    const actualDays = daysBetween(ordered, received);
    if (!Number.isFinite(actualDays) || actualDays < 0) continue; // 收货早于制单=历史补录脏数据，丢弃
    const promise = promises.size === 1 ? [...promises][0] : null;
    const promisedDays = promise ? daysBetween(ordered, promise) : null;
    const key = `${r.supplierId}|${r.skuId}`;
    const cur = byPair.get(key) ?? { supplierId: r.supplierId, skuId: r.skuId, samples: [] };
    cur.samples.push({ poId: r.poId, ordered, received, promises: [...promises].sort(),
      promisedDays: promisedDays != null && Number.isFinite(promisedDays) && promisedDays >= 0 ? promisedDays : null, actualDays });
    byPair.set(key, cur);
  }
  if (byPair.size === 0) {
    return { rows: [], total: 0, minSamples: MIN_SAMPLES, leadDeviationTolerancePct: DEVIATION_PCT, summary: { pairCount: 0, withSuggestion: 0, avgOnTimeRate: null } };
  }

  /* ── 主档：供应商名、SKU 编码/名称、档案交期 ── */
  const supplierIds = [...new Set([...byPair.values()].map((p) => p.supplierId))];
  const skuIds = [...new Set([...byPair.values()].map((p) => p.skuId))];
  const [supRows, skuRows, paramRows]: [
    { id: number; name: string }[],
    { id: number; code: string; name: string; skuType: string }[],
    { skuId: number; purchaseLeadDays: number | null; updatedAt: Date }[],
  ] = await Promise.all([
    db.select({ id: schema.suppliers.id, name: schema.suppliers.name }).from(schema.suppliers).where(inArray(schema.suppliers.id, supplierIds)),
    db.select({ id: schema.skus.id, code: schema.skus.code, name: schema.skus.name, skuType: schema.skus.skuType }).from(schema.skus).where(inArray(schema.skus.id, skuIds)),
    db.select({ skuId: schema.skuParams.skuId, purchaseLeadDays: schema.skuParams.purchaseLeadDays, updatedAt: schema.skuParams.updatedAt }).from(schema.skuParams).where(inArray(schema.skuParams.skuId, skuIds)),
  ]);
  const supById = new Map(supRows.map((s) => [s.id, s.name]));
  const skuById = new Map(skuRows.map((s) => [s.id, s]));
  const leadBySku = new Map(paramRows.map((p) => [p.skuId, p]));

  /* ── 逐对统计 + 建议 ── */
  const all: (LeadTimeRow & { score: number })[] = [];
  for (const pair of byPair.values()) {
    const sku = skuById.get(pair.skuId);
    if (!sku) continue; // SKU 已被删除（理论上 FK 拦住）
    const stats = leadTimeStats(pair.samples);
    const params = leadBySku.get(pair.skuId);
    const targetField = leadFieldsFor(sku.skuType).includes("purchaseLeadDays") ? "purchaseLeadDays" : null;
    const current = targetField ? params?.purchaseLeadDays ?? null : null;
    const sug = targetField ? suggestLeadDays(current, stats, MIN_SAMPLES, DEVIATION_PCT)
      : { suggest: null, reason: "此类型不适用采购周期；PO首批样本不能作为加工周期，保留观察" };
    const evidenceKey = createHash("sha256").update(JSON.stringify(["po-first-normal/v2", pair.supplierId, pair.skuId,
      sku.skuType, current, params?.updatedAt ?? null, [...pair.samples].sort((a, b) => a.poId - b.poId)])).digest("hex");
    // 排序权重「样本数 × 偏差」：样本多且档案偏得离谱的最值得处理；无档案值按 100% 偏差计
    const devRatio =
      stats.p50 == null ? 0 : current != null && current > 0 ? Math.abs(stats.p50 - current) / current : 1;
    all.push({
      supplierId: pair.supplierId,
      supplierName: supById.get(pair.supplierId) ?? `#${pair.supplierId}`,
      skuId: pair.skuId,
      code: sku.code,
      name: sku.name,
      samples: stats.n,
      promiseSamples: pair.samples.filter(s => s.promisedDays != null).length,
      targetField,
      evidenceKey,
      p50: stats.p50,
      p90: stats.p90,
      stdev: stats.stdev,
      onTimeRate: stats.onTimeRate,
      avgDelayDays: stats.avgDelayDays,
      currentLeadDays: current,
      suggestLeadDays: sug.suggest,
      suggestReason: sug.reason,
      score: stats.n * devRatio,
    });
  }

  /* ── 搜索 / 汇总 / 排序 / 分页 ── */
  let filtered = all;
  if (q) {
    filtered = filtered.filter(
      (r) =>
        r.code.toLowerCase().includes(q) ||
        r.name.toLowerCase().includes(q) ||
        r.supplierName.toLowerCase().includes(q),
    );
  }
  const rated = filtered.filter((r) => r.onTimeRate != null);
  const summary = {
    pairCount: filtered.length,
    withSuggestion: filtered.filter((r) => r.suggestLeadDays != null).length,
    avgOnTimeRate:
      rated.length > 0
        ? Math.round((rated.reduce((a, r) => a + (r.onTimeRate as number), 0) / rated.length) * 10000) / 10000
        : null,
  };
  filtered = [...filtered].sort((a, b) => b.score - a.score || b.samples - a.samples || a.code.localeCompare(b.code));

  return {
    rows: filtered.slice((page - 1) * pageSize, page * pageSize).map(({ score: _score, ...r }) => r),
    total: filtered.length,
    minSamples: MIN_SAMPLES,
    leadDeviationTolerancePct: DEVIATION_PCT,
    summary,
  };
}

const applySchema = z.object({
  skuId: z.number().int().positive(),
  supplierId: z.number().int().positive(),
  evidenceKey: z.string().regex(/^[a-f0-9]{64}$/),
  leadDays: z.number().int().min(1).max(365),
}).strict();

/**
 * 采纳所见建议：锁SKU/参数、在同一快照重新核对依据后仅更新采购周期。
 * upsert on (sku_id)，留痕 entity=sku_params / action=apply_leadtime_suggestion。
 */
export async function applyLeadTimeSuggestion(
  user: SessionUser,
  input: unknown,
  dbArg?: AnyDb,
): Promise<{ ok: true; skuId: number; leadDays: number }> {
  requireAnyRole(user, "pmc", "purchasing");
  const v = applySchema.parse(input);
  const db: AnyDb = dbArg ?? (await getDbAsync());

  try { await db.transaction(async (tx: AnyDb) => {
    const [sku] = await tx.select({ id: schema.skus.id }).from(schema.skus).where(eq(schema.skus.id, v.skuId)).for("update");
    if (!sku) throw new ApiError(404, `SKU 不存在: #${v.skuId}`);
    await tx.select({ skuId: schema.skuParams.skuId }).from(schema.skuParams).where(eq(schema.skuParams.skuId, v.skuId)).for("update");
    const row = (await buildLearning({ supplierId: v.supplierId, skuId: v.skuId }, tx)).rows[0];
    if (!row || row.evidenceKey !== v.evidenceKey || row.suggestLeadDays == null || row.suggestLeadDays !== v.leadDays || row.targetField !== "purchaseLeadDays") {
      throw new ApiError(409, "交期样本、档案或建议已变化/不适用，本次未写入；请刷新核对后再采纳");
    }
    if (row.currentLeadDays != null && !user.roles.some(r => r === "admin" || r === "pmc")) {
      throw new ApiError(403, "采购只能补录空值；覆盖已有采购周期须生产计划或管理员确认");
    }
    await tx
      .insert(schema.skuParams)
      .values({ skuId: v.skuId, purchaseLeadDays: v.leadDays, updatedBy: user.id, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: schema.skuParams.skuId,
        set: { purchaseLeadDays: v.leadDays, updatedBy: user.id, updatedAt: new Date() },
      });
    await writeAudit(tx, {
      userId: user.id,
      entity: "sku_params",
      entityId: v.skuId,
      action: "apply_leadtime_suggestion",
      before: { skuId: v.skuId, purchaseLeadDays: row.currentLeadDays },
      after: { skuId: v.skuId, supplierId: v.supplierId, purchaseLeadDays: v.leadDays, evidenceKey: v.evidenceKey,
        samples: row.samples, p50: row.p50, source: "po-first-normal/v2" },
    });
  }, { isolationLevel: "repeatable read" }); } catch (error) {
    const e = error as { code?: string; cause?: { code?: string } };
    if (e?.code === "40001" || e?.cause?.code === "40001") throw new ApiError(409, "采购周期正在被他人更新，本次未写入；请刷新核对");
    throw error;
  }
  return { ok: true, skuId: v.skuId, leadDays: v.leadDays };
}
