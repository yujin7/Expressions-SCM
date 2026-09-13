import { and, eq } from "drizzle-orm";
import { reviewItems } from "@/db/schema";
import { ApiError } from "@/server/modules/master/common";
import type { AnyDb } from "@/server/core/svc";

/** Shared source qualification; callers must still enforce their read/write permission.
 * A write caller supplies its transaction so the source share lock lasts through creation.
 */
export async function assertReviewedScrapSource(db: AnyDb, disposalId: number, skuCodes: readonly string[]) {
  const [disposal]: { refKey: string | null; title: string }[] = await db
    .select({ refKey: reviewItems.refKey, title: reviewItems.title }).from(reviewItems)
    .where(and(eq(reviewItems.id, disposalId), eq(reviewItems.category, "risk_disposal"), eq(reviewItems.status, "open"))).for("share");
  if (!disposal) throw new ApiError(409, "风险处置登记不存在、已关闭或已被改判");
  if (!disposal.title.startsWith("处置决定：报废评审 ")) throw new ApiError(409, "只有「报废评审」登记可生成报废出库单");
  const codes = new Set(skuCodes);
  if (codes.size !== 1 || !disposal.refKey || !codes.has(disposal.refKey)) {
    throw new ApiError(409, "报废出库明细必须且只能包含该处置登记对应的 SKU");
  }
}
