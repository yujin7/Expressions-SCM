import { and, eq, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { z } from "zod";
import { bhCreateRequests, bhDocs } from "@/db/schema";
import { currentWriteActor } from "@/server/core/current-write-actor";
import { bhReadScope } from "@/server/core/bh-read-scope";
import { loadUserScopes } from "@/server/core/data-scope";
import { dQty } from "@/server/core/decimal";
import type { SessionUser } from "@/server/core/dto";
import { type AnyDb, requireAnyRole, resolveDb } from "./common";
import { ApiError } from "@/server/modules/master/common";
import { createBhSchema } from "./schemas";
import { createBh } from "./bh";

export const bhRequestKeySchema = z.string().uuid("请保留原创建请求编号重试").transform(s => s.toLowerCase());
export const createBhRequestSchema = createBhSchema.extend({
  requestKey: bhRequestKeySchema,
  lines: createBhSchema.shape.lines.max(200, "一张备货申请最多200项，请分批确认"),
});
export type BhCreateSource = "manual" | "replenish";
const roleFor = (source: BhCreateSource) => source === "manual" ? "ops" : "pmc";
const lockRequest = (tx: AnyDb, actorId: number, key: string) =>
  tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('bh-create'), hashtext(${`${actorId}:${key}`}))`);

async function currentDocument(tx: AnyDb, actor: SessionUser, bhId: number) {
  const scopes = await loadUserScopes(tx, actor.id);
  const [doc]: { id: number; docNo: string; status: string }[] = await tx.select({ id: bhDocs.id, docNo: bhDocs.docNo, status: bhDocs.status }).from(bhDocs)
    .where(and(eq(bhDocs.id, bhId), bhReadScope(tx, { ...actor, ...scopes })));
  if (!doc) throw new ApiError(404, "原备货申请不存在或不在当前可读范围，请联系管理员核对原请求");
  return doc;
}

/** HTTP creation boundary; internal NPD/S&OP workflows retain their own source receipts. */
export async function createBhRequest(user: SessionUser, input: unknown, source: BhCreateSource, dbArg?: AnyDb) {
  const v = createBhRequestSchema.parse(input);
  if (source === "replenish" && (v.orderType || v.lines.some(l => l.expectDate))) {
    throw new ApiError(400, "实时补货请求不支持改写订单类型或期望日期");
  }
  const hash = createHash("sha256").update(JSON.stringify({ source, orderType: v.orderType || null, remark: v.remark || null,
    // Preserve independent original lines and their order; same SKU is not duplicate intent.
    lines: v.lines.map(l => ({ skuId: l.skuId, qty: dQty(l.qty), expectDate: l.expectDate ?? null })),
  })).digest("hex");
  const db = await resolveDb(dbArg);
  return db.transaction(async (tx: AnyDb) => {
    const actor = await currentWriteActor(tx, user);
    requireAnyRole(actor, roleFor(source));
    await lockRequest(tx, actor.id, v.requestKey);
    const [receipt] = await tx.select().from(bhCreateRequests).where(and(eq(bhCreateRequests.requestedBy, actor.id), eq(bhCreateRequests.requestKey, v.requestKey)));
    if (receipt) {
      if (receipt.source !== source || receipt.requestHash !== hash) throw new ApiError(409, "原请求已创建不同内容的备货申请，请先找回原单，不要改换内容重试");
      return { requestKey: v.requestKey, source, document: await currentDocument(tx, actor, receipt.bhId) };
    }
    // Only NEW live requests take the monthly mode gate. Recovering a committed original
    // after freeze is read-only and must not be mistaken for a second live order.
    const doc = source === "manual" ? await createBh(actor, v, tx)
      : await (await import("@/server/modules/replenish/service")).createReplenishDraft(actor, {
        remark: v.remark, items: v.lines.map(l => ({ skuId: l.skuId, qty: l.qty })),
      }, tx);
    await tx.insert(bhCreateRequests).values({ requestedBy: actor.id, requestKey: v.requestKey, source, requestHash: hash, bhId: doc.id });
    return { requestKey: v.requestKey, source, document: await currentDocument(tx, actor, doc.id) };
  });
}

/** A missing receipt is not permission to replace the request key or auto-submit. */
export async function getBhCreateResult(user: SessionUser, requestKey: string, dbArg?: AnyDb) {
  const key = bhRequestKeySchema.parse(requestKey), db = await resolveDb(dbArg);
  return db.transaction(async (tx: AnyDb) => {
    const actor = await currentWriteActor(tx, user);
    requireAnyRole(actor, "ops", "pmc");
    await lockRequest(tx, actor.id, key);
    const [receipt] = await tx.select().from(bhCreateRequests).where(and(eq(bhCreateRequests.requestedBy, actor.id), eq(bhCreateRequests.requestKey, key)));
    if (!receipt) return { requestKey: key, source: null, document: null };
    requireAnyRole(actor, roleFor(receipt.source as BhCreateSource));
    return { requestKey: key, source: receipt.source, document: await currentDocument(tx, actor, receipt.bhId) };
  });
}
