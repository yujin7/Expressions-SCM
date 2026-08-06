import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import {
   jgDocs, jgFeeSegments, pcDocs, poDocs, poLines, priceLists,
  skus, suppliers, sysParams, users,
} from "@/db/schema";
import { dCmp } from "@/server/core/decimal";
import { canSeePrices, type SessionUser } from "@/server/core/dto";
import { writeAudit } from "@/server/core/audit";
import { approveDoc, loadApprovalHistory, withdrawDoc } from "@/server/docflow/approval";
import { nextDocNo } from "@/server/docflow/doc-no";
import { nextStatus, TransitionError, type DocStatus } from "@/server/docflow/state";
import { checkPriceDeviation, normalizeToBaseNet } from "@/server/rules/price";
import { ApiError, todayShanghai } from "@/server/modules/master/common";
import { type AnyDb, requireAnyRole, resolveDb, rethrowApproval } from "./common";
import { approveDocSchema, confirmDocSchema, transitionDocSchema, withdrawDocSchema } from "./schemas";
import { skuLineMatch } from "@/server/core/doc-search";
import { transitionDoc } from "@/server/docflow/transition";

/** 采购订单 PO + 价格变更 PC（R1：基础单位未税比价；异动自动生成 PC，PO 留在草稿） */

type PoRow = typeof poDocs.$inferSelect;
type PoLineRow = typeof poLines.$inferSelect;
type PcRow = typeof pcDocs.$inferSelect;

// ---------- R1 基准价 ----------

/** 容差 %（sys_param global/price_tolerance_pct，缺省 "3"） */
async function getTolerancePct(db: AnyDb): Promise<string> {
  const [row] = await db
    .select({ value: sysParams.value })
    .from(sysParams)
    .where(and(eq(sysParams.scope, "global"), eq(sysParams.key, "price_tolerance_pct")));
  return row?.value ?? "3";
}

/**
 * 基准价（基础单位未税，《00》A5）：
 *   1) 最近一张已审批 PO 同 (供应商,SKU) 行价（approved/in_progress/completed，按单 id 倒序）
 *   2) 兜底 price_lists 生效日≤今日的最新行（表内已是基础单位未税价）
 *   3) 都无 → null（首购免检）
 */
async function findBaseline(db: AnyDb, supplierId: number, skuId: number, excludePoId: number): Promise<string | null> {
  const [prev] = await db
    .select({
      price: poLines.price,
      taxIncluded: poLines.taxIncluded,
      taxRatePct: poLines.taxRatePct,
      uomFactor: poLines.uomFactor,
    })
    .from(poLines)
    .innerJoin(poDocs, eq(poLines.poId, poDocs.id))
    .where(
      and(
        eq(poDocs.supplierId, supplierId),
        eq(poLines.skuId, skuId),
        inArray(poDocs.status, ["approved", "in_progress", "completed"]),
        sql`${poDocs.id} <> ${excludePoId}`,
      ),
    )
    .orderBy(desc(poDocs.id), desc(poLines.id))
    .limit(1);
  if (prev) {
    return normalizeToBaseNet({
      price: prev.price,
      taxIncluded: prev.taxIncluded,
      taxRatePct: prev.taxRatePct,
      uomFactor: prev.uomFactor,
    });
  }
  const [pl] = await db
    .select({ price: priceLists.price })
    .from(priceLists)
    .where(
      and(
        eq(priceLists.skuId, skuId),
        eq(priceLists.supplierId, supplierId),
        sql`${priceLists.effectiveDate} <= ${todayShanghai()}`,
      ),
    )
    .orderBy(desc(priceLists.effectiveDate), desc(priceLists.id))
    .limit(1);
  return pl?.price ?? null;
}

// ---------- 提交（R1 比价 → 异动自动生成 PC，PO 留草稿并 409） ----------

export async function submitPo(user: SessionUser, id: number, version: number, dbArg?: AnyDb): Promise<PoRow> {
  const db = await resolveDb(dbArg);
  const [doc]: PoRow[] = await db.select().from(poDocs).where(eq(poDocs.id, id));
  if (!doc) throw new ApiError(404, "单据不存在");
  if (doc.createdBy !== user.id && !user.roles.includes("purchasing") && !user.roles.includes("admin")) {
    throw new ApiError(403, "仅制单人/采购/管理员可提交");
  }
  if (doc.status !== "draft") throw new ApiError(409, `当前状态不可提交: ${doc.status}`);

  const lines: PoLineRow[] = await db.select().from(poLines).where(eq(poLines.poId, id)).orderBy(poLines.id);
  if (lines.length === 0) throw new ApiError(409, "PO 无行，不可提交");
  const tolerancePct = await getTolerancePct(db);

  // 逐行 R1：异动行需有「同价已批 PC」放行，否则挂/建 PC
  const blocking: string[] = []; // 阻塞提交的 PC 单号（已存在 pending 或本次新建）
  const toCreate: { line: PoLineRow; baseline: string | null; newBaseNet: string; deviationPct: string | null }[] = [];
  for (const line of lines) {
    const newBaseNet = normalizeToBaseNet({
      price: line.price,
      taxIncluded: line.taxIncluded,
      taxRatePct: line.taxRatePct,
      uomFactor: line.uomFactor,
    });
    const baseline = await findBaseline(db, doc.supplierId, line.skuId, id);
    const r = checkPriceDeviation({ baselineBaseNet: baseline, newBaseNet, tolerancePct });
    if (!r.requiresPc) continue; // 首购免检 / 容差内

    const linePcs: PcRow[] = await db
      .select()
      .from(pcDocs)
      .where(and(eq(pcDocs.target, "po_line"), eq(pcDocs.poLineId, line.id)));
    // 放行条件：该行已有「审批通过且 newPrice=本次归一价」的 PC（视为价格变更已核准）
    const cleared = linePcs.some((p) => p.status === "approved" && dCmp(p.newPrice, newBaseNet) === 0);
    if (cleared) continue;
    const open = linePcs.find((p) => p.status === "pending" && dCmp(p.newPrice, newBaseNet) === 0);
    if (open) {
      blocking.push(open.docNo); // 已有同价待审 PC——不重复建
      continue;
    }
    toCreate.push({ line, baseline, newBaseNet, deviationPct: r.deviationPct });
  }

  if (toCreate.length > 0 || blocking.length > 0) {
    // PC 创建须落库（独立事务提交后再抛 409——PO 保持草稿，是刻意行为而非回滚遗漏）
    const created: string[] = await db.transaction(async (tx: AnyDb) => {
      const nos: string[] = [];
      for (const c of toCreate) {
        const docNo = await nextDocNo(tx, "PC");
        const [pc]: PcRow[] = await tx
          .insert(pcDocs)
          .values({
            docNo,
            status: "pending", // PC 直接进入待审批（由提交动作触发，无草稿态）
            target: "po_line",
            poLineId: c.line.id,
            oldPrice: c.baseline ?? "0", // 首购不会走到这（requiresPc=false）；0 基准=数据异常强制复核
            newPrice: c.newBaseNet,
            deviationPct: c.deviationPct ?? "0",
            scope: "unreceived_only", // MVP：提交时点未收货，PoC 固定仅未收
            createdBy: user.id,
          })
          .returning();
        await writeAudit(tx, {
          userId: user.id, entity: "pc", entityId: pc.id, action: "create",
          after: { docNo: pc.docNo, poId: id, poLineId: c.line.id, oldPrice: pc.oldPrice, newPrice: pc.newPrice, deviationPct: pc.deviationPct },
        });
        nos.push(pc.docNo);
      }
      return nos;
    });
    const all = [...blocking, ...created];
    // PoC-honest：PO 提交被整单阻塞，直至其全部未决 PC 审批通过后重新提交
    throw new ApiError(409, `存在价格异动，已生成价格变更申请 ${all.join("、")}，审批通过后方可提交`);
  }

  const updated: PoRow[] = await db
    .update(poDocs)
    .set({ status: "pending", version: sql`${poDocs.version} + 1`, updatedAt: new Date() })
    .where(and(eq(poDocs.id, id), eq(poDocs.version, version)))
    .returning();
  if (updated.length === 0) throw new ApiError(409, `版本冲突：期望版本 ${version} 已过期`);
  await writeAudit(db, { userId: user.id, entity: "po", entityId: id, action: "submit" });
  return updated[0];
}

// ---------- 审批 ----------

export async function approvePo(
  user: SessionUser,
  id: number,
  input: unknown,
  dbArg?: AnyDb,
): Promise<{ status: string; idempotent: boolean }> {
  const v = approveDocSchema.parse(input);
  const db = await resolveDb(dbArg);
  try {
    return await db.transaction(async (tx: AnyDb) => {
      const r = await approveDoc(tx, {
        docType: "po",
        table: poDocs,
        docId: id,
        approver: { id: user.id, roles: user.roles, isApprover: user.isApprover },
        action: v.action,
        comment: v.comment,
        expectedVersion: v.version,
      });
      if (r.idempotent) return r;
      await writeAudit(tx, {
        userId: user.id, entity: "po", entityId: id, action: v.action,
        after: { comment: v.comment ?? null },
      });
      return r;
    });
  } catch (e) {
    rethrowApproval(e);
  }
}

// ---------- PC 审批（po_line：仅放行 PO 重提；jg_fee：同事务改现价+插分段，《00》A5） ----------

export async function approvePc(
  user: SessionUser,
  id: number,
  input: unknown,
  dbArg?: AnyDb,
): Promise<{ status: string; idempotent: boolean }> {
  const v = approveDocSchema.parse(input);
  const db = await resolveDb(dbArg);
  try {
    return await db.transaction(async (tx: AnyDb) => {
      const [pc]: PcRow[] = await tx.select().from(pcDocs).where(eq(pcDocs.id, id));
      if (!pc) throw new ApiError(404, "单据不存在");
      const r = await approveDoc(tx, {
        docType: "pc",
        table: pcDocs,
        docId: id,
        approver: { id: user.id, roles: user.roles, isApprover: user.isApprover },
        action: v.action,
        comment: v.comment,
        expectedVersion: v.version,
      });
      if (r.idempotent) return r;
      await writeAudit(tx, {
        userId: user.id, entity: "pc", entityId: id, action: v.action,
        after: { comment: v.comment ?? null, target: pc.target },
      });
      if (v.action === "reject") return r;

      if (pc.target === "jg_fee") {
        // 加工费变更立即生效：现价更新 + 新分段（结算按收货时点分段取价）
        if (pc.jgId == null) throw new ApiError(500, `jg_fee PC 缺 jgId: #${id}`);
        const now = new Date();
        await tx
          .update(jgDocs)
          .set({ feeRateCurrent: pc.newPrice, updatedAt: now })
          .where(eq(jgDocs.id, pc.jgId));
        await tx.insert(jgFeeSegments).values({ jgId: pc.jgId, rate: pc.newPrice, effectiveFrom: now });
        await writeAudit(tx, {
          userId: user.id, entity: "jg", entityId: pc.jgId, action: "fee_change",
          before: { feeRateCurrent: pc.oldPrice },
          after: { feeRateCurrent: pc.newPrice, viaPc: pc.docNo },
        });
      }
      // po_line PC 审批通过本身不改任何价：基准价只在 PO 最终审批通过后自然更新（《00》A5）
      return r;
    });
  } catch (e) {
    rethrowApproval(e);
  }
}

// ---------- 供应商确认（内部代录）：approved → in_progress ----------

export async function confirmPo(user: SessionUser, id: number, input: unknown, dbArg?: AnyDb): Promise<PoRow> {
  requireAnyRole(user, "purchasing", "pmc");
  const v = confirmDocSchema.parse(input);
  const db = await resolveDb(dbArg);
  const [doc]: PoRow[] = await db.select().from(poDocs).where(eq(poDocs.id, id));
  if (!doc) throw new ApiError(404, "单据不存在");
  let target: DocStatus;
  try {
    target = nextStatus(doc.status as DocStatus, "confirm");
  } catch (e) {
    if (e instanceof TransitionError) throw new ApiError(409, `当前状态不可确认: ${doc.status}`);
    throw e;
  }
  const now = new Date();
  const updated: PoRow[] = await db
    .update(poDocs)
    .set({
      status: target,
      confirmedAt: now,
      confirmedBy: user.id,
      confirmNote: v.note ?? null,
      version: sql`${poDocs.version} + 1`,
      updatedAt: now,
    })
    .where(and(eq(poDocs.id, id), eq(poDocs.version, v.version)))
    .returning();
  if (updated.length === 0) throw new ApiError(409, `版本冲突：期望版本 ${v.version} 已过期`);
  await writeAudit(db, {
    userId: user.id, entity: "po", entityId: id, action: "confirm",
    after: { note: v.note ?? null },
  });
  return updated[0];
}

// ---------- 查询 ----------

export async function getPo(id: number, dbArg?: AnyDb) {
  const db = await resolveDb(dbArg);
  const [doc] = await db
    .select({
      id: poDocs.id,
      docNo: poDocs.docNo,
      status: poDocs.status,
      remark: poDocs.remark,
      version: poDocs.version,
      woId: poDocs.woId,
      supplierId: poDocs.supplierId,
      supplierName: suppliers.name,
      expectedDate: poDocs.expectedDate,
      confirmedAt: poDocs.confirmedAt,
      confirmNote: poDocs.confirmNote,
      createdBy: poDocs.createdBy,
      createdAt: poDocs.createdAt,
      createdByName: users.name,
    })
    .from(poDocs)
    .innerJoin(suppliers, eq(poDocs.supplierId, suppliers.id))
    .leftJoin(users, eq(poDocs.createdBy, users.id))
    .where(eq(poDocs.id, id));
  if (!doc) throw new ApiError(404, "单据不存在");

  const lines = await db
    .select({
      id: poLines.id,
      skuId: poLines.skuId,
      skuCode: skus.code,
      skuName: skus.name,
      barcode: skus.barcode,
      baseUom: skus.baseUom,
      lineType: poLines.lineType,
      purchaseUom: poLines.purchaseUom,
      uomFactor: poLines.uomFactor,
      qty: poLines.qty,
      price: poLines.price, // 敏感——路由边界 maskSensitive 按角色剥离
      taxIncluded: poLines.taxIncluded,
      taxRatePct: poLines.taxRatePct,
      receivedQty: poLines.receivedQty,
    })
    .from(poLines)
    .innerJoin(skus, eq(poLines.skuId, skus.id))
    .where(eq(poLines.poId, id))
    .orderBy(poLines.id);

  const approvalRows = await loadApprovalHistory(db, "po", id);

  return { ...doc, lines, approvals: approvalRows };
}

export async function listPos(
  q: string,
  opts: { status?: string; woId?: number; page: number; pageSize: number },
  dbArg?: AnyDb,
): Promise<{ rows: unknown[]; total: number }> {
  const db = await resolveDb(dbArg);
  const conds = [];
  if (q) conds.push(or(sql`${poDocs.docNo} ILIKE ${"%" + q + "%"}`, skuLineMatch("po_lines", "po_id", poDocs.id, q)));
  if (opts.status) conds.push(eq(poDocs.status, opts.status as DocStatus));
  if (opts.woId) conds.push(eq(poDocs.woId, opts.woId));
  const where = conds.length ? and(...conds) : undefined;

  const lineAgg = db
    .select({ poId: poLines.poId, lineCount: sql<number>`count(*)::int`.as("agg_line_count") })
    .from(poLines)
    .groupBy(poLines.poId)
    .as("la");

  const [rows, [{ total }]] = await Promise.all([
    db
      .select({
        id: poDocs.id,
        docNo: poDocs.docNo,
        status: poDocs.status,
        woId: poDocs.woId,
        supplierName: suppliers.name,
        lineCount: sql<number>`coalesce(${lineAgg.lineCount}, 0)`,
        expectedDate: poDocs.expectedDate,
        confirmedAt: poDocs.confirmedAt,
        createdByName: users.name,
        createdAt: poDocs.createdAt,
      })
      .from(poDocs)
      .innerJoin(suppliers, eq(poDocs.supplierId, suppliers.id))
      .leftJoin(lineAgg, eq(lineAgg.poId, poDocs.id))
      .leftJoin(users, eq(poDocs.createdBy, users.id))
      .where(where)
      .orderBy(desc(poDocs.createdAt), desc(poDocs.id))
      .limit(opts.pageSize)
      .offset((opts.page - 1) * opts.pageSize),
    db.select({ total: sql<number>`count(*)::int` }).from(poDocs).where(where),
  ]);
  return { rows, total };
}

/**
 * PC 列表：oldPrice/newPrice/deviationPct 不在 SENSITIVE_FIELDS 黑名单（constants 本波不可改），
 * maskSensitive 剥不掉——在此按 canSeePrices 手工剥离，路由仍再套 maskSensitive 兜底。
 */
export async function listPcs(
  roles: string[],
  opts: { status?: string; target?: string; page: number; pageSize: number },
  dbArg?: AnyDb,
): Promise<{ rows: unknown[]; total: number }> {
  const db = await resolveDb(dbArg);
  const conds = [];
  if (opts.status) conds.push(eq(pcDocs.status, opts.status as DocStatus));
  if (opts.target) conds.push(eq(pcDocs.target, opts.target as "po_line" | "jg_fee"));
  const where = conds.length ? and(...conds) : undefined;

  const [rawRows, [{ total }]] = await Promise.all([
    db
      .select({
        id: pcDocs.id,
        docNo: pcDocs.docNo,
        status: pcDocs.status,
        target: pcDocs.target,
        poLineId: pcDocs.poLineId,
        jgId: pcDocs.jgId,
        oldPrice: pcDocs.oldPrice,
        newPrice: pcDocs.newPrice,
        deviationPct: pcDocs.deviationPct,
        scope: pcDocs.scope,
        version: pcDocs.version,
        createdByName: users.name,
        createdAt: pcDocs.createdAt,
      })
      .from(pcDocs)
      .leftJoin(users, eq(pcDocs.createdBy, users.id))
      .where(where)
      .orderBy(desc(pcDocs.createdAt), desc(pcDocs.id))
      .limit(opts.pageSize)
      .offset((opts.page - 1) * opts.pageSize),
    db.select({ total: sql<number>`count(*)::int` }).from(pcDocs).where(where),
  ]);
  const rows = canSeePrices(roles)
    ? rawRows
    : rawRows.map(({ oldPrice: _o, newPrice: _n, deviationPct: _d, ...rest }) => rest);
  return { rows, total };
}

/** 撤回：待审批 → 草稿。仅制单人本人（管理员豁免）；不写审批轨迹、不占审批轮次。 */
export async function withdrawPO(
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
        docType: "po",
        table: poDocs,
        docId: id,
        user: { id: user.id, roles: user.roles },
        expectedVersion: v.version,
      });
      if (r.idempotent) return r;
      await writeAudit(tx, { userId: user.id, entity: "po", entityId: id, action: "withdraw" });
      return r;
    });
  } catch (e) {
    rethrowApproval(e);
  }
}

/**
 * 手工状态流转：完成 / 短关 / 作废 / 重开。
 * 此前 po 没有任何到达「已完成」的路径，短关也全仓未实现——
 * 少送尾数的单据会永久卡在「执行中」。这里只补人工收口，不做自动完成。
 */
export async function transitionPO(
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
        docType: "po",
        table: poDocs,
        docId: id,
        user: { id: user.id, roles: user.roles },
        action: v.action,
        reason: v.reason,
        expectedVersion: v.version,
      });
      if (r.idempotent) return r;
      await writeAudit(tx, {
        userId: user.id, entity: "po", entityId: id, action: v.action,
        after: { status: r.status, reason: v.reason ?? null },
      });
      return r;
    });
  } catch (e) {
    rethrowApproval(e);
  }
}
