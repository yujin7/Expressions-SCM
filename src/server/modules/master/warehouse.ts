import { and, eq, ilike, inArray, ne, or, sql } from "drizzle-orm";
import { writeAudit } from "@/server/core/audit";
import { getNumParam } from "@/server/core/params";
import type { SessionUser } from "@/server/core/dto";
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle PGlite/Postgres structural compatibility is narrowed by the surrounding service contract
type AnyTx = any;
import { getDbAsync, schema } from "@/db";
import { ApiError } from "./common";
import { warehouseSchema } from "./schemas";
import { SELECTED_OPTIONS_LIMIT, selectedOptionsPredicate, type SelectedOptionValue } from "@/server/core/selected-options";

function buildWhere(q: string) {
  return q ? or(ilike(schema.warehouses.code, `%${q}%`), ilike(schema.warehouses.name, `%${q}%`)) : undefined;
}

export const WAREHOUSE_SORT_KEYS = ["code", "name", "regionCode"] as const;
export async function listWarehouses(q: string, page: number, pageSize: number, selectedValues?: SelectedOptionValue[], options?: {
  sort?: typeof WAREHOUSE_SORT_KEYS[number]; order?: "asc" | "desc";
  outsourceSupplierId?: number;
}) {
  const db = await getDbAsync();
  const sortColumn = schema.warehouses[options?.sort ?? "code"];
  const where = and(buildWhere(q), options?.outsourceSupplierId == null ? undefined : and(
    eq(schema.warehouses.supplierId, options.outsourceSupplierId), eq(schema.warehouses.kind, "outsource"),
    eq(schema.warehouses.accountingMode, "realtime"), eq(schema.warehouses.active, true),
  ), selectedOptionsPredicate(selectedValues, {
    id: schema.warehouses.id, text: [schema.warehouses.code, schema.warehouses.name],
  }));
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
      .orderBy(options?.order === "desc" ? sql`${sortColumn} desc nulls last` : sql`${sortColumn} asc nulls last`, schema.warehouses.code, schema.warehouses.id)
      .limit(selectedValues === undefined ? pageSize : SELECTED_OPTIONS_LIMIT)
      .offset(selectedValues === undefined ? (page - 1) * pageSize : 0),
    db.select({ total: sql<number>`count(*)::int` }).from(schema.warehouses).where(where),
  ]);
  return { data: rows, total };
}

export async function getWarehouse(id: number, dbArg?: AnyTx) {
  const db: AnyTx = dbArg ?? (await getDbAsync());
  const [row] = await db.select().from(schema.warehouses).where(eq(schema.warehouses.id, id));
  if (!row) throw new ApiError(404, "仓库不存在");
  return { ...row, identityUsage: await warehouseIdentityUsage(db, id) };
}

/** Warehouse execution identity belongs to existing evidence, including unposted drafts.
 * This is not a quantity total: zero/negative balances and closed documents still bind identity.
 * On update the caller holds the warehouse row lock, shared with posting and FK insertions.
 */
async function warehouseIdentityUsage(db: AnyTx, id: number): Promise<string[]> {
  const result = await db.execute(sql`
    select '库存余额' evidence where exists(select 1 from stock_balances where warehouse_id=${id})
    union all select '库存流水' where exists(select 1 from stock_ledger where warehouse_id=${id})
    union all select '库存快照' where exists(select 1 from stock_snapshots where warehouse_id=${id})
    union all select '效期参考' where exists(select 1 from batch_stocks where warehouse_id=${id})
    union all select '库位' where exists(select 1 from bins where warehouse_id=${id})
    union all select '库位流水' where exists(select 1 from bin_movements where warehouse_id=${id})
    union all select '发料单' where exists(select 1 from fl_docs where from_warehouse_id=${id} or to_warehouse_id=${id})
    union all select '退料单' where exists(select 1 from tl_docs where from_warehouse_id=${id} or to_warehouse_id=${id})
    union all select '收货单' where exists(select 1 from sh_docs where warehouse_id=${id})
    union all select '采购退货单' where exists(select 1 from ct_docs where warehouse_id=${id})
    union all select '库存单据' where exists(select 1 from stock_doc_lines where warehouse_id=${id} or to_warehouse_id=${id})
    union all select '盘点单' where exists(select 1 from pd_docs where warehouse_id=${id})
    union all select '质量案件' where exists(select 1 from quality_cases where warehouse_id=${id})
  `);
  return result.rows.map((row: { evidence: string }) => row.evidence);
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

/** D60 仓库上限口径：只数实体仓（成品/原料/包材），委外/在途/快照仓不计 */
export const PHYSICAL_WAREHOUSE_KINDS = ["finished", "raw", "packaging"] as const;
export const WAREHOUSE_MAX_ACTIVE_FALLBACK = 12;

/** 启用中的实体仓数与上限（仓库页「已启用 N / 上限 M」） */
export async function getWarehouseCapacity(dbArg?: AnyTx): Promise<{ activeCount: number; maxActive: number }> {
  const db: AnyTx = dbArg ?? (await getDbAsync());
  const [row]: { total: number }[] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(schema.warehouses)
    .where(and(eq(schema.warehouses.active, true), inArray(schema.warehouses.kind, [...PHYSICAL_WAREHOUSE_KINDS])));
  const maxActive = await getNumParam("warehouse_max_active", WAREHOUSE_MAX_ACTIVE_FALLBACK, dbArg);
  return { activeCount: Number(row?.total ?? 0), maxActive };
}

/**
 * D60 warehouse_max_active 守卫：新建/启用一个实体仓时，若其他启用中的实体仓数已 ≥ 上限 → 409。
 * 只在「结果是启用的实体仓」时检查；停用、非实体仓、或本仓原本已是启用实体仓（仅改名等）不触发。
 */
async function assertWarehouseCapacity(tx: AnyTx, selfId: number | null, next: { kind: string; active: boolean }): Promise<void> {
  if (!next.active || !(PHYSICAL_WAREHOUSE_KINDS as readonly string[]).includes(next.kind)) return;
  if (selfId != null) {
    const [existing]: { kind: string; active: boolean }[] = await tx
      .select({ kind: schema.warehouses.kind, active: schema.warehouses.active })
      .from(schema.warehouses)
      .where(eq(schema.warehouses.id, selfId));
    if (existing?.active && (PHYSICAL_WAREHOUSE_KINDS as readonly string[]).includes(existing.kind)) return; // 已占额度
  }
  const conds = [eq(schema.warehouses.active, true), inArray(schema.warehouses.kind, [...PHYSICAL_WAREHOUSE_KINDS])];
  if (selfId != null) conds.push(ne(schema.warehouses.id, selfId));
  const [row]: { total: number }[] = await tx
    .select({ total: sql<number>`count(*)::int` })
    .from(schema.warehouses)
    .where(and(...conds));
  const maxActive = await getNumParam("warehouse_max_active", WAREHOUSE_MAX_ACTIVE_FALLBACK, tx);
  const activeCount = Number(row?.total ?? 0);
  if (activeCount >= maxActive) {
    throw new ApiError(
      409,
      `启用中的实体仓已达上限（${activeCount} / ${maxActive}，参数 warehouse_max_active）；请先停用或合并仓库，或在运行参数中调整上限`,
    );
  }
}

/** @param actor 写入者；审计与写入同事务（路由层补记不原子，见 master/sku.ts 注释） */
export async function createWarehouse(input: unknown, actor?: SessionUser, dbArg?: AnyTx) {
  const v = warehouseSchema.parse(input);
  const db: AnyTx = dbArg ?? (await getDbAsync());
  return db.transaction(async (tx: AnyTx) => {
  await assertValidParent(tx, null, v.parentId ?? null);
  await assertWarehouseCapacity(tx, null, { kind: v.kind, active: v.active });
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
  const [existing] = await tx.select().from(schema.warehouses).where(eq(schema.warehouses.id, id)).for("update");
  if (!existing) throw new ApiError(404, "仓库不存在");
  await assertValidParent(tx, id, v.parentId ?? null);
  await assertWarehouseCapacity(tx, id, { kind: v.kind, active: v.active });
  const nextAccountingMode = v.kind === "snapshot" ? "snapshot" : "realtime";
  const nextSupplierId = v.kind === "outsource" ? (v.supplierId ?? null) : null;
  if (v.kind !== existing.kind || nextAccountingMode !== existing.accountingMode || nextSupplierId !== existing.supplierId) {
    const usage = await warehouseIdentityUsage(tx, id);
    if (usage.length > 0) throw new ApiError(409,
      `仓库已有${usage.join("、")}，不能切换记账模式，也不能更改类型或加工厂归属；请新建正确仓库，通过原单纠错或正式调拨处理，不可改主档转移历史库存。名称、层级、区域及启停仍可维护`);
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
      supplierId: nextSupplierId,
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
