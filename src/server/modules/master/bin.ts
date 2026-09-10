import { and, eq, ilike, or, sql } from "drizzle-orm";
import { getDbAsync } from "@/db";
import * as schema from "@/db/schema";
import { writeAudit } from "@/server/core/audit";
import type { SessionUser } from "@/server/core/dto";
import { ApiError } from "./common";
import { binSchema } from "./schemas";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle PGlite/Postgres structural compatibility is narrowed by the surrounding service contract
type AnyDb = any;

function whereFor(args: { q: string; warehouseId?: number; kind?: string; active?: boolean }) {
  const clauses = [];
  if (args.q) {
    clauses.push(or(
      ilike(schema.bins.code, `%${args.q}%`),
      ilike(schema.bins.name, `%${args.q}%`),
    ));
  }
  if (args.warehouseId) clauses.push(eq(schema.bins.warehouseId, args.warehouseId));
  if (args.kind) clauses.push(eq(schema.bins.kind, args.kind));
  if (args.active != null) clauses.push(eq(schema.bins.active, args.active));
  return clauses.length ? and(...clauses) : undefined;
}

export const BIN_SORT_KEYS = ["warehouseCode", "code", "name"] as const;
export async function listBins(
  args: { q: string; warehouseId?: number; kind?: string; active?: boolean; page: number; pageSize: number; sort?: typeof BIN_SORT_KEYS[number]; order?: "asc" | "desc" },
  dbArg?: AnyDb,
) {
  const db = dbArg ?? (await getDbAsync());
  const where = whereFor(args);
  const column = args.sort === "code" ? schema.bins.code : args.sort === "name" ? schema.bins.name : schema.warehouses.code;
  const [data, [{ total }]] = await Promise.all([
    db
      .select({
        id: schema.bins.id,
        warehouseId: schema.bins.warehouseId,
        warehouseCode: schema.warehouses.code,
        warehouseName: schema.warehouses.name,
        code: schema.bins.code,
        name: schema.bins.name,
        kind: schema.bins.kind,
        active: schema.bins.active,
        remark: schema.bins.remark,
        createdAt: schema.bins.createdAt,
      })
      .from(schema.bins)
      .innerJoin(schema.warehouses, eq(schema.bins.warehouseId, schema.warehouses.id))
      .where(where)
      .orderBy(args.order === "desc" ? sql`${column} desc nulls last` : sql`${column} asc nulls last`, schema.warehouses.code, schema.bins.code, schema.bins.id)
      .limit(args.pageSize)
      .offset((args.page - 1) * args.pageSize),
    db.select({ total: sql<number>`count(*)::int` }).from(schema.bins).where(where),
  ]);
  return { data, total };
}

export async function getBin(id: number, dbArg?: AnyDb) {
  const db = dbArg ?? (await getDbAsync());
  const [row] = await db.select().from(schema.bins).where(eq(schema.bins.id, id));
  if (!row) throw new ApiError(404, "库位不存在");
  return row;
}

async function requireRealtimeWarehouse(db: AnyDb, warehouseId: number) {
  const [warehouse] = await db
    .select({
      id: schema.warehouses.id,
      active: schema.warehouses.active,
      accountingMode: schema.warehouses.accountingMode,
    })
    .from(schema.warehouses)
    .where(eq(schema.warehouses.id, warehouseId));
  if (!warehouse) throw new ApiError(400, "所属仓库不存在");
  if (!warehouse.active) throw new ApiError(409, "停用仓库不能维护新库位");
  if (warehouse.accountingMode !== "realtime") {
    throw new ApiError(409, "快照仓只接受外部库存快照，不能维护作业库位");
  }
}

export async function createBin(input: unknown, actor: SessionUser, dbArg?: AnyDb) {
  const value = binSchema.parse(input);
  const db = dbArg ?? (await getDbAsync());
  return db.transaction(async (tx: AnyDb) => {
    await requireRealtimeWarehouse(tx, value.warehouseId);
    const [created] = await tx.insert(schema.bins).values({
      warehouseId: value.warehouseId,
      code: value.code,
      name: value.name ?? null,
      kind: value.kind,
      active: value.active,
      remark: value.remark ?? null,
    }).returning();
    await writeAudit(tx, {
      userId: actor.id,
      entity: "bin",
      entityId: created.id,
      action: "create",
      after: created,
    });
    return created;
  });
}

export async function updateBin(id: number, input: unknown, actor: SessionUser, dbArg?: AnyDb) {
  const value = binSchema.parse(input);
  const db = dbArg ?? (await getDbAsync());
  return db.transaction(async (tx: AnyDb) => {
    const [existing] = await tx.select().from(schema.bins).where(eq(schema.bins.id, id));
    if (!existing) throw new ApiError(404, "库位不存在");
    await requireRealtimeWarehouse(tx, value.warehouseId);

    const [usage] = await tx
      .select({
        positiveBalances: sql<number>`count(distinct ${schema.binBalances.id}) filter (where ${schema.binBalances.qty} > 0)::int`,
        movements: sql<number>`count(distinct ${schema.binMovements.id})::int`,
      })
      .from(schema.bins)
      .leftJoin(schema.binBalances, eq(schema.binBalances.binId, schema.bins.id))
      .leftJoin(
        schema.binMovements,
        or(eq(schema.binMovements.fromBinId, schema.bins.id), eq(schema.binMovements.toBinId, schema.bins.id)),
      )
      .where(eq(schema.bins.id, id));
    if (value.warehouseId !== existing.warehouseId && Number(usage?.movements ?? 0) > 0) {
      throw new ApiError(409, "已有作业流水的库位不能改所属仓库");
    }
    if (value.warehouseId !== existing.warehouseId && Number(usage?.positiveBalances ?? 0) > 0) {
      throw new ApiError(409, "仍有正库存的库位不能改所属仓库，请先移出");
    }
    if (value.kind !== existing.kind && Number(usage?.positiveBalances ?? 0) > 0) {
      throw new ApiError(409, "仍有正库存的库位不能改变用途，请先移出");
    }
    if (!value.active && Number(usage?.positiveBalances ?? 0) > 0) {
      throw new ApiError(409, "仍有正库存的库位不能停用，请先移出");
    }

    const [updated] = await tx
      .update(schema.bins)
      .set({
        warehouseId: value.warehouseId,
        code: value.code,
        name: value.name ?? null,
        kind: value.kind,
        active: value.active,
        remark: value.remark ?? null,
      })
      .where(eq(schema.bins.id, id))
      .returning();
    await writeAudit(tx, {
      userId: actor.id,
      entity: "bin",
      entityId: id,
      action: "update",
      before: existing,
      after: updated,
    });
    return updated;
  });
}
