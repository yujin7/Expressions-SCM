import { and, desc, eq, gte, ilike, lte, or, sql } from "drizzle-orm";

import { skus, spus, stockBalances, stockLedger, warehouses } from "@/db/schema";
import type { AnyDb } from "@/server/posting/post";
import { resolveDb } from "@/server/core/svc";


/** SKU×仓库×批次 余额（实时仓口径；快照仓 1.1 并入）。nonzero 默认 true=隐藏零余额行 */
export async function listBalances(
  opts: { q?: string; warehouseId?: number; nonzero?: boolean; page: number; pageSize: number },
  dbArg?: AnyDb,
): Promise<{ rows: unknown[]; total: number }> {
  const db = await resolveDb(dbArg);
  const conds = [];
  if (opts.nonzero !== false) conds.push(sql`${stockBalances.qty} <> 0`);
  if (opts.warehouseId) conds.push(eq(stockBalances.warehouseId, opts.warehouseId));
  if (opts.q) {
    conds.push(
      or(
        ilike(skus.code, `%${opts.q}%`),
        ilike(skus.name, `%${opts.q}%`),
        ilike(spus.nameCn, `%${opts.q}%`),
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
        spuCode: spus.code,
        spuNameCn: spus.nameCn,
        warehouseId: warehouses.id,
        warehouseName: warehouses.name,
        warehouseKind: warehouses.kind,
        batchId: stockBalances.batchId,
        qty: stockBalances.qty,
      })
      .from(stockBalances)
      .innerJoin(skus, eq(stockBalances.skuId, skus.id))
      .innerJoin(spus, eq(skus.spuId, spus.id))
      .innerJoin(warehouses, eq(stockBalances.warehouseId, warehouses.id))
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
  const { stockSnapshots } = await import("@/db/schema");
  const latest = db
    .select({
      warehouseId: stockSnapshots.warehouseId,
      skuId: stockSnapshots.skuId,
      maxDate: sql<string>`max(${stockSnapshots.bizDate})`.as("max_date"),
    })
    .from(stockSnapshots)
    .groupBy(stockSnapshots.warehouseId, stockSnapshots.skuId)
    .as("latest");
  const conds = [sql`${stockSnapshots.qty} <> 0`];
  if (opts.warehouseId) conds.push(eq(stockSnapshots.warehouseId, opts.warehouseId));
  if (opts.q) conds.push(or(ilike(skus.code, `%${opts.q}%`), ilike(skus.name, `%${opts.q}%`))!);
  const where = and(...conds);
  const base = db
    .select({
      skuId: stockSnapshots.skuId,
      skuCode: skus.code,
      skuName: skus.name,
      baseUom: skus.baseUom,
      spuCode: spus.code,
      spuNameCn: spus.nameCn,
      warehouseId: stockSnapshots.warehouseId,
      warehouseName: warehouses.name,
      warehouseKind: warehouses.kind,
      qty: stockSnapshots.qty,
      bizDate: stockSnapshots.bizDate,
    })
    .from(stockSnapshots)
    .innerJoin(
      latest,
      and(
        eq(latest.warehouseId, stockSnapshots.warehouseId),
        eq(latest.skuId, stockSnapshots.skuId),
        eq(latest.maxDate, stockSnapshots.bizDate),
      ),
    )
    .innerJoin(skus, eq(stockSnapshots.skuId, skus.id))
    .innerJoin(spus, eq(skus.spuId, spus.id))
    .innerJoin(warehouses, eq(stockSnapshots.warehouseId, warehouses.id));
  const [rows, [{ total }]] = await Promise.all([
    base.where(where).orderBy(skus.code, warehouses.name).limit(opts.pageSize).offset((opts.page - 1) * opts.pageSize),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(stockSnapshots)
      .innerJoin(
        latest,
        and(
          eq(latest.warehouseId, stockSnapshots.warehouseId),
          eq(latest.skuId, stockSnapshots.skuId),
          eq(latest.maxDate, stockSnapshots.bizDate),
        ),
      )
      .innerJoin(skus, eq(stockSnapshots.skuId, skus.id))
      .where(where),
  ]);
  return { rows, total };
}
