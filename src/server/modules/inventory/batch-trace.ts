/**
 * E4-01 批次登记与追溯（合规硬需求：召回时"这批货从哪来、去了哪"）。
 *
 * ── 现状诊断（实读代码后的结论，非推测）──
 * 1. 收货单行 `sh_lines` **已采集** batchNo / prodDate；
 * 2. 主档 `batches` 表**早已定义但从无任何代码写入**——批次登记册是空的；
 * 3. 批次过账现由 `batch_posting_enabled` 迁移闸门控制；打开后，收货、发料、
 *    退料、采购退货及手工出库/调拨均写入 batchId，未批次化历史余额允许显式回落。
 *
 * ── 本模块的范围与刻意不做的事（重要）──
 * 做：
 *   - `registerBatchesFromReceipt`：收货入库时把行上的批次信息登记进 `batches` 主档
 *     （幂等：同 (skuId,batchNo) 复用既有行，补齐缺失的效期/生产日期）；
 *   - `requireBatchForExpirySkus`：对"管效期"的 SKU 强制要求收货填批次（校验，不静默放过）；
 *   - `traceBatch`：按批次追溯**当前可知**的链路（登记信息 + 收货来源单 + 批次库存分布）。
 * 开闸前提：
 *   - 先迁移/盘点历史 null 批次余额并完成全出库路径 UAT；
 *   - 管理员再把 `batch_posting_enabled` 从 0 改为 1。默认关闭，避免半链路上线。
 */
import { and, desc, eq, sql } from "drizzle-orm";
import { getDbAsync } from "@/db";
import * as schema from "@/db/schema";
import { ApiError } from "@/server/modules/master/common";
import { num } from "@/server/core/svc";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle PGlite/Postgres structural compatibility is narrowed by the surrounding service contract
type AnyDb = any;

export interface ReceiptBatchLine {
  skuId: number;
  batchNo?: string | null;
  prodDate?: string | null;
  expiryDate?: string | null;
}

/**
 * 收货入库时登记批次主档（幂等）。
 * @returns 每行对应的 batchId（无批次号的行为 null）
 */
export async function registerBatchesFromReceipt(
  db: AnyDb,
  lines: ReceiptBatchLine[],
  source: { docType: string; docId: number },
): Promise<Map<string, number>> {
  const idByKey = new Map<string, number>();
  for (const l of lines) {
    const batchNo = (l.batchNo ?? "").trim();
    if (!batchNo) continue;
    const key = `${l.skuId}:${batchNo}`;
    if (idByKey.has(key)) continue;

    const [existing] = await db
      .select({ id: schema.batches.id, prodDate: schema.batches.prodDate, expiryDate: schema.batches.expiryDate })
      .from(schema.batches)
      .where(and(eq(schema.batches.skuId, l.skuId), eq(schema.batches.batchNo, batchNo)));

    if (existing) {
      // 补齐既有登记里缺失的日期（不覆盖已有值——先到先得，避免后录数据篡改历史）
      const patch: Record<string, unknown> = {};
      if (existing.prodDate == null && l.prodDate) patch.prodDate = l.prodDate;
      if (existing.expiryDate == null && l.expiryDate) patch.expiryDate = l.expiryDate;
      if (Object.keys(patch).length > 0) {
        await db.update(schema.batches).set(patch).where(eq(schema.batches.id, existing.id));
      }
      idByKey.set(key, existing.id);
      continue;
    }

    const [created] = await db
      .insert(schema.batches)
      .values({
        skuId: l.skuId,
        batchNo,
        prodDate: l.prodDate ?? null,
        expiryDate: l.expiryDate ?? null,
        sourceDocType: source.docType,
        sourceDocId: source.docId,
      })
      .onConflictDoNothing()
      .returning();
    if (created) {
      idByKey.set(key, created.id);
    } else {
      // 并发下被他人抢先插入——回查
      const [again] = await db
        .select({ id: schema.batches.id })
        .from(schema.batches)
        .where(and(eq(schema.batches.skuId, l.skuId), eq(schema.batches.batchNo, batchNo)));
      if (again) idByKey.set(key, again.id);
    }
  }
  return idByKey;
}

/**
 * 对"管效期"的 SKU 强制批次采集。
 * 判定：skus.nearExpiryDays 非空 视为该 SKU 纳入效期管理（与 R15 逐 SKU 阈值同源）。
 * 缺批次号即拒收——效期管理若允许无批次入库，后续一切效期与召回能力都是空中楼阁。
 */
export async function requireBatchForExpirySkus(db: AnyDb, lines: ReceiptBatchLine[]): Promise<void> {
  const skuIds = [...new Set(lines.map((l) => l.skuId))];
  if (skuIds.length === 0) return;
  const rows: { id: number; code: string; nearExpiryDays: number | null }[] = await db
    .select({ id: schema.skus.id, code: schema.skus.code, nearExpiryDays: schema.skus.nearExpiryDays })
    .from(schema.skus)
    .where(sql`${schema.skus.id} in ${skuIds}`);
  const managed = new Map(rows.filter((r) => r.nearExpiryDays != null).map((r) => [r.id, r.code]));
  const missing = lines
    .filter((l) => managed.has(l.skuId) && !(l.batchNo ?? "").trim())
    .map((l) => managed.get(l.skuId)!);
  if (missing.length > 0) {
    throw new ApiError(400, `以下管效期 SKU 收货必须填写批次号：${[...new Set(missing)].join("、")}`);
  }
}

export interface BatchTraceResult {
  batch: { id: number; batchNo: string; skuId: number; skuCode: string; skuName: string; prodDate: string | null; expiryDate: string | null };
  /** 来源单据（登记时记录） */
  source: { docType: string | null; docId: number | null };
  /** 该批次在各仓的参考层库存（batch_stocks） */
  stockByWarehouse: { warehouse: string; qty: number; stocktakeDate: string }[];
  /** 台账中带该 batchId 的流水（当前仅发料/库存单等已支持批次的路径会有） */
  ledger: { occurredAt: string; warehouse: string; qtyDelta: number; sourceDocType: string; sourceDocId: number }[];
  /** 诚实标注：出库侧批次归属的覆盖情况 */
  coverage: { outboundTraceable: boolean; note: string };
}

/** 按 SKU 编码 + 批次号追溯 */
export async function traceBatch(skuCode: string, batchNo: string, dbArg?: AnyDb): Promise<BatchTraceResult> {
  const db: AnyDb = dbArg ?? (await getDbAsync());
  const code = String(skuCode ?? "").trim();
  const bn = String(batchNo ?? "").trim();
  if (!code || !bn) throw new ApiError(400, "请提供 SKU 编码与批次号");

  const [sku] = await db
    .select({ id: schema.skus.id, code: schema.skus.code, name: schema.skus.name })
    .from(schema.skus)
    .where(eq(schema.skus.code, code));
  if (!sku) throw new ApiError(404, "SKU 不存在");

  const [b] = await db
    .select()
    .from(schema.batches)
    .where(and(eq(schema.batches.skuId, sku.id), eq(schema.batches.batchNo, bn)));
  if (!b) throw new ApiError(404, `未找到批次登记：${code} / ${bn}（该批次可能在批次登记功能上线前入库）`);

  const stockRows: { warehouse: string; qty: string; stocktakeDate: string }[] = await db
    .select({ warehouse: schema.warehouses.name, qty: schema.batchStocks.qty, stocktakeDate: schema.batchStocks.stocktakeDate })
    .from(schema.batchStocks)
    .innerJoin(schema.warehouses, eq(schema.batchStocks.warehouseId, schema.warehouses.id))
    .where(and(eq(schema.batchStocks.skuId, sku.id), eq(schema.batchStocks.batchNo, bn)));

  const ledgerRows: { occurredAt: Date; warehouse: string; qtyDelta: string; sourceDocType: string; sourceDocId: number }[] = await db
    .select({
      occurredAt: schema.stockLedger.occurredAt,
      warehouse: schema.warehouses.name,
      qtyDelta: schema.stockLedger.qtyDelta,
      sourceDocType: schema.stockLedger.sourceDocType,
      sourceDocId: schema.stockLedger.sourceDocId,
    })
    .from(schema.stockLedger)
    .innerJoin(schema.warehouses, eq(schema.stockLedger.warehouseId, schema.warehouses.id))
    .where(eq(schema.stockLedger.batchId, b.id))
    .orderBy(desc(schema.stockLedger.occurredAt))
    .limit(200);

  const outboundTraceable = ledgerRows.some((r) => num(r.qtyDelta) < 0);
  return {
    batch: {
      id: b.id, batchNo: b.batchNo, skuId: sku.id, skuCode: sku.code, skuName: sku.name,
      prodDate: b.prodDate ?? null, expiryDate: b.expiryDate ?? null,
    },
    source: { docType: b.sourceDocType ?? null, docId: b.sourceDocId ?? null },
    stockByWarehouse: stockRows.map((r) => ({ warehouse: r.warehouse, qty: num(r.qty), stocktakeDate: r.stocktakeDate })),
    ledger: ledgerRows.map((r) => ({
      occurredAt: new Date(r.occurredAt).toISOString().slice(0, 10),
      warehouse: r.warehouse,
      qtyDelta: num(r.qtyDelta),
      sourceDocType: r.sourceDocType,
      sourceDocId: r.sourceDocId,
    })),
    coverage: {
      outboundTraceable,
      note: outboundTraceable
        ? "该批次已有带批次的出库流水，可追至出库单据。"
        : "该批次尚无带批次的出库流水。可能是批次/FEFO 迁移闸门仍关闭、尚未发生出库，"
          + "或历史余额仍在无批次维度；在出现批次出库前，本页只能证明来源与当前库存分布。",
    },
  };
}
