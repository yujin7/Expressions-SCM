/**
 * E4-01 批次登记与追溯（合规硬需求：召回时"这批货从哪来、去了哪"）。
 *
 * ── 当前边界 ──
 * 收货单行 `sh_lines` 采集 batchNo / prodDate，入库时登记批次主档。
 * 批次过账由 `batch_posting_enabled` 迁移闸门控制；打开后，收货、发料、
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
import { and, eq, sql } from "drizzle-orm";
import { getDbAsync } from "@/db";
import * as schema from "@/db/schema";
import { ApiError } from "@/server/modules/master/common";
import { num } from "@/server/core/svc";
import { compareBatchIdentity } from "@/server/core/batch-order";
import { latestStocktakeRows, loadLatestStocktakeDates } from "@/server/core/stock-view";
import { shanghaiDayOf } from "@/server/core/business-day";
import { documentHref, documentTargetPath } from "@/lib/document-links";
import { LEDGER_SOURCE_TARGETS } from "@/lib/ledger-source-docs";
import { resolveSourceDocNos } from "./queries";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle PGlite/Postgres structural compatibility is narrowed by the surrounding service contract
type AnyDb = any;

export interface ReceiptBatchLine {
  skuId: number;
  batchNo?: string | null;
  prodDate?: string | null;
  expiryDate?: string | null;
}

/**
 * 收货入库时登记批次主档（幂等），须在调用方的入库/审计事务内使用。
 * 同批行先合并缺失字段；已有非空日期和首次来源不覆盖。
 * @returns SKU:批次号 → batchId（无批次号不进入映射）
 */
export async function registerBatchesFromReceipt(
  db: AnyDb,
  lines: ReceiptBatchLine[],
  source: { docType: string; docId: number },
): Promise<Map<string, number>> {
  const byKey = new Map<string, ReceiptBatchLine & { batchNo: string }>();
  for (const l of lines) {
    const batchNo = (l.batchNo ?? "").trim();
    if (!batchNo) continue;
    const key = `${l.skuId}:${batchNo}`;
    const prior = byKey.get(key);
    if (prior) {
      // 同一请求也沿用每字段首次非空优先，不以整个首行代表全部批次信息。
      prior.prodDate ??= l.prodDate;
      prior.expiryDate ??= l.expiryDate;
    } else {
      byKey.set(key, { ...l, batchNo });
    }
  }

  // 跨PO的收货不共享PO锁；统一批次锁顺序，避免两张SH按相反行顺序补日期时死锁。
  const ordered = [...byKey.values()].sort(compareBatchIdentity);
  const idByKey = new Map<string, number>();
  for (const l of ordered) {
    const [registered]: { id: number }[] = await db
      .insert(schema.batches)
      .values({
        skuId: l.skuId,
        batchNo: l.batchNo,
        prodDate: l.prodDate ?? null,
        expiryDate: l.expiryDate ?? null,
        sourceDocType: source.docType,
        sourceDocId: source.docId,
      })
      .onConflictDoUpdate({
        target: [schema.batches.skuId, schema.batches.batchNo],
        set: {
          // 在唯一键冲突持锁后判断“仍为空”，不能先SELECT再无条件UPDATE。
          prodDate: sql`coalesce(${schema.batches.prodDate}, excluded.prod_date)`,
          expiryDate: sql`coalesce(${schema.batches.expiryDate}, excluded.expiry_date)`,
        },
      })
      .returning({ id: schema.batches.id });
    if (!registered) throw new ApiError(409, `批次登记未返回身份：SKU #${l.skuId} / ${l.batchNo}，请重新核对收货单`);
    idByKey.set(`${l.skuId}:${l.batchNo}`, registered.id);
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
  batch: { id: number; batchNo: string; skuId: number; skuCode: string; skuName: string; baseUom: string; prodDate: string | null; expiryDate: string | null };
  /** 来源单据（登记时记录） */
  source: { docType: string | null; docId: number | null; href: string | null };
  /** 该批次在各仓的参考层库存（batch_stocks） */
  stockByWarehouse: { warehouse: string; qty: number; stocktakeDate: string }[];
  /** 台账中带该 batchId 的流水（当前仅发料/库存单等已支持批次的路径会有） */
  ledger: { id: number; occurredAt: string; warehouse: string; qtyDelta: string; sourceDocType: string; sourceDocId: number; sourceLineId: number; sourceDocNo: string | null; sourceHref: string | null }[];
  ledgerPage: { page: number; pageSize: number; total: number };
  /** 诚实标注：出库侧批次归属的覆盖情况 */
  coverage: { outboundTraceable: boolean; note: string };
}

/** 按 SKU 编码 + 批次号追溯 */
export async function traceBatch(skuCode: string, batchNo: string, dbArg?: AnyDb, options: { page?: number; pageSize?: number } = {}): Promise<BatchTraceResult> {
  const { page = 1, pageSize = 30 } = options;
  if (!Number.isSafeInteger(page) || page < 1 || page > 1_000_000 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
    throw new ApiError(400, "分页参数无效：页码须为1至1000000的整数，每页条数须为1至100的整数");
  }
  const db: AnyDb = dbArg ?? (await getDbAsync());
  const code = String(skuCode ?? "").trim();
  const bn = String(batchNo ?? "").trim();
  if (!code || !bn) throw new ApiError(400, "请提供 SKU 编码与批次号");

  const [sku] = await db
    .select({ id: schema.skus.id, code: schema.skus.code, name: schema.skus.name, baseUom: schema.skus.baseUom })
    .from(schema.skus)
    .where(eq(schema.skus.code, code));
  if (!sku) throw new ApiError(404, "SKU 不存在");

  const [b] = await db
    .select()
    .from(schema.batches)
    .where(and(eq(schema.batches.skuId, sku.id), eq(schema.batches.batchNo, bn)));
  if (!b) throw new ApiError(404, `未找到批次登记：${code} / ${bn}（该批次可能在批次登记功能上线前入库）`);

  const stockRowsAllPeriods: { warehouse: string; warehouseId: number; qty: string; stocktakeDate: string }[] = await db
    .select({ warehouse: schema.warehouses.name, warehouseId: schema.batchStocks.warehouseId, qty: schema.batchStocks.qty, stocktakeDate: schema.batchStocks.stocktakeDate })
    .from(schema.batchStocks)
    .innerJoin(schema.warehouses, eq(schema.batchStocks.warehouseId, schema.warehouses.id))
    .where(and(eq(schema.batchStocks.skuId, sku.id), eq(schema.batchStocks.batchNo, bn)));
  // 盘点期间收口（core/stock-view 唯一权威）：召回时「这批货现在在哪」只认该仓最新一期，旧期行不再重复出现
  const stockRows = latestStocktakeRows(stockRowsAllPeriods, await loadLatestStocktakeDates(db));

  // 一条语句保证总数、出库证据与本页处于同一DB快照；空页也保留全量统计。
  // 不把全部流水传回JS，不以当前页推断全批覆盖。同时间按不可变流水ID稳定排序。
  const result = await db.execute(sql`
    with matched as not materialized (
      select id, occurred_at, warehouse_id, qty_delta, source_doc_type, source_doc_id, source_line_id
      from stock_ledger where sku_id = ${sku.id} and batch_id = ${b.id}
    ), summary as (
      select count(*)::integer as total, coalesce(bool_or(qty_delta < 0 and source_doc_type in
        ('ct_return', 'fl_issue', 'tl_return', 'issue_out', 'sales_out', 'transfer')), false) as outbound from matched
    ), detail as (
      select m.*, w.name as warehouse from matched m join warehouses w on w.id = m.warehouse_id
      order by m.occurred_at desc, m.id desc limit ${pageSize} offset ${(page - 1) * pageSize}
    )
    select summary.total, summary.outbound, coalesce(jsonb_agg(jsonb_build_object(
      'id', detail.id, 'occurredAt', detail.occurred_at, 'warehouse', detail.warehouse,
      'qtyDelta', detail.qty_delta::text, 'sourceDocType', detail.source_doc_type,
      'sourceDocId', detail.source_doc_id, 'sourceLineId', detail.source_line_id
    ) order by detail.occurred_at desc, detail.id desc) filter (where detail.id is not null), '[]'::jsonb) as rows
    from summary left join detail on true group by summary.total, summary.outbound
  `);
  const summary: { total: number; outbound: boolean; rows: Omit<BatchTraceResult["ledger"][number], "sourceDocNo" | "sourceHref">[] } = result.rows[0];
  const ledgerRows = summary.rows;
  const sourceNos = await resolveSourceDocNos(db, ledgerRows);
  const outboundTraceable = summary.outbound;
  return {
    batch: {
      id: b.id, batchNo: b.batchNo, skuId: sku.id, skuCode: sku.code, skuName: sku.name,
      baseUom: sku.baseUom, prodDate: b.prodDate ?? null, expiryDate: b.expiryDate ?? null,
    },
    source: { docType: b.sourceDocType ?? null, docId: b.sourceDocId ?? null, href: documentHref(b.sourceDocType ?? "", b.sourceDocId ?? 0) },
    stockByWarehouse: stockRows.map((r) => ({ warehouse: r.warehouse, qty: num(r.qty), stocktakeDate: r.stocktakeDate })),
    ledger: ledgerRows.map((r) => {
      const target = Object.hasOwn(LEDGER_SOURCE_TARGETS, r.sourceDocType) ? LEDGER_SOURCE_TARGETS[r.sourceDocType] : null;
      const sourceDocNo = target ? sourceNos.get(`${target.table}:${r.sourceDocId}`) ?? null : null;
      return { ...r, occurredAt: shanghaiDayOf(new Date(r.occurredAt)), sourceDocNo,
        sourceHref: target && sourceDocNo ? documentTargetPath(target.path, "", r.sourceDocId) : null };
    }),
    ledgerPage: { page, pageSize, total: summary.total },
    coverage: {
      outboundTraceable,
      note: outboundTraceable
        ? "全部带该批次的流水中已有出库、退货或调拨负向记录，可逐行核对来源；盘亏、冲销及核销不充当发货证据。出库记录不代表未批次化历史或外部去向已完整覆盖，也不代表未被后续冲销。"
        : "该批次尚无带批次的出库流水。可能是批次/FEFO 迁移闸门仍关闭、尚未发生出库，"
          + "或历史余额仍在无批次维度；参考层按仓库最新盘点期展示，不等于实时总账。",
    },
  };
}
