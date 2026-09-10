import { and, asc, desc, eq, inArray, or, sql } from "drizzle-orm";
import {
   bhDocs, bhLines, bomLines, boms, jgDocs, jgFeeSegments, poDocs, poLines,
  skus, stockBalances, suppliers, uomConvs, users, warehouses, woDocs, woLines,
} from "@/db/schema";
import { dAdd, dCmp, dDiv, dMoney, dMul, dQty, dSub } from "@/server/core/decimal";
import type { SessionUser } from "@/server/core/dto";
import { writeAudit } from "@/server/core/audit";
import { bhReadScope } from "@/server/core/bh-read-scope";
import {
  BomCycleError,
  BomDepthError,
  explode,
  type BomLineLike,
} from "@/server/rules/bom-explode";
import { supplierNewOrderBlock } from "@/server/rules/supplier-status";
import { approveDoc, loadApprovalHistory, withdrawDoc } from "@/server/docflow/approval";
import { nextDocNo } from "@/server/docflow/doc-no";
import type { DocStatus } from "@/server/docflow/state";
import { ApiError } from "@/server/modules/master/common";
import { type AnyDb, requireAnyRole, resolveDb, rethrowApproval } from "./common";
import { approveDocSchema, createWoSchema, generateDocsSchema, transitionDocSchema, withdrawDocSchema } from "./schemas";
import { createdWithinShanghaiDays, skuHeaderMatch } from "@/server/core/doc-search";
import { transitionDoc } from "@/server/docflow/transition";
import {
  capacityAuditSnapshot,
  getSupplierCapacitySignal,
} from "@/server/modules/report/supplier-capacity";

/** 委外工单 WO（《02》§3）：选生效 BOM → 审批时递归到末级物料并冻结 wo_line（毛需求/可用/在途/建议量 R11） */

type WoRow = typeof woDocs.$inferSelect;
type PoRow = typeof poDocs.$inferSelect;
type JgRow = typeof jgDocs.$inferSelect;

// ---------- 创建 ----------

export async function createWo(user: SessionUser, input: unknown, dbArg?: AnyDb): Promise<WoRow> {
  requireAnyRole(user, "pmc");
  const v = createWoSchema.parse(input);
  const db = await resolveDb(dbArg);

  // 成品校验：存在、启用、类型=成品
  const [product] = await db.select().from(skus).where(eq(skus.id, v.productSkuId));
  if (!product || !product.active) throw new ApiError(400, `成品 SKU 不存在或已停用: #${v.productSkuId}`);
  if (product.skuType !== "finished") throw new ApiError(400, "委外工单只能针对成品 SKU");

  // 生效 BOM（B15：引用于单头，审批时快照复制）
  const [activeBom] = await db
    .select()
    .from(boms)
    .where(and(eq(boms.productSkuId, v.productSkuId), eq(boms.status, "active")));
  if (!activeBom) throw new ApiError(404, "该成品无生效 BOM");

  // 加工厂：存在且可接新单（黑名单 / 整改暂停 = 禁新单，存量收尾；规则见 rules/supplier-status）
  const [supplier] = await db.select().from(suppliers).where(eq(suppliers.id, v.supplierId));
  if (!supplier) throw new ApiError(400, `供应商不存在: #${v.supplierId}`);
  const block = supplierNewOrderBlock(supplier.status);
  if (block.blocked) throw new ApiError(400, `供应商${block.label}，禁止新单: ${supplier.name}（${block.reason}）`);

  return db.transaction(async (tx: AnyDb) => {
    // Same transaction as insert/audit; a concurrent BH edit/withdraw must not change
    // the approved source underneath the derived WO. Historical regular is NOT repeat.
    let sourceOrderType: string | null = null;
    if (v.bhId != null) {
      const [bh]: (typeof bhDocs.$inferSelect)[] = await tx.select().from(bhDocs)
        .where(and(eq(bhDocs.id, v.bhId), bhReadScope(tx, user))).for("share");
      if (!bh) throw new ApiError(404, "备货申请不存在或不可访问");
      if (bh.status !== "approved") throw new ApiError(409, "关联备货申请必须已审批，请重新核对来源状态");
      const [sourceLine] = await tx.select({ id: bhLines.id }).from(bhLines)
        .where(and(eq(bhLines.bhId, bh.id), eq(bhLines.skuId, v.productSkuId))).limit(1);
      if (!sourceLine) throw new ApiError(400, "成品不属于该备货申请，请核对关联申请和成品");
      sourceOrderType = bh.orderType ?? bh.purpose;
      if (sourceOrderType && v.orderType && sourceOrderType !== v.orderType) {
        throw new ApiError(409, "订单类型与已审批备货申请不一致；请继承来源类型，勿在工单中改写首单/返单身份");
      }
    }
    const orderType = sourceOrderType || v.orderType || null;
    const docNo = await nextDocNo(tx, "WO");
    const [doc]: WoRow[] = await tx
      .insert(woDocs)
      .values({
        docNo,
        remark: v.remark ?? null,
        bhId: v.bhId ?? null,
        productSkuId: v.productSkuId,
        qty: dQty(v.qty),
        supplierId: v.supplierId,
        feeRatePlan: dMoney(v.feeRatePlan),
        orderType,
        dueDate: v.dueDate ?? null,
        bomId: activeBom.id,
        createdBy: user.id,
      })
      .returning();
    await writeAudit(tx, {
      userId: user.id, entity: "wo", entityId: doc.id, action: "create",
      after: { docNo: doc.docNo, productSkuId: v.productSkuId, qty: doc.qty, bomId: activeBom.id,
        bhId: v.bhId ?? null, orderType, orderTypeSource: sourceOrderType ? "bh" : v.orderType ? "manual" : "unclassified" },
    });
    return doc;
  });
}

// ---------- 提交 ----------

export async function submitWo(user: SessionUser, id: number, version: number, dbArg?: AnyDb): Promise<WoRow> {
  const db = await resolveDb(dbArg);
  const [doc]: WoRow[] = await db.select().from(woDocs).where(eq(woDocs.id, id));
  if (!doc) throw new ApiError(404, "单据不存在");
  if (doc.createdBy !== user.id && !user.roles.includes("admin")) {
    throw new ApiError(403, "仅制单人或管理员可提交");
  }
  if (doc.status !== "draft") throw new ApiError(409, `当前状态不可提交: ${doc.status}`);
  const updated: WoRow[] = await db
    .update(woDocs)
    .set({ status: "pending", version: sql`${woDocs.version} + 1`, updatedAt: new Date() })
    .where(and(eq(woDocs.id, id), eq(woDocs.version, version)))
    .returning();
  if (updated.length === 0) throw new ApiError(409, `版本冲突：期望版本 ${version} 已过期`);
  await writeAudit(db, { userId: user.id, entity: "wo", entityId: id, action: "submit" });
  return updated[0];
}

// ---------- 审批（通过时同事务构建 wo_line 快照，《01》§3 wo_line） ----------

export async function approveWo(
  user: SessionUser,
  id: number,
  input: unknown,
  dbArg?: AnyDb,
): Promise<{ status: string; idempotent: boolean }> {
  const v = approveDocSchema.parse(input);
  const db = await resolveDb(dbArg);
  try {
    return await db.transaction(async (tx: AnyDb) => {
      const [wo]: WoRow[] = await tx.select().from(woDocs).where(eq(woDocs.id, id));
      if (!wo) throw new ApiError(404, "单据不存在");

      const r = await approveDoc(tx, {
        docType: "wo",
        table: woDocs,
        docId: id,
        approver: { id: user.id, roles: user.roles, isApprover: user.isApprover },
        action: v.action,
        comment: v.comment,
        expectedVersion: v.version,
      });
      if (r.idempotent) return r; // 重试短路：不重复快照
      await writeAudit(tx, {
        userId: user.id, entity: "wo", entityId: id, action: v.action,
        after: { comment: v.comment ?? null },
      });
      if (v.action === "reject") return r;

      await buildWoLineSnapshot(tx, wo, user.id);
      return r;
    });
  } catch (e) {
    rethrowApproval(e);
  }
}

/**
 * wo_line 快照（审批时点冻结；此后 BOM 改版不影响本单）：
 *   多层 BOM 递归到末级原料/包材；每层损耗均计入毛需求，中间半成品不进入采购快照。
 *   qtyPer = 各路径无损耗净单位用量合计；planLossRatePct = 多层综合有效损耗率。
 *   可用   = Σ stock_balances（仅实时记账仓）
 *   在途   = Σ PO 实物行未收量（已审批/执行中 PO；基础单位=qty×uomFactor−receivedQty，行内下限 0）
 *   建议量 = R11（MOQ/订货倍数取整，rules/netreq 纯函数）
 */
async function buildWoLineSnapshot(tx: AnyDb, wo: WoRow, userId: number): Promise<void> {
  const bLines = await tx
    .select()
    .from(bomLines)
    .where(eq(bomLines.bomId, wo.bomId))
    .orderBy(asc(bomLines.id));
  if (bLines.length === 0) throw new ApiError(500, `BOM 无行: #${wo.bomId}`);

  // 根 BOM 必须冻结为 WO 创建时引用的版本；下级半成品使用审批时点的生效版本，
  // 最终 leaf 快照一经写入 wo_lines，后续任何 BOM 改版都不再影响本单。
  const activeRows: Array<BomLineLike & { productSkuId: number }> = await tx
    .select({
      productSkuId: boms.productSkuId,
      materialSkuId: bomLines.materialSkuId,
      qtyPer: bomLines.qtyPer,
      incomingLossPct: bomLines.incomingLossPct,
      productionLossPct: bomLines.productionLossPct,
      lossRatePct: bomLines.lossRatePct,
    })
    .from(boms)
    .innerJoin(bomLines, eq(boms.id, bomLines.bomId))
    .where(eq(boms.status, "active"))
    .orderBy(asc(bomLines.id));
  const graph = new Map<number, BomLineLike[]>();
  for (const line of activeRows) {
    const lines = graph.get(line.productSkuId) ?? [];
    lines.push(line);
    graph.set(line.productSkuId, lines);
  }
  graph.set(wo.productSkuId, bLines);

  let grossLeaves: Map<number, string>;
  let netLeaves: Map<number, string>;
  try {
    grossLeaves = explode([{ skuId: wo.productSkuId, qty: wo.qty }], graph);
    const noLossGraph = new Map<number, BomLineLike[]>(
      [...graph].map(([skuId, lines]) => [
        skuId,
        lines.map((line) => ({
          ...line,
          incomingLossPct: "0",
          productionLossPct: "0",
          lossRatePct: "0",
        })),
      ]),
    );
    netLeaves = explode([{ skuId: wo.productSkuId, qty: wo.qty }], noLossGraph);
  } catch (error) {
    if (error instanceof BomCycleError || error instanceof BomDepthError) {
      const pathIds = error instanceof BomCycleError ? error.cycle : error.path;
      const codeRows = await tx
        .select({ id: skus.id, code: skus.code })
        .from(skus)
        .where(inArray(skus.id, [...new Set(pathIds)]));
      const codeById = new Map(codeRows.map((row) => [row.id, row.code]));
      const path = pathIds.map((id) => codeById.get(id) ?? `SKU#${id}`).join(" → ");
      throw new ApiError(
        409,
        error instanceof BomCycleError
          ? `工单不能审批：BOM 存在循环 ${path}`
          : `工单不能审批：BOM 层级超过 32 层安全上限 ${path}`,
      );
    }
    throw error;
  }
  const materialIds = [...grossLeaves.keys()];
  if (materialIds.length === 0) throw new ApiError(409, "工单不能审批：BOM 未展开出末级物料");

  const materialRows = await tx
    .select({ id: skus.id, code: skus.code, skuType: skus.skuType })
    .from(skus)
    .where(inArray(skus.id, materialIds));
  const materialById = new Map(materialRows.map((row) => [row.id, row]));
  const unsupportedLeaves = materialIds
    .map((id) => materialById.get(id))
    .filter((row) => !row || (row.skuType !== "raw" && row.skuType !== "packaging"));
  if (unsupportedLeaves.length > 0) {
    const labels = unsupportedLeaves.map(
      (row) => row ? `${row.code}（${row.skuType}）` : "未知物料",
    );
    throw new ApiError(
      409,
      `工单不能审批：末级物料必须是原料或包材；${labels.join("、")} 无生效下级 BOM，请补齐 BOM 或修正物料类型`,
    );
  }

  // 可用库存：仅实时记账仓（own-warehouse 口径）。诚实标注：快照仓（保税/E/云）按《00》A6
  // 不计入实时可用——因此 R11 建议量偏保守（可能高估需求），见 D20；1.1 快照仓接入后再合并口径。
  const onHandRows: { skuId: number; qty: string | null }[] = await tx
    .select({
      skuId: stockBalances.skuId,
      qty: sql<string | null>`sum(${stockBalances.qty})`,
    })
    .from(stockBalances)
    .innerJoin(warehouses, eq(stockBalances.warehouseId, warehouses.id))
    .where(and(inArray(stockBalances.skuId, materialIds), eq(warehouses.accountingMode, "realtime")))
    .groupBy(stockBalances.skuId);
  const onHandBySku = new Map(onHandRows.map((r) => [r.skuId, r.qty ?? "0"]));

  // 在途：已审批/执行中 PO 的实物行未收量（逐行 max(0, qty×factor−received) 后求和）
  const transitRows: { skuId: number; qty: string; uomFactor: string; receivedQty: string }[] = await tx
    .select({
      skuId: poLines.skuId,
      qty: poLines.qty,
      uomFactor: poLines.uomFactor,
      receivedQty: poLines.receivedQty,
    })
    .from(poLines)
    .innerJoin(poDocs, eq(poLines.poId, poDocs.id))
    .where(and(inArray(poLines.skuId, materialIds), inArray(poDocs.status, ["approved", "in_progress"])));
  const inTransitBySku = new Map<number, string>();
  for (const r of transitRows) {
    const remain = dSub(dMul(r.qty, r.uomFactor, 6), r.receivedQty, 6);
    if (dCmp(remain, "0") <= 0) continue; // 超收行不抵扣其他行（逐行下限 0）
    inTransitBySku.set(r.skuId, dAdd(inTransitBySku.get(r.skuId) ?? "0", remain, 6));
  }

  // MOQ/订货倍数：uom_convs 首行（按 id）兜底——多采购单位时以首选为准（PoC 口径）
  const uomRows = await tx
    .select()
    .from(uomConvs)
    .where(inArray(uomConvs.skuId, materialIds))
    .orderBy(asc(uomConvs.id));
  const uomBySku = new Map<number, typeof uomRows[number]>();
  for (const u of uomRows) if (!uomBySku.has(u.skuId)) uomBySku.set(u.skuId, u);

  const { suggestQty } = await import("@/server/rules/netreq");
  await tx.insert(woLines).values(
    materialIds.map((materialSkuId) => {
      const grossReq = dQty(grossLeaves.get(materialSkuId) ?? "0");
      const netReq = dQty(netLeaves.get(materialSkuId) ?? "0");
      const qtyPer = dQty(dDiv(netReq, wo.qty, 6));
      const effectiveLossPct = dMoney(
        dMul(dSub(dDiv(grossReq, netReq, 6), "1", 6), "100", 6),
      );
      if (dCmp(effectiveLossPct, "999.99") > 0) {
        throw new ApiError(
          409,
          `工单不能审批：物料 ${materialById.get(materialSkuId)?.code ?? `#${materialSkuId}`} 的多层综合损耗率超过 999.99%`,
        );
      }
      const onHand = dQty(onHandBySku.get(materialSkuId) ?? "0");
      const inTransit = dQty(inTransitBySku.get(materialSkuId) ?? "0");
      const uom = uomBySku.get(materialSkuId);
      const suggested = suggestQty({
        grossReq,
        onHand,
        inTransit,
        moq: uom?.moq ?? null,
        orderMultiple: uom?.orderMultiple ?? null,
      });
      return {
        woId: wo.id,
        materialSkuId,
        qtyPer,
        planLossRatePct: effectiveLossPct,
        grossReq,
        onHandAt: onHand,
        inTransitAt: inTransit,
        suggestedQty: suggested,
      };
    }),
  );
  await writeAudit(tx, {
    userId, entity: "wo", entityId: wo.id, action: "snapshot",
    after: { bomId: wo.bomId, lineCount: materialIds.length, multilevel: true },
  });
}

// ---------- 生成 PO + JG（WO 已审批后一键生成） ----------

export async function generateDocs(
  user: SessionUser,
  woId: number,
  input: unknown,
  dbArg?: AnyDb,
): Promise<{ pos: PoRow[]; jg: JgRow }> {
  requireAnyRole(user, "pmc");
  const v = generateDocsSchema.parse(input);
  const db = await resolveDb(dbArg);

  const [wo]: WoRow[] = await db.select().from(woDocs).where(eq(woDocs.id, woId));
  if (!wo) throw new ApiError(404, "工单不存在");
  if (wo.status !== "approved") throw new ApiError(409, `仅已审批工单可生成 PO/JG，当前状态: ${wo.status}`);

  // 幂等：一 WO 恰一 JG（无 DB 唯一约束——schema 本波不可改，先查后插为 PoC 口径，
  // 并发双写窗口在集成阶段补 UNIQUE(wo_id) 收口）
  const [existingJg] = await db
    .select({ id: jgDocs.id, docNo: jgDocs.docNo })
    .from(jgDocs)
    .where(eq(jgDocs.woId, woId));
  if (existingJg) throw new ApiError(409, `该工单已生成加工通知单 ${existingJg.docNo}，不可重复生成`);

  // 供应商：存在且可接新单（黑名单 / 整改暂停皆拒，规则见 rules/supplier-status）
  const supplierIds = [...new Set(v.poGroups.map((g) => g.supplierId))];
  if (supplierIds.length > 0) {
    const supRows = await db.select().from(suppliers).where(inArray(suppliers.id, supplierIds));
    const bySup = new Map(supRows.map((s) => [s.id, s]));
    for (const sid of supplierIds) {
      const s = bySup.get(sid);
      if (!s) throw new ApiError(400, `供应商不存在: #${sid}`);
      const block = supplierNewOrderBlock(s.status);
      if (block.blocked) throw new ApiError(400, `供应商${block.label}，禁止新单: ${s.name}（${block.reason}）`);
    }
  }

  // 物料：PO 行仅限原料/包材（加工费不进 PO，《00》A4）；行类型由 skuType 推导
  const materialIds = [...new Set(v.poGroups.flatMap((g) => g.lines.map((l) => l.materialSkuId)))];
  const lineTypeBySku = new Map<number, "raw" | "packaging">();
  if (materialIds.length > 0) {
    const matRows = await db.select().from(skus).where(inArray(skus.id, materialIds));
    const byId = new Map(matRows.map((s) => [s.id, s]));
    for (const mid of materialIds) {
      const s = byId.get(mid);
      if (!s || !s.active) throw new ApiError(400, `物料 SKU 不存在或已停用: #${mid}`);
      if (s.skuType !== "raw" && s.skuType !== "packaging") {
        throw new ApiError(400, `PO 行仅限原料/包材，物料 ${s.code} 类型为 ${s.skuType}`);
      }
      lineTypeBySku.set(mid, s.skuType);
    }
  }

  const [product] = await db
    .select({ baseUom: skus.baseUom })
    .from(skus)
    .where(eq(skus.id, wo.productSkuId));
  if (!product) throw new ApiError(400, `成品 SKU 不存在: #${wo.productSkuId}`);
  const jgQty = dQty(v.jg?.qty ?? wo.qty);
  const jgDueDate = v.jg?.dueDate ?? wo.dueDate;
  const capacity = await getSupplierCapacitySignal({
    supplierId: wo.supplierId,
    baseUom: product.baseUom,
    dueDate: jgDueDate,
    candidateQty: jgQty,
  }, db);

  return db.transaction(async (tx: AnyDb) => {
    const pos: PoRow[] = [];
    for (const g of v.poGroups) {
      const docNo = await nextDocNo(tx, "PO");
      const [po]: PoRow[] = await tx
        .insert(poDocs)
        .values({ docNo, woId, supplierId: g.supplierId, createdBy: user.id })
        .returning();
      await tx.insert(poLines).values(
        g.lines.map((l) => ({
          poId: po.id,
          skuId: l.materialSkuId,
          lineType: lineTypeBySku.get(l.materialSkuId)!,
          purchaseUom: l.purchaseUom ?? "基础单位",
          uomFactor: dQty(l.uomFactor ?? "1"),
          qty: dQty(l.qty),
          price: dMoney(l.price),
          taxIncluded: l.taxIncluded ?? true,
          taxRatePct: l.taxRatePct ?? "13",
        })),
      );
      await writeAudit(tx, {
        userId: user.id, entity: "po", entityId: po.id, action: "create",
        after: { docNo: po.docNo, woId, supplierId: g.supplierId, lineCount: g.lines.length },
      });
      pos.push(po);
    }

    // JG：加工费现价=WO 计划价起步；分段计价首段 effective_from=now（结算取价来源）
    const jgNo = await nextDocNo(tx, "JG");
    const [jg]: JgRow[] = await tx
      .insert(jgDocs)
      .values({
        docNo: jgNo,
        woId,
        supplierId: wo.supplierId,
        productSkuId: wo.productSkuId,
        qty: jgQty,
        dueDate: jgDueDate,
        feeRateCurrent: wo.feeRatePlan,
        orderType: wo.orderType,
        createdBy: user.id,
      })
      .returning();
    await tx.insert(jgFeeSegments).values({ jgId: jg.id, rate: jg.feeRateCurrent, effectiveFrom: new Date() });
    await writeAudit(tx, {
      userId: user.id, entity: "jg", entityId: jg.id, action: "create",
      after: {
        docNo: jg.docNo,
        woId,
        feeRateCurrent: jg.feeRateCurrent,
        capacity: capacityAuditSnapshot(capacity),
      },
    });
    return { pos, jg };
  });
}

// ---------- 查询 ----------

export async function getWo(id: number, dbArg?: AnyDb) {
  const db = await resolveDb(dbArg);
  const [doc] = await db
    .select({
      id: woDocs.id,
      docNo: woDocs.docNo,
      status: woDocs.status,
      remark: woDocs.remark,
      version: woDocs.version,
      bhId: woDocs.bhId,
      productSkuId: woDocs.productSkuId,
      productSkuCode: skus.code,
      productSkuName: skus.name,
      qty: woDocs.qty,
      supplierId: woDocs.supplierId,
      supplierName: suppliers.name,
      feeRatePlan: woDocs.feeRatePlan,
      orderType: woDocs.orderType,
      dueDate: woDocs.dueDate,
      bomId: woDocs.bomId,
      createdBy: woDocs.createdBy,
      createdAt: woDocs.createdAt,
      createdByName: users.name,
    })
    .from(woDocs)
    .innerJoin(skus, eq(woDocs.productSkuId, skus.id))
    .innerJoin(suppliers, eq(woDocs.supplierId, suppliers.id))
    .leftJoin(users, eq(woDocs.createdBy, users.id))
    .where(eq(woDocs.id, id));
  if (!doc) throw new ApiError(404, "单据不存在");

  const lines = await db
    .select({
      id: woLines.id,
      materialSkuId: woLines.materialSkuId,
      skuCode: skus.code,
      skuName: skus.name,
      baseUom: skus.baseUom,
      qtyPer: woLines.qtyPer,
      planLossRatePct: woLines.planLossRatePct,
      grossReq: woLines.grossReq,
      onHandAt: woLines.onHandAt,
      inTransitAt: woLines.inTransitAt,
      suggestedQty: woLines.suggestedQty,
    })
    .from(woLines)
    .innerJoin(skus, eq(woLines.materialSkuId, skus.id))
    .where(eq(woLines.woId, id))
    .orderBy(woLines.id);

  const approvalRows = await loadApprovalHistory(db, "wo", id);

  return { ...doc, lines, approvals: approvalRows };
}

export async function listWos(
  q: string,
  opts: { status?: string; from?: string; to?: string; page: number; pageSize: number },
  dbArg?: AnyDb,
): Promise<{ rows: unknown[]; total: number }> {
  const db = await resolveDb(dbArg);
  const conds = [];
  if (q) conds.push(or(sql`${woDocs.docNo} ILIKE ${"%" + q + "%"}`, skuHeaderMatch(woDocs.productSkuId, q)));
  if (opts.status) conds.push(eq(woDocs.status, opts.status as DocStatus));
  // 制单时间窗（上海业务日，含首尾）：全链漏斗「下单」级按同一口径回链到本列表
  conds.push(...createdWithinShanghaiDays(woDocs.createdAt, opts.from, opts.to));
  const where = conds.length ? and(...conds) : undefined;

  const [rows, [{ total }]] = await Promise.all([
    db
      .select({
        id: woDocs.id,
        docNo: woDocs.docNo,
        status: woDocs.status,
        productSkuCode: skus.code,
        productSkuName: skus.name,
        qty: woDocs.qty,
        supplierName: suppliers.name,
        orderType: woDocs.orderType,
        dueDate: woDocs.dueDate,
        createdByName: users.name,
        createdAt: woDocs.createdAt,
      })
      .from(woDocs)
      .innerJoin(skus, eq(woDocs.productSkuId, skus.id))
      .innerJoin(suppliers, eq(woDocs.supplierId, suppliers.id))
      .leftJoin(users, eq(woDocs.createdBy, users.id))
      .where(where)
      .orderBy(desc(woDocs.createdAt), desc(woDocs.id))
      .limit(opts.pageSize)
      .offset((opts.page - 1) * opts.pageSize),
    db.select({ total: sql<number>`count(*)::int` }).from(woDocs).where(where),
  ]);
  return { rows, total };
}

/** 撤回：待审批 → 草稿。仅制单人本人（管理员豁免）；不写审批轨迹、不占审批轮次。 */
export async function withdrawWO(
  user: SessionUser,
  id: number,
  input: unknown,
  dbArg?: AnyDb,
): Promise<{ status: string; idempotent: boolean }> {
  const v = withdrawDocSchema.parse(input);
  const db = await resolveDb(dbArg);
  try {
    return await db.transaction(async (tx: AnyDb) => {
      const r = await withdrawDoc(tx, {
        docType: "wo",
        table: woDocs,
        docId: id,
        user: { id: user.id, roles: user.roles },
        expectedVersion: v.version,
      });
      if (r.idempotent) return r;
      await writeAudit(tx, { userId: user.id, entity: "wo", entityId: id, action: "withdraw" });
      return r;
    });
  } catch (e) {
    rethrowApproval(e);
  }
}

/**
 * 手工状态流转：完成 / 短关 / 作废 / 重开。
 * 此前 wo 没有任何到达「已完成」的路径，短关也全仓未实现——
 * 少送尾数的单据会永久卡在「执行中」。这里只补人工收口，不做自动完成。
 */
export async function transitionWO(
  user: SessionUser,
  id: number,
  input: unknown,
  dbArg?: AnyDb,
): Promise<{ status: string; idempotent: boolean }> {
  const v = transitionDocSchema.parse(input);
  if (v.action !== "void" && v.action !== "reopen") requireAnyRole(user, "pmc", "ops");
  const db = await resolveDb(dbArg);
  try {
    return await db.transaction(async (tx: AnyDb) => {
      const r = await transitionDoc(tx, {
        docType: "wo",
        table: woDocs,
        docId: id,
        user: { id: user.id, roles: user.roles },
        action: v.action,
        reason: v.reason,
        expectedVersion: v.version,
      });
      if (r.idempotent) return r;
      await writeAudit(tx, {
        userId: user.id, entity: "wo", entityId: id, action: v.action,
        after: { status: r.status, reason: v.reason ?? null },
      });
      return r;
    });
  } catch (e) {
    rethrowApproval(e);
  }
}
