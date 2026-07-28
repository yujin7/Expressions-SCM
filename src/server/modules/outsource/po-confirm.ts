/**
 * #13 供应商确认门户（对标 Ariba/Coupa 的供应商确认链接）。
 *
 * 流程：买手对已审批 PO 生成不可猜 token（generateConfirmToken）→ 外发链接（外发渠道=IT/人工，
 * 买手可复制链接手动发）→ 供应商凭链接打开只读单据摘要（getPoByToken，脱敏：不含内部价）→
 * 提交确认交期（submitPoConfirm，公开写：回填 expectedDate/confirmedAt/confirmNote 并推进状态机，
 * token 门控 + 有效期 + 单次使用，单 PO 范围，无权限提升）。审计以买手(createdBy)为归属、标注 supplier_via_token 来源。
 *
 * 安全边界：token 为 UUID + 30 天有效期 + 单次使用；公开端点只可写确认字段与逐行交期；无 token 即拒；不暴露价格/成本。
 */
import { randomUUID } from "node:crypto";
import { and, eq, gte, isNull, or, sql } from "drizzle-orm";
import * as schema from "@/db/schema";
import { writeAudit } from "@/server/core/audit";
import { enqueueNotification } from "@/jobs/notify";
import { nextStatus, TransitionError, type DocStatus } from "@/server/docflow/state";
import { ApiError } from "@/server/modules/master/common";
import { requireAnyRole } from "@/server/modules/outsource/common";
import type { SessionUser } from "@/server/core/dto";
import { resolveDb } from "@/server/core/svc";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle PGlite/Postgres structural compatibility is narrowed by the surrounding service contract
type AnyDb = any;

const CONFIRM_TOKEN_TTL_MS = 30 * 86400 * 1000; // 30 天

/** 买手生成/重置确认 token（purchasing/pmc/admin），返回 token 与相对链接。TTL=30 天，重置时清空使用标记 */
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
  await db
    .update(schema.poDocs)
    .set({
      confirmToken: token,
      confirmTokenExpiresAt: new Date(Date.now() + CONFIRM_TOKEN_TTL_MS),
      confirmTokenUsedAt: null,
      updatedAt: new Date(),
    })
    .where(eq(schema.poDocs.id, poId));
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
  lines: { poLineId: number; skuCode: string; skuName: string; qty: string; uom: string; expectedDate: string | null }[];
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
      confirmTokenExpiresAt: schema.poDocs.confirmTokenExpiresAt,
      supplierName: schema.suppliers.name,
    })
    .from(schema.poDocs)
    .leftJoin(schema.suppliers, eq(schema.poDocs.supplierId, schema.suppliers.id))
    .where(eq(schema.poDocs.confirmToken, t));
  if (!doc) throw new ApiError(404, "链接无效或已失效");
  if (doc.confirmTokenExpiresAt && new Date(doc.confirmTokenExpiresAt).getTime() < Date.now()) {
    throw new ApiError(410, "确认链接已过期，请联系采购重新生成");
  }
  const lines: { poLineId: number; skuCode: string; skuName: string; qty: string; uom: string; expectedDate: string | null }[] = await db
    .select({
      poLineId: schema.poLines.id,
      skuCode: schema.skus.code,
      skuName: schema.skus.name,
      qty: schema.poLines.qty,
      uom: schema.poLines.purchaseUom,
      expectedDate: schema.poLines.expectedDate,
    })
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
    lines: lines.map((l) => ({ ...l, expectedDate: l.expectedDate ?? null })),
  };
}

/**
 * 公开写：供应商凭 token 提交确认交期。
 * - 校验 token 有效期（过期 410）与单次使用（已用 409）。
 * - 可选逐行交期 lines：逐行回填 po_lines.expectedDate；表头 expectedDate 取各行最早日期（无行则用单一日期）。
 * - 推进状态机（approved→in_progress，同内部确认）；标记 confirmTokenUsedAt。
 * - 通知买手（尽力而为，失败不影响确认）。
 */
export async function submitPoConfirm(
  token: string,
  input: { expectedDate: string; note?: string; lines?: { poLineId: number; expectedDate: string }[] },
  dbArg?: AnyDb,
): Promise<{ ok: true; docNo: string }> {
  const t = String(token ?? "").trim();
  if (t.length < 8) throw new ApiError(404, "链接无效");
  const headerInput = String(input?.expectedDate ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(headerInput)) throw new ApiError(400, "请填写有效的交货日期（YYYY-MM-DD）");
  const note = String(input?.note ?? "").trim().slice(0, 300);

  // 校验逐行交期
  const lineInputs = Array.isArray(input?.lines) ? input.lines : [];
  for (const l of lineInputs) {
    if (typeof l?.poLineId !== "number" || !Number.isInteger(l.poLineId)) throw new ApiError(400, "行标识无效");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(l?.expectedDate ?? "").trim())) throw new ApiError(400, "请填写有效的行交货日期（YYYY-MM-DD）");
  }

  const db = await resolveDb(dbArg);
  const [doc] = await db
    .select({
      id: schema.poDocs.id,
      docNo: schema.poDocs.docNo,
      status: schema.poDocs.status,
      createdBy: schema.poDocs.createdBy,
      confirmTokenExpiresAt: schema.poDocs.confirmTokenExpiresAt,
      confirmTokenUsedAt: schema.poDocs.confirmTokenUsedAt,
    })
    .from(schema.poDocs)
    .where(eq(schema.poDocs.confirmToken, t));
  if (!doc) throw new ApiError(404, "链接无效或已失效");
  if (doc.confirmTokenExpiresAt && new Date(doc.confirmTokenExpiresAt).getTime() < Date.now()) {
    throw new ApiError(410, "确认链接已过期，请联系采购重新生成");
  }
  if (doc.confirmTokenUsedAt) {
    throw new ApiError(409, "该确认链接已使用，如需修改交期请联系采购");
  }

  const now = new Date();
  const confirmed = await db.transaction(async (tx: AnyDb) => {
    const validDates = lineInputs.map((line) => String(line.expectedDate).trim());
    const headerDate = validDates.length > 0 ? validDates.slice().sort()[0] : headerInput;

    // 推进状态机（approved→in_progress），已在执行中则只更新交期。
    let target: DocStatus | null = null;
    try {
      target = nextStatus(doc.status as DocStatus, "confirm");
    } catch (e) {
      if (!(e instanceof TransitionError)) throw e;
      target = null;
    }

    // 原子消费 token：used_at 仍为空且未过期才更新成功。并发请求只有一个能 returning。
    const claimed: { id: number }[] = await tx
      .update(schema.poDocs)
      .set({
        ...(target ? { status: target } : {}),
        expectedDate: headerDate,
        confirmedAt: now,
        confirmNote: note || "供应商已确认交期",
        confirmTokenUsedAt: now,
        version: sql`${schema.poDocs.version} + 1`,
        updatedAt: now,
      })
      .where(and(
        eq(schema.poDocs.id, doc.id),
        eq(schema.poDocs.confirmToken, t),
        isNull(schema.poDocs.confirmTokenUsedAt),
        or(
          isNull(schema.poDocs.confirmTokenExpiresAt),
          gte(schema.poDocs.confirmTokenExpiresAt, now),
        ),
      ))
      .returning({ id: schema.poDocs.id });
    if (claimed.length !== 1) {
      throw new ApiError(409, "该确认链接已被使用或已过期，请联系采购重新生成");
    }

    // 逐行回填必须命中本 PO；任一行越权/不存在则整笔（含 token 消费）回滚。
    for (const line of lineInputs) {
      const updated: { id: number }[] = await tx
        .update(schema.poLines)
        .set({ expectedDate: String(line.expectedDate).trim() })
        .where(and(eq(schema.poLines.id, line.poLineId), eq(schema.poLines.poId, doc.id)))
        .returning({ id: schema.poLines.id });
      if (updated.length !== 1) {
        throw new ApiError(400, `采购单行不存在或不属于该单据: po_line#${line.poLineId}`);
      }
    }

    await writeAudit(tx, {
      userId: doc.createdBy,
      entity: "po",
      entityId: doc.id,
      action: "supplier_confirm",
      after: {
        source: "supplier_via_token",
        expectedDate: headerDate,
        lines: validDates.length,
        note: note || null,
        status: target ?? doc.status,
      },
    });
    return { headerDate };
  });

  // func#10 通知买手（尽力而为，失败不影响确认结果）
  try {
    await enqueueNotification(db, {
      channel: "in_app",
      title: "供应商已确认交期",
      body: `${doc.docNo} 供应商确认交货日 ${confirmed.headerDate}`,
      href: "/outsource/po",
      severity: "info",
      dedupeKey: `po_confirm:${doc.id}:${confirmed.headerDate}`,
      userId: doc.createdBy, // func#12：定向通知买手本人
    });
  } catch {
    // 通知失败不影响确认结果
  }

  return { ok: true, docNo: doc.docNo };
}
