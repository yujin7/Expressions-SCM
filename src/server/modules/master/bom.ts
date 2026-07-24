import { and, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import { getDbAsync, schema } from "@/db";
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

export async function createBom(input: unknown, userId?: number) {
  const v = bomSchema.parse(input);
  const db = await getDbAsync();
  return db.transaction(async (tx) => {
    const [head] = await tx
      .insert(schema.boms)
      .values({ productSkuId: v.productSkuId, versionNo: v.versionNo, status: "draft", createdBy: userId ?? null })
      .returning();
    await tx.insert(schema.bomLines).values(
      v.lines.map((l) => ({
        bomId: head.id,
        materialSkuId: l.materialSkuId,
        qtyPer: String(l.qtyPer),
        lossRatePct: String(l.lossRatePct),
        leadTimeDays: l.leadTimeDays ?? null,
      })),
    );
    return head;
  });
}

/** 生效即冻结行——仅草稿可编辑；改动=新版本（《01》§3） */
export async function updateBom(id: number, input: unknown) {
  const v = bomSchema.parse(input);
  const db = await getDbAsync();
  return db.transaction(async (tx) => {
    const [bom] = await tx.select().from(schema.boms).where(eq(schema.boms.id, id));
    if (!bom) throw new ApiError(404, "BOM 不存在");
    if (bom.status !== "draft") throw new ApiError(409, "仅草稿状态的 BOM 可编辑，生效版本请新建版本");
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
        leadTimeDays: l.leadTimeDays ?? null,
      })),
    );
    return updated;
  });
}

/**
 * BOM 生效：仅草稿可生效；同事务内先将同产品其他生效版本置为 retired，
 * 再置本版本 active（uq_bom_one_active 部分唯一索引要求——顺序不可颠倒）。
 * TODO(W3): route through approval engine（BOM 生效=审批动作，审批人=PMC is_approver 且非制单人，《01》§6）
 */
export async function activateBom(
  id: number,
  approver: { id: number; roles: string[]; isApprover: boolean },
) {
  const db = await getDbAsync();
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
      .set({ status: "active", effectiveDate: todayShanghai(), updatedAt: new Date() })
      .where(eq(schema.boms.id, id))
      .returning();
    return updated;
  });
}
