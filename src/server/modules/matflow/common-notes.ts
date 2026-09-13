import { and, eq, getTableColumns, inArray, sql } from "drizzle-orm";
import type { AnyPgTable, PgColumn } from "drizzle-orm/pg-core";
import { jgDocs, sysParams, warehouses } from "@/db/schema";
import { nextStatus } from "@/server/docflow/state";
import { ApiError } from "@/server/modules/master/common";
import type { AnyDb } from "@/server/modules/outsource/common";
import { getFrozenJgSettlement } from "@/server/core/jg-fee-boundary";

/**
 * W4 物料流转链（FL/TL/SH+QC/CT）公共工具（模块私有）。
 * 审批配置依赖（单一权威=approval_configs，seed 为准）：
 *   fl→warehouse / tl→warehouse / sh→warehouse / ct→warehouse
 *   ——已在 src/db/seed.ts approvalSeeds 就位（本次核对无缺口）；
 *   若生产库为旧 seed 需重跑 seed 或手工补齐，否则审批报 NO_CONFIG。
 *   测试自行种入配置不受影响。
 */
export const REQUIRED_APPROVAL_CONFIGS: Record<string, string> = {
  fl: "warehouse",
  tl: "warehouse",
  sh: "warehouse",
  ct: "warehouse",
};

/** 「已批准生效」单据口径：审批通过后（含瞬时执行完成）的状态集合——累计校验的分母 */
export const ACTIVE_DOC_STATUSES = ["approved", "in_progress", "completed"] as const;

/** sys_param（global 作用域）取值，缺省 fallback */
export async function getGlobalParam(db: AnyDb, key: string, fallback: string): Promise<string> {
  const [row]: { value: string }[] = await db
    .select({ value: sysParams.value })
    .from(sysParams)
    .where(and(eq(sysParams.scope, "global"), eq(sysParams.key, key)));
  return row?.value ?? fallback;
}

type JgRow = typeof jgDocs.$inferSelect;

/** 发料限已审批/执行中；退料可用已完成/已关闭JG，但结算冻结后必须另走纠错。 */
export async function getJgForMatflow(db: AnyDb, jgId: number, operation: "issue" | "return" = "issue"): Promise<JgRow> {
  const [jg]: JgRow[] = await db.select().from(jgDocs).where(eq(jgDocs.id, jgId));
  if (!jg) throw new ApiError(404, `加工通知单不存在: #${jgId}`);
  if (operation === "return") {
    const settlement = await getFrozenJgSettlement(db, jgId);
    if (settlement) throw new ApiError(409, `结算单 ${settlement.docNo} 已冻结，不可继续退料；损耗可能已核销，请联系财务和仓管核对库存及差额纠错，不可借用其他工单库存`);
  }
  if (operation === "return" && (jg.status === "completed" || jg.status === "closed")) return jg;
  if (jg.status !== "in_progress" && jg.status !== "approved") {
    throw new ApiError(409, `加工通知单当前状态不可操作: ${jg.status}（需 已审批/执行中）`);
  }
  return jg;
}

/** Serialize physical issue/return with JG closure and JS snapshot approval. */
export async function lockMatflowJg(db: AnyDb, jgId: number): Promise<void> {
  const [jg] = await db.select({ id: jgDocs.id }).from(jgDocs).where(eq(jgDocs.id, jgId)).for("update");
  if (!jg) throw new ApiError(404, `加工通知单不存在: #${jgId}`);
}

/** Only expected source refusals become hints; infrastructure failures must remain failed reads. */
export async function matflowSourceBlock(db: AnyDb, jgId: number, operation: "issue" | "return") {
  try { await getJgForMatflow(db, jgId, operation); return null; }
  catch (error) {
    if (error instanceof ApiError && (error.status === 404 || error.status === 409)) return error.message;
    throw error;
  }
}

type WarehouseRow = typeof warehouses.$inferSelect;

/** Explicit choice, or a unique eligible warehouse for older callers. Never guess among multiple warehouses. */
export async function getOutsourceWarehouseOf(db: AnyDb, supplierId: number, warehouseId?: number): Promise<WarehouseRow> {
  const rows: WarehouseRow[] = await db
    .select()
    .from(warehouses)
    .where(and(eq(warehouses.kind, "outsource"), eq(warehouses.supplierId, supplierId),
      eq(warehouses.active, true), eq(warehouses.accountingMode, "realtime"),
      warehouseId == null ? undefined : eq(warehouses.id, warehouseId)))
    .orderBy(warehouses.id).limit(2);
  if (!rows.length) throw new ApiError(warehouseId == null ? 404 : 409, warehouseId == null
    ? `该加工厂无启用的实时委外仓（supplier#${supplierId}），请先在仓库主数据核对`
    : `所选委外仓 #${warehouseId} 已停用或不属于该加工厂的实时委外仓，请重新核对`);
  if (rows.length > 1) throw new ApiError(409, "该加工厂有多个委外仓，请明确选择本次实际发料、退料或扣料的仓库");
  return rows[0];
}

/** Same ordered locks as posting. Callers re-read qualification after waiting, within the transaction. */
export async function lockMatflowWarehouses(db: AnyDb, warehouseIds: number[]): Promise<void> {
  await db.select({ id: warehouses.id }).from(warehouses)
    .where(inArray(warehouses.id, [...new Set(warehouseIds)]))
    .orderBy(warehouses.id).for("update");
}

/** 自有实时仓校验（发/退/收货落仓）：存在、启用、实时记账、非委外仓 */
export async function requireRealtimeWarehouse(db: AnyDb, warehouseId: number, label: string): Promise<WarehouseRow> {
  const [wh]: WarehouseRow[] = await db.select().from(warehouses).where(eq(warehouses.id, warehouseId));
  if (!wh || !wh.active) throw new ApiError(400, `${label}不存在或已停用: #${warehouseId}`);
  if (wh.accountingMode !== "realtime" || wh.kind === "outsource" || wh.kind === "snapshot") {
    throw new ApiError(400, `${label}必须是自有实时记账仓（快照/委外仓不可选）`);
  }
  return wh;
}

/**
 * 库存类单据瞬时执行（与 stock_doc 同口径）：审批过账成功后
 * approved -[start]→ in_progress -[complete]→ completed（走状态机保持流转合法）。
 */
export async function completeApprovedDoc(tx: AnyDb, table: AnyPgTable, id: number): Promise<string> {
  const inProgress = nextStatus("approved", "start");
  const finalStatus = nextStatus(inProgress, "complete");
  const cols = getTableColumns(table) as Record<string, PgColumn>;
  await tx
    .update(table)
    .set({ status: finalStatus, version: sql`${cols.version} + 1`, updatedAt: new Date() } as Record<string, unknown>)
    .where(eq(cols.id, id));
  return finalStatus;
}
