import { and, desc, eq, inArray, or } from "drizzle-orm";
import { approvals, jgDocs, shDocs, shLines, skus, stockLedger, suppliers, woDocs } from "@/db/schema";
import { dCmp } from "@/server/core/decimal";
import { type AnyDb, resolveDb } from "@/server/core/svc";
import { processingDays, quantityMilestones, type CycleEvent } from "@/server/rules/processing-cycle";

export interface ProcessingCycleRow {
  woId: number; woNo: string; status: string; orderType: string | null;
  supplierId: number; supplierName: string; skuCode: string; skuName: string; baseUom: string; orderQty: string;
  approvedAt: string | null; firstReceiptAt: string | null; normalFullAt: string | null; acceptedFullAt: string | null;
  firstReceiptDays: number | null; acceptedDays: number | null; acceptedQty: string;
  eligible: boolean; within20Days: boolean | null; issues: string[];
  jgNos: string[]; shNos: string[]; fullShNos: string[];
}
export interface ProcessingCycles {
  rows: ProcessingCycleRow[];
  summary: { orders: number; repeats: number; unclassified: number; validRepeats: number; within20: number; unresolvedRepeats: number };
}
type Order = Pick<ProcessingCycleRow, "woId" | "woNo" | "status" | "orderType" | "supplierId" | "supplierName" | "skuCode" | "skuName" | "baseUom" | "orderQty"> & { skuId: number };
interface Job { id: number; woId: number; docNo: string; skuId: number; supplierId: number; orderType: string | null; status: string }
interface Receipt { id: number; docNo: string; jgId: number; status: string; at: Date; warehouseId: number; lineId: number; skuId: number; type: string; qty: string }
interface Ledger { sourceDocId: number; action: string; sourceDocType: string; lineId: number; skuId: number; warehouseId: number; qty: string; at: Date }

/** Read-only evidence, never an automatic normalLeadDays update. One independent WO, not one JG/SH line. */
export async function listProcessingCycles(opts: { supplierId?: number } = {}, dbArg?: AnyDb): Promise<ProcessingCycles> {
  const db = await resolveDb(dbArg);
  return db.transaction(async (tx: AnyDb) => {
    const orders: Order[] = await tx.select({ woId: woDocs.id, woNo: woDocs.docNo, status: woDocs.status, orderType: woDocs.orderType,
      supplierId: woDocs.supplierId, supplierName: suppliers.name, skuId: woDocs.productSkuId,
      skuCode: skus.code, skuName: skus.name, baseUom: skus.baseUom, orderQty: woDocs.qty })
      .from(woDocs).innerJoin(suppliers, eq(suppliers.id, woDocs.supplierId)).innerJoin(skus, eq(skus.id, woDocs.productSkuId))
      .where(and(inArray(woDocs.status, ["approved", "in_progress", "completed", "closed"]),
        opts.supplierId ? eq(woDocs.supplierId, opts.supplierId) : undefined)).orderBy(desc(woDocs.id));
    const empty = { orders: 0, repeats: 0, unclassified: 0, validRepeats: 0, within20: 0, unresolvedRepeats: 0 };
    if (!orders.length) return { rows: [], summary: empty };
    const ids = orders.map(o => o.woId);
    const approvalRows: { woId: number; cycle: number; at: Date }[] = await tx.select({ woId: approvals.docId, cycle: approvals.cycle, at: approvals.createdAt })
      .from(approvals).where(and(eq(approvals.docType, "wo"), inArray(approvals.docId, ids), eq(approvals.action, "approve")))
      .orderBy(desc(approvals.cycle), desc(approvals.createdAt));
    const approved = new Map<number, string>();
    for (const a of approvalRows) if (!approved.has(a.woId)) approved.set(a.woId, a.at.toISOString());
    const jobs: Job[] = await tx.select({ id: jgDocs.id, woId: jgDocs.woId, docNo: jgDocs.docNo, skuId: jgDocs.productSkuId,
      supplierId: jgDocs.supplierId, orderType: jgDocs.orderType, status: jgDocs.status }).from(jgDocs)
      .where(and(inArray(jgDocs.woId, ids), inArray(jgDocs.status, ["approved", "in_progress", "completed", "closed"])));
    const jobIds = jobs.map(j => j.id);
    const receipts: Receipt[] = jobIds.length ? await tx.select({ id: shDocs.id, docNo: shDocs.docNo, jgId: shDocs.sourceId,
      status: shDocs.status, at: shDocs.createdAt, warehouseId: shDocs.warehouseId,
      lineId: shLines.id, skuId: shLines.skuId, type: shLines.lineType, qty: shLines.actualQty })
      .from(shDocs).innerJoin(shLines, eq(shLines.shId, shDocs.id)).where(and(eq(shDocs.sourceType, "jg"),
        inArray(shDocs.sourceId, jobIds))) : [];
    const shIds = [...new Set(receipts.map(s => s.id))];
    const ledgers: Ledger[] = shIds.length ? await tx.select({ sourceDocId: stockLedger.sourceDocId, action: stockLedger.action,
      sourceDocType: stockLedger.sourceDocType, lineId: stockLedger.sourceLineId, skuId: stockLedger.skuId,
      warehouseId: stockLedger.warehouseId, qty: stockLedger.qtyDelta, at: stockLedger.occurredAt })
      .from(stockLedger).where(or(
        and(eq(stockLedger.sourceDocType, "sh_outsource_in"), eq(stockLedger.action, "post"), inArray(stockLedger.sourceDocId, shIds)),
        and(eq(stockLedger.sourceDocType, "stock_doc"), inArray(stockLedger.action, shIds.map(id => `reverse:sh_outsource_in#${id}`))),
      )) : [];
    const jobMap = new Map(jobs.map(j => [j.id, j]));
    const receiptMap = new Map(receipts.map(s => [s.lineId, s]));
    const normal = new Map<number, CycleEvent[]>(), accepted = new Map<number, CycleEvent[]>();
    const issues = new Map<number, Set<string>>();
    const ordersById = new Map(orders.map(o => [o.woId, o]));
    const mark = (id: number, issue: string) => { const set = issues.get(id) ?? new Set<string>(); set.add(issue); issues.set(id, set); };
    for (const job of jobs) {
      const order = ordersById.get(job.woId)!;
      if (job.skuId !== order.skuId || job.supplierId !== order.supplierId ||
        (job.orderType !== null && job.orderType !== order.orderType)) mark(order.woId, "加工单与工单身份冲突");
      if (job.status === "closed") mark(order.woId, "含短关加工单，须人工核实完整交付");
    }
    for (const s of receipts) {
      const woId = jobMap.get(s.jgId)!.woId, order = ordersById.get(woId)!;
      if (!["approved", "in_progress", "completed"].includes(s.status)) continue;
      if (s.skuId !== order.skuId) { mark(woId, "收货成品不符"); continue; }
      if (s.type !== "normal" || dCmp(s.qty, "0") <= 0) continue;
      const events = normal.get(woId) ?? []; events.push({ at: s.at.toISOString(), qty: s.qty, docNo: s.docNo }); normal.set(woId, events);
    }
    const receiptsByDoc = new Map(receipts.map(s => [s.id, s]));
    for (const l of ledgers) {
      // Negative source lines are material consumption, not finished output; spare_in is never selected.
      if (l.lineId <= 0) continue;
      const sourceId = l.sourceDocType === "sh_outsource_in" ? l.sourceDocId : Number(l.action.split("#")[1]);
      const s = receiptMap.get(l.lineId);
      if (!s) {
        const parent = receiptsByDoc.get(sourceId);
        if (parent) mark(jobMap.get(parent.jgId)!.woId, "入库流水缺对应收货行");
        continue;
      }
      const woId = jobMap.get(s.jgId)!.woId, order = ordersById.get(woId)!;
      if (s.id !== sourceId || s.warehouseId !== l.warehouseId || s.skuId !== l.skuId || l.skuId !== order.skuId) {
        mark(woId, "入库流水与收货身份不符"); continue;
      }
      if (s.type === "spare") continue;
      if (s.status !== "completed") { mark(woId, "未完成收货存在入库流水"); continue; }
      if (dCmp(s.qty, "0") <= 0) { mark(woId, "非正收货行存在入库流水"); continue; }
      const events = accepted.get(woId) ?? []; events.push({ at: l.at.toISOString(), qty: l.qty, docNo: s.docNo }); accepted.set(woId, events);
    }
    // A completed positive receipt may be entirely rejected. No ledger alone is not proof of corruption.
    const jobsByWo = new Map<number, typeof jobs>(), receiptsByWo = new Map<number, typeof receipts>();
    for (const j of jobs) { const list = jobsByWo.get(j.woId) ?? []; list.push(j); jobsByWo.set(j.woId, list); }
    for (const s of receipts) { const id = jobMap.get(s.jgId)!.woId, list = receiptsByWo.get(id) ?? []; list.push(s); receiptsByWo.set(id, list); }
    const asOf = Date.now();
    const rows: ProcessingCycleRow[] = orders.map(order => {
      const ownJobs = jobsByWo.get(order.woId) ?? [];
      const ownReceipts = receiptsByWo.get(order.woId) ?? [];
      const n = quantityMilestones(order.orderQty, normal.get(order.woId) ?? []);
      const a = quantityMilestones(order.orderQty, accepted.get(order.woId) ?? []);
      const approvedAt = approved.get(order.woId) ?? null;
      const firstReceiptDays = processingDays(approvedAt, n.firstAt);
      const days = processingDays(approvedAt, a.fullAt);
      if (!approvedAt) mark(order.woId, "缺工单审批时点");
      if (!ownJobs.length) mark(order.woId, "尚无生效加工单");
      if (!n.firstAt) mark(order.woId, "尚无正常正数量收货");
      if (!a.fullAt) mark(order.woId, "尚无全量合格/让步净入库证据");
      if (order.status === "closed") mark(order.woId, "工单已短关，不作完整交付样本");
      if (n.invalid || a.invalid) mark(order.woId, "数量或流水顺序异常");
      const allEvents = [...normal.get(order.woId) ?? [], ...accepted.get(order.woId) ?? []];
      if (approvedAt && allEvents.some(e => processingDays(approvedAt, e.at) === null)) mark(order.woId, "收货/入库早于工单审批");
      if ((approvedAt && Date.parse(approvedAt) > asOf) || allEvents.some(e => Date.parse(e.at) > asOf)) mark(order.woId, "存在未来时点，暂不评估");
      const rowIssues = [...issues.get(order.woId) ?? []];
      const eligible = days !== null && rowIssues.length === 0;
      return { woId: order.woId, woNo: order.woNo, status: order.status, orderType: order.orderType,
        supplierId: order.supplierId, supplierName: order.supplierName, skuCode: order.skuCode, skuName: order.skuName,
        baseUom: order.baseUom, orderQty: order.orderQty, approvedAt, firstReceiptAt: n.firstAt, normalFullAt: n.fullAt,
        acceptedFullAt: a.fullAt, firstReceiptDays, acceptedDays: eligible ? days : null, acceptedQty: a.qty,
        eligible, within20Days: order.orderType === "repeat" && eligible ? days! <= 20 : null,
        issues: rowIssues, jgNos: ownJobs.map(j => j.docNo), shNos: [...new Set(ownReceipts.map(s => s.docNo))], fullShNos: a.fullDocs };
    });
    const repeats = rows.filter(r => r.orderType === "repeat");
    return { rows, summary: { orders: rows.length, repeats: repeats.length, unclassified: rows.filter(r => !r.orderType).length,
      validRepeats: repeats.filter(r => r.eligible).length, within20: repeats.filter(r => r.within20Days === true).length,
      unresolvedRepeats: repeats.filter(r => !r.eligible).length } };
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}
