/** D33-b: an auditable inbound planning estimate, never proof of physical returnable stock. */
import { createHash } from "node:crypto";
import { and, desc, eq, or, sql } from "drizzle-orm";
import * as schema from "@/db/schema";
import { writeAudit } from "@/server/core/audit";
import { currentWriteActor } from "@/server/core/current-write-actor";
import { ApiError } from "@/server/modules/master/common";
import { dCmp } from "@/server/core/decimal";
import type { SessionUser } from "@/server/core/dto";
import { estimateInboundMaterials, type InboundMaterialFact } from "@/server/rules/inbound-materials";
import { type AnyDb, requireAnyRole, resolveDb } from "./common";

type Facts = { wo_qty: string | null; inbound: string; completed_receipts: number; invalid_lines: number; materials: InboundMaterialFact[] };

/** Recover only the estimate, never call receipt posting again. */
export async function refreshInboundMaterialReview(user: SessionUser, shId: number, dbArg?: AnyDb): Promise<void> {
  if (!Number.isSafeInteger(shId) || shId <= 0 || shId > 2_147_483_647) throw new ApiError(400, "无效的收货单ID");
  await suggestLeftoverAfterInbound(user, 0, dbArg, shId);
}

export async function suggestLeftoverAfterInbound(user: SessionUser, jgId: number, dbArg?: AnyDb, receiptId?: number): Promise<void> {
  const db = await resolveDb(dbArg);
  await db.transaction(async (tx: AnyDb) => {
    const actor = await currentWriteActor(tx, user);
    requireAnyRole(actor, "warehouse");
    if (receiptId != null) {
      // Completed receipt identity is immutable; do not invert the posting SH → JG lock order.
      const [receipt] = await tx.select().from(schema.shDocs).where(eq(schema.shDocs.id, receiptId));
      if (!receipt) throw new ApiError(404, "收货单不存在");
      if (receipt.sourceType !== "jg" || (jgId !== 0 && receipt.sourceId !== jgId) || receipt.status !== "completed") {
        throw new ApiError(409, "仅已入库的委外收货单可重算物料核对；此操作不会再次入库");
      }
      jgId = receipt.sourceId;
    }
    // Serialize this producer's dedup/update, including simultaneous receipt hooks.
    const [jg]: (typeof schema.jgDocs.$inferSelect)[] = await tx.select().from(schema.jgDocs)
      .where(eq(schema.jgDocs.id, jgId)).for("update");
    if (!jg) {
      if (receiptId != null) throw new ApiError(409, "加工单来源缺失，请核对原收货单");
      return;
    }
    // One statement snapshot; query count does not grow with material count. Aggregate each
    // source BEFORE joining, so duplicate WO lines cannot multiply FL/TL or receipt facts.
    const result = await tx.execute(sql`
      with planned as (
        select material_sku_id sku_id, sum(gross_req)::text gross
        from wo_lines where wo_id=${jg.woId} group by material_sku_id
      ), issued as (
        select l.sku_id, sum(l.qty)::text qty from fl_lines l join fl_docs d on d.id=l.fl_id
        where d.jg_id=${jgId} and d.status='completed' group by l.sku_id
      ), returned as (
        select l.sku_id, sum(l.qty)::text qty from tl_lines l join tl_docs d on d.id=l.tl_id
        where d.jg_id=${jgId} and d.status='completed' group by l.sku_id
      ), ids as (select sku_id from planned union select sku_id from issued union select sku_id from returned),
      receipts as (select id from sh_docs where source_type='jg' and source_id=${jgId} and status='completed'),
      checked as (
        select l.id, l.sku_id, q.pass_qty, q.concession_qty,
          q.id is not null and q.pass_qty>=0 and q.concession_qty>=0 and q.fail_qty>=0
            and q.pass_qty+q.concession_qty+q.fail_qty=l.actual_qty valid
        from receipts r join sh_lines l on l.sh_id=r.id
        left join qc_records c on c.sh_id=r.id
        left join qc_lines q on q.qc_id=c.id and q.sh_line_id=l.id
      )
      select (select qty::text from wo_docs where id=${jg.woId}) wo_qty,
        (select count(*)::int from receipts) completed_receipts,
        ((select count(*) from checked where not valid or sku_id<>${jg.productSkuId})
          +(select count(*) from receipts r where not exists(select 1 from sh_lines l where l.sh_id=r.id)))::int invalid_lines,
        (select coalesce(sum(pass_qty+concession_qty),0)::text from checked where valid and sku_id=${jg.productSkuId}) inbound,
        coalesce((select jsonb_agg(jsonb_build_object(
          'skuId',s.id,'code',s.code,'unit',s.base_uom,'gross',p.gross,
          'issued',coalesce(i.qty,'0'),'returned',coalesce(t.qty,'0')) order by s.id)
          from ids x join skus s on s.id=x.sku_id left join planned p on p.sku_id=x.sku_id
          left join issued i on i.sku_id=x.sku_id left join returned t on t.sku_id=x.sku_id),'[]'::jsonb) materials
    `);
    const facts = result.rows[0] as Facts;
    if (!facts.completed_receipts) return; // QC/approval alone is not inbound.
    const estimate = estimateInboundMaterials(facts.materials, facts.wo_qty, facts.invalid_lines ? null : facts.inbound);
    const fingerprint = createHash("sha256").update(JSON.stringify({ version: 2, jgId, facts })).digest("hex");
    const marker = `依据指纹 D33-b/v2:${fingerprint}`;
    const unknown = facts.invalid_lines > 0 || !facts.materials.length || estimate.some(line => line.delta === null);
    const needsReview = unknown || estimate.some(line => line.delta !== null && dCmp(line.delta, "0") !== 0);
    const finish = async (reviewItemId: number | null) => {
      if (receiptId == null) return;
      // Even no-difference/idempotent results need a durable success receipt. If this fails,
      // the estimate mutation also rolls back; committed stock is in a different transaction.
      await writeAudit(tx, { userId: actor.id, entity: "sh", entityId: receiptId, action: "material_review_checked",
        after: { jgId, fingerprint, reviewItemId, basisStatus: unknown ? "unknown" : needsReview ? "needs_review" : "no_difference" } });
    };
    const items: (typeof schema.reviewItems.$inferSelect)[] = await tx.select().from(schema.reviewItems)
      .where(and(eq(schema.reviewItems.category, "material_leftover"), eq(schema.reviewItems.refType, "jg"),
        or(eq(schema.reviewItems.refKey, String(jgId)), eq(schema.reviewItems.refKey, jg.docNo))))
      .orderBy(desc(schema.reviewItems.id)).for("update");
    // Identical facts must not recreate an item already decided by a human.
    const pending = items.find(item => item.status === "open");
    if ((pending ?? items[0])?.detail?.endsWith(marker)) return finish((pending ?? items[0]).id);
    if (!needsReview && !pending) return finish(null);
    const lines = estimate.map(line => `${line.code}（${line.unit}）：净发料 ${line.netIssued}；毛用量估算 ${line.expected ?? "未知"}；差额 ${line.delta ?? "未知"}${line.reason ? `；${line.reason}` : ""}`);
    const detail = [
      "这是生成时的估算快照，不是实盘或可退库存；差额不自动生成TL/FL，也不代表欠料必须补发。",
      `仅已完成SH的合格+让步接收（含备品/返工）；本JG ${facts.completed_receipts}张。${facts.invalid_lines ? `有${facts.invalid_lines}行检验/产品依据不完整，估算暂停。` : `累计入库 ${facts.inbound}。`}`,
      ...lines,
      ...(!facts.materials.length ? ["没有可核对的工单物料/发退料依据，请核对来源。"] : []),
      ...(!needsReview && pending ? ["当前估算无差额，原复核项仍由负责人核对关闭，不自动当作账实一致。"] : []),
      "下一步：PMC核对工单毛用量/单位和后续生产需求；仓管核对发退单与现场实物；若结算冻结，交财务核对纠错。实际退/补料仍走原审批、库存和冻结保护。",
      marker,
    ].join("\n");
    const values = { title: `【入库物料核对】${jg.docNo}`, detail, refKey: String(jgId) };
    const [item]: (typeof schema.reviewItems.$inferSelect)[] = pending
      ? await tx.update(schema.reviewItems).set(values).where(eq(schema.reviewItems.id, pending.id)).returning()
      : await tx.insert(schema.reviewItems).values({ ...values, category: "material_leftover", refType: "jg", status: "open" }).returning();
    await writeAudit(tx, { userId: actor.id, entity: "review_item", entityId: item.id,
      action: pending ? "material_estimate_refresh" : "material_estimate_create",
      before: pending ? { title: pending.title, detail: pending.detail, refKey: pending.refKey } : undefined,
      after: { ...values, jgId, fingerprint, formulaVersion: "D33-b/v2" } });
    await finish(item.id);
  });
}
