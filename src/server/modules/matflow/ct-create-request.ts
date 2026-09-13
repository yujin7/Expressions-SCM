import { and, eq, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { z } from "zod";
import { ctCreateRequests, ctDocs } from "@/db/schema";
import { currentWriteActor } from "@/server/core/current-write-actor";
import { writeAudit } from "@/server/core/audit";
import { dQty } from "@/server/core/decimal";
import type { SessionUser } from "@/server/core/dto";
import { resolveDb, type AnyDb } from "@/server/core/svc";
import { ApiError } from "@/server/modules/master/common";
import { createCtSchema } from "./schemas";
import { createCt } from "./ct";

export const ctRequestKeySchema = z.string().uuid("请刷新页面并保留原创建请求编号重试").transform(s => s.toLowerCase());
const idSchema = z.number().int().positive().max(2147483647);
const lock = (tx: AnyDb, actorId: number, key: string) => tx.execute(
  sql`SELECT pg_advisory_xact_lock(hashtext('ct-create'), hashtext(${`${actorId}:${key}`}))`);
async function currentActor(tx: AnyDb, user: SessionUser) {
  const actor = await currentWriteActor(tx, user);
  if (!actor.roles.includes("warehouse") && !actor.roles.includes("admin")) throw new ApiError(403, "仅仓管或管理员可创建或核对采购退货单据");
  return actor;
}
async function currentDocument(tx: AnyDb, actorId: number, id: number) {
  const [doc] = await tx.select({ id: ctDocs.id, docNo: ctDocs.docNo, status: ctDocs.status }).from(ctDocs)
    .where(and(eq(ctDocs.id, id), eq(ctDocs.createdBy, actorId)));
  if (!doc) throw new ApiError(404, "原采购退货单不存在或归属已变化，请联系管理员核对原请求");
  return doc as { id: number; docNo: string; status: string };
}

/** Public CT creation binds explicit physical intent; internal service callers retain their contracts. */
export async function createCtRequest(user: SessionUser, input: unknown, dbArg?: AnyDb) {
  const v = createCtSchema.extend({ requestKey: ctRequestKeySchema, poId: idSchema, warehouseId: idSchema,
    lines: createCtSchema.shape.lines.element.extend({ poLineId: idSchema, skuId: idSchema, batchId: idSchema.nullable() }).strict().array().min(1),
  }).strict().parse(input);
  const requestKey = v.requestKey;
  const requestHash = createHash("sha256").update(JSON.stringify({
    poId: v.poId, warehouseId: v.warehouseId, remark: v.remark || null,
    // Independent physical lines stay ordered; null is explicit unbatched stock, not automatic allocation.
    lines: v.lines.map(l => ({ poLineId: l.poLineId, skuId: l.skuId, qty: dQty(l.qty), batchId: l.batchId, reason: l.reason || null })),
  })).digest("hex");
  const db = await resolveDb(dbArg);
  return db.transaction(async (tx: AnyDb) => {
    const actor = await currentActor(tx, user);
    await lock(tx, actor.id, requestKey);
    const [receipt] = await tx.select().from(ctCreateRequests).where(and(eq(ctCreateRequests.requestedBy, actor.id), eq(ctCreateRequests.requestKey, requestKey)));
    if (receipt) {
      if (receipt.cancelled) throw new ApiError(409, "原建单请求已取消，不会再生成退货单；请核对取消结果后准备下一笔");
      if (receipt.ctDocId == null) throw new ApiError(409, "原建单回执不完整，请联系管理员核对");
      if (receipt.requestHash !== requestHash) throw new ApiError(409, "原请求已创建不同内容的采购退货单，请先找回原单，不要改换内容重试");
      return { requestKey, document: await currentDocument(tx, actor.id, receipt.ctDocId) };
    }
    const doc = await createCt(actor, v, tx);
    await tx.insert(ctCreateRequests).values({ requestedBy: actor.id, requestKey, requestHash, ctDocId: doc.id });
    return { requestKey, document: await currentDocument(tx, actor.id, doc.id) };
  });
}

/** Wait for in-flight creation; lookup never creates, and only exposes this actor's receipt. */
export async function getCtCreateResult(user: SessionUser, requestKey: string, dbArg?: AnyDb) {
  const key = ctRequestKeySchema.parse(requestKey), db = await resolveDb(dbArg);
  return db.transaction(async (tx: AnyDb) => {
    const actor = await currentActor(tx, user);
    await lock(tx, actor.id, key);
    const [receipt] = await tx.select().from(ctCreateRequests).where(and(eq(ctCreateRequests.requestedBy, actor.id), eq(ctCreateRequests.requestKey, key)));
    if (receipt?.cancelled) return { requestKey: key, document: null, cancelled: true as const };
    if (receipt && receipt.ctDocId == null) throw new ApiError(409, "原建单回执不完整，请联系管理员核对");
    return { requestKey: key, document: receipt ? await currentDocument(tx, actor.id, receipt.ctDocId!) : null };
  });
}

/** One immutable outcome per account/key: cancellation fences all delayed creation, never voids a CT. */
export async function cancelCtCreateRequest(user: SessionUser, input: unknown, dbArg?: AnyDb) {
  const { requestKey: key } = z.object({ requestKey: ctRequestKeySchema }).strict().parse(input);
  const db = await resolveDb(dbArg);
  return db.transaction(async (tx: AnyDb) => {
    const actor = await currentActor(tx, user);
    await lock(tx, actor.id, key);
    const [receipt] = await tx.select().from(ctCreateRequests).where(and(eq(ctCreateRequests.requestedBy, actor.id), eq(ctCreateRequests.requestKey, key)));
    if (receipt) {
      if (receipt.cancelled) return { requestKey: key, document: null, cancelled: true as const };
      if (receipt.ctDocId == null) throw new ApiError(409, "原建单回执不完整，请联系管理员核对");
      return { requestKey: key, document: await currentDocument(tx, actor.id, receipt.ctDocId) };
    }
    const [saved] = await tx.insert(ctCreateRequests).values({ requestedBy: actor.id, requestKey: key, cancelled: true }).returning({ id: ctCreateRequests.id });
    await writeAudit(tx, { userId: actor.id, entity: "ct_create_request", entityId: saved.id, action: "cancel",
      after: { requestKey: key, cancelled: true, documentId: null } });
    return { requestKey: key, document: null, cancelled: true as const };
  });
}
