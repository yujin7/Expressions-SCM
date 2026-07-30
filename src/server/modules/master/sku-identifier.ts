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

    if (parsed.kind === "gtin") {
      const [legacyIdentifierCollision] = await tx
        .select({ code: schema.skus.code })
        .from(schema.skuIdentifiers)
        .innerJoin(schema.skus, eq(schema.skus.id, schema.skuIdentifiers.skuId))
        .where(and(
          eq(schema.skuIdentifiers.value, parsed.value),
          inArray(schema.skuIdentifiers.kind, ["gtin", "legacy"]),
          ne(schema.skuIdentifiers.skuId, skuId),
        ));
      if (legacyIdentifierCollision) {
        throw new ApiError(
          409,
          `该 GTIN 已作为历史条码关联 SKU ${legacyIdentifierCollision.code}；请先完成人工归属裁决`,
        );
      }
      const [legacyCollision] = await tx
        .select({ id: schema.skus.id, code: schema.skus.code })
        .from(schema.skus)
        .where(and(eq(schema.skus.barcode, parsed.value), ne(schema.skus.id, skuId)));
      if (legacyCollision) {
        throw new ApiError(
          409,
          `该 GTIN 已在旧条码字段关联 SKU ${legacyCollision.code}；请先完成人工归属裁决`,
        );
      }
    }

    if (parsed.isPrimary) {
      await tx
        .update(schema.skuIdentifiers)
        .set({ isPrimary: false, updatedAt: new Date() })
        .where(and(
          eq(schema.skuIdentifiers.skuId, skuId),
          eq(schema.skuIdentifiers.kind, parsed.kind),
          eq(schema.skuIdentifiers.scope, parsed.scope),
          parsed.packagingLevel == null
            ? isNull(schema.skuIdentifiers.packagingLevel)
            : eq(schema.skuIdentifiers.packagingLevel, parsed.packagingLevel),
          eq(schema.skuIdentifiers.active, true),
          eq(schema.skuIdentifiers.isPrimary, true),
        ));
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
      await tx
        .update(schema.skus)
        .set({ barcode: parsed.value, barcodeStatus: "valid", updatedAt: new Date() })
        .where(eq(schema.skus.id, skuId));
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

    const [updated] = await tx
      .update(schema.skuIdentifiers)
      .set({ active, isPrimary: active ? existing.isPrimary : false, updatedAt: new Date() })
      .where(eq(schema.skuIdentifiers.id, identifierId))
      .returning();

    if (
      !active
      && existing.kind === "gtin"
      && existing.packagingLevel === "each"
      && existing.isPrimary
    ) {
      const [replacement] = await tx
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
          barcode: replacement?.value ?? null,
          barcodeStatus: replacement ? "valid" : null,
          updatedAt: new Date(),
        })
        .where(eq(schema.skus.id, skuId));
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
