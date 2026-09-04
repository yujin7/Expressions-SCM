/**
 * C10 跨页在途草稿：**同一个 SKU 的补货缺口正在被另一页处理吗？**
 *
 * 事故形状（红队 C10）：`/replenish/move-or-buy` 起草的是**净额后**的 `residualBuyQty`
 * （先从别的仓挪过来，剩下的才买），可 `/replenish` 同一时刻仍然按**全额** `suggestQty` 下发建议，
 * `/report/transfer-suggest` 也不会把已经起草的调拨从可挪量里扣掉。
 * 于是计划员在一页起草了调拨、又在另一页起草了采购，**多订了整整一个调拨量**——
 * 两页各自都是对的，合起来是错的，而且谁也看不见对方。
 *
 * 本模块只做一件事：把两条起草路径**已经在飞、还没落地**的量按 SKU 取回来，
 * 让两页都能在行上说出「这个 SKU 另一页已经起草了 N 件，别重复下」。
 *
 * 边界（刻意保守）：
 * - **只提示，不自动净额**。草稿会被驳回、作废、改量，拿它去自动扣减建议量等于让一张
 *   随时可能消失的草稿改写判定口径；判断权留给人，系统负责把事实摆到眼前。
 * - 「在飞」= 未收口状态（draft/pending/approved/in_progress）。已完成的采购会变成未结供给
 *   （`core/supply.getOpenSupplyLines` 已经算进管道），已完成的调拨已经改变了在库，
 *   两者都已被引擎看见，再提示一次就是重复计数。
 * - 作废/驳回后的草稿状态回到 draft 或 void：void 不在名单里，draft 仍算在飞（它确实还挂着）。
 */
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import * as schema from "@/db/schema";
import { resolveDb, type AnyDb } from "@/server/core/svc";

/** 未收口 = 还会变成真实供给的状态；void / closed / completed 都不算在飞 */
export const IN_FLIGHT_DOC_STATUSES = ["draft", "pending", "approved", "in_progress"] as const;

export interface InFlightDrafts {
  /** 已起草、未收口的**采购**量（BH 备货申请，`/replenish` 与决策表的采购动作都落这里） */
  buyQty: number;
  buyDocs: number;
  /** 已起草、未收口的**调拨入库**量（DB 调拨单，调拨建议页与决策表的调拨动作都落这里） */
  transferQty: number;
  transferDocs: number;
}

export const EMPTY_IN_FLIGHT: InFlightDrafts = { buyQty: 0, buyDocs: 0, transferQty: 0, transferDocs: 0 };

/**
 * 行上的中文提示；两页共用同一句话，口径不会分叉。
 * `side` = 本页自己负责的那一侧，提示的是**另一侧**（本页自己的草稿本页看得见，不必再说一遍）。
 */
export function inFlightWarning(f: InFlightDrafts, side: "buy" | "transfer"): string | null {
  const other = side === "buy"
    ? (f.transferQty > 0 ? `已有 ${f.transferDocs} 张未收口的调拨单据在途，合计 ${f.transferQty} 件` : null)
    : (f.buyQty > 0 ? `已有 ${f.buyDocs} 张未收口的备货申请（BH）在途，合计 ${f.buyQty} 件` : null);
  if (!other) return null;
  return `${other}——${side === "buy" ? "先挪后买" : "补货"}页可能已经处理过这个缺口，`
    + "请核对后再下单，避免同一个缺口被两页各补一次（系统只提示，不自动扣减：草稿随时可能被驳回或改量）";
}

/** 按 SKU 取「另一页已经起草、尚未收口」的量。skuIds 为空返回空表。 */
export async function loadInFlightDrafts(dbArg: AnyDb, skuIds: number[]): Promise<Map<number, InFlightDrafts>> {
  const db = await resolveDb(dbArg);
  const ids = [...new Set(skuIds)].filter((n) => Number.isInteger(n) && n > 0);
  const out = new Map<number, InFlightDrafts>();
  if (ids.length === 0) return out;
  const statuses = [...IN_FLIGHT_DOC_STATUSES];

  const bump = (skuId: number): InFlightDrafts => {
    const cur = out.get(skuId) ?? { ...EMPTY_IN_FLIGHT };
    out.set(skuId, cur);
    return cur;
  };

  const buyRows: { skuId: number; qty: string | null; docs: number }[] = await db
    .select({
      skuId: schema.bhLines.skuId,
      qty: sql<string | null>`sum(${schema.bhLines.qty})`,
      docs: sql<number>`count(distinct ${schema.bhDocs.id})::int`,
    })
    .from(schema.bhLines)
    .innerJoin(schema.bhDocs, eq(schema.bhLines.bhId, schema.bhDocs.id))
    .where(and(inArray(schema.bhLines.skuId, ids), inArray(schema.bhDocs.status, statuses)))
    .groupBy(schema.bhLines.skuId);
  for (const r of buyRows) {
    const e = bump(r.skuId);
    e.buyQty = Number(r.qty ?? 0);
    e.buyDocs = r.docs;
  }

  /* 调拨只认**有转入仓**的行（to_warehouse_id 非空即调拨行；出库/期初单没有这一列）。
     取的是调拨量本身，即这个 SKU 已经被安排从别的仓挪过来多少。 */
  const transferRows: { skuId: number; qty: string | null; docs: number }[] = await db
    .select({
      skuId: schema.stockDocLines.skuId,
      qty: sql<string | null>`sum(${schema.stockDocLines.qty})`,
      docs: sql<number>`count(distinct ${schema.stockDocs.id})::int`,
    })
    .from(schema.stockDocLines)
    .innerJoin(schema.stockDocs, eq(schema.stockDocLines.stockDocId, schema.stockDocs.id))
    .where(and(
      inArray(schema.stockDocLines.skuId, ids),
      inArray(schema.stockDocs.status, statuses),
      eq(schema.stockDocs.subtype, "transfer"),
      isNotNull(schema.stockDocLines.toWarehouseId),
    ))
    .groupBy(schema.stockDocLines.skuId);
  for (const r of transferRows) {
    const e = bump(r.skuId);
    e.transferQty = Number(r.qty ?? 0);
    e.transferDocs = r.docs;
  }

  return out;
}
