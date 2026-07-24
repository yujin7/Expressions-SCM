/**
 * D33-b（0724 会议）：成品入库时自动核算剩余物料 → 复核清单提示（人工决定退料/补料）。
 * 结余 = 净发料(FL−TL) − 累计入库×毛单耗；正=厂内结余（可退/留用），负=欠料（需补发）。
 * v1 只提示不开单（人工闸）；金额不涉及。
 */
import { and, eq, sql } from "drizzle-orm";
import * as schema from "@/db/schema";
import { dCmp, dDiv, dMul, dSub } from "@/server/core/decimal";
import type { SessionUser } from "@/server/core/dto";
import { type AnyDb, resolveDb } from "./common";

export async function suggestLeftoverAfterInbound(user: SessionUser, jgId: number, dbArg?: AnyDb): Promise<void> {
  const db = await resolveDb(dbArg);
  const [jg] = await db
    .select({ id: schema.jgDocs.id, docNo: schema.jgDocs.docNo, woId: schema.jgDocs.woId, qty: schema.jgDocs.qty })
    .from(schema.jgDocs)
    .where(eq(schema.jgDocs.id, jgId));
  if (!jg) return;
  const [wo] = await db.select({ qty: schema.woDocs.qty }).from(schema.woDocs).where(eq(schema.woDocs.id, jg.woId));
  // 累计合格入库（本 JG）
  const [inb] = await db
    .select({ total: sql<string>`coalesce(sum(${schema.qcLines.passQty}), '0')` })
    .from(schema.qcRecords)
    .innerJoin(schema.qcLines, eq(schema.qcLines.qcId, schema.qcRecords.id))
    .innerJoin(schema.shDocs, eq(schema.qcRecords.shId, schema.shDocs.id))
    .where(and(eq(schema.shDocs.sourceType, "jg"), eq(schema.shDocs.sourceId, jgId)));
  const inbound = inb?.total ?? "0";
  // 各料净发 vs 应耗
  const lines: { skuId: number; grossReq: string; code: string }[] = await db
    .select({ skuId: schema.woLines.materialSkuId, grossReq: schema.woLines.grossReq, code: schema.skus.code })
    .from(schema.woLines)
    .innerJoin(schema.skus, eq(schema.woLines.materialSkuId, schema.skus.id))
    .where(eq(schema.woLines.woId, jg.woId));
  const notes: string[] = [];
  for (const l of lines) {
    const [fl] = await db
      .select({ t: sql<string>`coalesce(sum(${schema.flLines.qty}), '0')` })
      .from(schema.flDocs)
      .innerJoin(schema.flLines, eq(schema.flLines.flId, schema.flDocs.id))
      .where(and(eq(schema.flDocs.jgId, jgId), eq(schema.flLines.skuId, l.skuId), eq(schema.flDocs.status, "completed")));
    const [tl] = await db
      .select({ t: sql<string>`coalesce(sum(${schema.tlLines.qty}), '0')` })
      .from(schema.tlDocs)
      .innerJoin(schema.tlLines, eq(schema.tlLines.tlId, schema.tlDocs.id))
      .where(and(eq(schema.tlDocs.jgId, jgId), eq(schema.tlLines.skuId, l.skuId), eq(schema.tlDocs.status, "completed")));
    const netIssued = dSub(fl?.t ?? "0", tl?.t ?? "0");
    const perUnit = dDiv(l.grossReq, wo?.qty ?? jg.qty, 6);
    const expected = dMul(inbound, perUnit, 4);
    const leftover = dSub(netIssued, expected);
    if (dCmp(leftover, "0") > 0) notes.push(`${l.code} 厂内结余约 ${leftover}（可退料/留用下批）`);
    else if (dCmp(leftover, "0") < 0) notes.push(`${l.code} 欠料约 ${dSub("0", leftover)}（如需续产请补发）`);
  }
  if (notes.length === 0) return;
  const title = `【物料结余】${jg.docNo} 入库后核算（累计入库 ${inbound}）`;
  const [dup] = await db.select({ id: schema.reviewItems.id }).from(schema.reviewItems)
    .where(and(eq(schema.reviewItems.title, title), eq(schema.reviewItems.status, "open")));
  if (dup) return; // 同水位不重复提示
  await db.insert(schema.reviewItems).values({
    category: "material_leftover",
    refType: "jg",
    refKey: jg.docNo,
    title,
    detail: notes.join("\n") + `\n（D33-b：仅提示，请人工决定 退料TL / 补发FL；提交人触发：${user.name}）`,
    status: "open",
  });
}
