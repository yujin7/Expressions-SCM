import { and, asc, eq, inArray, isNull, ne } from "drizzle-orm";
import { getDbAsync, schema } from "@/db";
import { writeAudit } from "@/server/core/audit";
import type { SessionUser } from "@/server/core/dto";
import {
  normalizeSkuIdentifier,
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

async function assertBarcodeOwnership(
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

    const [exactIdentifier] = await tx
      .select({ skuId: schema.skuIdentifiers.skuId, skuCode: schema.skus.code })
      .from(schema.skuIdentifiers)
      .innerJoin(schema.skus, eq(schema.skus.id, schema.skuIdentifiers.skuId))
      .where(and(
        eq(schema.skuIdentifiers.kind, parsed.kind),
        eq(schema.skuIdentifiers.scope, parsed.scope),
        eq(schema.skuIdentifiers.value, parsed.value),
      ));
    if (exactIdentifier) {
      throw new ApiError(
        409,
        exactIdentifier.skuId === skuId
          ? "该标识已登记；如已停用，请在历史记录中重新启用"
          : `该标识已关联 SKU ${exactIdentifier.skuCode}；请先完成人工归属裁决`,
      );
    }

    await assertBarcodeOwnership(tx, skuId, parsed.kind, parsed.value);

    if (parsed.isPrimary) {
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
    if (active) {
      await assertBarcodeOwnership(tx, skuId, existing.kind, existing.value);
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
    await assertBarcodeOwnership(tx, skuId, existing.kind, existing.value);
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
