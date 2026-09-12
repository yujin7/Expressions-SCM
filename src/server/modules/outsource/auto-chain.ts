/**
 * D33 自动链（spec/11 预演优先）：BH→自动WO草稿；到料齐套→自动JG批次草稿。
 * 铁律：自动只产【草稿】，审批永远人工；开关默认关（auto_wo_on_bh / auto_jg_on_ready）；
 * 幂等：WO 按 bhId 查重；JG 批次按 UNIQUE(woId,batchSeq)+建议量水位；
 * 护栏：批次≤8、成品 attrs.needsReview 非空不自动、钩子失败绝不阻断主流程（审计留痕）。
 * 供应商解析：OEM 归属参考（transit_refs kind='oem_map'）→ supplier_oem 别名。
 */
import { and, eq, inArray, or, sql } from "drizzle-orm";
import * as schema from "@/db/schema";
import { writeAudit } from "@/server/core/audit";
import { currentWriteActor } from "@/server/core/current-write-actor";
import { dAdd, dCmp, dQty } from "@/server/core/decimal";
import type { SessionUser } from "@/server/core/dto";
import { getMaterialReferenceLines } from "@/server/core/material-reference";
import { getNumParam } from "@/server/core/params";
import { batchAllowed, producibleQty, suggestBatchQty, MAX_AUTO_BATCHES } from "@/server/rules/kitting";
import { earliestKitDate, type KitBlocker } from "@/server/rules/kitting-atp";
import { supplierNewOrderBlock } from "@/server/rules/supplier-status";
import { getOnHandBySku } from "@/server/core/stock-view";
import { getOpenSupplyLines } from "@/server/core/supply";
import { nextDocNo } from "@/server/docflow/doc-no";
import { ApiError, todayShanghai } from "@/server/modules/master/common";
import { type AnyDb, requireAnyRole, resolveDb } from "./common";
import { getReceiptBatchReview } from "@/server/modules/matflow/receipt-batch-status";
import {
  capacityAuditSnapshot,
  getSupplierCapacitySignal,
} from "@/server/modules/report/supplier-capacity";

/* ── 预演 ── */

export interface BatchSuggestion {
  woId: number;
  woDocNo: string;
  productCode: string;
  productName: string;
  woQty: string;
  receivedBasis: { materialCode: string; received: string; perUnit: string }[];
  producible: string;
  /** E2-09 预计齐套日（YYYY-MM-DD）；null = 视野内齐不了 */
  kitDate: string | null;
  /** 卡住齐套的物料（最多 3 个，够定位不刷屏） */
  kitBlockers: KitBlocker[];
  /** 齐套判定说明（含诚实降级：无物料行 ≠ 已验证齐套） */
  kitNote: string;
  /** 旧台账旁证推演；只展示，绝不改变 producible/suggestQty/blockedReason。 */
  referenceKitDate: string | null;
  referenceKitNote: string;
  referenceEvidenceCount: number;
  referenceReservedQty: string;
  alreadyBatched: string;
  existingBatches: number;
  suggestQty: string;
  blockedReason: string | null; // 护栏命中说明；null=可生成
}

export interface WoSuggestion {
  bhId: number;
  bhDocNo: string;
  skuId: number;
  skuCode: string;
  qty: string;
  supplierId: number | null;
  supplierName: string | null;
  feeRatePlan: string | null;
  blockedReason: string | null;
}

async function previewBatches(db: AnyDb, woId?: number): Promise<BatchSuggestion[]> {
  /* JG 批次建议：approved/in_progress 且有 PO 的 WO */
  const woRows: {
    id: number; docNo: string; qty: string; productSkuId: number; status: string;
    productCode: string; productName: string; attrs: unknown; productActive: boolean; supplierStatus: string | null;
  }[] = await db
    .select({
      id: schema.woDocs.id,
      docNo: schema.woDocs.docNo,
      qty: schema.woDocs.qty,
      productSkuId: schema.woDocs.productSkuId,
      status: schema.woDocs.status,
      productCode: schema.skus.code,
      productName: schema.skus.name,
      attrs: schema.skus.attrs,
      productActive: schema.skus.active,
      supplierStatus: schema.suppliers.status,
    })
    .from(schema.woDocs)
    .innerJoin(schema.skus, eq(schema.woDocs.productSkuId, schema.skus.id))
    .leftJoin(schema.suppliers, eq(schema.woDocs.supplierId, schema.suppliers.id))
    .where(and(inArray(schema.woDocs.status, ["approved", "in_progress"]), woId == null ? undefined : eq(schema.woDocs.id, woId)));

  const batches: BatchSuggestion[] = [];
  for (const wo of woRows) {
    const lines: { materialSkuId: number; grossReq: string; materialCode: string }[] = await db
      .select({ materialSkuId: schema.woLines.materialSkuId, grossReq: sql<string>`sum(${schema.woLines.grossReq})`, materialCode: schema.skus.code })
      .from(schema.woLines)
      .innerJoin(schema.skus, eq(schema.woLines.materialSkuId, schema.skus.id))
      .where(eq(schema.woLines.woId, wo.id))
      .groupBy(schema.woLines.materialSkuId, schema.skus.code);
    if (lines.length === 0) continue;
    // 到料 = 本 WO 下 PO 行已收量（基础单位）
    const recv: { skuId: number; received: string }[] = await db
      .select({ skuId: schema.poLines.skuId, received: sql<string>`coalesce(sum(${schema.poLines.receivedQty}), '0')` })
      .from(schema.poLines)
      .innerJoin(schema.poDocs, eq(schema.poLines.poId, schema.poDocs.id))
      .where(eq(schema.poDocs.woId, wo.id))
      .groupBy(schema.poLines.skuId);
    const recvBySku = new Map(recv.map((r) => [r.skuId, r.received]));
    const kit = lines.map((l) => ({ materialSkuId: l.materialSkuId, grossReq: l.grossReq, netIssued: recvBySku.get(l.materialSkuId) ?? "0" }));
    const producible = producibleQty(wo.qty, kit);

    /* E2-09 齐套 ATP：producibleQty 只回答「现在够不够」，回答不了业务真正要问的
       「几号能齐套」。rules/kitting-atp 早已实现（逐日推演 + 木桶效应取各料 readyDate 最大值）
       却零生产调用方，交付日期这个问题在系统里一直没人回答。此处接上。
       物料到货走 core/supply 唯一权威（有确认到货日的才进推演，无日期的不臆造）。 */
    const materialIds = lines.map((l) => l.materialSkuId);
    const matOnHand = materialIds.length ? await getOnHandBySku(db, { skuIds: materialIds }) : null;
    const matSupply = materialIds.length ? await getOpenSupplyLines(db, materialIds) : [];
    const arrivalsByMat = new Map<number, { date: string; qty: string }[]>();
    for (const sl of matSupply) {
      if (!sl.expectDate || sl.qty <= 0) continue;
      const arr = arrivalsByMat.get(sl.skuId) ?? [];
      arr.push({ date: sl.expectDate, qty: String(sl.qty) });
      arrivalsByMat.set(sl.skuId, arr);
    }
    const kitAtp = earliestKitDate(
      lines.map((l) => ({
        materialSkuId: l.materialSkuId,
        /* grossReq **本身就是全单毛需求**（rules/kitting.ts:10 定义，且 :3 写明
           「毛单耗 = grossReq / woQty」——单耗是除出来的）。首版在此又乘了一遍 wo.qty，
           把需求放大 wo.qty 倍，齐套日必然算不出来；而我把那个「视野内无法齐套」
           误当成了功能生效的证据。此处直接用 grossReq。 */
        required: dQty(l.grossReq),
        /* 在库只取物料在库。首版还把本 WO 下 PO 已收量加了上去——收货已过账进仓，
           getOnHandBySku 本就包含它，相加即重复计入。 */
        onHand: String(matOnHand?.bySku.get(l.materialSkuId) ?? "0"),
        arrivals: arrivalsByMat.get(l.materialSkuId) ?? [],
      })),
      todayShanghai(),
    );
    /* 已关联旧包材台账只作第二条证据线：必须同时命中物料与本 WO 成品，未分配行不套用。
       pkg_stock 可能已被实时账覆盖，pkg_order 也可能与系统 PO 重叠，因此这条参考推演
       绝不能改变自动批次的可产量、建议量或阻断结果。 */
    const matchedReference = (await getMaterialReferenceLines(db, materialIds))
      .filter((line) => line.productSkuId === wo.productSkuId);
    const referenceByMaterial = new Map<number, typeof matchedReference>();
    for (const line of matchedReference) {
      const arr = referenceByMaterial.get(line.materialSkuId) ?? [];
      arr.push(line);
      referenceByMaterial.set(line.materialSkuId, arr);
    }
    const referenceReservedQty = dQty(
      matchedReference
        .filter((line) => line.source === "legacy_pkg_stock")
        .reduce((sum, line) => dAdd(sum, line.qty, 6), "0"),
    );
    const referenceAtp = matchedReference.length > 0
      ? earliestKitDate(
        lines.map((line) => {
          const refs = referenceByMaterial.get(line.materialSkuId) ?? [];
          const reserved = refs
            .filter((ref) => ref.source === "legacy_pkg_stock")
            .reduce((sum, ref) => dAdd(sum, ref.qty, 6), "0");
          return {
            materialSkuId: line.materialSkuId,
            required: dQty(line.grossReq),
            onHand: dAdd(String(matOnHand?.bySku.get(line.materialSkuId) ?? "0"), reserved, 6),
            arrivals: [
              ...(arrivalsByMat.get(line.materialSkuId) ?? []),
              ...refs
                .filter((ref) => ref.source === "legacy_pkg_order" && ref.expectDate != null)
                .map((ref) => ({ date: ref.expectDate!, qty: ref.qty })),
            ],
          };
        }),
        todayShanghai(),
      )
      : null;
    const jgs: { qty: string; status: string }[] = await db
      .select({ qty: schema.jgDocs.qty, status: schema.jgDocs.status })
      .from(schema.jgDocs)
      .where(eq(schema.jgDocs.woId, wo.id));
    const alreadyBatched = jgs.reduce((a, j) => dAdd(a, j.qty), "0");
    const hasDraft = jgs.some((j) => j.status === "draft" || j.status === "pending");
    // 订货倍数
    const [conv] = await db
      .select({ orderMultiple: schema.uomConvs.orderMultiple })
      .from(schema.uomConvs)
      .where(eq(schema.uomConvs.skuId, wo.productSkuId))
      .limit(1);
    const suggest = suggestBatchQty({
      producible,
      alreadyBatched,
      woQty: wo.qty,
      orderMultiple: conv?.orderMultiple ?? null,
    });
    const needsReview = Array.isArray((wo.attrs as { needsReview?: unknown[] } | null)?.needsReview)
      && ((wo.attrs as { needsReview: unknown[] }).needsReview.length > 0);
    let blockedReason: string | null = null;
    const supplierBlock = supplierNewOrderBlock(wo.supplierStatus);
    if (!wo.productActive) blockedReason = "成品已停用，不能生成新批次";
    else if (wo.supplierStatus == null) blockedReason = "加工厂不存在，请核对工单来源";
    else if (supplierBlock.blocked) blockedReason = supplierBlock.reason;
    else if (dCmp(suggest, "0") <= 0) blockedReason = dCmp(producible, alreadyBatched) <= 0 ? "到料尚不足新批（或已全部下批）" : "不足一个订货倍数";
    else if (!batchAllowed(jgs.length)) blockedReason = `批次已达上限 ${MAX_AUTO_BATCHES}，转人工`;
    else if (needsReview) blockedReason = "成品档案待复核（needsReview）——不自动，请人工核对后生成";
    else if (hasDraft) blockedReason = "已有待审批批次草稿——先处理再生成";
    if (dCmp(suggest, "0") > 0 || jgs.length > 0) {
      batches.push({
        woId: wo.id,
        woDocNo: wo.docNo,
        productCode: wo.productCode,
        productName: wo.productName,
        woQty: wo.qty,
        receivedBasis: lines.slice(0, 6).map((l) => ({
          materialCode: l.materialCode,
          received: recvBySku.get(l.materialSkuId) ?? "0",
          perUnit: dQty(l.grossReq),
        })),
        producible,
        /** E2-09：预计齐套日（null=视野内齐不了，blockers 说明卡在哪个料） */
        kitDate: kitAtp.kitDate,
        kitBlockers: kitAtp.blockers.slice(0, 3),
        kitNote: kitAtp.note,
        referenceKitDate: referenceAtp?.kitDate ?? null,
        referenceKitNote: referenceAtp
          ? `${referenceAtp.note}；仅叠加 ${matchedReference.length} 条旧流程包材旁证，可能与实时账/系统 PO 重叠，不驱动自动批次`
          : "无同时命中本工单成品与物料的旧流程包材旁证",
        referenceEvidenceCount: matchedReference.length,
        referenceReservedQty,
        alreadyBatched,
        existingBatches: jgs.length,
        suggestQty: suggest,
        blockedReason,
      });
    }
  }
  return batches;
}

export async function previewAutoChain(dbArg?: AnyDb): Promise<{ batches: BatchSuggestion[]; wos: WoSuggestion[] }> {
  const db = await resolveDb(dbArg);
  const batches = await previewBatches(db);

  /* 自动 WO 建议：approved BH 且尚无 WO */
  const bhs: { id: number; docNo: string }[] = await db
    .select({ id: schema.bhDocs.id, docNo: schema.bhDocs.docNo })
    .from(schema.bhDocs)
    .where(eq(schema.bhDocs.status, "approved"));
  const wosOut: WoSuggestion[] = [];
  for (const bh of bhs) {
    const [existWo] = await db.select({ id: schema.woDocs.id }).from(schema.woDocs).where(eq(schema.woDocs.bhId, bh.id));
    if (existWo) continue;
    const lines: { skuId: number; qty: string; code: string }[] = await db
      .select({ skuId: schema.bhLines.skuId, qty: schema.bhLines.qty, code: schema.skus.code })
      .from(schema.bhLines)
      .innerJoin(schema.skus, eq(schema.bhLines.skuId, schema.skus.id))
      .where(eq(schema.bhLines.bhId, bh.id));
    for (const l of lines) {
      // OEM 归属 → 供应商
      const [oem] = await db
        .select({ oemRaw: schema.transitRefs.oemRaw, supplierId: schema.transitRefs.supplierId })
        .from(schema.transitRefs)
        .where(and(eq(schema.transitRefs.kind, "oem_map"), eq(schema.transitRefs.skuCode, l.code)));
      let supplierId = oem?.supplierId ?? null;
      let supplierName: string | null = null;
      if (supplierId == null && oem?.oemRaw) {
        const [al] = await db
          .select({ targetId: schema.aliases.targetId })
          .from(schema.aliases)
          .where(and(eq(schema.aliases.aliasType, "supplier_oem"), eq(schema.aliases.rawValue, oem.oemRaw)));
        supplierId = al?.targetId ?? null;
      }
      if (supplierId != null) {
        const [sup] = await db.select({ name: schema.suppliers.name, status: schema.suppliers.status }).from(schema.suppliers).where(eq(schema.suppliers.id, supplierId));
        supplierName = sup?.name ?? null;
        // 黑名单 / 整改暂停都不能作为自动链的加工厂（与 createWo / generateDocs 同一条规则）
        const block = supplierNewOrderBlock(sup?.status);
        if (block.blocked) { supplierId = null; supplierName = `${supplierName}（${block.label}）`; }
      }
      // 计划加工费：feeref 最新
      let feeRatePlan: string | null = null;
      if (supplierId != null) {
        const [fr] = await db
          .select({ feeRate: schema.processingFeeRefs.feeRate })
          .from(schema.processingFeeRefs)
          .where(and(eq(schema.processingFeeRefs.skuId, l.skuId), eq(schema.processingFeeRefs.supplierId, supplierId)))
          .orderBy(sql`${schema.processingFeeRefs.effectiveDate} desc`)
          .limit(1);
        feeRatePlan = fr?.feeRate ?? null;
      }
      const [activeBom] = await db
        .select({ id: schema.boms.id })
        .from(schema.boms)
        .where(and(eq(schema.boms.productSkuId, l.skuId), eq(schema.boms.status, "active")));
      let blockedReason: string | null = null;
      if (!activeBom) blockedReason = "无生效 BOM";
      else if (supplierId == null) blockedReason = "OEM 归属未解析（在途参考·OEM 归属页补认）";
      else if (feeRatePlan == null || Number(feeRatePlan) <= 0) blockedReason = "无加工费参考价（加工费参考价页补录后自动可用）";
      wosOut.push({ bhId: bh.id, bhDocNo: bh.docNo, skuId: l.skuId, skuCode: l.code, qty: l.qty, supplierId, supplierName, feeRatePlan, blockedReason });
    }
  }
  return { batches, wos: wosOut };
}

/* ── 生成（人工点按或钩子调用；一律草稿） ── */

export async function createBatchJg(user: SessionUser, woId: number, dbArg?: AnyDb) {
  if (!Number.isSafeInteger(woId) || woId <= 0 || woId > 2147483647) throw new ApiError(400, "工单编号无效");
  const db = await resolveDb(dbArg);
  return db.transaction(async (tx: AnyDb) => {
    const actor = await currentWriteActor(tx, user);
    requireAnyRole(actor, "pmc");
    const result = await createBatchInTransaction(tx, actor, woId);
    if (!result.jg) throw new ApiError(409, result.blockedReason!);
    return result.jg;
  });
}

/** Shared current-state calculation; expected refusal returns before any draft write. */
async function createBatchInTransaction(tx: AnyDb, actor: SessionUser, woId: number, receiptPoId?: number): Promise<{
  jg: typeof schema.jgDocs.$inferSelect | null; blockedReason: string | null;
}> {
    // Serialize proposals for this WO before reading a new waterline. The unique
    // (woId,batchSeq) constraint remains the final boundary for legacy writers.
    const [wo] = await tx.select().from(schema.woDocs).where(eq(schema.woDocs.id, woId)).for("update");
    if (!wo) throw new ApiError(404, "工单不存在");
    // Receipt/return services lock PO before changing its received quantities.
    // Hold those rows through the calculation; lock in deterministic order.
    const purchaseSources: { id: number; woId: number | null }[] = await tx.select({ id: schema.poDocs.id, woId: schema.poDocs.woId }).from(schema.poDocs)
      .where(or(eq(schema.poDocs.woId, woId), receiptPoId == null ? undefined : eq(schema.poDocs.id, receiptPoId)))
      .orderBy(schema.poDocs.id).for("share");
    if (receiptPoId != null && purchaseSources.find(po => po.id === receiptPoId)?.woId !== woId) {
      throw new ApiError(409, "采购单工单来源已变化，请刷新核对；未生成批次");
    }
    if (!["approved", "in_progress"].includes(wo.status)) return { jg: null, blockedReason: "工单当前不允许生成批次，请刷新核对状态" };
    const existing: { batchSeq: number }[] = await tx.select({ batchSeq: schema.jgDocs.batchSeq }).from(schema.jgDocs)
      .where(eq(schema.jgDocs.woId, woId)).orderBy(schema.jgDocs.id).for("share");
    const [product] = await tx
      .select({ baseUom: schema.skus.baseUom })
      .from(schema.skus)
      .where(eq(schema.skus.id, wo.productSkuId)).for("share");
    if (!product) throw new ApiError(400, `成品 SKU 不存在: #${wo.productSkuId}`);
    await tx.select({ id: schema.suppliers.id }).from(schema.suppliers)
      .where(eq(schema.suppliers.id, wo.supplierId)).for("share");
    const [s] = await previewBatches(tx, woId);
    if (!s) return { jg: null, blockedReason: "该工单当前无可生成批次建议，请刷新核对到料与物料依据" };
    if (s.blockedReason) return { jg: null, blockedReason: s.blockedReason };
    const candidateQty = dQty(s.suggestQty);
    const capacity = await getSupplierCapacitySignal({
      supplierId: wo.supplierId,
      baseUom: product.baseUom,
      dueDate: wo.dueDate,
      candidateQty,
    }, tx);
    const docNo = await nextDocNo(tx, "JG");
    const [jg] = await tx
      .insert(schema.jgDocs)
      .values({
        docNo,
        woId,
        batchSeq: Math.max(0, ...existing.map((j) => j.batchSeq)) + 1,
        supplierId: wo.supplierId,
        productSkuId: wo.productSkuId,
        qty: candidateQty,
        dueDate: wo.dueDate,
        feeRateCurrent: wo.feeRatePlan,
        orderType: wo.orderType,
        createdBy: actor.id,
      })
      .returning();
    await tx.insert(schema.jgFeeSegments).values({ jgId: jg.id, rate: jg.feeRateCurrent, effectiveFrom: new Date() });
    await writeAudit(tx, {
      userId: actor.id, entity: "auto_chain", entityId: jg.id, action: "batch_jg",
      after: {
        woId,
        docNo,
        batchSeq: jg.batchSeq,
        qty: s.suggestQty,
        producible: s.producible,
        capacity: capacityAuditSnapshot(capacity),
      },
    });
    return { jg, blockedReason: null };
}

/** Receipt intent + current PMC authority + WO aggregate lock + atomic result. No stock writes. */
export async function checkBatchAfterPoReceipt(user: SessionUser, shId: number, dbArg?: AnyDb) {
  if (!Number.isSafeInteger(shId) || shId <= 0 || shId > 2147483647) throw new ApiError(400, "收货单编号无效");
  const db = await resolveDb(dbArg);
  return db.transaction(async (tx: AnyDb) => {
    const actor = await currentWriteActor(tx, user);
    requireAnyRole(actor, "pmc");
    // Same-SH retries serialize here. Different SH for one WO serialize in the shared writer.
    const [sh] = await tx.select().from(schema.shDocs).where(eq(schema.shDocs.id, shId)).for("update");
    if (!sh) throw new ApiError(404, "收货单不存在");
    const review = await getReceiptBatchReview(tx, shId);
    if (!review) throw new ApiError(409, "该收货单没有可恢复的采购入库建批请求；请核对来源和入库时开关记录");
    if (review.state !== "pending") return review;
    const result = await createBatchInTransaction(tx, actor, review.woId, sh.sourceId);
    const after = { requestId: review.requestId, woId: review.woId,
      state: result.jg ? "created" as const : "not_generated" as const,
      jgId: result.jg?.id ?? null, docNo: result.jg?.docNo ?? null, reason: result.blockedReason };
    await writeAudit(tx, { userId: actor.id, entity: "sh", entityId: shId, action: "receipt_batch_checked", after });
    return (await getReceiptBatchReview(tx, shId))!;
  });
}

/* ── 钩子（失败绝不阻断主流程） ── */

export async function hookAfterBhApprove(user: SessionUser, bhId: number, dbArg?: AnyDb): Promise<void> {
  try {
    const db = await resolveDb(dbArg);
    if ((await getNumParam("auto_wo_on_bh", 0, db)) !== 1) return;
    const { wos } = await previewAutoChain(db);
    const mine = wos.filter((w) => w.bhId === bhId && !w.blockedReason && w.supplierId != null && w.feeRatePlan != null);
    for (const w of mine) {
      const { createWo } = await import("./wo");
      await createWo(user, {
        productSkuId: w.skuId,
        supplierId: w.supplierId,
        qty: Number(w.qty),
        feeRatePlan: Number(w.feeRatePlan ?? 0),
        bhId: w.bhId,
        remark: `自动生成（D33 auto_wo_on_bh；来源 ${w.bhDocNo}）`,
      }, db);
    }
    if (mine.length > 0) {
      await writeAudit(db, { userId: user.id, entity: "auto_chain", action: "auto_wo", after: { bhId, count: mine.length } });
    }
  } catch (e) {
    try {
      const db = await resolveDb(dbArg);
      await writeAudit(db, { userId: user.id, entity: "auto_chain", action: "auto_wo_failed", after: { bhId, error: String(e).slice(0, 300) } });
    } catch { /* 钩子留痕失败亦不阻断 */ }
  }
}
