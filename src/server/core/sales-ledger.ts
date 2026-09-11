import { and, eq, gte, inArray, lt, or, sql } from "drizzle-orm";
import { stockLedger, warehouses } from "@/db/schema";
import type { AnyDb } from "./svc";

/**
 * 系统销售流水的共同边界：正式销售出库 + 指向销售原单的红字。
 * 纠正在其 occurred_at 所属窗口净减；不回写原日、不夹掉负净额。
 * 调拨、发料、盘点、采购退货和其他红字不是销售；不得以 qty_delta < 0 代替本谓词。
 */
export function salesLedgerMovement() {
  return or(
    and(eq(stockLedger.sourceDocType, "sales_out"), eq(stockLedger.action, "post")),
    and(eq(stockLedger.sourceDocType, "stock_doc"), sql`${stockLedger.action} ~ '^reverse:sales_out#[1-9][0-9]*$'`),
  )!;
}

export interface LedgerMovementSummary {
  skuId: number;
  /** 已登记的销售净出库；无该类事件 = null，有销售且全额冲销 = 0。 */
  salesNetQty: string | null;
  /** 非销售的负向作业流量，未扣正向冲销；仅核对用途，不是销售或补货需求。 */
  operationsOutQty: string | null;
}

/** 一次聚合两个互斥口径，不按 SKU 发 N+1 查询；不能据有事件宣称全渠道覆盖完整。 */
export async function getLedgerMovementSummary(
  db: AnyDb,
  window: { start: Date; end: Date },
  skuIds: number[],
): Promise<LedgerMovementSummary[]> {
  if (!skuIds.length) return [];
  const sale = salesLedgerMovement();
  return db.select({
    skuId: stockLedger.skuId,
    salesNetQty: sql<string | null>`sum(-${stockLedger.qtyDelta}) FILTER (WHERE ${sale})::text`,
    operationsOutQty: sql<string | null>`sum(-${stockLedger.qtyDelta}) FILTER (WHERE NOT (${sale}) AND ${stockLedger.qtyDelta} < 0)::text`,
  }).from(stockLedger)
    .innerJoin(warehouses, eq(warehouses.id, stockLedger.warehouseId))
    .where(and(
      inArray(stockLedger.skuId, skuIds),
      eq(warehouses.accountingMode, "realtime"),
      gte(stockLedger.occurredAt, window.start),
      lt(stockLedger.occurredAt, window.end),
    ))
    .groupBy(stockLedger.skuId);
}
