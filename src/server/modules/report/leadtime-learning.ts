/**
 * E2-04 交期学习与供应商准时率（只读报表 + 人工采纳建议）。
 *
 * 背景：sku_params.normal_lead_days 是人工填的档案值，却被安全库存与最晚下单日推算当铁律用。
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
 *     故聚合粒度 = (po_id, sku_id)；同一 PO 同一 SKU 拆多行时无法区分（与 matflow/sh.ts
 *     收货回冲「同 SKU 多 PO 行计入首行」同一 PoC 口径）。
 *   - 分次收货取**最早**一次（首批到货即视为交付达成），不等末批收齐——否则尾批拖尾会污染交期。
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
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
  p50: number | null;
  p90: number | null;
  stdev: number | null;
  /** 准时率 0~1；无承诺交期样本 → null */
  onTimeRate: number | null;
  avgDelayDays: number | null;
  /** 档案常规交期（sku_params.normal_lead_days） */
  currentLeadDays: number | null;
  suggestLeadDays: number | null;
  suggestReason: string;
}

export interface LeadTimeLearning {
  rows: LeadTimeRow[];
  total: number;
  minSamples: number;
  deviationPct: number;
  summary: {
    /** 有样本的 供应商-SKU 对数 */
    pairCount: number;
    /** 其中给出建议的对数 */
    withSuggestion: number;
    /** 平均准时率 0~1（仅有承诺交期样本的对参与平均）；无 → null */
    avgOnTimeRate: number | null;
  };
}

/** 时间戳 → Asia/Shanghai 日期串（与 report/risk.ts 同准） */
function shanghaiDate(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(d);
}
/** 日界差（日期串直减） */
function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);
}

export async function getLeadTimeLearning(
  query: { q?: string; page?: number; pageSize?: number },
  dbArg?: AnyDb,
): Promise<LeadTimeLearning> {
  const db: AnyDb = dbArg ?? (await getDbAsync());
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
    .where(and(eq(schema.shDocs.sourceType, "po"), inArray(schema.shDocs.status, [...EFFECTIVE_STATUSES])))
    .groupBy(schema.shDocs.sourceId, schema.shLines.skuId)
    .as("receipts");

  const sampleRows: {
    supplierId: number;
    skuId: number;
    orderedAt: Date;
    promisedDate: string | null;
    receivedAt: Date;
  }[] = await db
    .select({
      supplierId: schema.poDocs.supplierId,
      skuId: schema.poLines.skuId,
      orderedAt: schema.poDocs.createdAt,
      promisedDate: sql<string | null>`coalesce(${schema.poLines.expectedDate}, ${schema.poDocs.expectedDate})`,
      receivedAt: receipts.receivedAt,
    })
    .from(schema.poLines)
    .innerJoin(schema.poDocs, eq(schema.poLines.poId, schema.poDocs.id))
    .innerJoin(receipts, and(eq(receipts.poId, schema.poLines.poId), eq(receipts.skuId, schema.poLines.skuId)));

  /* ── 按 (供应商, SKU) 归集样本 ── */
  const byPair = new Map<string, { supplierId: number; skuId: number; samples: LeadTimeSample[] }>();
  for (const r of sampleRows) {
    const ordered = shanghaiDate(new Date(r.orderedAt));
    const received = shanghaiDate(new Date(r.receivedAt));
    const actualDays = daysBetween(ordered, received);
    if (!Number.isFinite(actualDays) || actualDays < 0) continue; // 收货早于制单=历史补录脏数据，丢弃
    const promisedDays = r.promisedDate ? daysBetween(ordered, r.promisedDate) : null;
    const key = `${r.supplierId}|${r.skuId}`;
    const cur = byPair.get(key) ?? { supplierId: r.supplierId, skuId: r.skuId, samples: [] };
    cur.samples.push({ promisedDays: promisedDays != null && promisedDays >= 0 ? promisedDays : null, actualDays });
    byPair.set(key, cur);
  }
  if (byPair.size === 0) {
    return { rows: [], total: 0, minSamples: MIN_SAMPLES, deviationPct: DEVIATION_PCT, summary: { pairCount: 0, withSuggestion: 0, avgOnTimeRate: null } };
  }

  /* ── 主档：供应商名、SKU 编码/名称、档案交期 ── */
  const supplierIds = [...new Set([...byPair.values()].map((p) => p.supplierId))];
  const skuIds = [...new Set([...byPair.values()].map((p) => p.skuId))];
  const [supRows, skuRows, paramRows]: [
    { id: number; name: string }[],
    { id: number; code: string; name: string }[],
    { skuId: number; normalLeadDays: number | null }[],
  ] = await Promise.all([
    db.select({ id: schema.suppliers.id, name: schema.suppliers.name }).from(schema.suppliers).where(inArray(schema.suppliers.id, supplierIds)),
    db.select({ id: schema.skus.id, code: schema.skus.code, name: schema.skus.name }).from(schema.skus).where(inArray(schema.skus.id, skuIds)),
    db.select({ skuId: schema.skuParams.skuId, normalLeadDays: schema.skuParams.normalLeadDays }).from(schema.skuParams).where(inArray(schema.skuParams.skuId, skuIds)),
  ]);
  const supById = new Map(supRows.map((s) => [s.id, s.name]));
  const skuById = new Map(skuRows.map((s) => [s.id, s]));
  const leadBySku = new Map(paramRows.map((p) => [p.skuId, p.normalLeadDays]));

  /* ── 逐对统计 + 建议 ── */
  const all: (LeadTimeRow & { score: number })[] = [];
  for (const pair of byPair.values()) {
    const sku = skuById.get(pair.skuId);
    if (!sku) continue; // SKU 已被删除（理论上 FK 拦住）
    const stats = leadTimeStats(pair.samples);
    const current = leadBySku.get(pair.skuId) ?? null;
    const sug = suggestLeadDays(current, stats, MIN_SAMPLES, DEVIATION_PCT);
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
    deviationPct: DEVIATION_PCT,
    summary,
  };
}

const applySchema = z.object({
  skuId: z.number().int().positive(),
  leadDays: z.number().int().min(1).max(365),
});

/**
 * 采纳建议：把学习到的 P50 写入 sku_params.normal_lead_days（人工闸——只有点击才走到这里）。
 * upsert on (sku_id)，留痕 entity=sku_params / action=apply_leadtime_suggestion。
 */
export async function applyLeadTimeSuggestion(
  user: SessionUser,
  input: { skuId: number; leadDays: number },
  dbArg?: AnyDb,
): Promise<{ ok: true; skuId: number; leadDays: number }> {
  requireAnyRole(user, "pmc", "purchasing");
  const v = applySchema.parse(input);
  const db: AnyDb = dbArg ?? (await getDbAsync());

  const [sku]: { id: number }[] = await db.select({ id: schema.skus.id }).from(schema.skus).where(eq(schema.skus.id, v.skuId));
  if (!sku) throw new ApiError(404, `SKU 不存在: #${v.skuId}`);

  await db.transaction(async (tx: AnyDb) => {
    const [old]: { normalLeadDays: number | null }[] = await tx
      .select({ normalLeadDays: schema.skuParams.normalLeadDays })
      .from(schema.skuParams)
      .where(eq(schema.skuParams.skuId, v.skuId));
    await tx
      .insert(schema.skuParams)
      .values({ skuId: v.skuId, normalLeadDays: v.leadDays, updatedBy: user.id, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: schema.skuParams.skuId,
        set: { normalLeadDays: v.leadDays, updatedBy: user.id, updatedAt: new Date() },
      });
    await writeAudit(tx, {
      userId: user.id,
      entity: "sku_params",
      entityId: v.skuId,
      action: "apply_leadtime_suggestion",
      before: { skuId: v.skuId, normalLeadDays: old?.normalLeadDays ?? null },
      after: { skuId: v.skuId, leadDays: v.leadDays, source: "leadtime_learning" },
    });
  });
  return { ok: true, skuId: v.skuId, leadDays: v.leadDays };
}
