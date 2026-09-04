/**
 * 批次隔离适配器（W2 审计 4a）——质量案件与库存侧隔离能力之间的**唯一**接缝。
 *
 * 为什么要一层适配器而不是直接调：
 * 库存域这一波正在收敛「批次隔离」的对外形态（可能落成 batch 级 API，也可能继续沿用库位隔离）。
 * 质量域不能因为对方接口未定就把「案件冻结批次」这件事继续拖着不做——那正是审计说的
 * 「案件不冻结批次」。所以这里定义质量域需要的**能力契约**，默认实现挂在库存域**当前已经存在**的
 * 隔离作业上（`inventory/bin-operations.postBinMovement` 的 `operation: "quarantine"`，
 * 把未定位库存移入该仓 `kind='quarantine'` 的库位）。
 *
 * ⚠ 依赖说明（交接给库存域）：默认实现是**库位级**隔离，因此
 *   1) 只对 `accountingMode='realtime'` 的实时仓有效（快照仓没有可过账库位）；
 *   2) 该仓必须已配置至少一个启用的隔离库位；
 *   3) 执行者需持 warehouse / admin 角色（库存写路径的既有门禁，质量角色单独调会 403）。
 * 上述任一不满足时**不抛错、不假装成功**，而是返回 `ok:false` + 明确 reason，由调用方登记为
 * 「待仓库执行的围堵行动」。库存域一旦给出 batch 级隔离 API，只需 `setBatchQuarantineProvider`
 * 换掉默认实现，质量侧代码与测试都不用改。
 */
import { and, eq, gt, inArray } from "drizzle-orm";
import * as schema from "@/db/schema";
import type { SessionUser } from "@/server/core/dto";
import type { AnyDb } from "@/server/core/svc";

export interface BatchQuarantineRequest {
  warehouseId: number;
  skuId: number;
  batchId: number;
  /** 要隔离的数量（基础单位，decimal 字符串） */
  qty: string;
  reason: string;
  /** 幂等键：同一案件同一批次同一仓只应产生一次隔离作业 */
  idempotencyKey: string;
}

export interface BatchQuarantineOutcome {
  ok: boolean;
  /** 成功时库存侧作业的主键（默认实现 = bin_movements.id） */
  movementId: number | null;
  /** 隔离能力的实现标识，落进审计与行动证据，便于日后追「当时是怎么隔的」 */
  provider: string;
  /** 未执行的原因（ok=false 时必填；绝不静默跳过） */
  reason: string | null;
}

export type BatchQuarantineProvider = (
  actor: SessionUser,
  req: BatchQuarantineRequest,
  db: AnyDb,
) => Promise<BatchQuarantineOutcome>;

export const DEFAULT_QUARANTINE_PROVIDER_ID = "inventory/bin-operations#quarantine";

/** 默认实现：把未定位库存移入该仓的隔离库位（库存域当前实际存在的隔离能力） */
export const binQuarantineProvider: BatchQuarantineProvider = async (actor, req, db) => {
  const fail = (reason: string): BatchQuarantineOutcome =>
    ({ ok: false, movementId: null, provider: DEFAULT_QUARANTINE_PROVIDER_ID, reason });

  const [warehouse] = await db
    .select({ id: schema.warehouses.id, code: schema.warehouses.code, active: schema.warehouses.active, mode: schema.warehouses.accountingMode })
    .from(schema.warehouses)
    .where(eq(schema.warehouses.id, req.warehouseId));
  if (!warehouse) return fail(`仓库不存在：#${req.warehouseId}`);
  if (!warehouse.active) return fail(`仓库 ${warehouse.code} 已停用，无法执行隔离作业`);
  if (warehouse.mode !== "realtime") {
    return fail(`${warehouse.code} 是快照仓，没有可过账库位：隔离须在外部仓系统执行并回传`);
  }
  const [bin] = await db
    .select({ id: schema.bins.id, code: schema.bins.code })
    .from(schema.bins)
    .where(and(
      eq(schema.bins.warehouseId, req.warehouseId),
      eq(schema.bins.kind, "quarantine"),
      eq(schema.bins.active, true),
    ))
    .orderBy(schema.bins.code);
  if (!bin) return fail(`仓库 ${warehouse.code} 未配置启用的隔离库位，无法执行库位级隔离`);
  if (!actor.roles.includes("admin") && !actor.roles.includes("warehouse")) {
    return fail("执行库存隔离作业需要仓管或管理员角色：已登记围堵行动，待仓库执行");
  }

  const { postBinMovement } = await import("@/server/modules/inventory/bin-operations");
  const res = await postBinMovement(actor, {
    idempotencyKey: req.idempotencyKey,
    warehouseId: req.warehouseId,
    skuId: req.skuId,
    batchId: req.batchId,
    toBinId: bin.id,
    qty: req.qty,
    operation: "quarantine",
    reason: req.reason,
  }, db);
  return { ok: true, movementId: res.id, provider: DEFAULT_QUARANTINE_PROVIDER_ID, reason: null };
};

let provider: BatchQuarantineProvider = binQuarantineProvider;

/** 换实现（库存域给出 batch 级隔离 API 后在装配处调用一次；测试也用它注入桩） */
export function setBatchQuarantineProvider(next: BatchQuarantineProvider | null): void {
  provider = next ?? binQuarantineProvider;
}

export function resolveBatchQuarantineProvider(): BatchQuarantineProvider {
  return provider;
}

export interface QuarantineScopeRow {
  batchId: number;
  batchNo: string;
  skuId: number;
  skuCode: string;
  warehouseId: number;
  warehouseCode: string;
  warehouseName: string;
  onHandQty: string;
}

/**
 * 案件范围内**还在库**的批次库存（按仓拆行）。
 * 只认 `stock_balances` 正余额：隔离是对现货的动作，历史流水不是隔离对象。
 */
export async function listQuarantineScope(
  db: AnyDb,
  batchIds: readonly number[],
): Promise<QuarantineScopeRow[]> {
  if (batchIds.length === 0) return [];
  return db
    .select({
      batchId: schema.batches.id,
      batchNo: schema.batches.batchNo,
      skuId: schema.batches.skuId,
      skuCode: schema.skus.code,
      warehouseId: schema.stockBalances.warehouseId,
      warehouseCode: schema.warehouses.code,
      warehouseName: schema.warehouses.name,
      onHandQty: schema.stockBalances.qty,
    })
    .from(schema.stockBalances)
    .innerJoin(schema.batches, eq(schema.stockBalances.batchId, schema.batches.id))
    .innerJoin(schema.skus, eq(schema.batches.skuId, schema.skus.id))
    .innerJoin(schema.warehouses, eq(schema.stockBalances.warehouseId, schema.warehouses.id))
    .where(and(
      inArray(schema.stockBalances.batchId, [...batchIds]),
      gt(schema.stockBalances.qty, "0"),
    ))
    .orderBy(schema.batches.id, schema.warehouses.code);
}
