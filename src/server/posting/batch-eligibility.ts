import { and, eq, inArray, sql } from "drizzle-orm";
import { batches, reviewItems, skus, stockDocs } from "@/db/schema";
import { todayShanghai } from "@/server/core/business-day";
import { compareBatchIdentity } from "@/server/core/batch-order";
import { dCmp } from "@/server/core/decimal";
import type { AnyDb, PostingEvent } from "./post";
import { POSTING_REGISTRY } from "./registry";
import type { PostingErrorCode } from "./error-codes";

/** Caller holds ordered warehouse locks. No reallocation: check exactly the saved negative legs. */
export async function outboundBatchBlock(db: AnyDb, event: PostingEvent): Promise<{ code: PostingErrorCode; message: string } | null> {
  const policy = POSTING_REGISTRY[event.sourceDocType]?.batchPolicy;
  if (policy === "historical") return null;
  const lines = event.lines.filter(l => l.batchId != null && dCmp(l.qtyDelta, "0") < 0);
  if (!lines.length) return null;
  const ids = [...new Set(lines.map(l => l.batchId!))];
  const identities: { id: number; skuId: number; batchNo: string }[] = await db.select({ id: batches.id, skuId: batches.skuId, batchNo: batches.batchNo })
    .from(batches).where(inArray(batches.id, ids));
  const orderedIds = identities.sort(compareBatchIdentity).map(b => b.id);
  // Lock in the same JS natural-key order as receipt registration, independent of DB collation.
  const rows: { id: number; skuId: number; batchNo: string; expiryDate: string | null }[] = orderedIds.length ? await db
    .select({ id: batches.id, skuId: batches.skuId, batchNo: batches.batchNo, expiryDate: batches.expiryDate })
    .from(batches).where(inArray(batches.id, orderedIds))
    .orderBy(sql`array_position(array[${sql.join(orderedIds.map(id => sql`${id}`), sql`, `)}]::integer[], ${batches.id})`).for("share") : [];
  const byId = new Map(rows.map(b => [b.id, b]));
  // Expiry is an execution-day restriction: caller-supplied occurredAt cannot backdate eligibility.
  const today = todayShanghai();
  let disposalSku: number | undefined;
  if (event.sourceDocType === "issue_out") {
    // Only the existing approved, SKU-bound scrap-review path is disposal, never a free caller flag.
    const [disposal]: { skuId: number }[] = await db.select({ skuId: skus.id }).from(stockDocs)
      .innerJoin(reviewItems, eq(stockDocs.sourceDocId, reviewItems.id))
      .innerJoin(skus, eq(reviewItems.refKey, skus.code))
      .where(and(eq(stockDocs.id, event.sourceDocId), eq(stockDocs.subtype, "issue_out"), eq(stockDocs.status, "approved"),
        eq(stockDocs.sourceDocType, "risk_disposal"), eq(reviewItems.category, "risk_disposal"), eq(reviewItems.status, "open"),
        sql`${reviewItems.title} like '处置决定：报废评审 %'`)).for("update", { of: reviewItems });
    disposalSku = disposal?.skuId;
  }
  for (const line of lines) {
    const batch = byId.get(line.batchId!);
    if (!batch || batch.skuId !== line.skuId) return { code: "BATCH_IDENTITY",
      message: `批次不存在或不属于该 SKU：batch#${line.batchId} / sku#${line.skuId}；请驳回并核对原单批次，不可借用其他物料批次。` };
    if (policy === "use" && line.skuId !== disposalSku && batch.expiryDate != null && batch.expiryDate <= today) return {
      code: "EXPIRED_BATCH", message: `批次 ${batch.batchNo}（sku#${line.skuId}）已到期 ${batch.expiryDate}，执行日 ${today} 不可正常领用、销售或调拨；请驳回核对有效批次，需退回或报废时走对应受控流程。`,
    };
  }
  return null;
}
