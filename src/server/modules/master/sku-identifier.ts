import { and, asc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { getDbAsync, schema } from "@/db";
import { writeAudit } from "@/server/core/audit";
import type { SessionUser } from "@/server/core/dto";
import {
  normalizeSkuIdentifier,
  normalizeSkuIdentifierScope,
  skuIdentifierSchema,
} from "@/server/rules/sku-identifier";
import { ApiError } from "./common";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- PGlite/Postgres structural compatibility is constrained by service tests
type AnyDb = any;

async function requireSku(db: AnyDb, skuId: number) {
  const [sku] = await db
    .select({ id: schema.skus.id, code: schema.skus.code, barcode: schema.skus.barcode })
    .from(schema.skus)
    .where(eq(schema.skus.id, skuId));
  if (!sku) throw new ApiError(404, "SKU 不存在");
  return sku;
}

type IdentifierRow = typeof schema.skuIdentifiers.$inferSelect;

/**
 * Serialize claims for one logical identifier before running check-then-write ownership guards.
 *
 * GTIN and legacy barcode claims deliberately share one lock namespace: they are different
 * evidence kinds, but the same physical code must never race into two SKU owners. Known external
 * scope aliases are normalized before the key is built, so JST/JUSHUITAN/聚水潭 also serialize.
 */
export async function lockSkuIdentifierClaim(
  tx: AnyDb,
  kind: IdentifierRow["kind"],
  value: string,
  scope?: string | null,
) {
  const normalizedValue = value.trim();
  const lockKey = kind === "gtin" || kind === "legacy"
    ? `sku-barcode:${normalizedValue}`
    : `sku-identifier:${kind}:${normalizeSkuIdentifierScope(kind, scope)}:${normalizedValue}`;
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${lockKey}))`);
}

/** Serialize replacement/deactivation within one SKU identifier primary slot. */
export async function lockSkuIdentifierPrimarySlot(
  tx: AnyDb,
  input: Pick<IdentifierRow, "skuId" | "kind" | "scope" | "packagingLevel">,
) {
  const lockKey = [
    "sku-identifier-primary",
    input.skuId,
    input.kind,
    normalizeSkuIdentifierScope(input.kind, input.scope),
    input.packagingLevel ?? "",
  ].join(":");
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${lockKey}))`);
}

export async function assertSkuBarcodeOwnershipInTransaction(
  db: AnyDb,
  skuId: number,
  kind: IdentifierRow["kind"],
  value: string,
) {
  if (kind !== "gtin" && kind !== "legacy") return;
  const [identifierCollision] = await db
    .select({ code: schema.skus.code })
    .from(schema.skuIdentifiers)
    .innerJoin(schema.skus, eq(schema.skus.id, schema.skuIdentifiers.skuId))
    .where(and(
      eq(schema.skuIdentifiers.value, value),
      inArray(schema.skuIdentifiers.kind, ["gtin", "legacy"]),
      ne(schema.skuIdentifiers.skuId, skuId),
    ));
  if (identifierCollision) {
    throw new ApiError(
      409,
      `该条码已关联 SKU ${identifierCollision.code}；请先完成人工归属裁决`,
    );
  }
  const [legacyCollision] = await db
    .select({ code: schema.skus.code })
    .from(schema.skus)
    .where(and(eq(schema.skus.barcode, value), ne(schema.skus.id, skuId)));
  if (legacyCollision) {
    throw new ApiError(
      409,
      `该条码已在旧条码字段关联 SKU ${legacyCollision.code}；请先完成人工归属裁决`,
    );
  }
}

async function assertIdentifierOwnership(
  db: AnyDb,
  input: {
    skuId: number;
    kind: IdentifierRow["kind"];
    value: string;
    scope: string;
    exceptId?: number;
  },
) {
  const conditions = [
    eq(schema.skuIdentifiers.kind, input.kind),
    eq(schema.skuIdentifiers.value, input.value),
  ];
  if (input.exceptId != null) conditions.push(ne(schema.skuIdentifiers.id, input.exceptId));
  const possibleIdentifiers: {
    skuId: number;
    skuCode: string;
    scope: string;
  }[] = await db
    .select({
      skuId: schema.skuIdentifiers.skuId,
      skuCode: schema.skus.code,
      scope: schema.skuIdentifiers.scope,
    })
    .from(schema.skuIdentifiers)
    .innerJoin(schema.skus, eq(schema.skus.id, schema.skuIdentifiers.skuId))
    .where(and(...conditions));
  const equivalentIdentifier = possibleIdentifiers.find((identifier) => (
    input.kind === "external"
      ? normalizeSkuIdentifierScope("external", identifier.scope) === input.scope
      : identifier.scope === input.scope
  ));
  if (equivalentIdentifier) {
    throw new ApiError(
      409,
      equivalentIdentifier.skuId === input.skuId
        ? "该标识已登记；如已停用，请在历史记录中重新启用"
        : `该标识已关联 SKU ${equivalentIdentifier.skuCode}；请先完成人工归属裁决`,
    );
  }
  await assertSkuBarcodeOwnershipInTransaction(db, input.skuId, input.kind, input.value);
}

async function demotePrimarySlot(
  tx: AnyDb,
  identifier: Pick<IdentifierRow, "skuId" | "kind" | "scope" | "packagingLevel">,
  actor: SessionUser,
  exceptId?: number,
) {
  const conditions = [
    eq(schema.skuIdentifiers.skuId, identifier.skuId),
    eq(schema.skuIdentifiers.kind, identifier.kind),
    eq(schema.skuIdentifiers.scope, identifier.scope),
    identifier.packagingLevel == null
      ? isNull(schema.skuIdentifiers.packagingLevel)
      : eq(schema.skuIdentifiers.packagingLevel, identifier.packagingLevel),
    eq(schema.skuIdentifiers.active, true),
    eq(schema.skuIdentifiers.isPrimary, true),
  ];
  if (exceptId != null) conditions.push(ne(schema.skuIdentifiers.id, exceptId));
  const demoted: IdentifierRow[] = await tx
    .select()
    .from(schema.skuIdentifiers)
    .where(and(...conditions));
  for (const before of demoted) {
    const [after] = await tx
      .update(schema.skuIdentifiers)
      .set({ isPrimary: false, updatedAt: new Date() })
      .where(eq(schema.skuIdentifiers.id, before.id))
      .returning();
    await writeAudit(tx, {
      userId: actor.id,
      entity: "sku_identifier",
      entityId: before.id,
      action: "demote_primary",
      before,
      after,
    });
  }
}

async function syncPrimaryEachGtin(tx: AnyDb, skuId: number) {
  const [primary] = await tx
    .select({ value: schema.skuIdentifiers.value })
    .from(schema.skuIdentifiers)
    .where(and(
      eq(schema.skuIdentifiers.skuId, skuId),
      eq(schema.skuIdentifiers.kind, "gtin"),
      eq(schema.skuIdentifiers.packagingLevel, "each"),
      eq(schema.skuIdentifiers.active, true),
      eq(schema.skuIdentifiers.isPrimary, true),
    ));
  await tx
    .update(schema.skus)
    .set({
      barcode: primary?.value ?? null,
      barcodeStatus: primary ? "valid" : null,
      updatedAt: new Date(),
    })
    .where(eq(schema.skus.id, skuId));
}

export async function listSkuIdentifiers(skuId: number, dbArg?: AnyDb) {
  const db = dbArg ?? (await getDbAsync());
  await requireSku(db, skuId);
  return db
    .select()
    .from(schema.skuIdentifiers)
    .where(eq(schema.skuIdentifiers.skuId, skuId))
    .orderBy(
      asc(schema.skuIdentifiers.kind),
      asc(schema.skuIdentifiers.packagingLevel),
      asc(schema.skuIdentifiers.value),
    );
}

export async function createSkuIdentifier(
  skuId: number,
  input: unknown,
  actor: SessionUser,
  dbArg?: AnyDb,
) {
  const parsed = normalizeSkuIdentifier(skuIdentifierSchema.parse(input));
  const db = dbArg ?? (await getDbAsync());
  return db.transaction(async (tx: AnyDb) => {
    const sku = await requireSku(tx, skuId);

    await lockSkuIdentifierClaim(tx, parsed.kind, parsed.value, parsed.scope);
    await assertIdentifierOwnership(tx, {
      skuId,
      kind: parsed.kind,
      value: parsed.value,
      scope: parsed.scope,
    });

    if (parsed.isPrimary) {
      await lockSkuIdentifierPrimarySlot(tx, { skuId, ...parsed });
      await demotePrimarySlot(tx, { skuId, ...parsed }, actor);
    }

    const [created] = await tx
      .insert(schema.skuIdentifiers)
      .values({
        skuId,
        kind: parsed.kind,
        value: parsed.value,
        scope: parsed.scope,
        uom: parsed.uom,
        packagingLevel: parsed.packagingLevel,
        isPrimary: parsed.isPrimary,
        active: true,
        note: parsed.note,
        createdBy: actor.id,
      })
      .returning();

    if (parsed.kind === "gtin" && parsed.packagingLevel === "each" && parsed.isPrimary) {
      await syncPrimaryEachGtin(tx, skuId);
    }

    await writeAudit(tx, {
      userId: actor.id,
      entity: "sku_identifier",
      entityId: created.id,
      action: "create",
      after: { ...created, skuCode: sku.code },
    });
    return created;
  });
}

/**
 * 外部连接器异常经人工认领后，在同一事务内登记为受治理的系统标识。
 *
 * 这是 ensure 而不是盲目 insert：重复点击或历史同义 scope 不会制造重复行；
 * 若同一系统码已属于另一 SKU，则保持人工冲突而不是静默抢占。
 */
export async function ensureExternalSkuIdentifierInTransaction(
  tx: AnyDb,
  input: {
    skuId: number;
    value: string;
    scope: string;
    note?: string;
  },
  actor: SessionUser,
): Promise<{ identifier: IdentifierRow; created: boolean; reactivated: boolean }> {
  const parsed = normalizeSkuIdentifier(skuIdentifierSchema.parse({
    kind: "external",
    value: input.value,
    scope: input.scope,
    note: input.note,
  }));
  const sku = await requireSku(tx, input.skuId);
  await lockSkuIdentifierClaim(tx, parsed.kind, parsed.value, parsed.scope);
  const candidates: IdentifierRow[] = await tx
    .select()
    .from(schema.skuIdentifiers)
    .where(and(
      eq(schema.skuIdentifiers.kind, "external"),
      eq(schema.skuIdentifiers.value, parsed.value),
    ));
  const equivalent = candidates
    .filter((row) => normalizeSkuIdentifierScope("external", row.scope) === parsed.scope)
    .sort((left, right) => {
      if (left.active !== right.active) return left.active ? -1 : 1;
      if ((left.scope === parsed.scope) !== (right.scope === parsed.scope)) {
        return left.scope === parsed.scope ? -1 : 1;
      }
      return left.id - right.id;
    })[0];

  if (equivalent) {
    if (equivalent.skuId !== input.skuId) {
      const [owner] = await tx
        .select({ code: schema.skus.code })
        .from(schema.skus)
        .where(eq(schema.skus.id, equivalent.skuId));
      throw new ApiError(
        409,
        `该标识已关联 SKU ${owner?.code ?? equivalent.skuId}；请先完成人工归属裁决`,
      );
    }
    if (equivalent.active) {
      return { identifier: equivalent, created: false, reactivated: false };
    }
    const [reactivated] = await tx
      .update(schema.skuIdentifiers)
      .set({ active: true, updatedAt: new Date() })
      .where(eq(schema.skuIdentifiers.id, equivalent.id))
      .returning();
    await writeAudit(tx, {
      userId: actor.id,
      entity: "sku_identifier",
      entityId: equivalent.id,
      action: "reactivate_from_alias_claim",
      before: equivalent,
      after: { ...reactivated, skuCode: sku.code },
    });
    return { identifier: reactivated, created: false, reactivated: true };
  }

  await assertIdentifierOwnership(tx, {
    skuId: input.skuId,
    kind: "external",
    value: parsed.value,
    scope: parsed.scope,
  });
  const [created] = await tx
    .insert(schema.skuIdentifiers)
    .values({
      skuId: input.skuId,
      kind: "external",
      value: parsed.value,
      scope: parsed.scope,
      uom: null,
      packagingLevel: null,
      isPrimary: false,
      active: true,
      note: parsed.note,
      createdBy: actor.id,
    })
    .returning();
  await writeAudit(tx, {
    userId: actor.id,
    entity: "sku_identifier",
    entityId: created.id,
    action: "create_from_alias_claim",
    after: { ...created, skuCode: sku.code },
  });
  return { identifier: created, created: true, reactivated: false };
}

export async function setSkuIdentifierActive(
  skuId: number,
  identifierId: number,
  active: boolean,
  actor: SessionUser,
  dbArg?: AnyDb,
) {
  const db = dbArg ?? (await getDbAsync());
  return db.transaction(async (tx: AnyDb) => {
    await requireSku(tx, skuId);
    const [existing] = await tx
      .select()
      .from(schema.skuIdentifiers)
      .where(and(
        eq(schema.skuIdentifiers.id, identifierId),
        eq(schema.skuIdentifiers.skuId, skuId),
      ));
    if (!existing) throw new ApiError(404, "SKU 标识不存在");
    if (existing.active === active) return existing;
    if (!active && existing.isPrimary) {
      await lockSkuIdentifierPrimarySlot(tx, existing);
    }
    if (active) {
      await lockSkuIdentifierClaim(tx, existing.kind, existing.value, existing.scope);
      await assertIdentifierOwnership(tx, {
        skuId,
        kind: existing.kind,
        value: existing.value,
        scope: normalizeSkuIdentifierScope(existing.kind, existing.scope),
        exceptId: existing.id,
      });
    }

    const [updated] = await tx
      .update(schema.skuIdentifiers)
      .set({ active, isPrimary: false, updatedAt: new Date() })
      .where(eq(schema.skuIdentifiers.id, identifierId))
      .returning();

    if (
      !active
      && existing.kind === "gtin"
      && existing.packagingLevel === "each"
      && existing.isPrimary
    ) {
      await syncPrimaryEachGtin(tx, skuId);
    }

    await writeAudit(tx, {
      userId: actor.id,
      entity: "sku_identifier",
      entityId: identifierId,
      action: active ? "reactivate" : "deactivate",
      before: existing,
      after: updated,
    });
    return updated;
  });
}

export async function setSkuIdentifierPrimary(
  skuId: number,
  identifierId: number,
  actor: SessionUser,
  dbArg?: AnyDb,
) {
  const db = dbArg ?? (await getDbAsync());
  return db.transaction(async (tx: AnyDb) => {
    await requireSku(tx, skuId);
    const [existing] = await tx
      .select()
      .from(schema.skuIdentifiers)
      .where(and(
        eq(schema.skuIdentifiers.id, identifierId),
        eq(schema.skuIdentifiers.skuId, skuId),
      ));
    if (!existing) throw new ApiError(404, "SKU 标识不存在");
    if (!existing.active) throw new ApiError(409, "请先启用该标识，再设为主标识");
    if (existing.isPrimary) return existing;
    await lockSkuIdentifierPrimarySlot(tx, existing);
    await assertSkuBarcodeOwnershipInTransaction(tx, skuId, existing.kind, existing.value);
    await demotePrimarySlot(tx, existing, actor, identifierId);
    const [updated] = await tx
      .update(schema.skuIdentifiers)
      .set({ isPrimary: true, updatedAt: new Date() })
      .where(eq(schema.skuIdentifiers.id, identifierId))
      .returning();
    if (existing.kind === "gtin" && existing.packagingLevel === "each") {
      await syncPrimaryEachGtin(tx, skuId);
    }
    await writeAudit(tx, {
      userId: actor.id,
      entity: "sku_identifier",
      entityId: identifierId,
      action: "promote_primary",
      before: existing,
      after: updated,
    });
    return updated;
  });
}
