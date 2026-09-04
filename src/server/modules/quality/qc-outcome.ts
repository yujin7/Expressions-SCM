/**
 * 检验不合格的**去向**（W2 审计 3）——把 `qc_lines.fail_handling` 从一个死字段接回决策。
 *
 * 事故形态：检验录了 `fail_handling ∈ {rework, scrap, concession, pending}`，然后**什么都不会发生**：
 * 没有退货单、没有质量案件、没有供应商通知、没有扣款依据。不合格量在系统里就地蒸发，
 * 记分卡里它变成一个比率、报表里它变成一格数字，没有任何人被指派去处理它。
 *
 * 本模块提供两条明确的后果（可单独用、也可一次都要），并**双向留痕**：
 *  · 质量案件（QI）：`quality_cases.qc_record_id` ← → `qc_records.quality_case_id`；
 *    案件带 supplierId（于是自动进入供应商记分卡的「质量案件」维度，见 rules/scorecard.ts）
 *    与 skuId/batchId（于是可以被案件隔离作业圈到范围）。
 *  · 采购退货（CT）草稿：`qc_records.return_ct_id`，走既有 `matflow/ct.ts createCt`
 *    （退货量守卫、批次分配、审批过账、已收数回冲全部沿用，不另起一套）。
 *
 * ── 可退量口径（关键，别把不可退的量做成一张永远批不掉的单）──
 * CT 的既有铁律是「退货量 ≤ 该 PO 行当前 received_qty」，且审批时会**重查一次**。
 * 检验不合格量（fail_qty）从来不入库、也不进 received_qty——给它开 CT 只会得到一张
 * 审批必然 409 的草稿；而**合格量**虽然在库里，退它跟这次检验结论没有关系（那是另一件事，
 * 应当另行开单说明原因）。所以本模块的可退量只认一种量：
 *   可退量 = min(本次让步接收量, 该 PO 行当前 received_qty)，
 *   实务含义 = **让步接收进了库、事后又决定退回去**的那部分（W2 起让步量确实入库了，
 *   见 matflow/sh.ts inboundFromPo）。
 * 纯 rework/scrap 的不合格量可退量为 0：本模块**明说**「不合格量未入库，无需退货过账」，
 * 并仍然登记质量案件与扣款依据，而不是假装开了一张退货单。
 *
 * ── 扣款依据 ──
 * 案件正文固化了这次检验的三桶量与不合格去向（`summary`），审计 after 里带同一份结构化快照。
 * 结算侧的扣款单价仍走 `settlement/js.ts getDeductPrice`（D23 代理口径），本模块不重复计价。
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import * as schema from "@/db/schema";
import { writeAudit } from "@/server/core/audit";
import { dAdd, dCmp, dQty } from "@/server/core/decimal";
import type { SessionUser } from "@/server/core/dto";
import { deterministicIdempotencyKey } from "@/server/core/idempotency";
import { ApiError, todayShanghai } from "@/server/modules/master/common";
import { createCt } from "@/server/modules/matflow/ct";
import { type AnyDb, requireAnyRole, resolveDb } from "@/server/modules/outsource/common";
import { createQualityCase } from "./service";

/** 不合格去向的中文标签（界面与案件正文共用；新增去向必须补这里） */
export const FAIL_HANDLING_LABELS: Readonly<Record<string, string>> = {
  pending: "待判定",
  rework: "退厂返工",
  concession: "让步放行",
  scrap: "报废",
};

export interface QcOutcomeLine {
  qcLineId: number;
  shLineId: number;
  skuId: number;
  skuCode: string;
  skuName: string;
  passQty: string;
  failQty: string;
  concessionQty: string;
  failHandling: string;
  failHandlingLabel: string;
  /** 关联 PO 行（po 源收货才有）；jg 源为 null */
  poLineId: number | null;
  /** 该 PO 行当前已收数（退货量上限的来源） */
  poLineReceivedQty: string | null;
  /** 本行可开退货的量 = min(让步接收量, PO 行已收数)；0 = 没有可退过账的量（不合格量从未入库） */
  returnableQty: string;
}

export interface QcOutcomeSummary {
  qcId: number;
  shId: number;
  shDocNo: string;
  sourceType: string;
  sourceId: number;
  warehouseId: number;
  supplierId: number | null;
  /** 已登记的后果（双向链接的正向一侧） */
  qualityCaseId: number | null;
  returnCtId: number | null;
  lines: QcOutcomeLine[];
  totals: { pass: string; fail: string; concession: string; returnable: string };
  /** 有不合格量却还没有任何后果登记 —— 这正是审计说的「什么都不会发生」 */
  needsOutcome: boolean;
}

const raiseSchema = z.object({
  shId: z.number().int().positive(),
  /** 建质量案件（默认建；两个后果都不要的调用没有意义，schema 层就拦掉） */
  createCase: z.boolean().default(true),
  caseSeverity: z.enum(["low", "medium", "high", "critical"]).default("medium"),
  caseSummary: z.string().trim().min(5).max(4000).optional(),
  /** 案件责任人（quality/ops 主责）；缺省 = 操作人自己 */
  caseOwnerId: z.number().int().positive().optional(),
  /** 建退货（CT）草稿；只对**可退量 > 0** 的行有意义 */
  createReturn: z.boolean().default(false),
  returnReason: z.string().trim().min(2).max(300).optional(),
}).refine((v) => v.createCase || v.createReturn, "至少要选择一种后果：质量案件或退货草稿");

/** 读：这次检验的三桶量、不合格去向与可退量，以及已经登记过的后果 */
export async function getQcOutcome(
  user: SessionUser,
  shId: number,
  dbArg?: AnyDb,
): Promise<QcOutcomeSummary> {
  requireAnyRole(user, "quality", "warehouse", "purchasing", "ops");
  const db = await resolveDb(dbArg);
  const [sh] = await db
    .select({
      id: schema.shDocs.id,
      docNo: schema.shDocs.docNo,
      sourceType: schema.shDocs.sourceType,
      sourceId: schema.shDocs.sourceId,
      warehouseId: schema.shDocs.warehouseId,
    })
    .from(schema.shDocs)
    .where(eq(schema.shDocs.id, shId));
  if (!sh) throw new ApiError(404, `收货单不存在: #${shId}`);
  const [qc] = await db
    .select({
      id: schema.qcRecords.id,
      qualityCaseId: schema.qcRecords.qualityCaseId,
      returnCtId: schema.qcRecords.returnCtId,
    })
    .from(schema.qcRecords)
    .where(eq(schema.qcRecords.shId, shId));
  if (!qc) throw new ApiError(409, "该收货单尚无检验记录");

  const supplierId = await supplierOfReceipt(db, sh.sourceType, sh.sourceId);
  const rows: {
    qcLineId: number; shLineId: number; skuId: number; skuCode: string; skuName: string;
    passQty: string; failQty: string; concessionQty: string; failHandling: string;
  }[] = await db
    .select({
      qcLineId: schema.qcLines.id,
      shLineId: schema.qcLines.shLineId,
      skuId: schema.shLines.skuId,
      skuCode: schema.skus.code,
      skuName: schema.skus.name,
      passQty: schema.qcLines.passQty,
      failQty: schema.qcLines.failQty,
      concessionQty: schema.qcLines.concessionQty,
      failHandling: schema.qcLines.failHandling,
    })
    .from(schema.qcLines)
    .innerJoin(schema.shLines, eq(schema.qcLines.shLineId, schema.shLines.id))
    .innerJoin(schema.skus, eq(schema.shLines.skuId, schema.skus.id))
    .where(eq(schema.qcLines.qcId, qc.id))
    .orderBy(schema.qcLines.id);

  // po 源：按 SKU 找到对应 PO 行（与 matflow/sh.ts inboundFromPo 的「同 SKU 计入首行」同口径）
  const poLines: { id: number; skuId: number; receivedQty: string }[] = sh.sourceType === "po"
    ? await db
      .select({ id: schema.poLines.id, skuId: schema.poLines.skuId, receivedQty: schema.poLines.receivedQty })
      .from(schema.poLines)
      .where(eq(schema.poLines.poId, sh.sourceId))
      .orderBy(schema.poLines.id)
    : [];
  const poLineBySku = new Map<number, typeof poLines[number]>();
  for (const pl of poLines) if (!poLineBySku.has(pl.skuId)) poLineBySku.set(pl.skuId, pl);

  const totals = { pass: "0", fail: "0", concession: "0", returnable: "0" };
  const lines: QcOutcomeLine[] = rows.map((r) => {
    const pl = poLineBySku.get(r.skuId) ?? null;
    // 唯一真正可退的量 = 让步接收量（W2 起确实入了库）；不合格量从未入库，合格量不属本次结论
    const wanted = dQty(r.concessionQty);
    const returnable = pl == null
      ? "0.0000"
      : dQty(dCmp(wanted, pl.receivedQty) <= 0 ? wanted : pl.receivedQty);
    totals.pass = dAdd(totals.pass, r.passQty);
    totals.fail = dAdd(totals.fail, r.failQty);
    totals.concession = dAdd(totals.concession, r.concessionQty);
    totals.returnable = dAdd(totals.returnable, returnable);
    return {
      ...r,
      failHandlingLabel: FAIL_HANDLING_LABELS[r.failHandling] ?? r.failHandling,
      poLineId: pl?.id ?? null,
      poLineReceivedQty: pl?.receivedQty ?? null,
      returnableQty: returnable,
    };
  });

  return {
    qcId: qc.id,
    shId: sh.id,
    shDocNo: sh.docNo,
    sourceType: sh.sourceType,
    sourceId: sh.sourceId,
    warehouseId: sh.warehouseId,
    supplierId,
    qualityCaseId: qc.qualityCaseId,
    returnCtId: qc.returnCtId,
    lines,
    totals: {
      pass: dQty(totals.pass), fail: dQty(totals.fail),
      concession: dQty(totals.concession), returnable: dQty(totals.returnable),
    },
    needsOutcome: dCmp(totals.fail, "0") > 0 && qc.qualityCaseId == null && qc.returnCtId == null,
  };
}

async function supplierOfReceipt(db: AnyDb, sourceType: string, sourceId: number): Promise<number | null> {
  if (sourceType === "po") {
    const [po] = await db.select({ supplierId: schema.poDocs.supplierId }).from(schema.poDocs).where(eq(schema.poDocs.id, sourceId));
    return po?.supplierId ?? null;
  }
  const [jg] = await db.select({ supplierId: schema.jgDocs.supplierId }).from(schema.jgDocs).where(eq(schema.jgDocs.id, sourceId));
  return jg?.supplierId ?? null;
}

export interface QcOutcomeResult {
  qcId: number;
  qualityCaseId: number | null;
  qualityCaseNo: string | null;
  returnCtId: number | null;
  returnCtDocNo: string | null;
  /** 为什么没开退货单（可退量为 0 时的明说，不是静默跳过） */
  returnSkippedReason: string | null;
}

/**
 * 登记不合格后果：质量案件 和/或 退货（CT）草稿，并把链接双向写回。
 *
 * 幂等/防重：同一次检验只允许各挂一条（已有案件/退货再点会 409），
 * 避免同一批不合格量被开两张退货单或两个案件——那会让扣款依据出现两份互相矛盾的口径。
 */
export async function raiseQcFailureOutcome(
  user: SessionUser,
  input: unknown,
  dbArg?: AnyDb,
): Promise<QcOutcomeResult> {
  // 谁能给不合格量定去向：质量（主责）、仓管（现场）、采购（对供应商）；admin 兜底
  requireAnyRole(user, "quality", "warehouse", "purchasing");
  const v = raiseSchema.parse(input);
  const db = await resolveDb(dbArg);
  const summary = await getQcOutcome(user, v.shId, db);
  if (dCmp(summary.totals.fail, "0") <= 0 && dCmp(summary.totals.concession, "0") <= 0) {
    throw new ApiError(409, "本次检验没有不合格量或让步量，无需登记后果");
  }
  if (v.createCase && summary.qualityCaseId != null) {
    throw new ApiError(409, `该检验已关联质量案件 #${summary.qualityCaseId}，不重复登记`);
  }
  if (v.createReturn && summary.returnCtId != null) {
    throw new ApiError(409, `该检验已关联退货单 #${summary.returnCtId}，不重复登记`);
  }

  /* 案件正文 = 这次检验的结构化事实（也是扣款依据的叙述面） */
  const failLines = summary.lines.filter((l) => dCmp(l.failQty, "0") > 0 || dCmp(l.concessionQty, "0") > 0);
  const narrative = failLines
    .map((l) => `${l.skuCode} ${l.skuName}：不合格 ${l.failQty}（${l.failHandlingLabel}）、让步 ${l.concessionQty}、可退 ${l.returnableQty}`)
    .join("；");
  const evidence = {
    qcId: summary.qcId,
    shId: summary.shId,
    shDocNo: summary.shDocNo,
    sourceType: summary.sourceType,
    sourceId: summary.sourceId,
    totals: summary.totals,
    lines: failLines.map((l) => ({
      qcLineId: l.qcLineId, skuId: l.skuId, skuCode: l.skuCode,
      failQty: l.failQty, concessionQty: l.concessionQty,
      failHandling: l.failHandling, returnableQty: l.returnableQty,
    })),
  };

  let qualityCaseId: number | null = null;
  let qualityCaseNo: string | null = null;
  if (v.createCase) {
    const created = await createQualityCase(user, {
      kind: "complaint",
      severity: v.caseSeverity,
      marketCode: "CN",
      title: `来料检验不合格 ${summary.shDocNo}`,
      summary: v.caseSummary
        ?? `收货单 ${summary.shDocNo} 检验不合格：合计不合格 ${summary.totals.fail}、让步接收 ${summary.totals.concession}。${narrative || "（无逐行明细）"}`,
      sourceChannel: "supplier",
      skuId: failLines[0]?.skuId,
      supplierId: summary.supplierId ?? undefined,
      warehouseId: summary.warehouseId,
      ownerId: v.caseOwnerId ?? user.id,
      receivedDate: todayShanghai(),
      /* 幂等键由「这次检验」推导，不是 randomUUID()（2026-09-04 安全审计 S5）：
         createQualityCase 内部有 `pg_advisory_xact_lock(hashtext(key)) + 按键查重放`，
         而每次都换一个新键等于让那道守卫永远命中不了。并发两次点「登记不合格后果」
         此前会开出**两个 QI 案件**，吃掉两个单号，在供应商记分卡的「质量案件」维度双计，
         而 qc_records 只链得回其中一个。现在两笔并发被序列化，第二笔拿回第一笔的案件。 */
      idempotencyKey: deterministicIdempotencyKey("qc-failure-case", summary.qcId),
    }, db);
    qualityCaseId = created.id;
    qualityCaseNo = created.caseNo;
  }

  let returnCtId: number | null = null;
  let returnCtDocNo: string | null = null;
  let returnSkippedReason: string | null = null;
  if (v.createReturn) {
    if (summary.sourceType !== "po") {
      returnSkippedReason = "委外（JG）收货不走采购退货单：加工不合格由 JG 链路处理，这里只登记质量案件。";
    } else {
      const returnLines = summary.lines
        .filter((l) => l.poLineId != null && dCmp(l.returnableQty, "0") > 0)
        .map((l) => ({ poLineId: l.poLineId!, skuId: l.skuId, qty: l.returnableQty, reason: v.returnReason ?? "检验不合格退货" }));
      if (returnLines.length === 0) {
        returnSkippedReason =
          "可退量为 0：不合格量从未入库（CT 的铁律是退货量 ≤ PO 行已收数），无需退货过账。"
          + "已登记的质量案件即为供应商责任与扣款依据。";
      } else {
        const ct = await createCt(user, {
          poId: summary.sourceId,
          warehouseId: summary.warehouseId,
          remark: `由检验 qc#${summary.qcId}（${summary.shDocNo}）不合格触发`,
          lines: returnLines,
        }, db);
        returnCtId = ct.id;
        returnCtDocNo = ct.docNo;
      }
    }
  }

  await db.transaction(async (tx: AnyDb) => {
    /* 读-改-写守卫（本函数开头的 `summary.qualityCaseId != null` 判断）在并发下不成立：
       两笔请求都会读到 null。这里把 qc 行锁住并把更新写成**条件更新**——
       只有仍未挂接的那一笔能写进去，另一笔在下面被明确告知它输了这场竞争。
       数据库侧还有 uq_qc_record_quality_case / uq_qc_record_return_ct 两把唯一键兜底
       （migration 0057）：即使这段逻辑将来被改坏，一次检验也挂不上两个案件/两张退货单。 */
    await tx.execute(sql`SELECT id FROM qc_records WHERE id = ${summary.qcId} FOR UPDATE`);
    const linked: { id: number }[] = await tx
      .update(schema.qcRecords)
      .set({
        ...(qualityCaseId != null ? { qualityCaseId } : {}),
        ...(returnCtId != null ? { returnCtId } : {}),
      })
      .where(and(
        eq(schema.qcRecords.id, summary.qcId),
        qualityCaseId != null ? isNull(schema.qcRecords.qualityCaseId) : undefined,
        returnCtId != null ? isNull(schema.qcRecords.returnCtId) : undefined,
      ))
      .returning({ id: schema.qcRecords.id });
    if (linked.length === 0) {
      throw new ApiError(
        409,
        `该检验的后果已由另一次提交登记（qc#${summary.qcId}）。`
        + (returnCtDocNo
          ? `本次已生成的退货草稿 ${returnCtDocNo} 未挂接，请作废后按已登记的那张处理。`
          : "本次未产生新的挂接。"),
      );
    }
    if (qualityCaseId != null) {
      // 反向链接：案件也要能说出「我是哪一次检验来的」
      await tx
        .update(schema.qualityCases)
        .set({ qcRecordId: summary.qcId, updatedAt: new Date() })
        .where(eq(schema.qualityCases.id, qualityCaseId));
    }
    await writeAudit(tx, {
      userId: user.id,
      entity: "qc",
      entityId: summary.qcId,
      action: "raise_failure_outcome",
      before: { qualityCaseId: summary.qualityCaseId, returnCtId: summary.returnCtId },
      after: {
        qualityCaseId, qualityCaseNo, returnCtId, returnCtDocNo, returnSkippedReason,
        deductionBasis: evidence,
      },
    });
  });

  return { qcId: summary.qcId, qualityCaseId, qualityCaseNo, returnCtId, returnCtDocNo, returnSkippedReason };
}

/**
 * 待处理的不合格检验（有不合格量、尚无任何后果登记）——工作台/告警的取数面。
 * 只回主键与量，不回叙述，避免把受限案件正文混进列表。
 */
export async function listQcFailuresWithoutOutcome(
  dbArg: AnyDb,
  opts: { limit?: number } = {},
): Promise<{ qcId: number; shId: number; shDocNo: string; sourceType: string; sourceId: number; failQty: string; createdAt: Date }[]> {
  const db = await resolveDb(dbArg);
  const rows: {
    qcId: number; shId: number; shDocNo: string; sourceType: string; sourceId: number;
    failQty: string | null; createdAt: Date; qualityCaseId: number | null; returnCtId: number | null;
  }[] = await db
    .select({
      qcId: schema.qcRecords.id,
      shId: schema.shDocs.id,
      shDocNo: schema.shDocs.docNo,
      sourceType: schema.shDocs.sourceType,
      sourceId: schema.shDocs.sourceId,
      failQty: schema.qcLines.failQty,
      createdAt: schema.qcRecords.createdAt,
      qualityCaseId: schema.qcRecords.qualityCaseId,
      returnCtId: schema.qcRecords.returnCtId,
    })
    .from(schema.qcRecords)
    .innerJoin(schema.shDocs, eq(schema.qcRecords.shId, schema.shDocs.id))
    .innerJoin(schema.qcLines, eq(schema.qcLines.qcId, schema.qcRecords.id));

  const byQc = new Map<number, { qcId: number; shId: number; shDocNo: string; sourceType: string; sourceId: number; failQty: string; createdAt: Date }>();
  const settled = new Set<number>();
  for (const r of rows) {
    if (r.qualityCaseId != null || r.returnCtId != null) settled.add(r.qcId);
    const cur = byQc.get(r.qcId) ?? {
      qcId: r.qcId, shId: r.shId, shDocNo: r.shDocNo, sourceType: r.sourceType,
      sourceId: r.sourceId, createdAt: r.createdAt, failQty: "0",
    };
    cur.failQty = dAdd(cur.failQty, r.failQty ?? "0");
    byQc.set(r.qcId, cur);
  }
  return [...byQc.values()]
    .filter((r) => dCmp(r.failQty, "0") > 0 && !settled.has(r.qcId))
    .map((r) => ({ ...r, failQty: dQty(r.failQty) }))
    .sort((a, b) => dCmp(b.failQty, a.failQty) || a.qcId - b.qcId)
    .slice(0, Math.max(1, opts.limit ?? 200));
}
