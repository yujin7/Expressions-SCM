/** Current factory observations, not a second global-stock authority or a reservation engine. */
import { sql } from "drizzle-orm";
import type { SessionUser } from "@/server/core/dto";
import { todayShanghai } from "@/server/core/business-day";
import { ApiError } from "@/server/modules/master/common";
import { type AnyDb, requireAnyRole, resolveDb } from "./common";

export interface KitFactoryEvidence {
  woId: number; woDocNo: string; woVersion: number; observedAt: string; businessDate: string;
  supplierId: number; supplierName: string;
  allocationStatus: "unverified";
  warehouses: { id: number; code: string; name: string; active: boolean }[];
  materials: {
    skuId: number; code: string; name: string | null; unit: string; required: string;
    factoryOnHand: string | null;
    warehouses: {
      warehouseId: number; onHand: string; expired: string; unidentifiedBatch: string;
      undatedBatch: string; quarantine: string;
    }[];
    peers: { id: number; docNo: string; paused: boolean; required: string }[];
  }[];
}

/** One SQL snapshot; no joins between balance and bin grains that could multiply quantities.
 * Empty factory mapping is unknown, not zero. Negative OEM balances remain visible.
 * Expired, unidentifiable, undated and quarantine observations can overlap: never subtract/add
 * these columns into an invented available quantity. Physical bin location is NOT WO allocation.
 */
export async function getKitFactoryEvidence(user: SessionUser, woId: number, dbArg?: AnyDb): Promise<KitFactoryEvidence> {
  requireAnyRole(user, "pmc"); // Same read audience as the auto-chain preview; no financial fields.
  if (!Number.isSafeInteger(woId) || woId <= 0 || woId > 2_147_483_647) throw new ApiError(400, "无效的工单ID");
  const db = await resolveDb(dbArg);
  const day = todayShanghai();
  const result = await db.execute(sql`
    with target as (select w.id,w.doc_no,w.version,w.supplier_id,s.name supplier_name
      from wo_docs w join suppliers s on s.id=w.supplier_id where w.id=${woId}),
    materials as (select l.material_sku_id sku_id,sum(l.gross_req)::text required
      from wo_lines l join target t on t.id=l.wo_id group by l.material_sku_id),
    factory as (select w.id,w.code,w.name,w.active from warehouses w join target t on t.supplier_id=w.supplier_id
      where w.kind='outsource' and w.accounting_mode='realtime'),
    stocks as (select b.sku_id,b.warehouse_id,sum(b.qty)::text on_hand,
      coalesce(sum(greatest(b.qty,0)) filter(where lot.sku_id=b.sku_id and lot.expiry_date<${day}::date),0)::text expired,
      coalesce(sum(greatest(b.qty,0)) filter(where lot.id is null or lot.sku_id<>b.sku_id),0)::text unidentified,
      coalesce(sum(greatest(b.qty,0)) filter(where lot.sku_id=b.sku_id and lot.expiry_date is null),0)::text undated
      from stock_balances b join factory f on f.id=b.warehouse_id join materials m on m.sku_id=b.sku_id
      left join batches lot on lot.id=b.batch_id group by b.sku_id,b.warehouse_id),
    held as (select b.sku_id,bin.warehouse_id,sum(b.qty)::text qty
      from bin_balances b join bins bin on bin.id=b.bin_id
      join factory f on f.id=bin.warehouse_id join materials m on m.sku_id=b.sku_id
      where bin.kind='quarantine' group by b.sku_id,bin.warehouse_id),
    peers as (select l.material_sku_id sku_id,w.id,w.doc_no,w.is_paused,sum(l.gross_req)::text required
      from wo_docs w join target t on t.supplier_id=w.supplier_id and t.id<>w.id
      join wo_lines l on l.wo_id=w.id join materials m on m.sku_id=l.material_sku_id
      where w.status in ('approved','in_progress')
      group by l.material_sku_id,w.id,w.doc_no,w.is_paused)
    select jsonb_build_object('woId',t.id,'woDocNo',t.doc_no,'woVersion',t.version,
      'observedAt',statement_timestamp(),'businessDate',${day}::text,'supplierId',t.supplier_id,'supplierName',t.supplier_name,
      'allocationStatus','unverified',
      'warehouses',coalesce((select jsonb_agg(jsonb_build_object('id',f.id,'code',f.code,'name',f.name,'active',f.active) order by f.id) from factory f),'[]'::jsonb),
      'materials',coalesce((select jsonb_agg(jsonb_build_object(
        'skuId',s.id,'code',s.code,'name',s.name,'unit',s.base_uom,'required',m.required,
        'factoryOnHand',case when exists(select 1 from factory) then coalesce((select sum(x.on_hand::numeric)::text from stocks x where x.sku_id=m.sku_id),'0') else null end,
        'warehouses',coalesce((select jsonb_agg(jsonb_build_object('warehouseId',f.id,
          'onHand',coalesce(x.on_hand,'0'),'expired',coalesce(x.expired,'0'),
          'unidentifiedBatch',coalesce(x.unidentified,'0'),'undatedBatch',coalesce(x.undated,'0'),
          'quarantine',coalesce(h.qty,'0')) order by f.id)
          from factory f left join stocks x on x.warehouse_id=f.id and x.sku_id=m.sku_id
          left join held h on h.warehouse_id=f.id and h.sku_id=m.sku_id),'[]'::jsonb),
        'peers',coalesce((select jsonb_agg(jsonb_build_object('id',p.id,'docNo',p.doc_no,'paused',p.is_paused,'required',p.required) order by p.id)
          from peers p where p.sku_id=m.sku_id),'[]'::jsonb)
      ) order by s.id) from materials m join skus s on s.id=m.sku_id),'[]'::jsonb)) evidence from target t
  `);
  const evidence = (result.rows[0] as { evidence: KitFactoryEvidence } | undefined)?.evidence;
  if (!evidence) throw new ApiError(404, "工单或加工厂不存在，请核对来源");
  return evidence;
}
