import { and, asc, desc, eq, ilike, inArray, lt, ne, or, sql } from "drizzle-orm";
import { getDbAsync, schema, type DB } from "@/db";
import { writeAudit } from "@/server/core/audit";
import { dCmp } from "@/server/core/decimal";
import {
  BomDepthError,
  findBomCycleFrom,
  type BomLineLike,
} from "@/server/rules/bom-explode";
import { ApiError, todayShanghai } from "./common";
import { bomSchema } from "./schemas";

export interface BomLineRow {
  id: number;
  bomId: number;
  materialSkuId: number;
  materialSkuCode: string;
  materialName: string | null;
  materialSpec: string | null;
  baseUom: string;
  qtyPer: string;
  lossRatePct: string;
  leadTimeDays: number | null;
}

async function fetchLines(bomIds: number[]): Promise<BomLineRow[]> {
  if (!bomIds.length) return [];
  const db = await getDbAsync();
  return db
    .select({
      id: schema.bomLines.id,
      bomId: schema.bomLines.bomId,
      materialSkuId: schema.bomLines.materialSkuId,
      materialSkuCode: schema.skus.code,
      materialName: schema.spus.nameCn,
      materialSpec: schema.skus.spec,
      baseUom: schema.skus.baseUom,
      qtyPer: schema.bomLines.qtyPer,
      lossRatePct: schema.bomLines.lossRatePct,
      incomingLossPct: schema.bomLines.incomingLossPct,
      productionLossPct: schema.bomLines.productionLossPct,
      leadTimeDays: schema.bomLines.leadTimeDays,
    })
    .from(schema.bomLines)
    .innerJoin(schema.skus, eq(schema.bomLines.materialSkuId, schema.skus.id))
    .innerJoin(schema.spus, eq(schema.skus.spuId, schema.spus.id))
    .where(inArray(schema.bomLines.bomId, bomIds))
    .orderBy(schema.bomLines.id);
}

export async function listBoms(q: string, page: number, pageSize: number, status?: string) {
  const db = await getDbAsync();
  const conds = [];
  // RT4：status 过滤此前是无操作参数——现真实生效（非法值忽略）
  if (status && ["draft", "active", "retired"].includes(status)) {
    conds.push(eq(schema.boms.status, status as "draft" | "active" | "retired"));
  }
  if (q) {
    conds.push(
      or(
        ilike(schema.skus.code, `%${q}%`),
        ilike(schema.spus.nameCn, `%${q}%`),
        ilike(schema.boms.versionNo, `%${q}%`),
      ),
    );
  }
  const where = conds.length ? and(...conds) : undefined;

  const [rows, [{ total }]] = await Promise.all([
    db
      .select({
        id: schema.boms.id,
        productSkuId: schema.boms.productSkuId,
        productSkuCode: schema.skus.code,
        productName: schema.spus.nameCn,
        productSpec: schema.skus.spec,
        versionNo: schema.boms.versionNo,
        status: schema.boms.status,
        effectiveDate: schema.boms.effectiveDate,
      })
      .from(schema.boms)
      .innerJoin(schema.skus, eq(schema.boms.productSkuId, schema.skus.id))
      .innerJoin(schema.spus, eq(schema.skus.spuId, schema.spus.id))
      .where(where)
      .orderBy(desc(schema.boms.id))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(schema.boms)
      .innerJoin(schema.skus, eq(schema.boms.productSkuId, schema.skus.id))
      .innerJoin(schema.spus, eq(schema.skus.spuId, schema.spus.id))
      .where(where),
  ]);

  const lines = await fetchLines(rows.map((r) => r.id));
  const grouped = new Map<number, BomLineRow[]>();
  for (const line of lines) {
    const arr = grouped.get(line.bomId) ?? [];
    arr.push(line);
    grouped.set(line.bomId, arr);
  }
  return { data: rows.map((r) => ({ ...r, lines: grouped.get(r.id) ?? [] })), total };
}

export async function getBom(id: number) {
  const db = await getDbAsync();
  const [bom] = await db.select().from(schema.boms).where(eq(schema.boms.id, id));
  if (!bom) throw new ApiError(404, "BOM 不存在");
  const lines = await fetchLines([id]);
  return { ...bom, lines };
}

export async function createBom(
  input: unknown,
  actor?: { id: number },
  dbOverride?: DB,
) {
  const v = bomSchema.parse(input);
  const db = dbOverride ?? (await getDbAsync());
  return db.transaction(async (tx) => {
    const [head] = await tx
      .insert(schema.boms)
      .values({ productSkuId: v.productSkuId, versionNo: v.versionNo, status: "draft", createdBy: actor?.id ?? null })
      .returning();
    await tx.insert(schema.bomLines).values(
      v.lines.map((l) => ({
        bomId: head.id,
        materialSkuId: l.materialSkuId,
        qtyPer: String(l.qtyPer),
        lossRatePct: String(l.lossRatePct),
        incomingLossPct: String(l.incomingLossPct ?? 0),
        productionLossPct: String(l.productionLossPct ?? 0),
        leadTimeDays: l.leadTimeDays ?? null,
      })),
    );
    if (actor) {
      await writeAudit(tx, {
        userId: actor.id,
        entity: "bom",
        entityId: head.id,
        action: "create",
        after: { ...head, lines: v.lines },
      });
    }
    return head;
  });
}

/** 生效即冻结行——仅草稿可编辑；改动=新版本（《01》§3） */
export async function updateBom(
  id: number,
  input: unknown,
  actor?: { id: number },
  dbOverride?: DB,
) {
  const v = bomSchema.parse(input);
  const db = dbOverride ?? (await getDbAsync());
  return db.transaction(async (tx) => {
    const [bom] = await tx.select().from(schema.boms).where(eq(schema.boms.id, id));
    if (!bom) throw new ApiError(404, "BOM 不存在");
    if (bom.status !== "draft") throw new ApiError(409, "仅草稿状态的 BOM 可编辑，生效版本请新建版本");
    const existingLines = await tx.select().from(schema.bomLines).where(eq(schema.bomLines.bomId, id));
    const [updated] = await tx
      .update(schema.boms)
      .set({ productSkuId: v.productSkuId, versionNo: v.versionNo, updatedAt: new Date() })
      .where(eq(schema.boms.id, id))
      .returning();
    await tx.delete(schema.bomLines).where(eq(schema.bomLines.bomId, id));
    await tx.insert(schema.bomLines).values(
      v.lines.map((l) => ({
        bomId: id,
        materialSkuId: l.materialSkuId,
        qtyPer: String(l.qtyPer),
        lossRatePct: String(l.lossRatePct),
        incomingLossPct: String(l.incomingLossPct ?? 0),
        productionLossPct: String(l.productionLossPct ?? 0),
        leadTimeDays: l.leadTimeDays ?? null,
      })),
    );
    if (actor) {
      await writeAudit(tx, {
        userId: actor.id,
        entity: "bom",
        entityId: id,
        action: "update",
        before: { ...bom, lines: existingLines },
        after: { ...updated, lines: v.lines },
      });
    }
    return updated;
  });
}

/**
 * BOM 图是一个跨主档聚合不变量。用同一 doc_counters 哨兵行串行化生效事务，
 * 避免 A→B 与 B→A 两张草稿并发审批时都在对方提交前通过检查。
 */
async function lockAndValidateBomGraph(tx: DB, candidateBomId: number, productSkuId: number) {
  await tx
    .insert(schema.docCounters)
    .values({ prefix: "BOM-GRAPH", bizDate: "GLOBAL", lastNo: 0 })
    .onConflictDoNothing();
  await tx.execute(sql`
    SELECT prefix
    FROM doc_counters
    WHERE prefix = 'BOM-GRAPH' AND biz_date = 'GLOBAL'
    FOR UPDATE
  `);

  const activeHeaders = await tx
    .select({ id: schema.boms.id, productSkuId: schema.boms.productSkuId })
    .from(schema.boms)
    .where(and(
      eq(schema.boms.status, "active"),
      ne(schema.boms.productSkuId, productSkuId),
    ));
  const candidateLines = await tx
    .select({
      materialSkuId: schema.bomLines.materialSkuId,
      qtyPer: schema.bomLines.qtyPer,
      incomingLossPct: schema.bomLines.incomingLossPct,
      productionLossPct: schema.bomLines.productionLossPct,
      lossRatePct: schema.bomLines.lossRatePct,
    })
    .from(schema.bomLines)
    .where(eq(schema.bomLines.bomId, candidateBomId));

  const graph = new Map<number, BomLineLike[]>();
  if (activeHeaders.length > 0) {
    const activeLines = await tx
      .select({
        productSkuId: schema.boms.productSkuId,
        materialSkuId: schema.bomLines.materialSkuId,
        qtyPer: schema.bomLines.qtyPer,
        incomingLossPct: schema.bomLines.incomingLossPct,
        productionLossPct: schema.bomLines.productionLossPct,
        lossRatePct: schema.bomLines.lossRatePct,
      })
      .from(schema.boms)
      .innerJoin(schema.bomLines, eq(schema.bomLines.bomId, schema.boms.id))
      .where(inArray(schema.boms.id, activeHeaders.map((row) => row.id)));
    for (const line of activeLines) {
      const rows = graph.get(line.productSkuId) ?? [];
      rows.push(line);
      graph.set(line.productSkuId, rows);
    }
  }
  graph.set(productSkuId, candidateLines);

  // 候选自身可能不深，但已有父链 + 候选子树合并后会让上游成品超过上限。
  // 沿反向边找出所有受影响祖先，并从每个祖先重验完整可达图。
  const parentsByChild = new Map<number, Set<number>>();
  for (const [parent, lines] of graph) {
    for (const line of lines) {
      const parents = parentsByChild.get(line.materialSkuId) ?? new Set<number>();
      parents.add(parent);
      parentsByChild.set(line.materialSkuId, parents);
    }
  }
  const affectedRoots = new Set<number>([productSkuId]);
  const queue = [productSkuId];
  while (queue.length > 0) {
    const child = queue.shift()!;
    for (const parent of parentsByChild.get(child) ?? []) {
      if (affectedRoots.has(parent)) continue;
      affectedRoots.add(parent);
      queue.push(parent);
    }
  }

  const topRoots = [...affectedRoots].filter(
    (node) => ![...(parentsByChild.get(node) ?? [])].some((parent) => affectedRoots.has(parent)),
  );
  const validationOrder = [
    ...topRoots,
    ...[...affectedRoots].filter((node) => !topRoots.includes(node)),
  ];
  let violation: { kind: "cycle" | "depth"; path: number[] } | null = null;
  for (const root of validationOrder) {
    try {
      const cycle = findBomCycleFrom(root, graph);
      if (cycle) {
        violation = { kind: "cycle", path: cycle };
        break;
      }
    } catch (error) {
      if (error instanceof BomDepthError) {
        violation = { kind: "depth", path: error.path };
        break;
      }
      throw error;
    }
  }
  if (!violation) return;

  const codeRows = await tx
    .select({ id: schema.skus.id, code: schema.skus.code })
    .from(schema.skus)
    .where(inArray(schema.skus.id, [...new Set(violation.path)]));
  const codeById = new Map(codeRows.map((row) => [row.id, row.code]));
  const readablePath = violation.path.map((id) => codeById.get(id) ?? `SKU#${id}`).join(" → ");
  if (violation.kind === "depth") {
    throw new ApiError(409, `BOM 不能生效：层级超过 32 层安全上限 ${readablePath}`);
  }
  throw new ApiError(
    409,
    `BOM 不能生效：检测到循环 ${readablePath}`,
  );
}

/**
 * BOM 生效：仅草稿可生效；同事务内先将同产品其他生效版本置为 retired，
 * 再置本版本 active（uq_bom_one_active 部分唯一索引要求——顺序不可颠倒）。
 * 《01》§6 的管控要求**已在本函数内实现**（勿再当作待办）：审批人资格（is_approver，admin 亦不豁免
 * 职责分离）＋ 不可生效本人创建的 BOM ＋ 委外仓残料拦截（force 显式放行并留审计）。
 * 尚未做的只是形式：未走通用审批引擎（无审批队列条目/驳回理由/轮次），属架构统一，非管控缺口。
 */
export async function activateBom(
  id: number,
  approver: { id: number; roles: string[]; isApprover: boolean },
  opts: { force?: boolean; db?: DB } = {},
) {
  const db = opts.db ?? (await getDbAsync());
  return db.transaction(async (tx) => {
    const [bom] = await tx.select().from(schema.boms).where(eq(schema.boms.id, id));
    if (!bom) throw new ApiError(404, "BOM 不存在");
    if (bom.status !== "draft") throw new ApiError(409, "仅草稿状态的 BOM 可生效");
    // 体检 #4 整改：BOM 生效=审批动作（《01》§6 PMC(is_approver, 非本人)；管理员豁免角色不豁免 SoD）
    const isAdmin = approver.roles.includes("admin");
    if (!isAdmin && !approver.isApprover) throw new ApiError(403, "仅审批人可生效 BOM");
    if (bom.createdBy != null && bom.createdBy === approver.id) {
      throw new ApiError(403, "职责分离：不可生效本人创建的 BOM");
    }
    await lockAndValidateBomGraph(tx, id, bom.productSkuId);
    // FEATURE 5 物料流动效检查：新版本移除的物料若在委外仓仍有结存（垫料/在制），
    // 直接切版会造成发料口径与现场物料脱节——默认拦截，force=true 显式放行并留审计。
    const [outgoing] = await tx
      .select({ id: schema.boms.id, versionNo: schema.boms.versionNo })
      .from(schema.boms)
      .where(
        and(
          eq(schema.boms.productSkuId, bom.productSkuId),
          eq(schema.boms.status, "active"),
          ne(schema.boms.id, id),
        ),
      );
    if (outgoing) {
      const [oldLines, newLines] = await Promise.all([
        tx.select({ skuId: schema.bomLines.materialSkuId }).from(schema.bomLines).where(eq(schema.bomLines.bomId, outgoing.id)),
        tx.select({ skuId: schema.bomLines.materialSkuId }).from(schema.bomLines).where(eq(schema.bomLines.bomId, id)),
      ]);
      const kept = new Set(newLines.map((l) => l.skuId));
      const removed = [...new Set(oldLines.map((l) => l.skuId))].filter((s) => !kept.has(s));
      if (removed.length) {
        const stuck = await tx
          .selectDistinct({ code: schema.skus.code })
          .from(schema.stockBalances)
          .innerJoin(schema.warehouses, eq(schema.stockBalances.warehouseId, schema.warehouses.id))
          .innerJoin(schema.skus, eq(schema.stockBalances.skuId, schema.skus.id))
          .where(
            and(
              eq(schema.warehouses.kind, "outsource"),
              inArray(schema.stockBalances.skuId, removed),
              sql`${schema.stockBalances.qty} <> 0`,
            ),
          )
          .orderBy(schema.skus.code);
        if (stuck.length) {
          const codes = stuck.slice(0, 5).map((s) => s.code).join("、");
          if (!opts.force) {
            throw new ApiError(
              409,
              `新版本移除的物料 ${codes}${stuck.length > 5 ? ` 等 ${stuck.length} 项` : ""}在委外仓仍有结存（垫料/在制），请先核对物料流再生效；如确认无误可在备注注明后重试`,
            );
          }
          // 显式放行：审计记录被跳过的拦截明细
          await writeAudit(tx, {
            userId: approver.id,
            entity: "bom",
            entityId: id,
            action: "activate_forced",
            after: { outgoingBomId: outgoing.id, outgoingVersion: outgoing.versionNo, stuckCodes: stuck.map((s) => s.code) },
          });
        }
      }
    }
    await tx.insert(schema.approvals).values({
      docType: "bom", docId: id, node: 1, cycle: 0, approverId: approver.id, action: "approve",
      comment: `生效 ${bom.versionNo}`,
    }).onConflictDoNothing();
    await tx
      .update(schema.boms)
      .set({ status: "retired", updatedAt: new Date() })
      .where(and(eq(schema.boms.productSkuId, bom.productSkuId), eq(schema.boms.status, "active")));
    const [updated] = await tx
      .update(schema.boms)
      .set({ status: "active", effectiveDate: todayShanghai(), approvedBy: approver.id, updatedAt: new Date() })
      .where(eq(schema.boms.id, id))
      .returning();
    await writeAudit(tx, {
      userId: approver.id,
      entity: "bom",
      entityId: id,
      action: "activate",
      before: bom,
      after: updated,
    });
    return updated;
  });
}

/* ── FEATURE 2：BOM 版本对比 ─────────────────────────────── */

export interface DiffSide {
  id: number;
  versionNo: string;
  status: string;
  effectiveDate: string | null;
  lineCount: number;
}

interface DiffLineSnap {
  qtyPer: string;
  uom: string; // bom_lines.uom 缺省回落 SKU 基础单位
  supplierId: number | null;
  supplierName: string | null;
}

export interface BomDiffLine {
  materialSkuId: number;
  materialSkuCode: string;
  materialName: string | null;
  kind: "added" | "removed" | "changed" | "unchanged";
  changes: ("qty" | "supplier" | "uom")[];
  base: DiffLineSnap | null;
  target: DiffLineSnap | null;
}

async function fetchDiffLines(db: DB, bomId: number) {
  return db
    .select({
      materialSkuId: schema.bomLines.materialSkuId,
      materialSkuCode: schema.skus.code,
      materialName: schema.spus.nameCn,
      baseUom: schema.skus.baseUom,
      qtyPer: schema.bomLines.qtyPer,
      uom: schema.bomLines.uom,
      supplierId: schema.bomLines.preferredSupplierId,
      supplierName: schema.suppliers.name,
    })
    .from(schema.bomLines)
    .innerJoin(schema.skus, eq(schema.bomLines.materialSkuId, schema.skus.id))
    .innerJoin(schema.spus, eq(schema.skus.spuId, schema.spus.id))
    .leftJoin(schema.suppliers, eq(schema.bomLines.preferredSupplierId, schema.suppliers.id))
    .where(eq(schema.bomLines.bomId, bomId))
    .orderBy(schema.skus.code);
}

type DiffLineRow = Awaited<ReturnType<typeof fetchDiffLines>>[number];

function snap(l: DiffLineRow): DiffLineSnap {
  return { qtyPer: l.qtyPer, uom: l.uom ?? l.baseUom, supplierId: l.supplierId, supplierName: l.supplierName };
}

/**
 * 行级版本对比：againstId 缺省取同产品的上一版本（按创建序）。
 * 支持 retired vs active 任意同产品版本互比；跨产品拒绝。
 */
export async function diffBom(id: number, againstId?: number, dbOverride?: DB) {
  const db = dbOverride ?? (await getDbAsync());
  const [target] = await db.select().from(schema.boms).where(eq(schema.boms.id, id));
  if (!target) throw new ApiError(404, "BOM 不存在");

  // 同产品全部版本（Drawer 内切换对比基准用）
  const siblings = await db
    .select({
      id: schema.boms.id,
      versionNo: schema.boms.versionNo,
      status: schema.boms.status,
      effectiveDate: schema.boms.effectiveDate,
    })
    .from(schema.boms)
    .where(eq(schema.boms.productSkuId, target.productSkuId))
    .orderBy(asc(schema.boms.id));

  let base: (typeof siblings)[number] | null = null;
  if (againstId != null) {
    base = siblings.find((s) => s.id === againstId) ?? null;
    if (!base) throw new ApiError(400, "对比版本必须是同一成品的 BOM");
    if (base.id === id) throw new ApiError(400, "不能与自身对比");
  } else {
    const prev = await db
      .select({ id: schema.boms.id })
      .from(schema.boms)
      .where(and(eq(schema.boms.productSkuId, target.productSkuId), lt(schema.boms.id, id)))
      .orderBy(desc(schema.boms.id))
      .limit(1);
    base = prev.length ? siblings.find((s) => s.id === prev[0].id) ?? null : null;
  }

  const [product] = await db
    .select({ code: schema.skus.code, name: schema.spus.nameCn, spec: schema.skus.spec })
    .from(schema.skus)
    .innerJoin(schema.spus, eq(schema.skus.spuId, schema.spus.id))
    .where(eq(schema.skus.id, target.productSkuId));

  const targetLines = await fetchDiffLines(db, id);
  const baseLines = base ? await fetchDiffLines(db, base.id) : [];
  const baseMap = new Map(baseLines.map((l) => [l.materialSkuId, l]));
  const targetMap = new Map(targetLines.map((l) => [l.materialSkuId, l]));

  const lines: BomDiffLine[] = [];
  for (const t of targetLines) {
    const b = baseMap.get(t.materialSkuId);
    if (!b) {
      lines.push({
        materialSkuId: t.materialSkuId, materialSkuCode: t.materialSkuCode, materialName: t.materialName,
        kind: "added", changes: [], base: null, target: snap(t),
      });
      continue;
    }
    const changes: BomDiffLine["changes"] = [];
    if (dCmp(b.qtyPer, t.qtyPer) !== 0) changes.push("qty");
    if ((b.supplierId ?? null) !== (t.supplierId ?? null)) changes.push("supplier");
    if ((b.uom ?? b.baseUom) !== (t.uom ?? t.baseUom)) changes.push("uom");
    lines.push({
      materialSkuId: t.materialSkuId, materialSkuCode: t.materialSkuCode, materialName: t.materialName,
      kind: changes.length ? "changed" : "unchanged", changes, base: snap(b), target: snap(t),
    });
  }
  for (const b of baseLines) {
    if (targetMap.has(b.materialSkuId)) continue;
    lines.push({
      materialSkuId: b.materialSkuId, materialSkuCode: b.materialSkuCode, materialName: b.materialName,
      kind: "removed", changes: [], base: snap(b), target: null,
    });
  }
  lines.sort((a, c) => a.materialSkuCode.localeCompare(c.materialSkuCode));

  const side = (h: { id: number; versionNo: string; status: string; effectiveDate: string | null } | null, count: number): DiffSide | null =>
    h ? { id: h.id, versionNo: h.versionNo, status: h.status, effectiveDate: h.effectiveDate, lineCount: count } : null;

  return {
    product: { skuId: target.productSkuId, code: product?.code ?? "", name: product?.name ?? "", spec: product?.spec ?? null },
    target: side({ id: target.id, versionNo: target.versionNo, status: target.status, effectiveDate: target.effectiveDate }, targetLines.length)!,
    base: side(base, baseLines.length),
    siblings,
    lines,
  };
}
