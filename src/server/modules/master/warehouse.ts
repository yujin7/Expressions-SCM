import { eq, ilike, or, sql } from "drizzle-orm";
import { writeAudit } from "@/server/core/audit";
import type { SessionUser } from "@/server/core/dto";
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle PGlite/Postgres structural compatibility is narrowed by the surrounding service contract
type AnyTx = any;
import { getDbAsync, schema } from "@/db";
import { ApiError } from "./common";
import { warehouseSchema } from "./schemas";

function buildWhere(q: string) {
  return q ? or(ilike(schema.warehouses.code, `%${q}%`), ilike(schema.warehouses.name, `%${q}%`)) : undefined;
}

export async function listWarehouses(q: string, page: number, pageSize: number) {
  const db = await getDbAsync();
  const where = buildWhere(q);
  const [rows, [{ total }]] = await Promise.all([
    db
      .select({
        id: schema.warehouses.id,
        code: schema.warehouses.code,
        name: schema.warehouses.name,
        kind: schema.warehouses.kind,
        accountingMode: schema.warehouses.accountingMode,
        regionCode: schema.warehouses.regionCode,
        supplierId: schema.warehouses.supplierId,
        supplierName: schema.suppliers.name,
        parentId: schema.warehouses.parentId,
        active: schema.warehouses.active,
      })
      .from(schema.warehouses)
      .leftJoin(schema.suppliers, eq(schema.warehouses.supplierId, schema.suppliers.id))
      .where(where)
      .orderBy(schema.warehouses.code)
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db.select({ total: sql<number>`count(*)::int` }).from(schema.warehouses).where(where),
  ]);
  return { data: rows, total };
}

export async function getWarehouse(id: number, dbArg?: AnyTx) {
  const db: AnyTx = dbArg ?? (await getDbAsync());
  const [row] = await db.select().from(schema.warehouses).where(eq(schema.warehouses.id, id));
  if (!row) throw new ApiError(404, "仓库不存在");
  return row;
}

/**
 * D32 仓库树硬闸：父节点必须存在，且沿祖先链不能回到自身。
 * 仅靠 UI 排除自身不足以防并发、旧客户端或恶意请求造环。
 */
async function assertValidParent(tx: AnyTx, warehouseId: number | null, parentId: number | null): Promise<void> {
  if (parentId == null) return;
  const visited = new Set<number>();
  let cursor: number | null = parentId;
  while (cursor != null) {
    if (cursor === warehouseId) throw new ApiError(400, "仓库上级不能是自身或其下级");
    if (visited.has(cursor)) throw new ApiError(409, "现有仓库层级存在循环，请先修复");
    visited.add(cursor);
    const [parent]: { id: number; parentId: number | null }[] = await tx
      .select({ id: schema.warehouses.id, parentId: schema.warehouses.parentId })
      .from(schema.warehouses)
      .where(eq(schema.warehouses.id, cursor));
    if (!parent) throw new ApiError(400, "所选上级仓库不存在");
    cursor = parent.parentId;
  }
}

/** @param actor 写入者；审计与写入同事务（路由层补记不原子，见 master/sku.ts 注释） */
export async function createWarehouse(input: unknown, actor?: SessionUser, dbArg?: AnyTx) {
  const v = warehouseSchema.parse(input);
  const db: AnyTx = dbArg ?? (await getDbAsync());
  return db.transaction(async (tx: AnyTx) => {
  await assertValidParent(tx, null, v.parentId ?? null);
  const [created] = await tx
    .insert(schema.warehouses)
    .values({
      code: v.code,
      name: v.name,
      kind: v.kind,
      // 快照仓账务模式=snapshot，其余实时
      accountingMode: v.kind === "snapshot" ? "snapshot" : "realtime",
      regionCode: v.regionCode ?? "CN",
      supplierId: v.kind === "outsource" ? (v.supplierId ?? null) : null,
      parentId: v.parentId ?? null,
      active: v.active,
    })
    .returning();
  if (actor) {
    await writeAudit(tx, { userId: actor.id, entity: "warehouse", entityId: created.id, action: "create", after: created });
  }
  return created;
  });
}

export async function updateWarehouse(id: number, input: unknown, actor?: SessionUser, dbArg?: AnyTx) {
  const v = warehouseSchema.parse(input);
  const db: AnyTx = dbArg ?? (await getDbAsync());
  return db.transaction(async (tx: AnyTx) => {
  const [existing] = await tx.select().from(schema.warehouses).where(eq(schema.warehouses.id, id));
  if (!existing) throw new ApiError(404, "仓库不存在");
  await assertValidParent(tx, id, v.parentId ?? null);
  const nextAccountingMode = v.kind === "snapshot" ? "snapshot" : "realtime";
  if (nextAccountingMode !== existing.accountingMode) {
    const [balanceUsage]: { total: number }[] = await tx
      .select({ total: sql<number>`count(*)::int` })
      .from(schema.stockBalances)
      .where(eq(schema.stockBalances.warehouseId, id));
    const [snapshotUsage]: { total: number }[] = await tx
      .select({ total: sql<number>`count(*)::int` })
      .from(schema.stockSnapshots)
      .where(eq(schema.stockSnapshots.warehouseId, id));
    const [ledgerUsage]: { total: number }[] = await tx
      .select({ total: sql<number>`count(*)::int` })
      .from(schema.stockLedger)
      .where(eq(schema.stockLedger.warehouseId, id));
    const [binUsage]: { total: number }[] = await tx
      .select({ total: sql<number>`count(*)::int` })
      .from(schema.bins)
      .where(eq(schema.bins.warehouseId, id));
    const evidenceCount =
      Number(balanceUsage?.total ?? 0)
      + Number(snapshotUsage?.total ?? 0)
      + Number(ledgerUsage?.total ?? 0)
      + Number(binUsage?.total ?? 0);
    if (evidenceCount > 0) {
      throw new ApiError(409, "已有库存、快照、流水或库位的仓库不能切换记账模式；请新建正确类型的仓库");
    }
  }
  const [updated] = await tx
    .update(schema.warehouses)
    .set({
      code: v.code,
      name: v.name,
      kind: v.kind,
      accountingMode: nextAccountingMode,
      // 兼容迁移前客户端：更新未携带新字段时保留原区域，绝不静默重置为 CN。
      regionCode: v.regionCode ?? existing.regionCode,
      supplierId: v.kind === "outsource" ? (v.supplierId ?? null) : null,
      parentId: v.parentId ?? null,
      active: v.active,
    })
    .where(eq(schema.warehouses.id, id))
    .returning();
  if (actor) {
    await writeAudit(tx, { userId: actor.id, entity: "warehouse", entityId: id, action: "update", before: existing, after: updated });
  }
  return updated;
  });
}
