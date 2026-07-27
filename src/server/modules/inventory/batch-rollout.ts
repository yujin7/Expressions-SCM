/**
 * 批次过账上线体检与一次性启用。
 *
 * 这不是普通的 0/1 参数：一旦启用，新入库开始写 batchId、出库开始按 FEFO 拆行；
 * 再关闭会制造两套并行库存口径。因此启用必须先看体检快照、显式确认历史无批次
 * 库存的回落策略，并且只允许 0 → 1。
 */
import { createHash } from "node:crypto";
import { and, eq, gt, isNotNull, isNull, sql } from "drizzle-orm";
import * as schema from "@/db/schema";
import { writeAudit } from "@/server/core/audit";
import { clearParamCache } from "@/server/core/params";
import { ApiError, type SessionUser, todayShanghai } from "@/server/modules/master/common";
import { isBatchPostingEnabled } from "./batch-allocation";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = any;

export const BATCH_ROLLOUT_CONFIRMATION = "ENABLE_FEFO_WITH_LEGACY_FALLBACK";

export interface BatchRolloutReport {
  enabled: boolean;
  generatedAt: string;
  positiveQty: number;
  traceableBatchQty: number;
  legacyQty: number;
  orphanBatchQty: number;
  coveragePct: number;
  batchPairs: number;
  legacyPairs: number;
  orphanBatchPairs: number;
  expiredLots: number;
  expiredQty: number;
  openLegacyOutboundLines: number;
  managedReceiptLinesMissingBatch: number;
  outboundPaths: {
    key: string;
    label: string;
    covered: boolean;
  }[];
  canEnable: boolean;
  warnings: string[];
  snapshotToken: string;
}

const OUTBOUND_PATHS = [
  { key: "stock_doc", label: "手工领料 / 销售出库 / 调拨", covered: true },
  { key: "ct", label: "采购退货 CT", covered: true },
  { key: "fl", label: "委外发料 FL", covered: true },
  { key: "tl", label: "委外退料 TL", covered: true },
  { key: "jg_consume", label: "加工收货倒冲物料", covered: true },
] as const;

function numberOf(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function tokenFor(report: Omit<BatchRolloutReport, "snapshotToken">): string {
  return createHash("sha256")
    .update(JSON.stringify({
      enabled: report.enabled,
      positiveQty: report.positiveQty,
      traceableBatchQty: report.traceableBatchQty,
      legacyQty: report.legacyQty,
      orphanBatchQty: report.orphanBatchQty,
      batchPairs: report.batchPairs,
      legacyPairs: report.legacyPairs,
      orphanBatchPairs: report.orphanBatchPairs,
      expiredLots: report.expiredLots,
      expiredQty: report.expiredQty,
      openLegacyOutboundLines: report.openLegacyOutboundLines,
      managedReceiptLinesMissingBatch: report.managedReceiptLinesMissingBatch,
    }))
    .digest("hex")
    .slice(0, 16);
}

export async function getBatchRolloutReport(db: AnyDb): Promise<BatchRolloutReport> {
  const today = todayShanghai();
  const [
    [batchSummary],
    [legacySummary],
    [orphanSummary],
    [expiredSummary],
    [stockDocOpen],
    [ctOpen],
    [flOpen],
    [tlOpen],
    [managedMissing],
  ] = await Promise.all([
    db
      .select({
        qty: sql<string>`coalesce(sum(${schema.stockBalances.qty}), 0)`,
        pairs: sql<number>`count(*)::int`,
      })
      .from(schema.stockBalances)
      .innerJoin(schema.batches, eq(schema.stockBalances.batchId, schema.batches.id))
      .where(and(isNotNull(schema.stockBalances.batchId), gt(schema.stockBalances.qty, "0"))),
    db
      .select({
        qty: sql<string>`coalesce(sum(${schema.stockBalances.qty}), 0)`,
        pairs: sql<number>`count(*)::int`,
      })
      .from(schema.stockBalances)
      .where(and(isNull(schema.stockBalances.batchId), gt(schema.stockBalances.qty, "0"))),
    db
      .select({
        qty: sql<string>`coalesce(sum(${schema.stockBalances.qty}), 0)`,
        pairs: sql<number>`count(*)::int`,
      })
      .from(schema.stockBalances)
      .leftJoin(schema.batches, eq(schema.stockBalances.batchId, schema.batches.id))
      .where(and(
        isNotNull(schema.stockBalances.batchId),
        isNull(schema.batches.id),
        gt(schema.stockBalances.qty, "0"),
      )),
    db
      .select({
        qty: sql<string>`coalesce(sum(${schema.stockBalances.qty}), 0)`,
        lots: sql<number>`count(distinct ${schema.stockBalances.batchId})::int`,
      })
      .from(schema.stockBalances)
      .innerJoin(schema.batches, eq(schema.stockBalances.batchId, schema.batches.id))
      .where(and(
        gt(schema.stockBalances.qty, "0"),
        sql`${schema.batches.expiryDate} is not null and ${schema.batches.expiryDate} <= ${today}`,
      )),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.stockDocLines)
      .innerJoin(schema.stockDocs, eq(schema.stockDocLines.stockDocId, schema.stockDocs.id))
      .where(and(
        isNull(schema.stockDocLines.batchId),
        sql`${schema.stockDocs.status} in ('draft', 'pending')`,
        sql`${schema.stockDocs.subtype} in ('issue_out', 'sales_out', 'transfer')`,
      )),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.ctLines)
      .innerJoin(schema.ctDocs, eq(schema.ctLines.ctId, schema.ctDocs.id))
      .where(and(isNull(schema.ctLines.batchId), sql`${schema.ctDocs.status} in ('draft', 'pending')`)),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.flLines)
      .innerJoin(schema.flDocs, eq(schema.flLines.flId, schema.flDocs.id))
      .where(and(isNull(schema.flLines.batchId), sql`${schema.flDocs.status} in ('draft', 'pending')`)),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.tlLines)
      .innerJoin(schema.tlDocs, eq(schema.tlLines.tlId, schema.tlDocs.id))
      .where(and(isNull(schema.tlLines.batchId), sql`${schema.tlDocs.status} in ('draft', 'pending')`)),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.shLines)
      .innerJoin(schema.skus, eq(schema.shLines.skuId, schema.skus.id))
      .where(and(isNotNull(schema.skus.nearExpiryDays), sql`trim(coalesce(${schema.shLines.batchNo}, '')) = ''`)),
  ]);

  const traceableBatchQty = numberOf(batchSummary?.qty);
  const legacyQty = numberOf(legacySummary?.qty);
  const orphanBatchQty = numberOf(orphanSummary?.qty);
  const positiveQty = traceableBatchQty + legacyQty + orphanBatchQty;
  const openLegacyOutboundLines =
    numberOf(stockDocOpen?.count) +
    numberOf(ctOpen?.count) +
    numberOf(flOpen?.count) +
    numberOf(tlOpen?.count);
  const coveragePct = positiveQty > 0 ? Math.round((traceableBatchQty / positiveQty) * 1000) / 10 : 100;
  const warnings: string[] = [];
  if (legacyQty > 0) {
    warnings.push(`仍有 ${legacyQty.toLocaleString("zh-CN")} 件正库存没有批次；启用后将按迁移期回落路径继续可用，但不可追溯。`);
  }
  if (numberOf(orphanSummary?.pairs) > 0) {
    warnings.push(
      `有 ${numberOf(orphanSummary?.pairs)} 条正库存引用不存在的批次主档（${orphanBatchQty.toLocaleString("zh-CN")} 件）；这是数据完整性阻断项，必须先修复。`,
    );
  }
  if (numberOf(expiredSummary?.lots) > 0) {
    warnings.push(`检测到 ${numberOf(expiredSummary?.lots)} 个过期正库存批次；FEFO 会排除它们，需另行隔离处置。`);
  }
  if (openLegacyOutboundLines > 0) {
    warnings.push(`有 ${openLegacyOutboundLines} 条启用前创建的在途出库行没有批次；它们仍按原口径审批，建议先清理。`);
  }
  if (numberOf(managedMissing?.count) > 0) {
    warnings.push(`历史收货中有 ${numberOf(managedMissing?.count)} 条管效期 SKU 缺批次号；新收货已由硬校验阻断此情况。`);
  }

  const base: Omit<BatchRolloutReport, "snapshotToken"> = {
    enabled: await isBatchPostingEnabled(db),
    generatedAt: new Date().toISOString(),
    positiveQty,
    traceableBatchQty,
    legacyQty,
    orphanBatchQty,
    coveragePct,
    batchPairs: numberOf(batchSummary?.pairs),
    legacyPairs: numberOf(legacySummary?.pairs),
    orphanBatchPairs: numberOf(orphanSummary?.pairs),
    expiredLots: numberOf(expiredSummary?.lots),
    expiredQty: numberOf(expiredSummary?.qty),
    openLegacyOutboundLines,
    managedReceiptLinesMissingBatch: numberOf(managedMissing?.count),
    outboundPaths: OUTBOUND_PATHS.map((path) => ({ ...path })),
    canEnable: OUTBOUND_PATHS.every((path) => path.covered) && numberOf(orphanSummary?.pairs) === 0,
    warnings,
  };
  return { ...base, snapshotToken: tokenFor(base) };
}

export async function activateBatchPosting(
  user: SessionUser,
  input: { snapshotToken?: string; confirmation?: string },
  db: AnyDb,
): Promise<{ enabled: true; idempotent: boolean; report: BatchRolloutReport }> {
  if (!user.roles.includes("admin")) throw new ApiError(403, "仅管理员可启用批次过账");

  return db.transaction(async (tx: AnyDb) => {
    const report = await getBatchRolloutReport(tx);
    if (report.enabled) return { enabled: true, idempotent: true, report };
    if (!report.canEnable) throw new ApiError(409, "仍有出库路径未接入批次分配，不可启用");
    if (!input.snapshotToken || input.snapshotToken !== report.snapshotToken) {
      throw new ApiError(409, "上线体检数据已变化，请刷新后重新确认");
    }
    if (report.legacyQty > 0 && input.confirmation !== BATCH_ROLLOUT_CONFIRMATION) {
      throw new ApiError(400, "必须确认历史无批次库存的回落与不可追溯风险");
    }

    const transitioned: { value: string }[] = await tx
      .insert(schema.sysParams)
      .values({
        scope: "global",
        key: "batch_posting_enabled",
        value: "1",
        note: "批次过账与 FEFO（一次性启用）",
      })
      .onConflictDoUpdate({
        target: [schema.sysParams.scope, schema.sysParams.key],
        set: { value: "1", note: "批次过账与 FEFO（一次性启用）" },
        setWhere: eq(schema.sysParams.value, "0"),
      })
      .returning({ value: schema.sysParams.value });
    if (transitioned.length === 0) {
      // 同一体检快照被两位管理员并发确认时，只有数据库条件更新的赢家留激活审计。
      clearParamCache();
      return {
        enabled: true,
        idempotent: true,
        report: { ...report, enabled: true },
      };
    }
    await writeAudit(tx, {
      userId: user.id,
      entity: "batch_posting",
      action: "activate",
      before: { enabled: false },
      after: {
        enabled: true,
        snapshotToken: report.snapshotToken,
        legacyQty: report.legacyQty,
        coveragePct: report.coveragePct,
        openLegacyOutboundLines: report.openLegacyOutboundLines,
      },
    });
    clearParamCache();
    return {
      enabled: true,
      idempotent: false,
      report: { ...report, enabled: true },
    };
  });
}
