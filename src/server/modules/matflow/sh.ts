import { and, eq, inArray, ne, sql } from "drizzle-orm";
import {
   jgDocs, offsetPools, poDocs, poLines, qcLines, qcRecords,
  shDocs, shLines, warehouses, woLines,
} from "@/db/schema";
import { dAdd, dCmp, dDiv, dMul, dNeg, dQty, dSub, dZero } from "@/server/core/decimal";
import type { SessionUser } from "@/server/core/dto";
import { writeAudit } from "@/server/core/audit";
import { registerBatchesFromReceipt, requireBatchForExpirySkus } from "@/server/modules/inventory/batch-trace";
import {
  expandOutboundLinesForBatchPosting,
  isBatchPostingEnabled,
} from "@/server/modules/inventory/batch-allocation";
import { approveDoc } from "@/server/docflow/approval";
import { nextDocNo } from "@/server/docflow/doc-no";
import { nextStatus } from "@/server/docflow/state";
import { post, PostingError, type PostingLine } from "@/server/posting";
import { ApiError } from "@/server/modules/master/common";
import {
  type AnyDb, requireAnyRole, resolveDb, rethrowApproval,
} from "@/server/modules/outsource/common";
import { approveDocSchema } from "@/server/modules/outsource/schemas";
import {
  ACTIVE_DOC_STATUSES, completeApprovedDoc, getGlobalParam, getJgForMatflow,
  getOutsourceWarehouseOf, requireRealtimeWarehouse,
} from "./common-notes";
import { createQcSchema, createShSchema } from "./schemas";
import { lockPurchaseReceipt, resolvePurchaseReceiptLine } from "./purchase-receipt-lock";
import { currentWriteActor as currentMatflowActor } from "@/server/core/current-write-actor";

/**
 * 收货单 SH + 检验 QC + 入库确认（《01》§3/§4，《02》§3 关键校验）。
 * - 分次收货；行类型 normal（占累计）/ rework（返工重交，冲抵原不合格，不占累计）/ spare（备品，不占 JG 数量）。
 * - 累计校验（jg 源）：Σ正常行实收 ≤ JG数量 − Σ已判不合格 + 超收容差（sys_param over_receive_tolerance_pct）。
 * - 审批仅置 approved——检验前不入库；QC 一单一检；confirmInbound 才过账：
 *   jg 源 → sh_outsource_in（成品仓 +合格+让步；委外仓 −净标准用量×(合格+让步+备品)）+ spare_in（备品零成本+对冲池）；
 *   po 源 → sh_purchase_in（仓库 +合格+让步）+ po_line.receivedQty 累加（全收自动完成 PO）。
 */

type ShRow = typeof shDocs.$inferSelect;
type ShLineRow = typeof shLines.$inferSelect;
type QcRecordRow = typeof qcRecords.$inferSelect;

const NON_SPARE_TYPES = ["normal", "rework"] as const;

// ---------- 累计校验（《02》§3：分母 = JG数量 − 已判不合格 + 容差） ----------

/**
 * SH审批改变正常累计，QC改变不合格分母：两者都在本单SH锁后锁共同JG，
 * 直到各自事务提交。不能仅锁SH，也不能用可并行的FOR SHARE保护累计。
 * 这里只保源存在；已批SH的检验事实不因JG后来关闭而禁止登记。
 */
async function lockJgReceiptAggregate(tx: AnyDb, jgId: number): Promise<void> {
  const [jg]: { id: number }[] = await tx.select({ id: jgDocs.id }).from(jgDocs).where(eq(jgDocs.id, jgId)).for("update");
  if (!jg) throw new ApiError(500, `收货单挂空 JG: #${jgId}`);
}

/**
 * jg 源 SH 的累计口径（excludeShId=排除审批中的本单）：
 * normalCum = 已生效 SH 正常行实收合计；failCum = 已检 SH（正常+返工行）不合格合计。
 */
async function jgReceiptCum(
  db: AnyDb,
  jgId: number,
  excludeShId?: number,
): Promise<{ normalCum: string; failCum: string }> {
  const docConds = [
    eq(shDocs.sourceType, "jg"),
    eq(shDocs.sourceId, jgId),
    inArray(shDocs.status, [...ACTIVE_DOC_STATUSES]),
  ];
  if (excludeShId != null) docConds.push(ne(shDocs.id, excludeShId));
  const normalRows: { qty: string }[] = await db
    .select({ qty: shLines.actualQty })
    .from(shLines)
    .innerJoin(shDocs, eq(shLines.shId, shDocs.id))
    .where(and(...docConds, eq(shLines.lineType, "normal")));
  let normalCum = "0";
  for (const r of normalRows) normalCum = dAdd(normalCum, r.qty);

  // 已判不合格：该 JG 全部 SH 的 QC 行（备品行不占 JG 数量，不入分母）
  const failRows: { failQty: string }[] = await db
    .select({ failQty: qcLines.failQty })
    .from(qcLines)
    .innerJoin(qcRecords, eq(qcLines.qcId, qcRecords.id))
    .innerJoin(shDocs, eq(qcRecords.shId, shDocs.id))
    .innerJoin(shLines, eq(qcLines.shLineId, shLines.id))
    .where(and(
      eq(shDocs.sourceType, "jg"),
      eq(shDocs.sourceId, jgId),
      inArray(shLines.lineType, [...NON_SPARE_TYPES]),
    ));
  let failCum = "0";
  for (const r of failRows) failCum = dAdd(failCum, r.failQty);
  return { normalCum, failCum };
}

/** 累计校验；违反抛 409。thisNormal=本单正常行实收合计。 */
async function assertJgReceiptWithinCap(
  db: AnyDb,
  jg: typeof jgDocs.$inferSelect,
  thisNormal: string,
  excludeShId?: number,
): Promise<void> {
  if (dZero(thisNormal)) return; // 纯返工/备品单不占累计
  const { normalCum, failCum } = await jgReceiptCum(db, jg.id, excludeShId);
  const tolPct = await getGlobalParam(db, "over_receive_tolerance_pct", "0");
  const tolerance = dMul(jg.qty, dDiv(tolPct, "100", 6));
  const cap = dAdd(dSub(jg.qty, failCum), tolerance);
  const total = dAdd(normalCum, thisNormal);
  if (dCmp(total, cap) > 0) {
    throw new ApiError(
      409,
      `累计收货超限：正常行累计 ${total} > 上限 ${cap}（JG数量 ${jg.qty} − 已判不合格 ${failCum} + 容差 ${tolerance}）`,
    );
  }
}

// ---------- 创建 ----------

export async function createSh(user: SessionUser, input: unknown, dbArg?: AnyDb): Promise<ShRow> {
  requireAnyRole(user, "warehouse");
  const v = createShSchema.parse(input);
  const db = await resolveDb(dbArg);

  return db.transaction(async (tx: AnyDb) => {
    const actor = await currentMatflowActor(tx, user);
    requireAnyRole(actor, "warehouse");
    await tx.select({ id: warehouses.id }).from(warehouses).where(eq(warehouses.id, v.warehouseId)).for("share");
    await requireRealtimeWarehouse(tx, v.warehouseId, "收货仓");

    let lines = v.lines;
    if (v.sourceType === "jg") {
      await tx.select({ id: jgDocs.id }).from(jgDocs).where(eq(jgDocs.id, v.sourceId)).for("share");
      const jg = await getJgForMatflow(tx, v.sourceId);
      for (const l of lines) {
        if (l.poLineId != null) throw new ApiError(400, "加工来源收货不可携带采购行编号");
        if (l.skuId !== jg.productSkuId) {
          throw new ApiError(400, `jg 源收货行 SKU 必须是加工成品 sku#${jg.productSkuId}，实为 sku#${l.skuId}`);
        }
      }
      // 草稿不预占累计；审批仍须重查。
      let thisNormal = "0";
      for (const l of lines) if (l.lineType === "normal") thisNormal = dAdd(thisNormal, l.actualQty);
      await assertJgReceiptWithinCap(tx, jg, thisNormal);
    } else {
      const [po]: (typeof poDocs.$inferSelect)[] = await tx.select().from(poDocs).where(eq(poDocs.id, v.sourceId)).for("share");
      if (!po) throw new ApiError(404, `采购订单不存在: #${v.sourceId}`);
      if (po.status !== "approved" && po.status !== "in_progress") {
        throw new ApiError(409, `采购订单当前状态不可收货: ${po.status}`);
      }
      const plRows: { id: number; skuId: number }[] = await tx
        .select({ id: poLines.id, skuId: poLines.skuId })
        .from(poLines)
        .where(eq(poLines.poId, po.id)).orderBy(poLines.id).for("share");
      // po 源无行类型概念，强制 normal
      lines = lines.map((l) => ({ ...l, poLineId: resolvePurchaseReceiptLine(plRows, l.skuId, l.poLineId).id, lineType: "normal" as const }));
    }
    const docNo = await nextDocNo(tx, "SH");
    const [doc]: ShRow[] = await tx
      .insert(shDocs)
      .values({
        docNo,
        remark: v.remark ?? null,
        sourceType: v.sourceType,
        sourceId: v.sourceId,
        warehouseId: v.warehouseId,
        createdBy: user.id,
      })
      .returning();
    // E4-01：管效期 SKU 必须带批次号——否则后续效期与召回能力形同虚设
    await requireBatchForExpirySkus(tx, lines.map((l) => ({ skuId: l.skuId, batchNo: l.batchNo ?? null })));
    await tx.insert(shLines).values(
      lines.map((l) => ({
        shId: doc.id,
        skuId: l.skuId,
        poLineId: l.poLineId ?? null,
        lineType: l.lineType,
        expectedQty: l.expectedQty != null ? dQty(l.expectedQty) : null,
        actualQty: dQty(l.actualQty),
        batchNo: l.batchNo ?? null,
        prodDate: l.prodDate ?? null,
      })),
    );
    await writeAudit(tx, {
      userId: user.id, entity: "sh", entityId: doc.id, action: "create",
      after: { docNo: doc.docNo, sourceType: v.sourceType, sourceId: v.sourceId, lineCount: lines.length },
    });
    return doc;
  });
}

// ---------- 提交 ----------

export async function submitSh(user: SessionUser, id: number, version: number, dbArg?: AnyDb): Promise<ShRow> {
  const db = await resolveDb(dbArg);
  return db.transaction(async (tx: AnyDb) => {
    const actor = await currentMatflowActor(tx, user);
    const [doc]: ShRow[] = await tx.select().from(shDocs).where(eq(shDocs.id, id)).for("update");
    if (!doc) throw new ApiError(404, "单据不存在");
    if (doc.createdBy !== actor.id && !actor.roles.includes("warehouse") && !actor.roles.includes("admin")) {
      throw new ApiError(403, "仅制单人/仓管/管理员可提交");
    }
    if (doc.status !== "draft") throw new ApiError(409, `当前状态不可提交: ${doc.status}`);
    const updated: ShRow[] = await tx
      .update(shDocs)
      .set({ status: "pending", version: sql`${shDocs.version} + 1`, updatedAt: new Date() })
      .where(and(eq(shDocs.id, id), eq(shDocs.version, version)))
      .returning();
    if (updated.length === 0) throw new ApiError(409, `版本冲突：期望版本 ${version} 已过期`);
    await writeAudit(tx, { userId: actor.id, entity: "sh", entityId: id, action: "submit" });
    return updated[0];
  });
}

// ---------- 审批（仅置 approved——检验前不入库；累计校验并发兜底重查） ----------

export async function approveSh(
  user: SessionUser,
  id: number,
  input: unknown,
  dbArg?: AnyDb,
): Promise<{ status: string; idempotent: boolean }> {
  const v = approveDocSchema.parse(input);
  const db = await resolveDb(dbArg);
  try {
    return await db.transaction(async (tx: AnyDb) => {
      const actor = await currentMatflowActor(tx, user);
      const [doc]: ShRow[] = await tx.select().from(shDocs).where(eq(shDocs.id, id)).for("update");
      if (!doc) throw new ApiError(404, "单据不存在");

      const r = await approveDoc(tx, {
        docType: "sh",
        table: shDocs,
        docId: id,
        approver: actor,
        action: v.action,
        comment: v.comment,
        expectedVersion: v.version,
      });
      if (r.idempotent) return r;
      await writeAudit(tx, {
        userId: user.id, entity: "sh", entityId: id, action: v.action,
        after: { comment: v.comment ?? null },
      });
      if (v.action === "reject") return r;

      // 累计校验兜底重查（创建后可能有其他 SH 先行生效；本单已置 approved 故排除自身再加回）
      if (doc.sourceType === "jg") {
        await lockJgReceiptAggregate(tx, doc.sourceId);
        const jg = await getJgForMatflow(tx, doc.sourceId);
        const rows: { qty: string }[] = await tx
          .select({ qty: shLines.actualQty })
          .from(shLines)
          .where(and(eq(shLines.shId, id), eq(shLines.lineType, "normal")));
        let thisNormal = "0";
        for (const row of rows) thisNormal = dAdd(thisNormal, row.qty);
        await assertJgReceiptWithinCap(tx, jg, thisNormal, id);
      }
      return r; // 状态停在 approved：待 QC + confirmInbound
    });
  } catch (e) {
    rethrowApproval(e);
  }
}

// ---------- QC 检验（一单一检；每个收货行必须完整三分且合计=实收） ----------

export async function createQc(
  user: SessionUser,
  input: unknown,
  dbArg?: AnyDb,
): Promise<QcRecordRow & { lines: (typeof qcLines.$inferSelect)[] }> {
  requireAnyRole(user, "warehouse");
  const v = createQcSchema.parse(input);
  const db = await resolveDb(dbArg);

  return db.transaction(async (tx: AnyDb) => {
    requireAnyRole(await currentMatflowActor(tx, user), "warehouse");
    // Serialize QC creation and inbound against this exact receipt. All facts
    // used below are read after the lock, not from a stale pre-transaction check.
    const [sh]: ShRow[] = await tx.select().from(shDocs).where(eq(shDocs.id, v.shId)).for("update");
    if (!sh) throw new ApiError(404, `收货单不存在: #${v.shId}`);
    if (sh.status !== "approved") throw new ApiError(409, `收货单须先审批方可检验，当前状态: ${sh.status}`);
    if (sh.sourceType === "jg") await lockJgReceiptAggregate(tx, sh.sourceId);

    const [dup]: { id: number }[] = await tx
      .select({ id: qcRecords.id })
      .from(qcRecords)
      .where(eq(qcRecords.shId, v.shId));
    if (dup) throw new ApiError(409, `该收货单已有检验记录: qc#${dup.id}（一单一检）`);

    const lineRows: ShLineRow[] = await tx.select().from(shLines).where(eq(shLines.shId, v.shId)).orderBy(shLines.id).for("share");
    const lineById = new Map(lineRows.map((l) => [l.id, l]));
    const submittedIds = new Set<number>();
    for (const l of v.lines) {
      const shLine = lineById.get(l.shLineId);
      if (!shLine) throw new ApiError(400, `检验行不属于该收货单: sh_line#${l.shLineId}`);
      if (submittedIds.has(l.shLineId)) {
        throw new ApiError(400, `同一收货行不可重复检验: sh_line#${l.shLineId}`);
      }
      submittedIds.add(l.shLineId);
      const graded = dAdd(dAdd(l.passQty, l.failQty), l.concessionQty);
      if (dCmp(graded, shLine.actualQty) !== 0) {
        throw new ApiError(
          400,
          `检验数量必须完整覆盖实收: sh_line#${l.shLineId}（判定合计 ${graded} ≠ 实收 ${shLine.actualQty}）`,
        );
      }
    }
    const missingIds = lineRows.filter((l) => !submittedIds.has(l.id)).map((l) => l.id);
    if (missingIds.length > 0) {
      throw new ApiError(400, `检验必须覆盖全部收货行，缺少: ${missingIds.map((id) => `sh_line#${id}`).join("、")}`);
    }
    const [qc]: QcRecordRow[] = await tx
      .insert(qcRecords)
      .values({ shId: v.shId, conclusion: v.conclusion ?? null, createdBy: user.id })
      .returning();
    const insLines: (typeof qcLines.$inferSelect)[] = await tx
      .insert(qcLines)
      .values(
        v.lines.map((l) => ({
          qcId: qc.id,
          shLineId: l.shLineId,
          passQty: dQty(l.passQty),
          failQty: dQty(l.failQty),
          concessionQty: dQty(l.concessionQty),
          failHandling: l.failHandling,
        })),
      )
      .returning();
    await writeAudit(tx, {
      userId: user.id, entity: "qc", entityId: qc.id, action: "create",
      after: { shId: v.shId, lineCount: v.lines.length, conclusion: v.conclusion ?? null },
    });
    return { ...qc, lines: insLines };
  });
}

// ---------- 入库确认（检验后过账，单事务；二次入库 409） ----------

export async function confirmInbound(
  user: SessionUser,
  shId: number,
  dbArg?: AnyDb,
): Promise<{ status: string }> {
  requireAnyRole(user, "warehouse");
  const db = await resolveDb(dbArg);
  try {
    return await db.transaction(async (tx: AnyDb) => {
      requireAnyRole(await currentMatflowActor(tx, user), "warehouse");
      const [sh]: ShRow[] = await tx.select().from(shDocs).where(eq(shDocs.id, shId)).for("update");
      if (!sh) throw new ApiError(404, "单据不存在");
      if (sh.status === "completed") throw new ApiError(409, "该收货单已入库，不可重复入库");
      if (sh.status !== "approved") throw new ApiError(409, `当前状态不可入库: ${sh.status}（须先审批）`);

      const [qc]: QcRecordRow[] = await tx.select().from(qcRecords).where(eq(qcRecords.shId, shId));
      if (!qc) throw new ApiError(409, "收货必检：须先录入检验记录方可入库");
      const qcRows: (typeof qcLines.$inferSelect)[] = await tx
        .select()
        .from(qcLines)
        .where(eq(qcLines.qcId, qc.id));
      const qcByShLine = new Map(qcRows.map((l) => [l.shLineId, l]));
      const lines: ShLineRow[] = await tx.select().from(shLines).where(eq(shLines.shId, shId)).orderBy(shLines.id);

      // Lock the shared PO aggregate before batch/stock writes; different SH and CT
      // must not independently read the same old receivedQty.
      const purchase = sh.sourceType === "po" ? await lockPurchaseReceipt(tx, sh.sourceId) : null;
      const batchPostingEnabled = await isBatchPostingEnabled(tx);
      const batchIds = await registerBatchesFromReceipt(
        tx,
        lines.map((l) => ({ skuId: l.skuId, batchNo: l.batchNo, prodDate: l.prodDate })),
        { docType: "sh", docId: shId },
      );
      const batchByShLine = new Map<number, number | null>(
        lines.map((line) => [
          line.id,
          batchPostingEnabled && line.batchNo
            ? (batchIds.get(`${line.skuId}:${line.batchNo.trim()}`) ?? null)
            : null,
        ]),
      );

      if (sh.sourceType === "jg") {
        await inboundFromJg(tx, user, sh, lines, qcByShLine, batchByShLine);
      } else {
        await inboundFromPo(tx, user, sh, lines, qcByShLine, batchByShLine, purchase!);
      }

      const finalStatus = await completeApprovedDoc(tx, shDocs, shId);
      await writeAudit(tx, {
        userId: user.id, entity: "sh", entityId: shId, action: "inbound",
        after: {
          qcId: qc.id,
          sourceType: sh.sourceType,
          sourceId: sh.sourceId,
          batchPostingEnabled,
        },
      });
      return { status: finalStatus, sourceType: sh.sourceType, sourceId: sh.sourceId };
    }).then(async (r: { status: string; sourceType?: string; sourceId?: number }) => {
      // D33 钩子②（事务外、失败不阻断）：材料到仓（po 源入库）→ 齐套自动 JG（开关默认关）
      if (r?.sourceType === "po" && r.sourceId != null) {
        try {
          const [po] = await db.select({ woId: poDocs.woId }).from(poDocs).where(eq(poDocs.id, r.sourceId));
          const { hookAfterPoReceipt } = await import("@/server/modules/outsource/auto-chain");
          await hookAfterPoReceipt(user, po?.woId ?? null, dbArg);
        } catch { /* 钩子失败不阻断入库 */ }
      }
      // D33-b（0724：成品入库时核算剩余物料）：jg 源入库 → 结余提示入复核清单
      if (r?.sourceType === "jg" && r.sourceId != null) {
        try {
          const { suggestLeftoverAfterInbound } = await import("@/server/modules/outsource/leftover");
          await suggestLeftoverAfterInbound(user, r.sourceId, dbArg);
        } catch { /* 提示失败不阻断入库 */ }
      }
      return { status: r.status };
    });
  } catch (e) {
    if (e instanceof PostingError && e.code === "NEGATIVE_STOCK") {
      throw new ApiError(409, `库存不足：${e.message}`);
    }
    throw e;
  }
}

/**
 * jg 源入库（《01》§4 过账表两行）：
 * sh_outsource_in：成品仓 + (合格+让步)（正常+返工行）；委外仓 − qtyPer×Q（Q=合格+让步+备品实收，R5 口径）。
 * spare_in：成品仓 + 备品实收（零成本行）+ offset_pool(kind=spare, amount=0)。
 */
async function inboundFromJg(
  tx: AnyDb,
  user: SessionUser,
  sh: ShRow,
  lines: ShLineRow[],
  qcByShLine: Map<number, typeof qcLines.$inferSelect>,
  batchByShLine: Map<number, number | null>,
): Promise<void> {
  const [jg]: (typeof jgDocs.$inferSelect)[] = await tx.select().from(jgDocs).where(eq(jgDocs.id, sh.sourceId));
  if (!jg) throw new ApiError(500, `收货单挂空 JG: #${sh.sourceId}`);
  const outWh = await getOutsourceWarehouseOf(tx, jg.supplierId);
  const woLineRows: (typeof woLines.$inferSelect)[] = await tx
    .select()
    .from(woLines)
    .where(eq(woLines.woId, jg.woId))
    .orderBy(woLines.id);

  const eventLines: PostingLine[] = [];
  let goodTotal = "0"; // 合格+让步（正常+返工行）
  let spareTotal = "0"; // 备品合格+让步
  for (const l of lines) {
    const qc = qcByShLine.get(l.id);
    if (!qc) throw new ApiError(500, `检验记录缺少收货行: sh_line#${l.id}`);
    const good = dAdd(qc.passQty, qc.concessionQty);
    if (l.lineType === "spare") {
      spareTotal = dAdd(spareTotal, good);
      continue;
    }
    if (dCmp(good, "0") > 0) {
      eventLines.push({
        sourceLineId: l.id,
        skuId: l.skuId,
        warehouseId: sh.warehouseId,
        batchId: batchByShLine.get(l.id) ?? null,
        qtyDelta: good,
      });
      goodTotal = dAdd(goodTotal, good);
    }
  }

  // 委外仓净标准用量扣减：Q = 合格+让步+备品实收（备品占用物料——R5 有效完工数口径）
  const q = dAdd(goodTotal, spareTotal);
  if (dCmp(q, "0") > 0) {
    const consumption = woLineRows
      .map((wl) => ({ skuId: wl.materialSkuId, qty: dMul(wl.qtyPer, q), originId: wl.id }))
      .filter((line) => !dZero(line.qty));
    const allocated = await expandOutboundLinesForBatchPosting(tx, outWh.id, consumption);
    const fragmentByOrigin = new Map<number, number>();
    for (const line of allocated) {
      const fragment = (fragmentByOrigin.get(line.originId) ?? 0) + 1;
      fragmentByOrigin.set(line.originId, fragment);
      // 负号与收货成品正 sourceLineId 分域；每个原 WO 行预留 100000 个批次片段。
      const sourceLineId = -(line.originId * 100000 + fragment);
      eventLines.push({
        sourceLineId,
        skuId: line.skuId,
        warehouseId: outWh.id,
        batchId: line.batchId,
        qtyDelta: dNeg(line.qty),
      });
    }
  }
  if (eventLines.length > 0) {
    await post(tx, { sourceDocType: "sh_outsource_in", sourceDocId: sh.id, action: "post", lines: eventLines });
  }

  // 备品：独立 spare_in 事件（零成本）+ 对冲池台账（R7；amount=0 为占位——
  // 规格计价=当月加权平均，加权价数据源 W5 结算波接入，先记 0 并在池行留痕）
  if (dCmp(spareTotal, "0") > 0) {
    const spareLines: PostingLine[] = lines
      .filter((l) => l.lineType === "spare")
      .map((l) => ({ line: l, qc: qcByShLine.get(l.id)! }))
      .filter(({ qc }) => dCmp(dAdd(qc.passQty, qc.concessionQty), "0") > 0)
      .map((l) => ({
        sourceLineId: l.line.id,
        skuId: l.line.skuId,
        warehouseId: sh.warehouseId,
        batchId: batchByShLine.get(l.line.id) ?? null,
        qtyDelta: dQty(dAdd(l.qc.passQty, l.qc.concessionQty)),
      }));
    await post(tx, { sourceDocType: "spare_in", sourceDocId: sh.id, action: "post", lines: spareLines });
    await tx.insert(offsetPools).values({
      kind: "spare",
      skuId: jg.productSkuId,
      qty: dQty(spareTotal),
      amount: "0", // 零成本入库；当月加权平均计价随 W5 结算波补
      sourceDocType: "sh",
      sourceDocId: sh.id,
    });
    await writeAudit(tx, {
      userId: user.id, entity: "offset_pool", entityId: sh.id, action: "spare_in",
      after: { skuId: jg.productSkuId, qty: dQty(spareTotal), amount: "0" },
    });
  }
}

/**
 * po 源入库：sh_purchase_in 仓库 +（合格 + 让步接收）；po_line.receivedQty 同额累加（基础单位）。
 *
 * **W2 审计 3（让步量不再静默蒸发）**：此前这里只入合格数，让步接收量既不入库也不退货——
 * 它在 `qc_lines.concession_qty` 里留着，然后凭空消失：仓库账少了这批货，PO 的已收数也不含它，
 * 而 `report/supply-commitment` 早已按「合格 + 让步接收」当有效接收量算承诺兑现
 * （于是那边一路判 controlMismatch 把整行踢出分母）。jg 源入库本来就按「合格 + 让步」入，
 * 两条收货路径的口径在此对齐——让步接收的定义就是**接收**，不是丢弃。
 *
 * 不合格量（fail_qty，去向 rework/scrap）仍然不入库，但也不再无声无息：
 * 由 `modules/quality/qc-outcome.ts` 显式登记质量案件 / 退货（CT）草稿并双向留痕。
 *
 * 全部行 receivedQty ≥ qty×uomFactor 且 PO 执行中 → 状态机完成 PO。
 */
async function inboundFromPo(
  tx: AnyDb,
  user: SessionUser,
  sh: ShRow,
  lines: ShLineRow[],
  qcByShLine: Map<number, typeof qcLines.$inferSelect>,
  batchByShLine: Map<number, number | null>,
  purchase: Awaited<ReturnType<typeof lockPurchaseReceipt>>,
): Promise<void> {
  const { po, lines: plRows } = purchase;

  const eventLines: PostingLine[] = [];
  const passByPoLine = new Map<number, string>();
  for (const l of lines) {
    // 在同一PO聚合锁内复核，历史歧义不能在库存已过账后才发现。
    const purchaseLine = resolvePurchaseReceiptLine(plRows, l.skuId, l.poLineId);
    const qc = qcByShLine.get(l.id);
    // 有效接收量 = 合格 + 让步接收（与 jg 源入库、supply-commitment 的接收口径同一定义）
    const accepted = qc ? dAdd(qc.passQty, qc.concessionQty) : "0";
    if (dCmp(accepted, "0") <= 0) continue;
    eventLines.push({
      sourceLineId: l.id,
      skuId: l.skuId,
      warehouseId: sh.warehouseId,
      batchId: batchByShLine.get(l.id) ?? null,
      qtyDelta: dQty(accepted),
    });
    passByPoLine.set(purchaseLine.id, dAdd(passByPoLine.get(purchaseLine.id) ?? "0", accepted));
  }
  if (eventLines.length > 0) {
    await post(tx, { sourceDocType: "sh_purchase_in", sourceDocId: sh.id, action: "post", lines: eventLines });
  }

  // 基础单位数量只累加到明确采购行；同采购行的多个批次先精确合计。
  for (const pl of plRows) {
    const pass = passByPoLine.get(pl.id);
    if (pass == null) continue;
    await tx
      .update(poLines)
      .set({ receivedQty: dAdd(pl.receivedQty, pass) })
      .where(eq(poLines.id, pl.id));
  }

  // 全收自动完成（仅执行中 PO 可走 complete 边；approved 未确认的留待人工）
  if (po.status === "in_progress" && passByPoLine.size > 0) {
    const fresh: (typeof poLines.$inferSelect)[] = await tx
      .select()
      .from(poLines)
      .where(eq(poLines.poId, po.id));
    const fullyReceived = fresh.every((r) => dCmp(r.receivedQty, dMul(r.qty, r.uomFactor)) >= 0);
    if (fullyReceived) {
      const done = nextStatus("in_progress", "complete");
      await tx
        .update(poDocs)
        .set({ status: done, version: sql`${poDocs.version} + 1`, updatedAt: new Date() })
        .where(eq(poDocs.id, po.id));
      await writeAudit(tx, {
        userId: user.id, entity: "po", entityId: po.id, action: "complete",
        after: { via: "sh_inbound", shId: sh.id },
      });
    }
  }
}

export { getSh, listShs } from "./sh-read";
