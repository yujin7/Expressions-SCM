import { and, eq, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { z } from "zod";
import { stockCreateRequests, stockDocs } from "@/db/schema";
import { currentWriteActor } from "@/server/core/current-write-actor";
import { writeAudit } from "@/server/core/audit";
import { dMoney, dQty } from "@/server/core/decimal";
import type { SessionUser } from "@/server/core/dto";
import { resolveDb, type AnyDb } from "@/server/core/svc";
import { ApiError } from "@/server/modules/master/common";
import { createStockDocSchema } from "./schemas";
import { createStockDoc } from "./stock-doc";

export const stockRequestKeySchema = z.string().uuid("请刷新页面并保留原创建请求编号重试").transform(s => s.toLowerCase());
const lock = (tx: AnyDb, actorId: number, key: string) => tx.execute(
  sql`SELECT pg_advisory_xact_lock(hashtext('stock-create'), hashtext(${`${actorId}:${key}`}))`);
async function currentActor(tx: AnyDb, user: SessionUser) {
  const actor = await currentWriteActor(tx, user);
  if (!actor.roles.includes("warehouse") && !actor.roles.includes("admin")) throw new ApiError(403, "仅仓管或管理员可创建或核对库存单据");
  return actor;
}
async function currentDocument(tx: AnyDb, actorId: number, id: number) {
  const [doc] = await tx.select({ id: stockDocs.id, docNo: stockDocs.docNo, status: stockDocs.status }).from(stockDocs)
    .where(and(eq(stockDocs.id, id), eq(stockDocs.createdBy, actorId)));
  if (!doc) throw new ApiError(404, "原库存单不存在或归属已变化，请联系管理员核对原请求");
  return doc as { id: number; docNo: string; status: string };
}

/** HTTP-only recovery boundary; generated inventory documents retain their domain receipts. */
export async function createStockRequest(user: SessionUser, input: unknown, dbArg?: AnyDb) {
  const v = createStockDocSchema.parse(input);
  const { requestKey } = z.object({ requestKey: stockRequestKeySchema }).parse(input);
  const requestHash = createHash("sha256").update(JSON.stringify({
    subtype: v.subtype, warehouseId: v.warehouseId, toWarehouseId: v.subtype === "transfer" ? v.toWarehouseId : null,
    transferType: v.transferType ?? null, reason: v.reason || null, remark: v.remark || null, riskDisposalId: v.riskDisposalId ?? null,
    // Independent lines and explicit batch identity are intent; never merge by SKU.
    lines: v.lines.map(l => ({ skuId: l.skuId, qty: dQty(l.qty), price: l.price == null ? null : dMoney(l.price), batchId: l.batchId ?? null })),
    // Keep pre-lineage fingerprints byte-identical for old requests.
    ...(v.replacementOfId == null ? {} : { replacementOfId: v.replacementOfId }),
  })).digest("hex");
  const db = await resolveDb(dbArg);
  return db.transaction(async (tx: AnyDb) => {
    const actor = await currentActor(tx, user);
    await lock(tx, actor.id, requestKey);
    const [receipt] = await tx.select().from(stockCreateRequests).where(and(eq(stockCreateRequests.requestedBy, actor.id), eq(stockCreateRequests.requestKey, requestKey)));
    if (receipt) {
      if (receipt.cancelled) throw new ApiError(409, "原建单请求已取消，不会再生成库存单；请核对取消结果后准备下一笔");
      if (receipt.stockDocId == null) throw new ApiError(409, "原建单回执不完整，请联系管理员核对");
      if (receipt.requestHash !== requestHash) throw new ApiError(409, "原请求已创建不同内容的库存单，请先找回原单，不要改换内容重试");
      return { requestKey, document: await currentDocument(tx, actor.id, receipt.stockDocId) };
    }
    const doc = await createStockDoc(actor, v, tx);
    await tx.insert(stockCreateRequests).values({ requestedBy: actor.id, requestKey, requestHash, stockDocId: doc.id });
    return { requestKey, document: await currentDocument(tx, actor.id, doc.id) };
  });
}

/** Wait for in-flight creation; lookup never creates, and only exposes this actor's receipt. */
export async function getStockCreateResult(user: SessionUser, requestKey: string, dbArg?: AnyDb) {
  const key = stockRequestKeySchema.parse(requestKey), db = await resolveDb(dbArg);
  return db.transaction(async (tx: AnyDb) => {
    const actor = await currentActor(tx, user);
    await lock(tx, actor.id, key);
    const [receipt] = await tx.select().from(stockCreateRequests).where(and(eq(stockCreateRequests.requestedBy, actor.id), eq(stockCreateRequests.requestKey, key)));
    if (receipt?.cancelled) return { requestKey: key, document: null, cancelled: true as const };
    if (receipt && receipt.stockDocId == null) throw new ApiError(409, "原建单回执不完整，请联系管理员核对");
    return { requestKey: key, document: receipt ? await currentDocument(tx, actor.id, receipt.stockDocId!) : null };
  });
}

/** Cancellation and creation share one account/key lock and one immutable outcome. Never voids a document. */
export async function cancelStockCreateRequest(user: SessionUser, input: unknown, dbArg?: AnyDb) {
  const { requestKey: key } = z.object({ requestKey: stockRequestKeySchema }).strict().parse(input);
  const db = await resolveDb(dbArg);
  return db.transaction(async (tx: AnyDb) => {
    const actor = await currentActor(tx, user);
    await lock(tx, actor.id, key);
    const [receipt] = await tx.select().from(stockCreateRequests).where(and(eq(stockCreateRequests.requestedBy, actor.id), eq(stockCreateRequests.requestKey, key)));
    if (receipt) {
      if (receipt.cancelled) return { requestKey: key, document: null, cancelled: true as const };
      if (receipt.stockDocId == null) throw new ApiError(409, "原建单回执不完整，请联系管理员核对");
      return { requestKey: key, document: await currentDocument(tx, actor.id, receipt.stockDocId) };
    }
    const [saved] = await tx.insert(stockCreateRequests).values({ requestedBy: actor.id, requestKey: key, cancelled: true }).returning({ id: stockCreateRequests.id });
    await writeAudit(tx, { userId: actor.id, entity: "stock_create_request", entityId: saved.id, action: "cancel",
      after: { requestKey: key, cancelled: true, documentId: null } });
    return { requestKey: key, document: null, cancelled: true as const };
  });
}
