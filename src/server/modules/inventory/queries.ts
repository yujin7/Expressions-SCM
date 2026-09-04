import { and, desc, eq, gte, ilike, inArray, lte, or, sql } from "drizzle-orm";

import { batches, skus, spus, stockBalances, stockLedger, warehouses } from "@/db/schema";
import type { AnyDb } from "@/server/posting/post";
import { resolveDb } from "@/server/core/svc";


/** SKU×仓库×批次 余额（实时仓口径；快照仓 1.1 并入）。nonzero 默认 true=隐藏零余额行 */
export async function listBalances(
  opts: {
    q?: string;
    warehouseId?: number;
    nonzero?: boolean;
    /** 业务用途筛选（0727 会议：小样要能单独查库存明细）。 */
    commercialRole?: string;
    page: number;
    pageSize: number;
  },
  dbArg?: AnyDb,
): Promise<{ rows: unknown[]; total: number }> {
  const db = await resolveDb(dbArg);
  const conds = [];
  if (opts.nonzero !== false) conds.push(sql`${stockBalances.qty} <> 0`);
  if (opts.warehouseId) conds.push(eq(stockBalances.warehouseId, opts.warehouseId));
  // 能筛小样的地方（SKU 主档）没有库存数量，有库存数量的地方没有业务用途——
  // M-22 说的「输入=小样、输出=库存明细」此前无处可做，这里补上入口。
  if (opts.commercialRole) conds.push(eq(skus.commercialRole, opts.commercialRole));
  if (opts.q) {
    conds.push(
      or(
        ilike(skus.code, `%${opts.q}%`),
        ilike(skus.name, `%${opts.q}%`),
        ilike(spus.nameCn, `%${opts.q}%`),
        ilike(batches.batchNo, `%${opts.q}%`),
      ),
    );
  }
  const where = conds.length ? and(...conds) : undefined;

  const [rows, [{ total }]] = await Promise.all([
    db
      .select({
        skuId: skus.id,
        skuCode: skus.code,
        skuName: skus.name,
        baseUom: skus.baseUom,
        commercialRole: skus.commercialRole,
        spuCode: spus.code,
        spuNameCn: spus.nameCn,
        warehouseId: warehouses.id,
        warehouseName: warehouses.name,
        warehouseKind: warehouses.kind,
        batchId: stockBalances.batchId,
        batchNo: batches.batchNo,
        batchExpiryDate: batches.expiryDate,
        qty: stockBalances.qty,
      })
      .from(stockBalances)
      .innerJoin(skus, eq(stockBalances.skuId, skus.id))
      .innerJoin(spus, eq(skus.spuId, spus.id))
      .innerJoin(warehouses, eq(stockBalances.warehouseId, warehouses.id))
      .leftJoin(batches, eq(stockBalances.batchId, batches.id))
      .where(where)
      .orderBy(skus.code, warehouses.code, stockBalances.batchId)
      .limit(opts.pageSize)
      .offset((opts.page - 1) * opts.pageSize),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(stockBalances)
      .innerJoin(skus, eq(stockBalances.skuId, skus.id))
      .innerJoin(spus, eq(skus.spuId, spus.id))
      .innerJoin(warehouses, eq(stockBalances.warehouseId, warehouses.id))
      .leftJoin(batches, eq(stockBalances.batchId, batches.id))
      .where(where),
  ]);
  return { rows, total };
}

/**
 * SPU 口径汇总（R3 报表归集）。跨仓合计；仅同基础单位的产品数量相加才有业务意义
 * （单位混合风险已知，UI 注明）。
 */
export async function listBalancesBySpu(
  opts: { q?: string; page: number; pageSize: number },
  dbArg?: AnyDb,
): Promise<{ rows: unknown[]; total: number }> {
  const db = await resolveDb(dbArg);
  const conds = [];
  if (opts.q) conds.push(or(ilike(spus.code, `%${opts.q}%`), ilike(spus.nameCn, `%${opts.q}%`)));
  const where = conds.length ? and(...conds) : undefined;

  const [rows, [{ total }]] = await Promise.all([
    db
      .select({
        spuId: spus.id,
        spuCode: spus.code,
        spuNameCn: spus.nameCn,
        totalQty: sql<string>`sum(${stockBalances.qty})`,
        skuCount: sql<number>`count(distinct ${skus.id})::int`,
      })
      .from(stockBalances)
      .innerJoin(skus, eq(stockBalances.skuId, skus.id))
      .innerJoin(spus, eq(skus.spuId, spus.id))
      .where(where)
      .groupBy(spus.id, spus.code, spus.nameCn)
      .orderBy(spus.code)
      .limit(opts.pageSize)
      .offset((opts.page - 1) * opts.pageSize),
    db
      .select({ total: sql<number>`count(distinct ${spus.id})::int` })
      .from(stockBalances)
      .innerJoin(skus, eq(stockBalances.skuId, skus.id))
      .innerJoin(spus, eq(skus.spuId, spus.id))
      .where(where),
  ]);
  return { rows, total };
}

/** 库存流水（唯一事实源，仅追加）分页查询 */
export async function listLedger(
  opts: { skuId?: number; warehouseId?: number; from?: string; to?: string; page: number; pageSize: number },
  dbArg?: AnyDb,
): Promise<{ rows: unknown[]; total: number }> {
  const db = await resolveDb(dbArg);
  const conds = [];
  if (opts.skuId) conds.push(eq(stockLedger.skuId, opts.skuId));
  if (opts.warehouseId) conds.push(eq(stockLedger.warehouseId, opts.warehouseId));
  if (opts.from) conds.push(gte(stockLedger.occurredAt, new Date(opts.from)));
  if (opts.to) conds.push(lte(stockLedger.occurredAt, new Date(opts.to)));
  const where = conds.length ? and(...conds) : undefined;

  const [rows, [{ total }]] = await Promise.all([
    db
      .select({
        id: stockLedger.id,
        occurredAt: stockLedger.occurredAt,
        skuCode: skus.code,
        skuName: skus.name,
        warehouseName: warehouses.name,
        qtyDelta: stockLedger.qtyDelta,
        sourceDocType: stockLedger.sourceDocType,
        sourceDocId: stockLedger.sourceDocId,
        action: stockLedger.action,
      })
      .from(stockLedger)
      .innerJoin(skus, eq(stockLedger.skuId, skus.id))
      .innerJoin(warehouses, eq(stockLedger.warehouseId, warehouses.id))
      .where(where)
      .orderBy(desc(stockLedger.occurredAt), desc(stockLedger.id))
      .limit(opts.pageSize)
      .offset((opts.page - 1) * opts.pageSize),
    db.select({ total: sql<number>`count(*)::int` }).from(stockLedger).where(where),
  ]);
  return { rows, total };
}

/**
 * D20 全仓视图（2026-07-24 代决落地）：快照仓最新快照，只读参考口径——不入账本。
 * 每 (仓库,SKU) 取最大 biz_date 行；行带 bizDate 供前端数据龄标注。
 */
export async function listSnapshotBalances(
  opts: { q?: string; warehouseId?: number; page: number; pageSize: number },
  dbArg?: AnyDb,
): Promise<{ rows: unknown[]; total: number }> {
  const db = await resolveDb(dbArg);
  /* 「取最新快照」只有 core/stock-view.getLatestSnapshotRows 一个实现（此前本函数逐字复制了一份子查询）。
     快照仓 × SKU 的最新行规模在千级，维表补齐与搜索/分页在内存完成；行带 commercialRole（0727：小样要能单独查库存）。 */
  const { getLatestSnapshotRows } = await import("@/server/core/stock-view");
  const latestRows = (await getLatestSnapshotRows(db))
    .filter((r) => Number(r.qty) !== 0 && (!opts.warehouseId || r.warehouseId === opts.warehouseId));
  const skuIds = [...new Set(latestRows.map((r) => r.skuId))];
  const whIds = [...new Set(latestRows.map((r) => r.warehouseId))];
  const [skuRows, whRows]: [
    { id: number; code: string; name: string; baseUom: string; commercialRole: string; spuCode: string; spuNameCn: string }[],
    { id: number; name: string; kind: string }[],
  ] = await Promise.all([
    skuIds.length
      ? db
        .select({
          id: skus.id, code: skus.code, name: skus.name, baseUom: skus.baseUom, commercialRole: skus.commercialRole,
          spuCode: spus.code, spuNameCn: spus.nameCn,
        })
        .from(skus)
        .innerJoin(spus, eq(skus.spuId, spus.id))
        .where(inArray(skus.id, skuIds))
      : Promise.resolve([]),
    whIds.length
      ? db.select({ id: warehouses.id, name: warehouses.name, kind: warehouses.kind }).from(warehouses).where(inArray(warehouses.id, whIds))
      : Promise.resolve([]),
  ]);
  const skuById = new Map(skuRows.map((s) => [s.id, s]));
  const whById = new Map(whRows.map((w) => [w.id, w]));
  const q = (opts.q ?? "").trim().toLowerCase();
  const collator = new Intl.Collator("zh-CN");
  const all = latestRows
    .flatMap((r) => {
      const s = skuById.get(r.skuId);
      const w = whById.get(r.warehouseId);
      if (!s || !w) return [];
      if (q && !s.code.toLowerCase().includes(q) && !s.name.toLowerCase().includes(q)) return [];
      return [{
        skuId: r.skuId,
        skuCode: s.code,
        skuName: s.name,
        baseUom: s.baseUom,
        commercialRole: s.commercialRole,
        spuCode: s.spuCode,
        spuNameCn: s.spuNameCn,
        warehouseId: r.warehouseId,
        warehouseName: w.name,
        warehouseKind: w.kind,
        qty: r.qty,
        bizDate: r.bizDate,
      }];
    })
    .sort((a, b) => collator.compare(a.skuCode, b.skuCode) || collator.compare(a.warehouseName, b.warehouseName));
  const start = (opts.page - 1) * opts.pageSize;
  return { rows: all.slice(start, start + opts.pageSize), total: all.length };
}
