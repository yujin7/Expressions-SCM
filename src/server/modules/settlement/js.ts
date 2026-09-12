import { createHash } from "node:crypto";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import {
   approvals, pcDocs, flDocs, flLines, jgDocs, jgFeeSegments, jsDocs, jsLines,
  shDocs, shLines, qcLines, skus, suppliers, sysParams,
  tlDocs, tlLines, users, warehouses, woDocs, woLines,
} from "@/db/schema";
import { PARAM_KEYS } from "@/server/core/constants";
import { dAdd, dCmp, dDiv, dMoney, dMul, dNeg, dQty, dSub, dZero } from "@/server/core/decimal";
import { currentWriteActor } from "@/server/core/current-write-actor";
import { processingFeeAt } from "@/server/rules/processing-fee";
import { canSeePrices, type SessionUser } from "@/server/core/dto";
import { writeAudit } from "@/server/core/audit";
import { approvalRoleError, approveDoc, loadApprovalHistory } from "@/server/docflow/approval";
import { nextDocNo } from "@/server/docflow/doc-no";
import { nextStatus, TransitionError, type DocStatus } from "@/server/docflow/state";
import { ApiError } from "@/server/modules/master/common";
import {
  type AnyDb, requireAnyRole, resolveDb, rethrowApproval,
} from "@/server/modules/outsource/common";
import { currentPriceListRow } from "@/server/modules/outsource/price-list";
import { post } from "@/server/posting";
import { settle, type SettleResult } from "@/server/rules/settlement";
import { approveJsSchema, closeJgSchema, createJsSchema, refreshJsBasisSchema, submitJsSchema } from "./schemas";
import { loadSettlementReadPolicy } from "./read-access";
import { loadUserScopes } from "@/server/core/data-scope";

/** CurrentWriteActor holds the user lock; never trust a caller-supplied unrestricted scope. */
async function assertSettlementWriteAccess(tx: AnyDb, actor: SessionUser) {
  const scopes = await loadUserScopes(tx, actor.id);
  if (!(await loadSettlementReadPolicy(tx, { ...actor, ...scopes })).allowed) {
    throw new ApiError(403, "当前角色或渠道范围不可处理结算单，请联系管理员核对权限");
  }
}

/**
 * 委外结算单 JS（R5 逐物料，《01》§5）——本系统的"出钱口"。
 * 数学唯一权威 = rules/settlement.ts settle()，本模块只负责取数与落库；
 * 审批（js→finance，seed 已含）通过即同事务过账 js_loss_writeoff：
 * 委外仓 − 实际损耗（带内不计价核销）；核销后该 JG 委外仓余额必须=0，
 * 残留（负实际损耗=结余）强制先走 TL 退料或财务短溢说明（acknowledgeSurplus）。
 */

type JsRow = typeof jsDocs.$inferSelect;
type JgRow = typeof jgDocs.$inferSelect;

/** 收货口径：已审批/已完成的 SH 计入合格与让步（备品要求已入库=completed） */
const RECEIVED_SH_STATUSES: DocStatus[] = ["approved", "completed"];
/** 发/退料口径：审批过账后的单据（approved 或其后的 completed） */
const POSTED_DOC_STATUSES: DocStatus[] = ["approved", "completed"];

// ---------- 扣款取价（D23 候选偏差——务必让财务知晓口径） ----------

/**
 * ⚠ 扣款单价代理口径（D23 候选偏差）：
 * 《01》§5 R5 规定扣款价 = "当月加权平均价"，但 1.0 阶段没有成本台账
 * （加权平均价的数据源 P1 才建）。此处以 price_lists 最新价（生效日≤今日，
 * 任一供应商中生效日最新者）**代理**，DTO/详情携带
 * deductPriceSource: "price_list_proxy" 供财务识别口径；无价格行 → 0 并出警告。
 * P1 成本台账上线后，仅需替换本函数实现。
 */
export async function getDeductPrice(db: AnyDb, skuId: number): Promise<string | null> {
  // 生效日口径唯一权威 = outsource/price-list.currentPriceListRow（价目表维护页写、这里读，同一取行规则）；
  // supplierId 省略 = 跨供应商取最新，是本代理口径的既有定义（D23 已披露），不是遗漏。
  const row = await currentPriceListRow(db, { skuId });
  return row?.price ?? null;
}

/** 品类允许损耗率（R2 唯一来源=sys_param scope=category:<lossCategory>）；缺失→null */
async function getLossRatePct(db: AnyDb, lossCategory: string | null): Promise<string | null> {
  if (!lossCategory) return null;
  const [row]: { value: string }[] = await db
    .select({ value: sysParams.value })
    .from(sysParams)
    .where(and(eq(sysParams.scope, `category:${lossCategory}`), eq(sysParams.key, PARAM_KEYS.lossRatePct)));
  return row?.value ?? null;
}

/** 全局参数（缺失走默认值） */
async function getGlobalParam(db: AnyDb, key: string, fallback: string): Promise<string> {
  const [row]: { value: string }[] = await db
    .select({ value: sysParams.value })
    .from(sysParams)
    .where(and(eq(sysParams.scope, "global"), eq(sysParams.key, key)));
  return row?.value ?? fallback;
}

// ---------- 预览（createJs 复用同一取数与计算） ----------

export type JsPreviewLine = {
  materialSkuId: number;
  skuCode: string;
  skuName: string;
  qtyPer: string;
  issuedQty: string;
  returnedQty: string;
  allowedLossRatePct: string;
  stdQty: string;
  allowedLoss: string;
  actualLoss: string;
  excessLoss: string;
  deductPrice: string; // 敏感（R9）——路由边界 maskSensitive 剥离
  deductAmount: string; // 敏感
};

export type JsPreview = {
  jgId: number;
  jgDocNo: string;
  jgStatus: string;
  woId: number;
  supplierId: number;
  goodQty: string;
  concessionQty: string;
  spareQty: string;
  effectiveQty: string;
  /** 分段 rate → DTO 键名 feeRate（SENSITIVE_FIELDS 收录 feeRate，保证脱敏可剥） */
  feeSegments: { qty: string; feeRate: string }[];
  retrospectivePc: { id: number; docNo: string; approvedAt: Date } | null;
  concessionPrice: string; // 敏感
  feePayable: string; // 敏感
  deductionTotal: string; // 敏感
  manualAdj: string; // 敏感
  settleAmount: string; // 敏感
  lines: JsPreviewLine[];
  /** 负实际损耗（结余）物料——审批时强制先退料(TL)或财务短溢确认 */
  surplusMaterials: { skuId: number; skuCode: string; surplus: string }[];
  warnings: string[];
  /** 扣款价口径标识（见 getDeductPrice；D23 候选偏差） */
  deductPriceSource: "price_list_proxy";
};

export async function previewJs(jgId: number, manualAdj = "0", dbArg?: AnyDb): Promise<JsPreview> {
  const db = await resolveDb(dbArg);

  const [jg]: JgRow[] = await db.select().from(jgDocs).where(eq(jgDocs.id, jgId));
  if (!jg) throw new ApiError(404, `加工通知单不存在: #${jgId}`);

  const warnings: string[] = [];

  // ---- 完工数：QC 行（合格/让步）按 SH 行类型归集；备品=已入库 SH 的备品行实收 ----
  const qcRows: {
    shId: number; shStatus: string; shCreatedAt: Date; lineType: string;
    passQty: string; concessionQty: string;
  }[] = await db
    .select({
      shId: shDocs.id,
      shStatus: shDocs.status,
      shCreatedAt: shDocs.createdAt,
      lineType: shLines.lineType,
      passQty: qcLines.passQty,
      concessionQty: qcLines.concessionQty,
    })
    .from(qcLines)
    .innerJoin(shLines, eq(qcLines.shLineId, shLines.id))
    .innerJoin(shDocs, eq(shLines.shId, shDocs.id))
    .where(
      and(
        eq(shDocs.sourceType, "jg"),
        eq(shDocs.sourceId, jgId),
        inArray(shDocs.status, RECEIVED_SH_STATUSES),
      ),
    );

  let goodQty = "0";
  let concessionQty = "0";
  const goodByShId = new Map<number, { createdAt: Date; qty: string }>(); // 分段计价用
  for (const r of qcRows) {
    if (r.lineType !== "normal" && r.lineType !== "rework") continue; // 备品行不占完工数口径的合格/让步
    goodQty = dAdd(goodQty, r.passQty, 4);
    concessionQty = dAdd(concessionQty, r.concessionQty, 4);
    const acc = goodByShId.get(r.shId);
    goodByShId.set(r.shId, {
      createdAt: r.shCreatedAt,
      qty: acc ? dAdd(acc.qty, r.passQty, 4) : dQty(r.passQty),
    });
  }

  const spareRows: { qty: string | null }[] = await db
    .select({ qty: sql<string | null>`sum(${shLines.actualQty})` })
    .from(shLines)
    .innerJoin(shDocs, eq(shLines.shId, shDocs.id))
    .where(
      and(
        eq(shDocs.sourceType, "jg"),
        eq(shDocs.sourceId, jgId),
        eq(shDocs.status, "completed"), // 备品以已入库（SH 完成）为准
        eq(shLines.lineType, "spare"),
      ),
    );
  const spareQty = dQty(spareRows[0]?.qty ?? "0");

  // ---- 加工费分段：每张 SH 的合格数 × 该 SH 创建时点生效的分段费率 ----
  const segments: { rate: string; effectiveFrom: Date }[] = await db
    .select({ rate: jgFeeSegments.rate, effectiveFrom: jgFeeSegments.effectiveFrom })
    .from(jgFeeSegments)
    .where(eq(jgFeeSegments.jgId, jgId))
    .orderBy(asc(jgFeeSegments.effectiveFrom), asc(jgFeeSegments.id));

  // Use the actual approved PC and its exact approval cycle, not matching price/time guesses.
  const retros: { id: number; docNo: string; rate: string; approvedAt: Date; approvalId: number | null }[] = await db
    .select({ id: pcDocs.id, docNo: pcDocs.docNo, rate: pcDocs.newPrice, approvedAt: pcDocs.updatedAt, approvalId: approvals.id })
    .from(pcDocs).leftJoin(approvals, and(eq(approvals.docType, "pc"), eq(approvals.docId, pcDocs.id),
      eq(approvals.action, "approve"), eq(approvals.cycle, sql`${pcDocs.version} - 1`)))
    .where(and(eq(pcDocs.jgId, jgId), eq(pcDocs.target, "jg_fee"), eq(pcDocs.status, "approved"), eq(pcDocs.scope, "retroactive")))
    .orderBy(desc(pcDocs.updatedAt), desc(approvals.id));
  if (retros.some(r => r.approvalId == null)) throw new ApiError(409, "追溯改价缺少对应审批依据，请核对PC审批记录后再计算结算");
  const latestRetro = retros[0];
  const retroactive = latestRetro?.approvedAt ? { rate: latestRetro.rate, approvedAt: latestRetro.approvedAt } : undefined;
  if (latestRetro) warnings.push(`合格收货已按追溯改价 ${latestRetro.docNo} 重算；之后的新时段价格继续生效。已审批结算不自动改写。`);
  if (segments.length === 0 && goodByShId.size > 0) {
    warnings.push("该 JG 无加工费分段记录，按现价单段计价");
  }

  // 按费率归并（保持分段先后次序）
  const segAgg: { qty: string; feeRate: string }[] = [];
  const shEntries = [...goodByShId.values()].sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
  );
  for (const e of shEntries) {
    if (dZero(e.qty)) continue;
    const rate = processingFeeAt(e.createdAt, segments, jg.feeRateCurrent, retroactive);
    const last = segAgg[segAgg.length - 1];
    if (last && dCmp(last.feeRate, rate) === 0) last.qty = dAdd(last.qty, e.qty, 4);
    else segAgg.push({ qty: dQty(e.qty), feeRate: dMoney(rate) });
  }

  // 让步单价 = JG 加工费现价 × concession_price_ratio%（D6 默认全价，财务审批）
  const ratio = await getGlobalParam(db, PARAM_KEYS.concessionPriceRatio, "100");
  const concessionPrice = dMoney(dMul(jg.feeRateCurrent, dDiv(ratio, "100", 6), 6));

  // ---- 物料行：WO 快照行（wo_lines）为物料集；FL/TL 审批后口径累计 ----
  const materialRows: {
    materialSkuId: number; qtyPer: string; skuCode: string; skuName: string;
    lossCategory: string | null;
  }[] = await db
    .select({
      materialSkuId: woLines.materialSkuId,
      qtyPer: woLines.qtyPer,
      skuCode: skus.code,
      skuName: skus.name,
      lossCategory: skus.lossCategory,
    })
    .from(woLines)
    .innerJoin(skus, eq(woLines.materialSkuId, skus.id))
    .where(eq(woLines.woId, jg.woId))
    .orderBy(asc(woLines.id));

  const issuedRows: { skuId: number; qty: string | null }[] = await db
    .select({ skuId: flLines.skuId, qty: sql<string | null>`sum(${flLines.qty})` })
    .from(flLines)
    .innerJoin(flDocs, eq(flLines.flId, flDocs.id))
    .where(and(eq(flDocs.jgId, jgId), inArray(flDocs.status, POSTED_DOC_STATUSES)))
    .groupBy(flLines.skuId);
  const issuedBySku = new Map(issuedRows.map((r) => [r.skuId, dQty(r.qty ?? "0")]));

  const returnedRows: { skuId: number; qty: string | null }[] = await db
    .select({ skuId: tlLines.skuId, qty: sql<string | null>`sum(${tlLines.qty})` })
    .from(tlLines)
    .innerJoin(tlDocs, eq(tlLines.tlId, tlDocs.id))
    .where(and(eq(tlDocs.jgId, jgId), inArray(tlDocs.status, POSTED_DOC_STATUSES)))
    .groupBy(tlLines.skuId);
  const returnedBySku = new Map(returnedRows.map((r) => [r.skuId, dQty(r.qty ?? "0")]));

  // 发料含 WO 物料集之外的 SKU → 该料完全逃出结算口径，必须提示
  const materialSkuSet = new Set(materialRows.map((m) => m.materialSkuId));
  for (const r of issuedRows) {
    if (!materialSkuSet.has(r.skuId)) {
      warnings.push(`发料含 WO 物料清单之外的 SKU#${r.skuId}，未纳入结算扣款口径`);
    }
  }

  // A material may occur on several WO snapshot lines. Its issued/returned totals belong
  // to the SKU once, not to each BOM component row; sum its per-unit requirement first.
  const materialBySku = new Map<number, typeof materialRows[number]>();
  for (const row of materialRows) {
    const previous = materialBySku.get(row.materialSkuId);
    materialBySku.set(row.materialSkuId, { ...row, qtyPer: dAdd(previous?.qtyPer ?? "0", row.qtyPer, 4) });
  }
  const settleMaterials = [];
  const lineMeta: { skuCode: string; skuName: string; issuedQty: string; returnedQty: string; allowedLossRatePct: string; qtyPer: string }[] = [];
  for (const m of materialBySku.values()) {
    const lossRate = await getLossRatePct(db, m.lossCategory);
    if (lossRate == null) {
      warnings.push(
        `物料 ${m.skuCode} 无品类损耗率参数（lossCategory=${m.lossCategory ?? "空"}），按 0% 计算`,
      );
    }
    const price = await getDeductPrice(db, m.materialSkuId);
    if (price == null) {
      warnings.push(`物料 ${m.skuCode} 无价格表记录，扣款单价按 0 计算——请先到「采购价目表」（/outsource/price-list）维护基准价`);
    }
    const issuedQty = issuedBySku.get(m.materialSkuId) ?? "0";
    const returnedQty = returnedBySku.get(m.materialSkuId) ?? "0";
    settleMaterials.push({
      materialSkuId: m.materialSkuId,
      qtyPer: m.qtyPer,
      issuedQty,
      returnedQty,
      allowedLossRatePct: lossRate ?? "0",
      avgPrice: price ?? "0",
    });
    lineMeta.push({
      skuCode: m.skuCode,
      skuName: m.skuName,
      issuedQty,
      returnedQty,
      allowedLossRatePct: lossRate ?? "0",
      qtyPer: m.qtyPer,
    });
  }

  // ---- R5 数学唯一权威：rules/settlement.settle() ----
  const result: SettleResult = settle({
    goodQty,
    concessionQty,
    spareQty,
    feeSegments: segAgg.map((s) => ({ qty: s.qty, rate: s.feeRate })),
    concessionPrice,
    manualAdj,
    materials: settleMaterials,
  });

  const lines: JsPreviewLine[] = result.lines.map((l, idx) => ({
    materialSkuId: l.materialSkuId,
    skuCode: lineMeta[idx].skuCode,
    skuName: lineMeta[idx].skuName,
    qtyPer: lineMeta[idx].qtyPer,
    issuedQty: lineMeta[idx].issuedQty,
    returnedQty: lineMeta[idx].returnedQty,
    allowedLossRatePct: lineMeta[idx].allowedLossRatePct,
    stdQty: l.stdQty,
    allowedLoss: l.allowedLoss,
    actualLoss: l.actualLoss,
    excessLoss: l.excessLoss,
    deductPrice: dMoney(l.deductPrice),
    deductAmount: l.deductAmount,
  }));

  // 结余（负实际损耗）：残差=发料−退料−净标准用量−实际损耗≡0（构造恒等），
  // 故余料全部体现为负实际损耗——审批前必须 TL 退回或财务短溢确认（《01》§4 核销后余额=0）
  const surplusMaterials = lines
    .filter((l) => dCmp(l.actualLoss, "0") < 0)
    .map((l) => ({ skuId: l.materialSkuId, skuCode: l.skuCode, surplus: dNeg(l.actualLoss) }));

  return {
    jgId: jg.id,
    jgDocNo: jg.docNo,
    jgStatus: jg.status,
    woId: jg.woId,
    supplierId: jg.supplierId,
    goodQty: dQty(goodQty),
    concessionQty: dQty(concessionQty),
    spareQty,
    effectiveQty: result.effectiveQty,
    feeSegments: segAgg,
    retrospectivePc: latestRetro?.approvedAt ? { id: latestRetro.id, docNo: latestRetro.docNo, approvedAt: latestRetro.approvedAt } : null,
    concessionPrice,
    feePayable: result.feePayable,
    deductionTotal: result.deductionTotal,
    manualAdj: dMoney(manualAdj),
    settleAmount: result.settleAmount,
    lines,
    surplusMaterials,
    warnings,
    deductPriceSource: "price_list_proxy",
  };
}

// ---------- JG 收货关闭（in_progress → completed，开 JS 的门） ----------

/**
 * JG 完成动作在 outsource 模块（W3）中不存在（其状态止于 confirm→in_progress），
 * 而 JS 依赖"收货关闭/短关后可开"（《01》§3）——故收货关闭动作落在结算模块：
 * PMC 确认收货闭环后 in_progress ─complete→ completed。短关（short_close）仍走
 * 通用状态机（未实现专门入口，closed 的 JG 同样可开 JS）。
 */
export async function closeJgReceiving(
  user: SessionUser,
  jgId: number,
  version: number,
  dbArg?: AnyDb,
): Promise<JgRow> {
  const db = await resolveDb(dbArg);
  return db.transaction(async (tx: AnyDb) => {
  const actor = await currentWriteActor(tx, user); requireAnyRole(actor, "pmc");
  const [jg]: JgRow[] = await tx.select().from(jgDocs).where(eq(jgDocs.id, jgId)).for("update");
  if (!jg) throw new ApiError(404, `加工通知单不存在: #${jgId}`);
  let target: DocStatus;
  try {
    target = nextStatus(jg.status as DocStatus, "complete");
  } catch (e) {
    if (e instanceof TransitionError) throw new ApiError(409, `当前状态不可关闭收货: ${jg.status}`);
    throw e;
  }
  const updated: JgRow[] = await tx
    .update(jgDocs)
    .set({ status: target, inProduction: false, version: sql`${jgDocs.version} + 1`, updatedAt: new Date() })
    .where(and(eq(jgDocs.id, jgId), eq(jgDocs.version, version)))
    .returning();
  if (updated.length === 0) throw new ApiError(409, `版本冲突：期望版本 ${version} 已过期`);
  await writeAudit(tx, { userId: actor.id, entity: "jg", entityId: jgId, action: "complete" });
  return updated[0];
  });
}

// ---------- 创建 ----------

export async function createJs(user: SessionUser, input: unknown, dbArg?: AnyDb): Promise<JsRow & { lines: (typeof jsLines.$inferSelect)[] }> {
  const v = createJsSchema.parse(input);
  const db = await resolveDb(dbArg);
  return db.transaction(async (tx: AnyDb) => {
  const actor = await currentWriteActor(tx, user);
  await assertSettlementWriteAccess(tx, actor);
  requireAnyRole(actor, "pmc"); // 《01》§6：JS 制单=PMC
  const [jg]: JgRow[] = await tx.select().from(jgDocs).where(eq(jgDocs.id, v.jgId)).for("update");
  if (!jg) throw new ApiError(404, `加工通知单不存在: #${v.jgId}`);
  // 收货关闭（completed）或短关（closed）后方可开结算（《01》§3 JS）
  if (jg.status !== "completed" && jg.status !== "closed") {
    throw new ApiError(409, `JG 尚未收货关闭（当前状态 ${jg.status}），不可发起结算`);
  }

  // 一 JG 一 JS（应用层先查友好报错；schema UNIQUE(jg_id) 并发兜底）
  const [existing] = await tx
    .select({ docNo: jsDocs.docNo })
    .from(jsDocs)
    .where(eq(jsDocs.jgId, v.jgId));
  if (existing) throw new ApiError(409, `该 JG 已存在结算单 ${existing.docNo}（一 JG 一 JS）`);

  const preview = await previewJs(v.jgId, v.manualAdj, tx);
    const docNo = await nextDocNo(tx, "JS");
    const [doc]: JsRow[] = await tx
      .insert(jsDocs)
      .values({
        docNo,
        status: "draft",
        remark: v.remark ?? (v.manualAdjNote ? `手工调整说明：${v.manualAdjNote}` : null),
        jgId: v.jgId,
        goodQty: preview.goodQty,
        concessionQty: preview.concessionQty,
        spareQty: preview.spareQty,
        feePayable: preview.feePayable,
        concessionPrice: preview.concessionPrice,
        deductionTotal: preview.deductionTotal,
        manualAdj: preview.manualAdj,
        settleAmount: preview.settleAmount,
        createdBy: actor.id,
      })
      .returning();
    const insertedLines: (typeof jsLines.$inferSelect)[] = preview.lines.length
      ? await tx
          .insert(jsLines)
          .values(
            preview.lines.map((l) => ({
              jsId: doc.id,
              materialSkuId: l.materialSkuId,
              issuedQty: l.issuedQty,
              returnedQty: l.returnedQty,
              stdQty: l.stdQty,
              allowedLoss: l.allowedLoss,
              actualLoss: l.actualLoss,
              excessLoss: l.excessLoss,
              deductPrice: l.deductPrice,
              deductAmount: l.deductAmount,
            })),
          )
          .returning()
      : [];
    await writeAudit(tx, {
      userId: actor.id,
      entity: "js",
      entityId: doc.id,
      action: "create",
      after: {
        docNo,
        jgId: v.jgId,
        manualAdj: preview.manualAdj,
        manualAdjNote: v.manualAdjNote ?? null, // 手工调整留痕（R5）
        settleAmount: preview.settleAmount,
        warnings: preview.warnings,
        deductPriceSource: preview.deductPriceSource,
        retrospectivePc: preview.retrospectivePc,
      },
    });
    return { ...doc, lines: insertedLines };
  });
}

// ---------- 提交 ----------

/** Same lock order as PC approval: JG authority before settlement document. */
async function lockedJs(tx: AnyDb, id: number): Promise<JsRow> {
  const [target]: JsRow[] = await tx.select().from(jsDocs).where(eq(jsDocs.id, id));
  if (!target) throw new ApiError(404, "单据不存在");
  await tx.select({ id: jgDocs.id }).from(jgDocs).where(eq(jgDocs.id, target.jgId)).for("update");
  const [doc]: JsRow[] = await tx.select().from(jsDocs).where(eq(jsDocs.id, id)).for("update");
  return doc;
}

async function currentFeePreview(tx: AnyDb, doc: JsRow) {
  const preview = await previewJs(doc.jgId, doc.manualAdj, tx);
  if ((["goodQty", "concessionQty", "spareQty"] as const).some(k => dCmp(doc[k], preview[k]) !== 0)) {
    throw new ApiError(409, "结算收货数量依据已变化，请先核对收货与质检；不能只更新加工费");
  }
  return preview;
}

async function assertCurrentFee(tx: AnyDb, doc: JsRow) {
  const preview = await currentFeePreview(tx, doc);
  if (dCmp(doc.feePayable, preview.feePayable) !== 0 || dCmp(doc.concessionPrice, preview.concessionPrice) !== 0) {
    throw new ApiError(409, "加工费依据已变化：草稿请先更新加工费；待审批单请由财务驳回后更新再提交");
  }
  const savedLines = await tx.select().from(jsLines).where(eq(jsLines.jsId, doc.id));
  if (basisKey(doc, savedLines) !== basisKey(preview, preview.lines)) {
    throw new ApiError(409, "结算物料或扣款依据已变化，请核对结算依据；草稿由PMC更新，待审批单先驳回，不能按旧依据批准");
  }
}

const BASIS_HEADER_FIELDS = ["goodQty", "concessionQty", "spareQty", "feePayable", "concessionPrice", "deductionTotal", "manualAdj", "settleAmount"] as const;
const BASIS_LINE_FIELDS = ["issuedQty", "returnedQty", "stdQty", "allowedLoss", "actualLoss", "excessLoss", "deductPrice", "deductAmount"] as const;
type BasisHeader = Pick<JsRow, typeof BASIS_HEADER_FIELDS[number]>;
type BasisLine = Pick<typeof jsLines.$inferSelect, "materialSkuId" | typeof BASIS_LINE_FIELDS[number]>;
function basisKey(header: BasisHeader, lines: BasisLine[]) {
  return JSON.stringify({ header: BASIS_HEADER_FIELDS.map(k => dQty(header[k])),
    lines: lines.map(l => [l.materialSkuId, ...BASIS_LINE_FIELDS.map(k => dQty(l[k]))])
      .sort((a, b) => Number(a[0]) - Number(b[0]) || JSON.stringify(a).localeCompare(JSON.stringify(b))) });
}

async function readBasis(tx: AnyDb, doc: JsRow) {
  const savedLines = await tx.select({ ...getJsLineColumns(), skuCode: skus.code, skuName: skus.name })
    .from(jsLines).innerJoin(skus, eq(jsLines.materialSkuId, skus.id)).where(eq(jsLines.jsId, doc.id)).orderBy(asc(jsLines.id));
  const current = await previewJs(doc.jgId, doc.manualAdj, tx);
  const saved = { ...Object.fromEntries(BASIS_HEADER_FIELDS.map(k => [k, doc[k]])) as BasisHeader, lines: savedLines };
  const savedKey = basisKey(doc, savedLines), currentKey = basisKey(current, current.lines);
  // Freshness token binds the exact reviewed persisted version and current calculations.
  // It grants no authority and contains no raw monetary facts.
  const basisToken = createHash("sha256").update(JSON.stringify([doc.id, doc.version, savedKey, currentKey, current.warnings])).digest("hex");
  return { id: doc.id, docNo: doc.docNo, version: doc.version, status: doc.status,
    saved, current, changed: savedKey !== currentKey, basisToken };
}

function getJsLineColumns() {
  return { materialSkuId: jsLines.materialSkuId, issuedQty: jsLines.issuedQty, returnedQty: jsLines.returnedQty,
    stdQty: jsLines.stdQty, allowedLoss: jsLines.allowedLoss, actualLoss: jsLines.actualLoss, excessLoss: jsLines.excessLoss,
    deductPrice: jsLines.deductPrice, deductAmount: jsLines.deductAmount };
}

/** Read-only review, including frozen history. Never replaces the saved document on GET. */
export async function getJsBasis(user: SessionUser, id: number, dbArg?: AnyDb) {
  const db = await resolveDb(dbArg);
  if (!(await loadSettlementReadPolicy(db, user)).allowed || !canSeePrices(user.roles)) {
    throw new ApiError(403, "无权限核对结算金额依据");
  }
  return db.transaction(async (tx: AnyDb) => readBasis(tx, await lockedJs(tx, id)));
}

/** Explicit reviewed draft recovery. No ledger effects; immutable approvals and frozen JS stay intact. */
export async function refreshJsBasis(user: SessionUser, id: number, input: unknown, dbArg?: AnyDb) {
  const v = refreshJsBasisSchema.parse(input), db = await resolveDb(dbArg);
  return db.transaction(async (tx: AnyDb) => {
    const actor = await currentWriteActor(tx, user); requireAnyRole(actor, "pmc");
    await assertSettlementWriteAccess(tx, actor);
    const doc = await lockedJs(tx, id);
    if (doc.status !== "draft" || doc.version !== v.version) throw new ApiError(409, "仅当前版本草稿可更新依据；待审批单先驳回，已审批结算请交财务处理差额");
    const review = await readBasis(tx, doc);
    if (review.basisToken !== v.basisToken) throw new ApiError(409, "核对后结算依据又有变化，请重新读取并核对，不会自动覆盖");
    if (!review.changed) return doc;
    const values = Object.fromEntries(BASIS_HEADER_FIELDS.map(k => [k, review.current[k]])) as BasisHeader;
    // Draft rows have never been posted; replace the snapshot as one versioned transaction.
    await tx.delete(jsLines).where(eq(jsLines.jsId, id));
    if (review.current.lines.length) await tx.insert(jsLines).values(review.current.lines.map(l => ({ jsId: id,
      materialSkuId: l.materialSkuId, ...Object.fromEntries(BASIS_LINE_FIELDS.map(k => [k, l[k]])) as Omit<BasisLine, "materialSkuId"> })));
    const [updated]: JsRow[] = await tx.update(jsDocs).set({ ...values, version: sql`${jsDocs.version} + 1`, updatedAt: new Date() })
      .where(eq(jsDocs.id, id)).returning();
    await writeAudit(tx, { userId: actor.id, entity: "js", entityId: id, action: "refresh_basis",
      before: review.saved, after: { ...values, lines: review.current.lines, note: v.note, warnings: review.current.warnings,
        deductPriceSource: review.current.deductPriceSource, retrospectivePc: review.current.retrospectivePc } });
    return updated;
  });
}

/** Explicit fee-only draft refresh: preserve material deductions, manual adjustments and posted history. */
export async function refreshJsFee(user: SessionUser, id: number, input: unknown, dbArg?: AnyDb) {
  const { version } = submitJsSchema.parse(input), db = await resolveDb(dbArg);
  return db.transaction(async (tx: AnyDb) => {
    const actor = await currentWriteActor(tx, user); requireAnyRole(actor, "pmc");
    await assertSettlementWriteAccess(tx, actor);
    const doc = await lockedJs(tx, id);
    if (doc.status !== "draft" || doc.version !== version) throw new ApiError(409, "仅当前版本草稿可更新加工费，请刷新核对");
    const preview = await currentFeePreview(tx, doc);
    const settleAmount = dMoney(dAdd(dSub(preview.feePayable, doc.deductionTotal), doc.manualAdj));
    const [updated]: JsRow[] = await tx.update(jsDocs).set({ feePayable: preview.feePayable, concessionPrice: preview.concessionPrice,
      settleAmount, version: sql`${jsDocs.version} + 1`, updatedAt: new Date() }).where(eq(jsDocs.id, id)).returning();
    await writeAudit(tx, { userId: actor.id, entity: "js", entityId: id, action: "refresh_fee",
      before: { feePayable: doc.feePayable, concessionPrice: doc.concessionPrice, settleAmount: doc.settleAmount },
      after: { feePayable: updated.feePayable, concessionPrice: updated.concessionPrice, settleAmount, retrospectivePc: preview.retrospectivePc } });
    return updated;
  });
}

export async function submitJs(user: SessionUser, id: number, input: unknown, dbArg?: AnyDb): Promise<JsRow> {
  const { version } = submitJsSchema.parse(input);
  const db = await resolveDb(dbArg);
  return db.transaction(async (tx: AnyDb) => {
  const actor = await currentWriteActor(tx, user), doc = await lockedJs(tx, id);
  await assertSettlementWriteAccess(tx, actor);
  if (doc.createdBy !== actor.id && !actor.roles.includes("pmc") && !actor.roles.includes("admin")) {
    throw new ApiError(403, "仅制单人/PMC/管理员可提交");
  }
  if (doc.status !== "draft") throw new ApiError(409, `当前状态不可提交: ${doc.status}`);
  await assertCurrentFee(tx, doc);
  const updated: JsRow[] = await tx
    .update(jsDocs)
    .set({ status: "pending", version: sql`${jsDocs.version} + 1`, updatedAt: new Date() })
    .where(and(eq(jsDocs.id, id), eq(jsDocs.version, version)))
    .returning();
  if (updated.length === 0) throw new ApiError(409, `版本冲突：期望版本 ${version} 已过期`);
  await writeAudit(tx, { userId: actor.id, entity: "js", entityId: id, action: "submit" });
  return updated[0];
  });
}

// ---------- 审批（财务）→ 同事务损耗核销过账 → completed ----------

export async function approveJs(
  user: SessionUser,
  id: number,
  input: unknown,
  dbArg?: AnyDb,
): Promise<{ status: string; idempotent: boolean }> {
  const v = approveJsSchema.parse(input);
  const db = await resolveDb(dbArg);

  try {
    return await db.transaction(async (tx: AnyDb) => {
      const actor = await currentWriteActor(tx, user), doc = await lockedJs(tx, id);
      await assertSettlementWriteAccess(tx, actor);
      const r = await approveDoc(tx, {
        docType: "js", table: jsDocs, docId: id, approver: actor,
        action: v.action, comment: v.comment, expectedVersion: v.version,
      });
      if (r.idempotent) return r;
      // Configuration alone cannot grant review of amounts hidden by the DTO policy.
      // Rejection remains available to an otherwise qualified checker for recovery.
      // A new-action refusal rolls back approveDoc too; completed-cycle retries have no financial effects.
      if (v.action === "approve" && !canSeePrices(actor.roles)) {
        throw new ApiError(403, "当前角色不可查看结算金额，不能审批通过；请联系管理员配置具备金额查看权限的审批人，或驳回交PMC核对");
      }
      const lines: (typeof jsLines.$inferSelect)[] = await tx
        .select()
        .from(jsLines)
        .where(eq(jsLines.jsId, id))
        .orderBy(asc(jsLines.id));

      // 结余闸门（《01》§4：核销后该 JG 委外仓余额必须=0）：
      // 负实际损耗=真实结余仍压在委外仓——通过前必须 TL 退回，或财务显式短溢确认。
      // 仅在真实待审（pending）时拦截：幂等重试/非法状态交给 approveDoc 按 R10 语义处理
      if (v.action === "approve" && doc.status === "pending") {
        const surplus = lines.filter((l) => dCmp(l.actualLoss, "0") < 0);
        if (surplus.length > 0 && !v.acknowledgeSurplus) {
          const skuRows: { id: number; code: string }[] = await tx
            .select({ id: skus.id, code: skus.code })
            .from(skus)
            .where(inArray(skus.id, surplus.map((l) => l.materialSkuId)));
          const codeById = new Map(skuRows.map((s) => [s.id, s.code]));
          const detail = surplus
            .map((l) => `物料${codeById.get(l.materialSkuId) ?? `#${l.materialSkuId}`}结余${dNeg(l.actualLoss)}未退`)
            .join("；");
          { const e = new ApiError(409, `${detail}，请先退料(TL)或短溢说明后确认（acknowledgeSurplus）`); e.code = "SURPLUS_UNACKED"; throw e; }
        }
      }

      if (v.action === "approve") await assertCurrentFee(tx, doc);

      await writeAudit(tx, {
        userId: actor.id,
        entity: "js",
        entityId: id,
        action: v.action,
        after: {
          comment: v.comment ?? null,
          ...(v.acknowledgeSurplus
            ? { acknowledgeSurplus: true, surplusNote: v.surplusNote ?? null } // 短溢确认留痕
            : {}),
        },
      });
      if (v.action === "reject") return r;

      // ---- 同事务过账 js_loss_writeoff：委外仓 − 实际损耗（仅正损耗；带内不计价核销） ----
      const [jg]: { supplierId: number }[] = await tx
        .select({ supplierId: jgDocs.supplierId })
        .from(jgDocs)
        .where(eq(jgDocs.id, doc.jgId));
      const [wh]: { id: number }[] = await tx
        .select({ id: warehouses.id })
        .from(warehouses)
        .where(and(eq(warehouses.kind, "outsource"), eq(warehouses.supplierId, jg?.supplierId ?? -1)));
      if (!wh) throw new ApiError(500, "该加工厂无委外仓——无法核销损耗，请先维护仓库档案");

      const writeoffLines = lines
        .filter((l) => dCmp(l.actualLoss, "0") > 0)
        .map((l) => ({
          sourceLineId: l.id,
          skuId: l.materialSkuId,
          warehouseId: wh.id,
          qtyDelta: dNeg(l.actualLoss), // 委外仓 − 实际损耗；结余（负损耗）物料不过账，留仓为真实结余
        }));
      if (writeoffLines.length > 0) {
        await post(tx, {
          sourceDocType: "js_loss_writeoff",
          sourceDocId: id,
          action: "writeoff",
          lines: writeoffLines,
        });
      }

      // ---- 审批通过即完成：approved ─start→ in_progress ─complete→ completed ----
      const afterStart = nextStatus("approved", "start");
      const finalStatus = nextStatus(afterStart, "complete");
      await tx
        .update(jsDocs)
        .set({ status: finalStatus, version: sql`${jsDocs.version} + 1`, updatedAt: new Date() })
        .where(eq(jsDocs.id, id));
      await writeAudit(tx, { userId: actor.id, entity: "js", entityId: id, action: "complete" });
      return { status: finalStatus, idempotent: false };
    });
  } catch (e) {
    rethrowApproval(e);
  }
}

// ---------- 查询 ----------

/** Role/config hints only: submit and approval still revalidate monetary/quantity facts in their transaction. */
export function jsTaskActions(user: SessionUser, doc: { status: string; createdBy: number | null }, role: string | null) {
  const pmc = user.roles.includes("admin") || user.roles.includes("pmc"), maker = user.id === doc.createdBy;
  const qualification = approvalRoleError(user, role);
  const submit = doc.status === "draft" && (maker || pmc);
  const reject = doc.status === "pending" && !maker && !qualification;
  const approve = reject && canSeePrices(user.roles);
  const reason = doc.status === "draft"
    ? submit ? "核对已保存的数量与金额后提交；加工费更新仅限PMC/管理员，不改变物料扣款或手工调整。" : "请联系制单人、PMC或管理员核对并提交；加工费更新仅限PMC/管理员。"
    : doc.status === "pending" ? maker ? "制单人不可自审或自行驳回；请另一位有资格的审批人处理。"
      : qualification?.message ?? (!canSeePrices(user.roles)
        ? "当前角色不可查看结算金额，不能审批通过；请联系管理员配置具备金额查看权限的审批人，或驳回交PMC核对。"
        : "当前具备审批资格；提交时仍须核对费用、数量及余料，异常可驳回交PMC处理。")
    : "结算已冻结或结束，只读保留历史；如有差额请联系财务，不可重算或重复审批。";
  return { submit, refreshFee: doc.status === "draft" && pmc, approve, reject, reason };
}

export async function getJs(id: number, dbArg?: AnyDb, user?: SessionUser) {
  const db = await resolveDb(dbArg);
  const policy = user ? await loadSettlementReadPolicy(db, user) : null;
  if (policy && !policy.allowed) throw new ApiError(403, "无权限查看结算单，请核对角色、审批配置及渠道范围");
  const [doc] = await db
    .select({
      id: jsDocs.id,
      docNo: jsDocs.docNo,
      status: jsDocs.status,
      remark: jsDocs.remark,
      version: jsDocs.version,
      jgId: jsDocs.jgId,
      jgDocNo: jgDocs.docNo,
      woId: jgDocs.woId,
      woDocNo: woDocs.docNo,
      supplierId: jgDocs.supplierId,
      supplierName: suppliers.name,
      productSkuCode: skus.code,
      productSkuName: skus.name,
      goodQty: jsDocs.goodQty,
      concessionQty: jsDocs.concessionQty,
      spareQty: jsDocs.spareQty,
      feePayable: jsDocs.feePayable, // 敏感——路由边界 maskSensitive 剥离
      concessionPrice: jsDocs.concessionPrice, // 敏感
      deductionTotal: jsDocs.deductionTotal, // 敏感
      manualAdj: jsDocs.manualAdj, // 敏感
      settleAmount: jsDocs.settleAmount, // 敏感
      createdBy: jsDocs.createdBy,
      createdByName: users.name,
      createdAt: jsDocs.createdAt,
    })
    .from(jsDocs)
    .innerJoin(jgDocs, eq(jsDocs.jgId, jgDocs.id))
    .innerJoin(woDocs, eq(jgDocs.woId, woDocs.id))
    .innerJoin(suppliers, eq(jgDocs.supplierId, suppliers.id))
    .innerJoin(skus, eq(jgDocs.productSkuId, skus.id))
    .leftJoin(users, eq(jsDocs.createdBy, users.id))
    .where(eq(jsDocs.id, id));
  if (!doc) throw new ApiError(404, "单据不存在");

  const lines = await db
    .select({
      id: jsLines.id,
      materialSkuId: jsLines.materialSkuId,
      skuCode: skus.code,
      skuName: skus.name,
      issuedQty: jsLines.issuedQty,
      returnedQty: jsLines.returnedQty,
      stdQty: jsLines.stdQty,
      allowedLoss: jsLines.allowedLoss,
      actualLoss: jsLines.actualLoss,
      excessLoss: jsLines.excessLoss,
      deductPrice: jsLines.deductPrice, // 敏感
      deductAmount: jsLines.deductAmount, // 敏感
    })
    .from(jsLines)
    .innerJoin(skus, eq(jsLines.materialSkuId, skus.id))
    .where(eq(jsLines.jsId, id))
    .orderBy(asc(jsLines.id));

  const approvalRows = await loadApprovalHistory(db, "js", id);
  return { ...doc, lines, approvals: approvalRows, deductPriceSource: "price_list_proxy" as const,
    actions: user ? jsTaskActions(user, doc, policy?.approverRole ?? null) : undefined };
}

export async function listJss(
  q: string,
  opts: { status?: string; jgId?: number; page: number; pageSize: number },
  dbArg?: AnyDb,
  user?: SessionUser,
): Promise<{ rows: unknown[]; total: number }> {
  const db = await resolveDb(dbArg);
  if (user && !(await loadSettlementReadPolicy(db, user)).allowed) {
    throw new ApiError(403, "无权限查看结算单，请核对角色、审批配置及渠道范围");
  }
  const conds = [];
  if (q) conds.push(sql`${jsDocs.docNo} ILIKE ${"%" + q + "%"}`);
  if (opts.status) conds.push(eq(jsDocs.status, opts.status as DocStatus));
  if (opts.jgId) conds.push(eq(jsDocs.jgId, opts.jgId));
  const where = conds.length ? and(...conds) : undefined;

  const [rows, [{ total }]] = await Promise.all([
    db
      .select({
        id: jsDocs.id,
        docNo: jsDocs.docNo,
        status: jsDocs.status,
        jgId: jsDocs.jgId,
        jgDocNo: jgDocs.docNo,
        woDocNo: woDocs.docNo,
        supplierName: suppliers.name,
        goodQty: jsDocs.goodQty,
        concessionQty: jsDocs.concessionQty,
        spareQty: jsDocs.spareQty,
        feePayable: jsDocs.feePayable, // 敏感——路由边界 maskSensitive 剥离
        deductionTotal: jsDocs.deductionTotal, // 敏感
        settleAmount: jsDocs.settleAmount, // 敏感
        createdByName: users.name,
        createdAt: jsDocs.createdAt,
      })
      .from(jsDocs)
      .innerJoin(jgDocs, eq(jsDocs.jgId, jgDocs.id))
      .innerJoin(woDocs, eq(jgDocs.woId, woDocs.id))
      .innerJoin(suppliers, eq(jgDocs.supplierId, suppliers.id))
      .leftJoin(users, eq(jsDocs.createdBy, users.id))
      .where(where)
      .orderBy(desc(jsDocs.createdAt), desc(jsDocs.id))
      .limit(opts.pageSize)
      .offset((opts.page - 1) * opts.pageSize),
    db.select({ total: sql<number>`count(*)::int` }).from(jsDocs).where(where),
  ]);
  return { rows, total };
}

// ---------- 关闭 JG 的路由入口参数（settlement/jg-close） ----------

export async function closeJgFromRoute(user: SessionUser, input: unknown, dbArg?: AnyDb): Promise<JgRow> {
  const v = closeJgSchema.parse(input);
  return closeJgReceiving(user, v.jgId, v.version, dbArg);
}
