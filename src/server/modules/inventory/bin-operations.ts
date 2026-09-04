/**
 * 库位定位子账。
 *
 * 关键边界：warehouse `stock_balances` 仍是唯一库存真相；本模块只在其下定位。
 * 任意 SKU×仓×批次都保持 `Σ bin_balances <= stock_balances`，差额就是“未定位”。
 * 库位间移动不改仓库总账，避免同仓移动制造虚假出入库。
 */
import { and, desc, eq, gt, gte, ilike, inArray, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import { getDbAsync } from "@/db";
import * as schema from "@/db/schema";
import { writeAudit } from "@/server/core/audit";
import { dAdd, dCmp, dQty, dSub } from "@/server/core/decimal";
import type { SessionUser } from "@/server/core/dto";
import { ApiError } from "@/server/modules/master/common";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle PGlite/Postgres structural compatibility is narrowed by the surrounding service contract
type AnyDb = any;

const movementSchema = z.object({
  idempotencyKey: z.string().trim().min(8).max(100),
  warehouseId: z.number().int().positive(),
  skuId: z.number().int().positive(),
  batchId: z.number().int().positive().nullable().optional(),
  fromBinId: z.number().int().positive().nullable().optional(),
  toBinId: z.number().int().positive().nullable().optional(),
  qty: z.union([z.string(), z.number()]).transform((value) => dQty(String(value))),
  operation: z.enum(["locate", "move", "unlocate", "quarantine", "release"]),
  reason: z.string().trim().min(1, "作业原因必填").max(300),
});

type MovementInput = z.infer<typeof movementSchema>;
type ExistingMovement = {
  id: number;
  warehouseId: number;
  skuId: number;
  batchId: number | null;
  fromBinId: number | null;
  toBinId: number | null;
  qty: string;
  operation: string;
  reason: string | null;
  createdBy: number;
};

function assertIdempotentReplay(existing: ExistingMovement, input: MovementInput, actor: SessionUser) {
  const sameRequest =
    existing.warehouseId === input.warehouseId
    && existing.skuId === input.skuId
    && existing.batchId === (input.batchId ?? null)
    && existing.fromBinId === (input.fromBinId ?? null)
    && existing.toBinId === (input.toBinId ?? null)
    && dCmp(existing.qty, input.qty) === 0
    && existing.operation === input.operation
    && existing.reason === input.reason
    && existing.createdBy === actor.id;
  if (!sameRequest) {
    throw new ApiError(409, "该幂等键已用于不同的库位作业，请生成新键后重试");
  }
  return { id: existing.id, idempotent: true as const };
}

function batchWhere(batchId: number | null) {
  return batchId == null
    ? isNull(schema.binBalances.batchId)
    : eq(schema.binBalances.batchId, batchId);
}

function stockBatchWhere(batchId: number | null) {
  return batchId == null
    ? isNull(schema.stockBalances.batchId)
    : eq(schema.stockBalances.batchId, batchId);
}

async function warehouseForOperation(db: AnyDb, warehouseId: number) {
  const [warehouse] = await db
    .select({
      id: schema.warehouses.id,
      code: schema.warehouses.code,
      name: schema.warehouses.name,
      active: schema.warehouses.active,
      accountingMode: schema.warehouses.accountingMode,
    })
    .from(schema.warehouses)
    .where(eq(schema.warehouses.id, warehouseId));
  if (!warehouse) throw new ApiError(400, "仓库不存在");
  if (!warehouse.active) throw new ApiError(409, "停用仓库不可执行库位作业");
  if (warehouse.accountingMode !== "realtime") {
    throw new ApiError(409, "快照仓没有可过账库位；请在外部仓系统维护定位");
  }
  return warehouse;
}

async function loadBins(db: AnyDb, input: MovementInput) {
  const ids = [...new Set([input.fromBinId, input.toBinId].filter((id): id is number => id != null))];
  if (ids.length === 0) throw new ApiError(400, "来源库位与目标库位不能同时为空");
  const rows: { id: number; warehouseId: number; code: string; kind: string; active: boolean }[] =
    await db
      .select({
        id: schema.bins.id,
        warehouseId: schema.bins.warehouseId,
        code: schema.bins.code,
        kind: schema.bins.kind,
        active: schema.bins.active,
      })
      .from(schema.bins)
      .where(inArray(schema.bins.id, ids));
  if (rows.length !== ids.length) throw new ApiError(400, "来源或目标库位不存在");
  for (const row of rows) {
    if (row.warehouseId !== input.warehouseId) throw new ApiError(400, `库位 ${row.code} 不属于所选仓库`);
    if (!row.active) throw new ApiError(409, `库位 ${row.code} 已停用`);
  }
  return {
    from: rows.find((row) => row.id === input.fromBinId) ?? null,
    to: rows.find((row) => row.id === input.toBinId) ?? null,
  };
}

function assertOperationShape(input: MovementInput, bins: Awaited<ReturnType<typeof loadBins>>) {
  if (input.fromBinId != null && input.fromBinId === input.toBinId) {
    throw new ApiError(400, "来源与目标库位不能相同");
  }
  if (dCmp(input.qty, "0") <= 0) throw new ApiError(400, "作业数量必须大于 0");
  if (input.operation === "locate" && (bins.from != null || bins.to == null)) {
    throw new ApiError(400, "定位作业必须从未定位库存移入一个库位");
  }
  if (input.operation === "unlocate" && (bins.from == null || bins.to != null)) {
    throw new ApiError(400, "取消定位必须从库位移回未定位库存");
  }
  if (input.operation === "move" && (bins.from == null || bins.to == null)) {
    throw new ApiError(400, "移库必须同时指定来源与目标库位");
  }
  if (bins.to?.kind === "quarantine" && input.operation !== "quarantine") {
    throw new ApiError(400, "移入隔离库位必须使用隔离作业");
  }
  if (bins.from?.kind === "quarantine" && input.operation !== "release") {
    throw new ApiError(400, "移出隔离库位必须使用放行作业");
  }
  if (input.operation === "quarantine" && bins.to?.kind !== "quarantine") {
    throw new ApiError(400, "隔离作业的目标必须是隔离库位");
  }
  if (input.operation === "release") {
    if (bins.from?.kind !== "quarantine") throw new ApiError(400, "放行作业必须从隔离库位移出");
    if (!bins.to || !["normal", "staging"].includes(bins.to.kind)) {
      throw new ApiError(400, "放行目标必须是普通或暂存库位");
    }
  }
}

export async function postBinMovement(
  actor: SessionUser,
  raw: unknown,
  dbArg?: AnyDb,
): Promise<{ id: number; idempotent: boolean }> {
  if (!actor.roles.includes("admin") && !actor.roles.includes("warehouse")) {
    throw new ApiError(403, "仅仓管或管理员可执行库位作业");
  }
  const input = movementSchema.parse(raw);
  const db = dbArg ?? (await getDbAsync());

  return db.transaction(async (tx: AnyDb) => {
    const existingColumns = {
      id: schema.binMovements.id,
      warehouseId: schema.binMovements.warehouseId,
      skuId: schema.binMovements.skuId,
      batchId: schema.binMovements.batchId,
      fromBinId: schema.binMovements.fromBinId,
      toBinId: schema.binMovements.toBinId,
      qty: schema.binMovements.qty,
      operation: schema.binMovements.operation,
      reason: schema.binMovements.reason,
      createdBy: schema.binMovements.createdBy,
    };
    const [prior]: ExistingMovement[] = await tx
      .select(existingColumns)
      .from(schema.binMovements)
      .where(eq(schema.binMovements.idempotencyKey, input.idempotencyKey));
    if (prior) return assertIdempotentReplay(prior, input, actor);

    await warehouseForOperation(tx, input.warehouseId);
    const bins = await loadBins(tx, input);
    assertOperationShape(input, bins);

    const [sku] = await tx
      .select({ id: schema.skus.id, active: schema.skus.active })
      .from(schema.skus)
      .where(eq(schema.skus.id, input.skuId));
    if (!sku || !sku.active) throw new ApiError(400, "SKU 不存在或已停用");
    const batchId = input.batchId ?? null;
    if (batchId != null) {
      const [batch] = await tx
        .select({ skuId: schema.batches.skuId })
        .from(schema.batches)
        .where(eq(schema.batches.id, batchId));
      if (!batch || batch.skuId !== input.skuId) throw new ApiError(400, "批次不存在或不属于该 SKU");
    }

    const [movement]: { id: number }[] = await tx
      .insert(schema.binMovements)
      .values({
        idempotencyKey: input.idempotencyKey,
        warehouseId: input.warehouseId,
        skuId: input.skuId,
        batchId,
        fromBinId: input.fromBinId ?? null,
        toBinId: input.toBinId ?? null,
        qty: input.qty,
        operation: input.operation,
        reason: input.reason,
        createdBy: actor.id,
      })
      .onConflictDoNothing({ target: schema.binMovements.idempotencyKey })
      .returning({ id: schema.binMovements.id });
    if (!movement) {
      const [existing]: ExistingMovement[] = await tx
        .select(existingColumns)
        .from(schema.binMovements)
        .where(eq(schema.binMovements.idempotencyKey, input.idempotencyKey));
      if (!existing) throw new ApiError(409, "幂等请求正在处理中，请稍后重试");
      return assertIdempotentReplay(existing, input, actor);
    }

    // 以仓库主档行为互斥锁：同仓定位串行，防止两个“未定位→库位”同时超分总账。
    await tx.execute(sql`select id from warehouses where id = ${input.warehouseId} for update`);

    if (bins.from == null) {
      const [warehouseBalance]: { qty: string | null }[] = await tx
        .select({ qty: schema.stockBalances.qty })
        .from(schema.stockBalances)
        .where(and(
          eq(schema.stockBalances.warehouseId, input.warehouseId),
          eq(schema.stockBalances.skuId, input.skuId),
          stockBatchWhere(batchId),
        ));
      const [located]: { qty: string | null }[] = await tx
        .select({ qty: sql<string>`coalesce(sum(${schema.binBalances.qty}), 0)` })
        .from(schema.binBalances)
        .innerJoin(schema.bins, eq(schema.binBalances.binId, schema.bins.id))
        .where(and(
          eq(schema.bins.warehouseId, input.warehouseId),
          eq(schema.binBalances.skuId, input.skuId),
          batchWhere(batchId),
          gt(schema.binBalances.qty, "0"),
        ));
      const unlocated = dSub(warehouseBalance?.qty ?? "0", located?.qty ?? "0");
      if (dCmp(unlocated, input.qty) < 0) {
        throw new ApiError(409, `未定位库存不足（可用 ${dQty(unlocated)}，需 ${input.qty}）`);
      }
    }

    if (bins.from != null) {
      const [decremented]: { qty: string }[] = await tx
        .update(schema.binBalances)
        .set({ qty: sql`${schema.binBalances.qty} - ${input.qty}` })
        .where(and(
          eq(schema.binBalances.binId, bins.from.id),
          eq(schema.binBalances.skuId, input.skuId),
          batchWhere(batchId),
          gte(schema.binBalances.qty, input.qty),
        ))
        .returning({ qty: schema.binBalances.qty });
      if (!decremented) {
        throw new ApiError(409, `来源库位 ${bins.from.code} 库存不足`);
      }
    }

    if (bins.to != null) {
      await tx
        .insert(schema.binBalances)
        .values({ binId: bins.to.id, skuId: input.skuId, batchId, qty: input.qty })
        .onConflictDoUpdate({
          target: [schema.binBalances.binId, schema.binBalances.skuId, schema.binBalances.batchId],
          set: { qty: sql`${schema.binBalances.qty} + ${input.qty}` },
        });
    }

    await writeAudit(tx, {
      userId: actor.id,
      entity: "bin_movement",
      entityId: movement.id,
      action: input.operation,
      after: {
        warehouseId: input.warehouseId,
        skuId: input.skuId,
        batchId,
        fromBinId: input.fromBinId ?? null,
        toBinId: input.toBinId ?? null,
        qty: input.qty,
        reason: input.reason,
      },
    });
    return { id: movement.id, idempotent: false };
  });
}

/* ── W2-6：隔离 / 放行的批次级入口 ───────────────────────────────────────────
   `bin.kind='quarantine'` 与 `bin_movements.operation='quarantine'|'release'` 连同完整
   不变量守卫早就建好了，但只有「库位作业」页按仓库逐行能用；召回或检验不合格时，
   人手上拿到的是**批次号**，不是某个仓的某个库位。下面两个函数把批次作为入口：
   给定 (SKU, 批次)，列出它此刻散落在哪些仓/库位，并按同一套守卫执行隔离/放行。
   写入仍然只经 postBinMovement——不另开第二条写路径，审计与幂等都在那里。 */

export interface BatchPlacementRow {
  key: string;
  warehouseId: number;
  warehouseCode: string;
  warehouseName: string;
  binId: number | null;
  binCode: string | null;
  binName: string | null;
  binKind: string | null;
  qty: string;
  locationState: "located" | "unlocated";
}

export interface BatchPlacementBin {
  id: number;
  warehouseId: number;
  code: string;
  name: string | null;
  kind: string;
}

/**
 * 某 (SKU, 批次) 当前的物理分布：逐仓的已定位库位行 + 未定位余量，
 * 外加各仓可选的隔离/放行目标库位（供页面直接下拉，不必再跳去库位主档翻）。
 * batchId=null 表示无批次维度的余额行。
 */
export async function listBatchPlacements(
  args: { skuId: number; batchId: number | null },
  dbArg?: AnyDb,
): Promise<{ rows: BatchPlacementRow[]; bins: BatchPlacementBin[] }> {
  const db = dbArg ?? (await getDbAsync());
  const batchId = args.batchId ?? null;

  const located: {
    binId: number; binCode: string; binName: string | null; binKind: string;
    warehouseId: number; warehouseCode: string; warehouseName: string; qty: string;
  }[] = await db
    .select({
      binId: schema.bins.id,
      binCode: schema.bins.code,
      binName: schema.bins.name,
      binKind: schema.bins.kind,
      warehouseId: schema.bins.warehouseId,
      warehouseCode: schema.warehouses.code,
      warehouseName: schema.warehouses.name,
      qty: schema.binBalances.qty,
    })
    .from(schema.binBalances)
    .innerJoin(schema.bins, eq(schema.binBalances.binId, schema.bins.id))
    .innerJoin(schema.warehouses, eq(schema.bins.warehouseId, schema.warehouses.id))
    .where(and(
      eq(schema.binBalances.skuId, args.skuId),
      batchWhere(batchId),
      gt(schema.binBalances.qty, "0"),
    ))
    .orderBy(schema.warehouses.code, schema.bins.code);

  const ledger: { warehouseId: number; warehouseCode: string; warehouseName: string; qty: string }[] = await db
    .select({
      warehouseId: schema.stockBalances.warehouseId,
      warehouseCode: schema.warehouses.code,
      warehouseName: schema.warehouses.name,
      qty: schema.stockBalances.qty,
    })
    .from(schema.stockBalances)
    .innerJoin(schema.warehouses, eq(schema.stockBalances.warehouseId, schema.warehouses.id))
    .where(and(
      eq(schema.stockBalances.skuId, args.skuId),
      stockBatchWhere(batchId),
      gt(schema.stockBalances.qty, "0"),
      eq(schema.warehouses.accountingMode, "realtime"),
    ))
    .orderBy(schema.warehouses.code);

  const locatedByWarehouse = new Map<number, string>();
  for (const row of located) {
    locatedByWarehouse.set(row.warehouseId, dAdd(locatedByWarehouse.get(row.warehouseId) ?? "0", row.qty));
  }
  const rows: BatchPlacementRow[] = located.map((row) => ({
    key: `bin:${row.binId}`,
    warehouseId: row.warehouseId,
    warehouseCode: row.warehouseCode,
    warehouseName: row.warehouseName,
    binId: row.binId,
    binCode: row.binCode,
    binName: row.binName,
    binKind: row.binKind,
    qty: dQty(row.qty),
    locationState: "located",
  }));
  for (const row of ledger) {
    const unlocated = dSub(row.qty, locatedByWarehouse.get(row.warehouseId) ?? "0");
    if (dCmp(unlocated, "0") <= 0) continue;
    rows.push({
      key: `unlocated:${row.warehouseId}`,
      warehouseId: row.warehouseId,
      warehouseCode: row.warehouseCode,
      warehouseName: row.warehouseName,
      binId: null,
      binCode: null,
      binName: null,
      binKind: null,
      qty: dQty(unlocated),
      locationState: "unlocated",
    });
  }

  const warehouseIds = [...new Set(rows.map((row) => row.warehouseId))];
  const bins: BatchPlacementBin[] = warehouseIds.length
    ? await db
      .select({
        id: schema.bins.id,
        warehouseId: schema.bins.warehouseId,
        code: schema.bins.code,
        name: schema.bins.name,
        kind: schema.bins.kind,
      })
      .from(schema.bins)
      .where(and(inArray(schema.bins.warehouseId, warehouseIds), eq(schema.bins.active, true)))
      .orderBy(schema.bins.code)
    : [];
  return { rows, bins };
}

const quarantineSchema = z.object({
  idempotencyKey: z.string().trim().min(8).max(100),
  intent: z.enum(["quarantine", "release"]),
  warehouseId: z.number().int().positive(),
  skuId: z.number().int().positive(),
  batchId: z.number().int().positive().nullable().optional(),
  /** 来源库位；隔离时可为空（= 从未定位量隔离），放行时必须是隔离库位 */
  fromBinId: z.number().int().positive().nullable().optional(),
  /** 目标库位；省略时按仓内唯一的候选库位自动解析，多于一个即要求显式指定 */
  toBinId: z.number().int().positive().nullable().optional(),
  qty: z.union([z.string(), z.number()]),
  reason: z.string().trim().min(1, "作业原因必填").max(300),
});

/**
 * 批次隔离 / 放行。目标库位可省略：仓内只有一个启用的隔离库位（放行则只有一个普通/暂存库位）时
 * 自动解析；有多个就要求显式指定——**不猜**。真正的写入与全部不变量守卫都在 postBinMovement。
 */
export async function quarantineOrReleaseBatch(
  actor: SessionUser,
  raw: unknown,
  dbArg?: AnyDb,
): Promise<{ id: number; idempotent: boolean }> {
  const input = quarantineSchema.parse(raw);
  const db = dbArg ?? (await getDbAsync());
  let toBinId = input.toBinId ?? null;
  if (toBinId == null) {
    const wanted = input.intent === "quarantine" ? ["quarantine"] : ["normal", "staging"];
    const candidates: { id: number; code: string }[] = await db
      .select({ id: schema.bins.id, code: schema.bins.code })
      .from(schema.bins)
      .where(and(
        eq(schema.bins.warehouseId, input.warehouseId),
        eq(schema.bins.active, true),
        inArray(schema.bins.kind, wanted),
      ))
      .orderBy(schema.bins.code);
    if (candidates.length === 0) {
      throw new ApiError(
        409,
        input.intent === "quarantine"
          ? "该仓没有启用的隔离库位，请先在库位主数据维护一个 kind=隔离 的库位"
          : "该仓没有启用的普通/暂存库位可放行",
      );
    }
    if (candidates.length > 1) throw new ApiError(400, "该仓有多个候选库位，请显式选择目标库位");
    toBinId = candidates[0].id;
  }
  return postBinMovement(
    actor,
    {
      idempotencyKey: input.idempotencyKey,
      warehouseId: input.warehouseId,
      skuId: input.skuId,
      batchId: input.batchId ?? null,
      fromBinId: input.fromBinId ?? null,
      toBinId,
      qty: input.qty,
      operation: input.intent,
      reason: input.reason,
    },
    db,
  );
}

export interface BinInventoryRow {
  key: string;
  warehouseId: number;
  skuId: number;
  skuCode: string;
  skuName: string;
  baseUom: string;
  batchId: number | null;
  batchNo: string | null;
  expiryDate: string | null;
  binId: number | null;
  binCode: string | null;
  binName: string | null;
  binKind: string | null;
  qty: string;
  locationState: "located" | "unlocated";
}

export async function listBinInventory(
  args: { warehouseId: number; q?: string },
  dbArg?: AnyDb,
): Promise<{
  warehouse: { id: number; code: string; name: string };
  rows: BinInventoryRow[];
  totals: { located: string; unlocated: string; normal: string; quarantine: string; staging: string };
  integrityIssues: { skuId: number; skuCode: string; batchId: number | null; batchNo: string | null; warehouseQty: string; locatedQty: string }[];
}> {
  const db = dbArg ?? (await getDbAsync());
  const warehouse = await warehouseForOperation(db, args.warehouseId);
  const q = (args.q ?? "").trim();
  const skuFilter = q
    ? or(ilike(schema.skus.code, `%${q}%`), ilike(schema.skus.name, `%${q}%`))
    : undefined;

  const located: {
    binId: number; binCode: string; binName: string | null; binKind: string;
    skuId: number; skuCode: string; skuName: string; baseUom: string;
    batchId: number | null; batchNo: string | null; expiryDate: string | null; qty: string;
  }[] = await db
    .select({
      binId: schema.bins.id,
      binCode: schema.bins.code,
      binName: schema.bins.name,
      binKind: schema.bins.kind,
      skuId: schema.skus.id,
      skuCode: schema.skus.code,
      skuName: schema.skus.name,
      baseUom: schema.skus.baseUom,
      batchId: schema.binBalances.batchId,
      batchNo: schema.batches.batchNo,
      expiryDate: schema.batches.expiryDate,
      qty: schema.binBalances.qty,
    })
    .from(schema.binBalances)
    .innerJoin(schema.bins, eq(schema.binBalances.binId, schema.bins.id))
    .innerJoin(schema.skus, eq(schema.binBalances.skuId, schema.skus.id))
    .leftJoin(schema.batches, eq(schema.binBalances.batchId, schema.batches.id))
    .where(and(
      eq(schema.bins.warehouseId, args.warehouseId),
      gt(schema.binBalances.qty, "0"),
      skuFilter,
    ))
    .orderBy(schema.bins.code, schema.skus.code);

  const ledger: {
    skuId: number; skuCode: string; skuName: string; baseUom: string;
    batchId: number | null; batchNo: string | null; expiryDate: string | null; qty: string;
  }[] = await db
    .select({
      skuId: schema.skus.id,
      skuCode: schema.skus.code,
      skuName: schema.skus.name,
      baseUom: schema.skus.baseUom,
      batchId: schema.stockBalances.batchId,
      batchNo: schema.batches.batchNo,
      expiryDate: schema.batches.expiryDate,
      qty: schema.stockBalances.qty,
    })
    .from(schema.stockBalances)
    .innerJoin(schema.skus, eq(schema.stockBalances.skuId, schema.skus.id))
    .leftJoin(schema.batches, eq(schema.stockBalances.batchId, schema.batches.id))
    .where(and(
      eq(schema.stockBalances.warehouseId, args.warehouseId),
      gt(schema.stockBalances.qty, "0"),
      skuFilter,
    ))
    .orderBy(schema.skus.code);

  const locatedByKey = new Map<string, string>();
  for (const row of located) {
    const key = `${row.skuId}:${row.batchId ?? "null"}`;
    locatedByKey.set(key, dAdd(locatedByKey.get(key) ?? "0", row.qty));
  }
  const rows: BinInventoryRow[] = located.map((row) => ({
    key: `bin:${row.binId}:${row.skuId}:${row.batchId ?? "null"}`,
    warehouseId: args.warehouseId,
    ...row,
    locationState: "located",
  }));
  let locatedTotal = "0";
  for (const row of located) locatedTotal = dAdd(locatedTotal, row.qty);
  const byKind = { normal: "0", quarantine: "0", staging: "0" };
  for (const row of located) {
    if (row.binKind in byKind) {
      const kind = row.binKind as keyof typeof byKind;
      byKind[kind] = dAdd(byKind[kind], row.qty);
    }
  }
  const ledgerByKey = new Map(ledger.map((row) => [`${row.skuId}:${row.batchId ?? "null"}`, row]));
  const integrityIssues: {
    skuId: number; skuCode: string; batchId: number | null; batchNo: string | null;
    warehouseQty: string; locatedQty: string;
  }[] = [];
  for (const [key, locatedQty] of locatedByKey) {
    const ledgerRow = ledgerByKey.get(key);
    const warehouseQty = ledgerRow?.qty ?? "0";
    if (dCmp(locatedQty, warehouseQty) > 0) {
      const firstLocated = located.find((row) => `${row.skuId}:${row.batchId ?? "null"}` === key);
      integrityIssues.push({
        skuId: ledgerRow?.skuId ?? firstLocated!.skuId,
        skuCode: ledgerRow?.skuCode ?? firstLocated!.skuCode,
        batchId: ledgerRow?.batchId ?? firstLocated!.batchId,
        batchNo: ledgerRow?.batchNo ?? firstLocated!.batchNo,
        warehouseQty: dQty(warehouseQty),
        locatedQty: dQty(locatedQty),
      });
    }
  }
  let unlocatedTotal = "0";
  for (const row of ledger) {
    const key = `${row.skuId}:${row.batchId ?? "null"}`;
    const unlocated = dSub(row.qty, locatedByKey.get(key) ?? "0");
    if (dCmp(unlocated, "0") <= 0) continue;
    unlocatedTotal = dAdd(unlocatedTotal, unlocated);
    rows.push({
      key: `unlocated:${row.skuId}:${row.batchId ?? "null"}`,
      warehouseId: args.warehouseId,
      ...row,
      binId: null,
      binCode: null,
      binName: null,
      binKind: null,
      qty: dQty(unlocated),
      locationState: "unlocated",
    });
  }
  return {
    warehouse: { id: warehouse.id, code: warehouse.code, name: warehouse.name },
    rows,
    totals: {
      located: dQty(locatedTotal),
      unlocated: dQty(unlocatedTotal),
      normal: dQty(byKind.normal),
      quarantine: dQty(byKind.quarantine),
      staging: dQty(byKind.staging),
    },
    integrityIssues,
  };
}

export async function listBinMovements(warehouseId: number, dbArg?: AnyDb) {
  const db = dbArg ?? (await getDbAsync());
  await warehouseForOperation(db, warehouseId);
  const rows: {
    id: number;
    idempotencyKey: string;
    operation: string;
    skuCode: string;
    skuName: string;
    batchNo: string | null;
    fromBinId: number | null;
    toBinId: number | null;
    qty: string;
    reason: string | null;
    createdByName: string | null;
    occurredAt: Date;
  }[] = await db
    .select({
      id: schema.binMovements.id,
      idempotencyKey: schema.binMovements.idempotencyKey,
      operation: schema.binMovements.operation,
      skuCode: schema.skus.code,
      skuName: schema.skus.name,
      batchNo: schema.batches.batchNo,
      fromBinId: schema.binMovements.fromBinId,
      toBinId: schema.binMovements.toBinId,
      qty: schema.binMovements.qty,
      reason: schema.binMovements.reason,
      createdByName: schema.users.name,
      occurredAt: schema.binMovements.occurredAt,
    })
    .from(schema.binMovements)
    .innerJoin(schema.skus, eq(schema.binMovements.skuId, schema.skus.id))
    .leftJoin(schema.batches, eq(schema.binMovements.batchId, schema.batches.id))
    .leftJoin(schema.users, eq(schema.binMovements.createdBy, schema.users.id))
    .where(eq(schema.binMovements.warehouseId, warehouseId))
    .orderBy(desc(schema.binMovements.occurredAt), desc(schema.binMovements.id))
    .limit(100);

  const binIds = [...new Set(rows.flatMap((row) => [row.fromBinId, row.toBinId]).filter((id): id is number => id != null))];
  const binRows: { id: number; code: string }[] = binIds.length
    ? await db.select({ id: schema.bins.id, code: schema.bins.code }).from(schema.bins).where(inArray(schema.bins.id, binIds))
    : [];
  const codeById = new Map(binRows.map((row) => [row.id, row.code]));
  return rows.map((row) => ({
    ...row,
    reason: row.reason ?? "—",
    createdByName: row.createdByName ?? "—",
    fromBinCode: row.fromBinId ? codeById.get(row.fromBinId) ?? `#${row.fromBinId}` : "未定位",
    toBinCode: row.toBinId ? codeById.get(row.toBinId) ?? `#${row.toBinId}` : "未定位",
  }));
}
