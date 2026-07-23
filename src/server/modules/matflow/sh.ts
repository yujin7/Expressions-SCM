import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import {
  approvals, jgDocs, offsetPools, poDocs, poLines, qcLines, qcRecords,
  shDocs, shLines, skus, users, warehouses, woLines,
} from "@/db/schema";
import { dAdd, dCmp, dDiv, dMul, dNeg, dQty, dSub, dZero } from "@/server/core/decimal";
import type { SessionUser } from "@/server/core/dto";
import { writeAudit } from "@/server/core/audit";
import { approveDoc } from "@/server/docflow/approval";
import { nextDocNo } from "@/server/docflow/doc-no";
import { nextStatus, type DocStatus } from "@/server/docflow/state";
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

/**
 * 收货单 SH + 检验 QC + 入库确认（《01》§3/§4，《02》§3 关键校验）。
 * - 分次收货；行类型 normal（占累计）/ rework（返工重交，冲抵原不合格，不占累计）/ spare（备品，不占 JG 数量）。
 * - 累计校验（jg 源）：Σ正常行实收 ≤ JG数量 − Σ已判不合格 + 超收容差（sys_param over_receive_tolerance_pct）。
 * - 审批仅置 approved——检验前不入库；QC 一单一检；confirmInbound 才过账：
 *   jg 源 → sh_outsource_in（成品仓 +合格+让步；委外仓 −净标准用量×(合格+让步+备品)）+ spare_in（备品零成本+对冲池）；
 *   po 源 → sh_purchase_in（仓库 +合格数）+ po_line.receivedQty 累加（全收自动完成 PO）。
 */

type ShRow = typeof shDocs.$inferSelect;
type ShLineRow = typeof shLines.$inferSelect;
type QcRecordRow = typeof qcRecords.$inferSelect;

const NON_SPARE_TYPES = ["normal", "rework"] as const;

// ---------- 累计校验（《02》§3：分母 = JG数量 − 已判不合格 + 容差） ----------

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

  await requireRealtimeWarehouse(db, v.warehouseId, "收货仓");

  let lines = v.lines;
  if (v.sourceType === "jg") {
    const jg = await getJgForMatflow(db, v.sourceId);
    for (const l of lines) {
      if (l.skuId !== jg.productSkuId) {
        throw new ApiError(400, `jg 源收货行 SKU 必须是加工成品 sku#${jg.productSkuId}，实为 sku#${l.skuId}`);
      }
    }
    // 累计校验（分母=JG数量−已判不合格+容差）
    let thisNormal = "0";
    for (const l of lines) if (l.lineType === "normal") thisNormal = dAdd(thisNormal, l.actualQty);
    await assertJgReceiptWithinCap(db, jg, thisNormal);
  } else {
    const [po]: (typeof poDocs.$inferSelect)[] = await db.select().from(poDocs).where(eq(poDocs.id, v.sourceId));
    if (!po) throw new ApiError(404, `采购订单不存在: #${v.sourceId}`);
    if (po.status !== "approved" && po.status !== "in_progress") {
      throw new ApiError(409, `采购订单当前状态不可收货: ${po.status}`);
    }
    const plRows: { skuId: number }[] = await db
      .select({ skuId: poLines.skuId })
      .from(poLines)
      .where(eq(poLines.poId, po.id));
    const poSkus = new Set(plRows.map((r) => r.skuId));
    for (const l of lines) {
      if (!poSkus.has(l.skuId)) throw new ApiError(400, `SKU #${l.skuId} 不在该 PO 行上，不可收货`);
    }
    // po 源无行类型概念，强制 normal
    lines = lines.map((l) => ({ ...l, lineType: "normal" as const }));
  }

  return db.transaction(async (tx: AnyDb) => {
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
    await tx.insert(shLines).values(
      lines.map((l) => ({
        shId: doc.id,
        skuId: l.skuId,
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
  const [doc]: ShRow[] = await db.select().from(shDocs).where(eq(shDocs.id, id));
  if (!doc) throw new ApiError(404, "单据不存在");
  if (doc.createdBy !== user.id && !user.roles.includes("warehouse") && !user.roles.includes("admin")) {
    throw new ApiError(403, "仅制单人/仓管/管理员可提交");
  }
  if (doc.status !== "draft") throw new ApiError(409, `当前状态不可提交: ${doc.status}`);
  const updated: ShRow[] = await db
    .update(shDocs)
    .set({ status: "pending", version: sql`${shDocs.version} + 1`, updatedAt: new Date() })
    .where(and(eq(shDocs.id, id), eq(shDocs.version, version)))
    .returning();
  if (updated.length === 0) throw new ApiError(409, `版本冲突：期望版本 ${version} 已过期`);
  await writeAudit(db, { userId: user.id, entity: "sh", entityId: id, action: "submit" });
  return updated[0];
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
      const [doc]: ShRow[] = await tx.select().from(shDocs).where(eq(shDocs.id, id));
      if (!doc) throw new ApiError(404, "单据不存在");

      const r = await approveDoc(tx, {
        docType: "sh",
        table: shDocs,
        docId: id,
        approver: { id: user.id, roles: user.roles, isApprover: user.isApprover },
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
        const [jg]: (typeof jgDocs.$inferSelect)[] = await tx.select().from(jgDocs).where(eq(jgDocs.id, doc.sourceId));
        if (!jg) throw new ApiError(500, `收货单挂空 JG: #${doc.sourceId}`);
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

// ---------- QC 检验（一单一检；pass+fail+concession ≤ 实收） ----------

export async function createQc(
  user: SessionUser,
  input: unknown,
  dbArg?: AnyDb,
): Promise<QcRecordRow & { lines: (typeof qcLines.$inferSelect)[] }> {
  requireAnyRole(user, "warehouse");
  const v = createQcSchema.parse(input);
  const db = await resolveDb(dbArg);

  const [sh]: ShRow[] = await db.select().from(shDocs).where(eq(shDocs.id, v.shId));
  if (!sh) throw new ApiError(404, `收货单不存在: #${v.shId}`);
  if (sh.status !== "approved") throw new ApiError(409, `收货单须先审批方可检验，当前状态: ${sh.status}`);

  const [dup]: { id: number }[] = await db
    .select({ id: qcRecords.id })
    .from(qcRecords)
    .where(eq(qcRecords.shId, v.shId));
  if (dup) throw new ApiError(409, `该收货单已有检验记录: qc#${dup.id}（一单一检）`);

  const lineRows: ShLineRow[] = await db.select().from(shLines).where(eq(shLines.shId, v.shId));
  const lineById = new Map(lineRows.map((l) => [l.id, l]));
  for (const l of v.lines) {
    const shLine = lineById.get(l.shLineId);
    if (!shLine) throw new ApiError(400, `检验行不属于该收货单: sh_line#${l.shLineId}`);
    const graded = dAdd(dAdd(l.passQty, l.failQty), l.concessionQty);
    if (dCmp(graded, shLine.actualQty) > 0) {
      throw new ApiError(400, `检验数量超过实收: sh_line#${l.shLineId}（判定合计 ${graded} > 实收 ${shLine.actualQty}）`);
    }
  }

  return db.transaction(async (tx: AnyDb) => {
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
      const [sh]: ShRow[] = await tx.select().from(shDocs).where(eq(shDocs.id, shId));
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

      if (sh.sourceType === "jg") {
        await inboundFromJg(tx, user, sh, lines, qcByShLine);
      } else {
        await inboundFromPo(tx, user, sh, lines, qcByShLine);
      }

      const finalStatus = await completeApprovedDoc(tx, shDocs, shId);
      await writeAudit(tx, {
        userId: user.id, entity: "sh", entityId: shId, action: "inbound",
        after: { qcId: qc.id, sourceType: sh.sourceType, sourceId: sh.sourceId },
      });
      return { status: finalStatus };
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
  let spareTotal = "0"; // 备品实收
  for (const l of lines) {
    if (l.lineType === "spare") {
      spareTotal = dAdd(spareTotal, l.actualQty);
      continue;
    }
    const qc = qcByShLine.get(l.id);
    const good = qc ? dAdd(qc.passQty, qc.concessionQty) : "0";
    if (dCmp(good, "0") > 0) {
      eventLines.push({
        sourceLineId: l.id, skuId: l.skuId, warehouseId: sh.warehouseId, batchId: null, qtyDelta: good,
      });
      goodTotal = dAdd(goodTotal, good);
    }
  }

  // 委外仓净标准用量扣减：Q = 合格+让步+备品实收（备品占用物料——R5 有效完工数口径）
  const q = dAdd(goodTotal, spareTotal);
  if (dCmp(q, "0") > 0) {
    for (const wl of woLineRows) {
      const consume = dMul(wl.qtyPer, q);
      if (dZero(consume)) continue;
      eventLines.push({
        sourceLineId: -wl.id, skuId: wl.materialSkuId, warehouseId: outWh.id, batchId: null, qtyDelta: dNeg(consume),
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
      .map((l) => ({
        sourceLineId: l.id, skuId: l.skuId, warehouseId: sh.warehouseId, batchId: null, qtyDelta: dQty(l.actualQty),
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
 * po 源入库：sh_purchase_in 仓库 +合格数；po_line.receivedQty += 合格数（基础单位，
 * SH 实收即基础单位——让步件另行处置不自动入库，MVP 与任务口径一致）。
 * 全部行 receivedQty ≥ qty×uomFactor 且 PO 执行中 → 状态机完成 PO。
 */
async function inboundFromPo(
  tx: AnyDb,
  user: SessionUser,
  sh: ShRow,
  lines: ShLineRow[],
  qcByShLine: Map<number, typeof qcLines.$inferSelect>,
): Promise<void> {
  const [po]: (typeof poDocs.$inferSelect)[] = await tx.select().from(poDocs).where(eq(poDocs.id, sh.sourceId));
  if (!po) throw new ApiError(500, `收货单挂空 PO: #${sh.sourceId}`);
  const plRows: (typeof poLines.$inferSelect)[] = await tx
    .select()
    .from(poLines)
    .where(eq(poLines.poId, po.id))
    .orderBy(poLines.id);

  const eventLines: PostingLine[] = [];
  const passBySku = new Map<number, string>();
  for (const l of lines) {
    const qc = qcByShLine.get(l.id);
    const pass = qc ? qc.passQty : "0";
    if (dCmp(pass, "0") <= 0) continue;
    eventLines.push({
      sourceLineId: l.id, skuId: l.skuId, warehouseId: sh.warehouseId, batchId: null, qtyDelta: dQty(pass),
    });
    passBySku.set(l.skuId, dAdd(passBySku.get(l.skuId) ?? "0", pass));
  }
  if (eventLines.length > 0) {
    await post(tx, { sourceDocType: "sh_purchase_in", sourceDocId: sh.id, action: "post", lines: eventLines });
  }

  // 已收数累加（同 SKU 多 PO 行时计入首行——PoC 口径）
  for (const [skuId, pass] of passBySku) {
    const pl = plRows.find((r) => r.skuId === skuId);
    if (!pl) throw new ApiError(500, `PO 行缺失: po#${po.id} sku#${skuId}`);
    await tx
      .update(poLines)
      .set({ receivedQty: dAdd(pl.receivedQty, pass) })
      .where(eq(poLines.id, pl.id));
  }

  // 全收自动完成（仅执行中 PO 可走 complete 边；approved 未确认的留待人工）
  if (po.status === "in_progress" && passBySku.size > 0) {
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

// ---------- 查询 ----------

export async function getSh(id: number, dbArg?: AnyDb) {
  const db = await resolveDb(dbArg);
  const [doc] = await db
    .select({
      id: shDocs.id,
      docNo: shDocs.docNo,
      status: shDocs.status,
      remark: shDocs.remark,
      version: shDocs.version,
      sourceType: shDocs.sourceType,
      sourceId: shDocs.sourceId,
      warehouseId: shDocs.warehouseId,
      warehouseName: warehouses.name,
      createdBy: shDocs.createdBy,
      createdAt: shDocs.createdAt,
      createdByName: users.name,
    })
    .from(shDocs)
    .innerJoin(warehouses, eq(shDocs.warehouseId, warehouses.id))
    .leftJoin(users, eq(shDocs.createdBy, users.id))
    .where(eq(shDocs.id, id));
  if (!doc) throw new ApiError(404, "单据不存在");

  // 来源单号
  let sourceDocNo: string | null = null;
  if (doc.sourceType === "jg") {
    const [j]: { docNo: string }[] = await db
      .select({ docNo: jgDocs.docNo }).from(jgDocs).where(eq(jgDocs.id, doc.sourceId));
    sourceDocNo = j?.docNo ?? null;
  } else {
    const [p]: { docNo: string }[] = await db
      .select({ docNo: poDocs.docNo }).from(poDocs).where(eq(poDocs.id, doc.sourceId));
    sourceDocNo = p?.docNo ?? null;
  }

  const lines = await db
    .select({
      id: shLines.id,
      skuId: shLines.skuId,
      skuCode: skus.code,
      skuName: skus.name,
      baseUom: skus.baseUom,
      lineType: shLines.lineType,
      expectedQty: shLines.expectedQty,
      actualQty: shLines.actualQty,
      batchNo: shLines.batchNo,
      prodDate: shLines.prodDate,
    })
    .from(shLines)
    .innerJoin(skus, eq(shLines.skuId, skus.id))
    .where(eq(shLines.shId, id))
    .orderBy(shLines.id);

  // QC（一单一检）
  const [qcRow]: QcRecordRow[] = await db.select().from(qcRecords).where(eq(qcRecords.shId, id));
  const qc = qcRow
    ? {
        id: qcRow.id,
        conclusion: qcRow.conclusion,
        createdAt: qcRow.createdAt,
        lines: await db
          .select({
            id: qcLines.id,
            shLineId: qcLines.shLineId,
            passQty: qcLines.passQty,
            failQty: qcLines.failQty,
            concessionQty: qcLines.concessionQty,
            failHandling: qcLines.failHandling,
          })
          .from(qcLines)
          .where(eq(qcLines.qcId, qcRow.id))
          .orderBy(qcLines.id),
      }
    : null;

  const approvalRows = await db
    .select({
      approverName: users.name,
      action: approvals.action,
      comment: approvals.comment,
      createdAt: approvals.createdAt,
    })
    .from(approvals)
    .leftJoin(users, eq(approvals.approverId, users.id))
    .where(and(eq(approvals.docType, "sh"), eq(approvals.docId, id)))
    .orderBy(approvals.createdAt, approvals.id);

  return { ...doc, sourceDocNo, lines, qc, inbound: doc.status === "completed", approvals: approvalRows };
}

export async function listShs(
  q: string,
  opts: { status?: string; sourceType?: string; sourceId?: number; page: number; pageSize: number },
  dbArg?: AnyDb,
): Promise<{ rows: unknown[]; total: number }> {
  const db = await resolveDb(dbArg);
  const conds = [];
  if (q) conds.push(sql`${shDocs.docNo} ILIKE ${"%" + q + "%"}`);
  if (opts.status) conds.push(eq(shDocs.status, opts.status as DocStatus));
  if (opts.sourceType) conds.push(eq(shDocs.sourceType, opts.sourceType));
  if (opts.sourceId) conds.push(eq(shDocs.sourceId, opts.sourceId));
  const where = conds.length ? and(...conds) : undefined;

  const lineAgg = db
    .select({ shId: shLines.shId, lineCount: sql<number>`count(*)::int`.as("agg_line_count") })
    .from(shLines)
    .groupBy(shLines.shId)
    .as("la");
  const qcAgg = db
    .select({ shId: qcRecords.shId, qcId: sql<number>`min(${qcRecords.id})`.as("agg_qc_id") })
    .from(qcRecords)
    .groupBy(qcRecords.shId)
    .as("qa");

  const [rows, [{ total }]] = await Promise.all([
    db
      .select({
        id: shDocs.id,
        docNo: shDocs.docNo,
        status: shDocs.status,
        sourceType: shDocs.sourceType,
        sourceId: shDocs.sourceId,
        sourceDocNo: sql<string | null>`case when ${shDocs.sourceType} = 'po' then ${poDocs.docNo} else ${jgDocs.docNo} end`,
        warehouseName: warehouses.name,
        lineCount: sql<number>`coalesce(${lineAgg.lineCount}, 0)`,
        hasQc: sql<boolean>`${qcAgg.qcId} is not null`,
        inbound: sql<boolean>`${shDocs.status} = 'completed'`,
        createdByName: users.name,
        createdAt: shDocs.createdAt,
      })
      .from(shDocs)
      .leftJoin(poDocs, and(eq(shDocs.sourceType, sql`'po'`), eq(shDocs.sourceId, poDocs.id)))
      .leftJoin(jgDocs, and(eq(shDocs.sourceType, sql`'jg'`), eq(shDocs.sourceId, jgDocs.id)))
      .innerJoin(warehouses, eq(shDocs.warehouseId, warehouses.id))
      .leftJoin(lineAgg, eq(lineAgg.shId, shDocs.id))
      .leftJoin(qcAgg, eq(qcAgg.shId, shDocs.id))
      .leftJoin(users, eq(shDocs.createdBy, users.id))
      .where(where)
      .orderBy(desc(shDocs.createdAt), desc(shDocs.id))
      .limit(opts.pageSize)
      .offset((opts.page - 1) * opts.pageSize),
    db.select({ total: sql<number>`count(*)::int` }).from(shDocs).where(where),
  ]);
  return { rows, total };
}
