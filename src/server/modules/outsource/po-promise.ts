import { asc, eq } from "drizzle-orm";

import * as schema from "@/db/schema";
import { ApiError } from "@/server/modules/master/common";
import type { AnyDb } from "./common";

export type PoPromiseRevisionSource =
  | "supplier_confirm"
  | "buyer_revision"
  | "legacy_backfill"
  | "external_observation";

export type PoPromiseActorType =
  | "supplier_token"
  | "internal_user"
  | "system_backfill"
  | "external_system";

export interface PoPromiseSnapshot {
  poId: number;
  headerDate: string | null;
  lines: Array<{ poLineId: number; lineDate: string | null; effectiveDate: string | null }>;
}

/** 在修改日期前捕获有效承诺。调用方必须与后续更新、事件插入放在同一事务。 */
export async function capturePoPromiseSnapshot(db: AnyDb, poId: number): Promise<PoPromiseSnapshot> {
  const [doc] = await db
    .select({ id: schema.poDocs.id, expectedDate: schema.poDocs.expectedDate })
    .from(schema.poDocs)
    .where(eq(schema.poDocs.id, poId));
  if (!doc) throw new ApiError(404, "采购单不存在");
  const rows: Array<{ poLineId: number; lineDate: string | null }> = await db
    .select({ poLineId: schema.poLines.id, lineDate: schema.poLines.expectedDate })
    .from(schema.poLines)
    .where(eq(schema.poLines.poId, poId))
    .orderBy(schema.poLines.id);
  return {
    poId,
    headerDate: doc.expectedDate ?? null,
    lines: rows.map((row) => ({
      ...row,
      lineDate: row.lineDate ?? null,
      effectiveDate: row.lineDate ?? doc.expectedDate ?? null,
    })),
  };
}

/**
 * 供应商亲自给出的承诺来源。第一条这样的修订 = **承诺建立**（`rules/promise-basis` 的原始承诺）。
 * 买手改期（`buyer_revision`）与迁移快照（`legacy_backfill`）都不是供应商的承诺，不在此列。
 */
const SUPPLIER_ORIGIN_SOURCES: ReadonlySet<string> = new Set<PoPromiseRevisionSource>(["supplier_confirm"]);

/**
 * 追加有效承诺变化；没有变化时不写事件。
 * `nextLineDates` 只列出本次明确覆盖的行，其余行继续沿用已有行交期或新的表头交期。
 *
 * **例外——承诺建立行（C5）**：供应商第一次确认时，即使确认的日期与买手下单时填的预计到期日
 * 一模一样，也**必须**写一条行（previousDate = 买手预填日，promisedDate = 供应商确认日）。
 * 不写会留下一个可以洗白 OTIF 的缺口：买手期望 03-01 → 供应商确认 03-01（无行）→
 * `po-confirm.generateConfirmToken` 重发 token → 供应商改到 03-30（这才是第一条行）→
 * `promise-basis` 于是把 03-30 当作「原始承诺」且标 `trusted`，03-28 到货算准时命中。
 * 承诺建立必须留痕，「没改期」不等于「没承诺过」。
 */
export async function appendPoPromiseRevisions(
  db: AnyDb,
  snapshot: PoPromiseSnapshot,
  input: {
    nextHeaderDate: string | null;
    nextLineDates?: ReadonlyMap<number, string | null>;
    source: Exclude<PoPromiseRevisionSource, "legacy_backfill">;
    actorType: Exclude<PoPromiseActorType, "system_backfill">;
    recordedBy?: number | null;
    reason?: string | null;
    externalSource?: string | null;
    externalRef?: string | null;
    occurredAt?: Date;
  },
): Promise<{ inserted: number }> {
  const knownLineIds = new Set(snapshot.lines.map((line) => line.poLineId));
  for (const lineId of input.nextLineDates?.keys() ?? []) {
    if (!knownLineIds.has(lineId)) {
      throw new ApiError(400, `采购单行不存在或不属于该单据: po_line#${lineId}`);
    }
  }

  const existing: Array<{ poLineId: number; sequence: number }> = await db
    .select({ poLineId: schema.poPromiseRevisions.poLineId, sequence: schema.poPromiseRevisions.sequence })
    .from(schema.poPromiseRevisions)
    .where(eq(schema.poPromiseRevisions.poId, snapshot.poId))
    .orderBy(asc(schema.poPromiseRevisions.poLineId), asc(schema.poPromiseRevisions.sequence));
  const maxSequence = new Map<number, number>();
  for (const row of existing) {
    maxSequence.set(row.poLineId, Math.max(maxSequence.get(row.poLineId) ?? 0, row.sequence));
  }

  const occurredAt = input.occurredAt ?? new Date();
  /* 承诺建立行只在供应商**首次**确认时补写：该行此前没有任何修订记录，
     且本次来源是供应商本人。之后的同日重复确认不再补行（幂等，不制造噪声）。 */
  const establishesPromise = SUPPLIER_ORIGIN_SOURCES.has(input.source);
  const values = snapshot.lines.flatMap((line) => {
    const explicitLineDate = input.nextLineDates?.has(line.poLineId)
      ? input.nextLineDates.get(line.poLineId) ?? null
      : line.lineDate;
    const nextEffectiveDate = explicitLineDate ?? input.nextHeaderDate;
    // 没有日期就没有承诺可建立——空承诺不写行（`promise-basis` 也只认 promisedDate 非空的那条）
    const isEstablishment = establishesPromise
      && (maxSequence.get(line.poLineId) ?? 0) === 0
      && nextEffectiveDate != null;
    if (line.effectiveDate === nextEffectiveDate && !isEstablishment) return [];
    const sequence = (maxSequence.get(line.poLineId) ?? 0) + 1;
    return [{
      poId: snapshot.poId,
      poLineId: line.poLineId,
      sequence,
      previousDate: line.effectiveDate,
      promisedDate: nextEffectiveDate,
      source: input.source,
      actorType: input.actorType,
      recordedBy: input.recordedBy ?? null,
      reason: input.reason?.trim() || null,
      externalSource: input.externalSource ?? null,
      externalRef: input.externalRef ?? null,
      idempotencyKey: `po:${snapshot.poId}:line:${line.poLineId}:promise-seq:${sequence}`,
      occurredAt,
    }];
  });
  if (values.length === 0) return { inserted: 0 };
  await db.insert(schema.poPromiseRevisions).values(values);
  return { inserted: values.length };
}
