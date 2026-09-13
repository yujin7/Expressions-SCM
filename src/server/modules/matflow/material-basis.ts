import { sql } from "drizzle-orm";
import type { JgMaterialBasis } from "@/lib/matflow-basis";
import type { SessionUser } from "@/server/core/dto";
import { ApiError } from "@/server/modules/master/common";
import { requireAnyRole, resolveDb, type AnyDb } from "@/server/modules/outsource/common";
import { ACTIVE_DOC_STATUSES } from "./common-notes";

/** One statement snapshot; documents are evidence, not allocations. Approval rechecks latest facts. */
export async function getJgMaterialBasis(user: SessionUser, jgId: number, dbArg?: AnyDb): Promise<JgMaterialBasis> {
  requireAnyRole(user, "warehouse");
  if (!Number.isSafeInteger(jgId) || jgId <= 0 || jgId > 2_147_483_647) throw new ApiError(400, "无效的加工单ID");
  const db = await resolveDb(dbArg);
  const active = sql.join(ACTIVE_DOC_STATUSES.map(status => sql`${status}`), sql`, `);
  const result = await db.execute(sql`
    with target as (select id,wo_id,supplier_id from jg_docs where id=${jgId}),
    requirements as (select l.material_sku_id sku_id,sum(l.gross_req) qty from wo_lines l
      join target t on t.wo_id=l.wo_id group by l.material_sku_id),
    documents as (
      select 'fl' kind,d.id,d.doc_no,d.status from fl_docs d join target t on t.id=d.jg_id
      union all select 'tl',d.id,d.doc_no,d.status from tl_docs d join target t on t.id=d.jg_id),
    movements as (
      select d.kind,d.status,l.sku_id,l.qty from documents d join fl_lines l on d.kind='fl' and l.fl_id=d.id
      union all select d.kind,d.status,l.sku_id,l.qty from documents d join tl_lines l on d.kind='tl' and l.tl_id=d.id),
    totals as (select sku_id,
      coalesce(sum(qty) filter(where kind='fl' and status in (${active})),0) issued,
      coalesce(sum(qty) filter(where kind='tl' and status in (${active})),0) returned,
      coalesce(sum(qty) filter(where kind='fl' and status='draft'),0) draft_issue,
      coalesce(sum(qty) filter(where kind='fl' and status='pending'),0) pending_issue,
      coalesce(sum(qty) filter(where kind='tl' and status='draft'),0) draft_return,
      coalesce(sum(qty) filter(where kind='tl' and status='pending'),0) pending_return
      from movements where status in (${active},'draft','pending') group by sku_id),
    material_ids as (select sku_id from requirements union select sku_id from totals)
    select jsonb_build_object('jgId',t.id,'woId',t.wo_id,'supplierId',t.supplier_id,'observedAt',statement_timestamp(),
      'openDocuments',coalesce((select jsonb_agg(jsonb_build_object('kind',d.kind,'id',d.id,'docNo',d.doc_no,'status',d.status)
        order by d.kind,d.id) from documents d where d.status in ('draft','pending')),'[]'::jsonb),
      'lines',coalesce((select jsonb_agg(jsonb_build_object('materialSkuId',s.id,'skuCode',s.code,'skuName',s.name,'baseUom',s.base_uom,
        'grossReq',coalesce(r.qty,0)::text,'issuedQty',coalesce(m.issued,0)::text,'returnedQty',coalesce(m.returned,0)::text,
        'draftIssueQty',coalesce(m.draft_issue,0)::text,'pendingIssueQty',coalesce(m.pending_issue,0)::text,
        'draftReturnQty',coalesce(m.draft_return,0)::text,'pendingReturnQty',coalesce(m.pending_return,0)::text,
        'suggestedIssueQty',case when coalesce(m.draft_issue,0)>0 or coalesce(m.pending_issue,0)>0 then '0'
          else greatest(coalesce(r.qty,0)-coalesce(m.issued,0),0)::text end
      ) order by s.code,s.id) from material_ids i join skus s on s.id=i.sku_id
        left join requirements r on r.sku_id=i.sku_id left join totals m on m.sku_id=i.sku_id),'[]'::jsonb)) basis from target t
  `);
  const basis = (result.rows[0] as { basis: JgMaterialBasis } | undefined)?.basis;
  if (!basis) throw new ApiError(404, "加工通知单不存在");
  return basis;
}
