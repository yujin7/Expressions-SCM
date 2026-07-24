/**
 * #13 供应商确认门户（对标 Ariba/Coupa 的供应商确认链接）。
 *
 * 流程：买手对已审批 PO 生成不可猜 token（generateConfirmToken）→ 外发链接（外发渠道=IT/人工，
 * 买手可复制链接手动发）→ 供应商凭链接打开只读单据摘要（getPoByToken，脱敏：不含内部价）→
 * 提交确认交期（submitPoConfirm，公开写：仅回填 expectedDate/confirmedAt/confirmNote，token 门控，
 * 单 PO 范围，无权限提升）。审计以买手(createdBy)为归属、标注 supplier_via_token 来源。
 *
 * 安全边界：token 为 UUID；公开端点只可写确认三字段；无 token 即拒；不暴露价格/成本。
 */
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { getDbAsync } from "@/db";
import * as schema from "@/db/schema";
import { writeAudit } from "@/server/core/audit";
import { ApiError } from "@/server/modules/master/common";
import { requireAnyRole } from "@/server/modules/outsource/common";
import type { SessionUser } from "@/server/core/dto";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = any;
async function resolveDb(db?: AnyDb): Promise<AnyDb> {
  return db ?? (await getDbAsync());
}

/** 买手生成/重置确认 token（purchasing/pmc/admin），返回 token 与相对链接 */
export async function generateConfirmToken(
  user: SessionUser,
  poId: number,
  dbArg?: AnyDb,
): Promise<{ token: string; path: string }> {
  requireAnyRole(user, "purchasing", "pmc");
  const db = await resolveDb(dbArg);
  const [doc] = await db.select({ id: schema.poDocs.id, status: schema.poDocs.status }).from(schema.poDocs).where(eq(schema.poDocs.id, poId));
  if (!doc) throw new ApiError(404, "采购单不存在");
  if (!["approved", "in_progress"].includes(doc.status)) throw new ApiError(409, "仅已审批/执行中的采购单可生成供应商确认链接");
  const token = randomUUID();
  await db.update(schema.poDocs).set({ confirmToken: token, updatedAt: new Date() }).where(eq(schema.poDocs.id, poId));
  await writeAudit(db, { userId: user.id, entity: "po", entityId: poId, action: "gen_confirm_token", after: { hasToken: true } });
  return { token, path: `/supplier/confirm/${token}` };
}

export interface PublicPoView {
  docNo: string;
  supplierName: string | null;
  status: string;
  expectedDate: string | null;
  confirmedAt: string | null;
  confirmNote: string | null;
  lines: { skuCode: string; skuName: string; qty: string; uom: string }[];
}

/** 公开只读：凭 token 取 PO 摘要（脱敏——不含单价/税/金额） */
export async function getPoByToken(token: string, dbArg?: AnyDb): Promise<PublicPoView> {
  const t = String(token ?? "").trim();
  if (t.length < 8) throw new ApiError(404, "链接无效");
  const db = await resolveDb(dbArg);
  const [doc] = await db
    .select({
      id: schema.poDocs.id,
      docNo: schema.poDocs.docNo,
      status: schema.poDocs.status,
      expectedDate: schema.poDocs.expectedDate,
      confirmedAt: schema.poDocs.confirmedAt,
      confirmNote: schema.poDocs.confirmNote,
      supplierName: schema.suppliers.name,
    })
    .from(schema.poDocs)
    .leftJoin(schema.suppliers, eq(schema.poDocs.supplierId, schema.suppliers.id))
    .where(eq(schema.poDocs.confirmToken, t));
  if (!doc) throw new ApiError(404, "链接无效或已失效");
  const lines: { skuCode: string; skuName: string; qty: string; uom: string }[] = await db
    .select({ skuCode: schema.skus.code, skuName: schema.skus.name, qty: schema.poLines.qty, uom: schema.poLines.purchaseUom })
    .from(schema.poLines)
    .innerJoin(schema.skus, eq(schema.poLines.skuId, schema.skus.id))
    .where(eq(schema.poLines.poId, doc.id));
  return {
    docNo: doc.docNo,
    supplierName: doc.supplierName ?? null,
    status: doc.status,
    expectedDate: doc.expectedDate ?? null,
    confirmedAt: doc.confirmedAt ? new Date(doc.confirmedAt).toISOString() : null,
    confirmNote: doc.confirmNote ?? null,
    lines,
  };
}

/** 公开写：供应商凭 token 提交确认交期（仅回填确认三字段） */
export async function submitPoConfirm(
  token: string,
  input: { expectedDate: string; note?: string },
  dbArg?: AnyDb,
): Promise<{ ok: true; docNo: string }> {
  const t = String(token ?? "").trim();
  if (t.length < 8) throw new ApiError(404, "链接无效");
  const date = String(input?.expectedDate ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new ApiError(400, "请填写有效的交货日期（YYYY-MM-DD）");
  const note = String(input?.note ?? "").trim().slice(0, 300);
  const db = await resolveDb(dbArg);
  const [doc] = await db.select({ id: schema.poDocs.id, docNo: schema.poDocs.docNo, createdBy: schema.poDocs.createdBy }).from(schema.poDocs).where(eq(schema.poDocs.confirmToken, t));
  if (!doc) throw new ApiError(404, "链接无效或已失效");
  const now = new Date();
  await db
    .update(schema.poDocs)
    .set({ expectedDate: date, confirmedAt: now, confirmNote: note || "供应商已确认交期", version: sql`${schema.poDocs.version} + 1`, updatedAt: now })
    .where(and(eq(schema.poDocs.id, doc.id), eq(schema.poDocs.confirmToken, t)));
  await writeAudit(db, {
    userId: doc.createdBy,
    entity: "po",
    entityId: doc.id,
    action: "supplier_confirm",
    after: { source: "supplier_via_token", expectedDate: date, note: note || null },
  });
  return { ok: true, docNo: doc.docNo };
}
