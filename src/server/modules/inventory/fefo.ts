/**
 * E2-12 FEFO 出库批次建议（服务层，**只读、不过账**）。
 *
 * 判定全部委托 `rules/fefo.ts` 纯函数；本模块只负责取数与口径组合。
 *
 * ── 为什么这一步是安全的 ──
 * 出库侧支持逐行 `batchId`；本模块提供唯一 FEFO 建议口径。只读 API 可供人预览，
 * `batch-allocation.ts` 也会在迁移闸门开启时把建议写入**草稿单行**，仍须走原审批。
 * 过账逻辑保持唯一；开关未开时对现网零影响。
 *
 * ── 迁移期的关键取舍（步骤 5 护栏，别删）──
 * 入库分批开关打开后，库里会**同时存在** batchId=null 的历史余额行与新的分批行。
 * 若 FEFO 只认分批行，历史那批 null 库存就会变成**永远发不出去的死库存**。
 * 所以：分批行不足时**允许回落到 null 行**，并在 note 里如实说明回落了多少。
 * 这不是妥协，是迁移期的正确行为——抑制≠隐藏，回落也必须被看见。
 *
 * ── 诚实降级 ──
 * 该 (SKU,仓) 完全没有分批余额时，返回空分配 + 说明「批次化未覆盖」，**不报错**。
 * 调用方据此走原有的无批次出库路径。
 */
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import * as schema from "@/db/schema";
import { dAdd, dCmp, dQty, dSub } from "@/server/core/decimal";
import { allocateFefo, type BatchLot } from "@/server/rules/fefo";
import { todayShanghai } from "@/server/modules/master/common";
import { listLocatedQtyByBatch, locationBatchKey } from "./location-balance";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle PGlite/Postgres structural compatibility is narrowed by the surrounding service contract
type AnyDb = any;

export interface FefoSuggestion {
  /** 建议的逐批分配（可直接填进出库单行的 batchId/qty） */
  allocations: { batchId: number; batchNo: string; expiryDate: string | null; qty: string }[];
  /** 分批行覆盖不了、需回落到无批次库存的量（迁移期历史库存） */
  fallbackQty: string;
  /** 连回落也不够的缺口 */
  shortBy: string;
  /** 因过期被排除的正库存批次数 */
  expiredLots: number;
  /** 该 (SKU,仓) 是否存在分批维度余额 */
  batchCoverage: boolean;
  note: string;
}

/**
 * 为一次出库给出 FEFO 批次建议。
 * @param today 判定「已过期」的基准日（YYYY-MM-DD）；由调用方传入，规则层不取系统时间
 */
export async function suggestFefoAllocation(
  db: AnyDb,
  args: { skuId: number; warehouseId: number; qty: string; today?: string },
): Promise<FefoSuggestion> {
  const required = dQty(args.qty);

  if (dCmp(required, "0") <= 0) {
    return {
      allocations: [], fallbackQty: dQty("0"), shortBy: dQty("0"),
      expiredLots: 0, batchCoverage: false, note: "出库量为 0，无需分配批次",
    };
  }

  /* ── 分批维度余额（batchId 非空）+ 批次主档效期 ── */
  const batchRows: { batchId: number | null; batchNo: string | null; expiryDate: string | null; qty: string | null }[] =
    await db
      .select({
        batchId: schema.stockBalances.batchId,
        batchNo: schema.batches.batchNo,
        expiryDate: schema.batches.expiryDate,
        qty: schema.stockBalances.qty,
      })
      .from(schema.stockBalances)
      .leftJoin(schema.batches, eq(schema.stockBalances.batchId, schema.batches.id))
      .where(
        and(
          eq(schema.stockBalances.skuId, args.skuId),
          eq(schema.stockBalances.warehouseId, args.warehouseId),
          isNotNull(schema.stockBalances.batchId),
        ),
      );
  const locatedByBatch = await listLocatedQtyByBatch(db, {
    skuId: args.skuId,
    warehouseId: args.warehouseId,
  });

  const lots: BatchLot[] = batchRows
    .filter((r) => r.batchId != null)
    .map((r) => ({
      batchId: r.batchId as number,
      batchNo: r.batchNo ?? `#${r.batchId}`,
      expiryDate: r.expiryDate ?? null,
      qty: dCmp(
        dSub(r.qty ?? "0", locatedByBatch.get(locationBatchKey(r.batchId)) ?? "0"),
        "0",
      ) > 0
        ? dQty(dSub(r.qty ?? "0", locatedByBatch.get(locationBatchKey(r.batchId)) ?? "0"))
        : "0.0000",
    }));

  /* ── 无批次维度余额：诚实降级，不报错 ── */
  if (lots.length === 0) {
    return {
      allocations: [], fallbackQty: dQty("0"), shortBy: dQty("0"),
      expiredLots: 0, batchCoverage: false,
      note: "该 SKU 在此仓尚无批次维度库存（批次化未覆盖），按无批次库存出库即可",
    };
  }

  // 安全默认：调用方不传 today 也必须按上海业务日排除已过期批次，不能绕过。
  const r = allocateFefo(lots, required, args.today ?? todayShanghai());

  /* ── 迁移期回落：分批行不足时看 batchId=null 的历史行 ── */
  let fallbackQty = dQty("0");
  let shortBy = r.shortBy;
  if (dCmp(r.shortBy, "0") > 0) {
    const nullRows: { qty: string | null }[] = await db
      .select({ qty: schema.stockBalances.qty })
      .from(schema.stockBalances)
      .where(
        and(
          eq(schema.stockBalances.skuId, args.skuId),
          eq(schema.stockBalances.warehouseId, args.warehouseId),
          isNull(schema.stockBalances.batchId),
        ),
      );
    const nullGross = nullRows.reduce((s, x) => dAdd(s, x.qty ?? "0", 6), "0");
    const nullRemainder = dSub(nullGross, locatedByBatch.get(locationBatchKey(null)) ?? "0");
    const nullQty = dCmp(nullRemainder, "0") > 0 ? nullRemainder : "0";
    if (dCmp(nullQty, "0") > 0) {
      // 回落量 = min(缺口, 无批次余量)
      fallbackQty = dQty(dCmp(nullQty, r.shortBy) >= 0 ? r.shortBy : nullQty);
      shortBy = dQty(dSub(r.shortBy, fallbackQty, 6));
    }
  }

  const parts: string[] = [];
  if (r.allocations.length > 0) parts.push(`按先到期先出选中 ${r.allocations.length} 个批次`);
  if (dCmp(fallbackQty, "0") > 0) {
    parts.push(
      `其中 ${fallbackQty} 由**无批次的历史库存**补足——迁移期历史库存尚未分批，` +
        `不回落它就会变成发不出去的死库存；这部分无法参与批次追溯`,
    );
  }
  if (dCmp(shortBy, "0") > 0) parts.push(`仍缺 ${shortBy}，本仓库存不足`);
  if (r.expiredLots > 0) parts.push(`已排除 ${r.expiredLots} 个过期批次，不计入可发库存`);

  return {
    allocations: r.allocations.map((a) => ({
      batchId: a.batchId,
      batchNo: a.batchNo,
      expiryDate: a.expiryDate,
      qty: a.qty,
    })),
    fallbackQty,
    shortBy,
    expiredLots: r.expiredLots,
    batchCoverage: true,
    note: parts.join("；") || "无需分配",
  };
}
