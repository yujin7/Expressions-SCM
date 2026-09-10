import { eq } from "drizzle-orm";
import { poDocs, poLines } from "@/db/schema";
import type { AnyDb } from "@/server/core/svc";
import { ApiError } from "@/server/modules/master/common";

/**
 * SH/CT 的 PO 已收数共享同一聚合锁。必须在调用方事务内、批次登记和库存过账前调用。
 * 顺序：当前业务单据 → PO 头 → PO 行按 id → 批次/库存锁。
 * 只锁行不能保护“全部行全收”的完成判断；只用 SQL += 也保护不了 CT 退货上限。
 */
export async function lockPurchaseReceipt(tx: AnyDb, poId: number): Promise<{
  po: typeof poDocs.$inferSelect;
  lines: (typeof poLines.$inferSelect)[];
}> {
  const [po]: (typeof poDocs.$inferSelect)[] = await tx
    .select().from(poDocs).where(eq(poDocs.id, poId)).for("update");
  if (!po) throw new ApiError(409, `来源采购订单不存在: #${poId}，请核对关联单据`);
  const lines: (typeof poLines.$inferSelect)[] = await tx
    .select().from(poLines).where(eq(poLines.poId, poId)).orderBy(poLines.id).for("update");
  return { po, lines };
}
