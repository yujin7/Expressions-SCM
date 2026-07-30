/**
 * 别名解析器（《04》§4 管道核心复用件）：
 * 仓库 40+ 别名、渠道别名、OEM 简码、SKU 三码全走同一机制。
 * 解析不到 = 进异常队列人工认领一次，永久生效——摩擦只发生一次。
 *
 * 注意：已知变体（调拨在途/在途调拨、唯品/唯品会、多多/拼多多）不在代码里硬编码，
 * 它们以 aliases 数据行的形式由 seed / 人工认领写入。
 */
import { and, eq, inArray, or } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as schema from "@/db/schema";
import type { AliasType } from "@/db/schema";
import { ApiError } from "@/server/modules/master/common";
import { normalizeSkuIdentifierScope } from "@/server/rules/sku-identifier";

/** 兼容 node-postgres / PGlite / 事务句柄的最小 db 类型 */
export type DimDb = PgDatabase<PgQueryResultHKT, typeof schema>;

export interface AliasResolutionOptions {
  /** GLOBAL=企业通用；外部连接器必须传其规范系统 scope。 */
  scope?: string;
  /** 外部系统专属别名未命中时，是否允许回退企业通用别名。默认 true。 */
  allowGlobalFallback?: boolean;
}

/**
 * 别名文本归一（纯函数）：trim → 全角→半角（含全角空格 U+3000）→ 内部空白折叠为单个半角空格。
 * 不做大小写折叠、不做语义变体映射——语义变体是 aliases 表的数据，不是代码。
 */
export function normalizeAliasText(raw: string): string {
  let s = "";
  for (const ch of raw) {
    const cp = ch.codePointAt(0)!;
    if (cp === 0x3000) {
      s += " "; // 全角空格
    } else if (cp >= 0xff01 && cp <= 0xff5e) {
      s += String.fromCodePoint(cp - 0xfee0); // 全角 ASCII → 半角
    } else {
      s += ch;
    }
  }
  return s.replace(/\s+/g, " ").trim();
}

export function normalizeAliasScope(raw?: string): string {
  return normalizeSkuIdentifierScope("external", raw ?? schema.GLOBAL_ALIAS_SCOPE);
}

async function resolveAliasInScope(
  db: DimDb,
  aliasType: AliasType,
  value: string,
  scope: string,
): Promise<number | null> {
  const [row] = await db
    .select({ targetId: schema.aliases.targetId })
    .from(schema.aliases)
    .where(and(
      eq(schema.aliases.aliasType, aliasType),
      eq(schema.aliases.scope, scope),
      eq(schema.aliases.rawValue, value),
    ));
  return row ? row.targetId : null;
}

/** 归一后精确查 aliases；未命中返回 null（不猜测、不模糊匹配——歧义交人裁决） */
export async function resolveAlias(
  db: DimDb,
  aliasType: AliasType,
  rawValue: string,
  options: AliasResolutionOptions = {},
): Promise<number | null> {
  const value = normalizeAliasText(rawValue);
  if (!value) return null;
  const scope = normalizeAliasScope(options.scope);
  const scoped = await resolveAliasInScope(db, aliasType, value, scope);
  if (scoped !== null) return scoped;
  if (
    scope !== schema.GLOBAL_ALIAS_SCOPE
    && options.allowGlobalFallback !== false
  ) {
    return resolveAliasInScope(db, aliasType, value, schema.GLOBAL_ALIAS_SCOPE);
  }
  return null;
}

/** 入异常队列（幂等：同一类型、scope、值只排队一次；不同系统同码互不串扰） */
export async function queueException(
  db: DimDb,
  aliasType: AliasType,
  rawValue: string,
  context: unknown,
  options: AliasResolutionOptions = {},
): Promise<void> {
  const value = normalizeAliasText(rawValue);
  if (!value) return;
  const scope = normalizeAliasScope(options.scope);
  await db
    .insert(schema.aliasExceptions)
    .values({ aliasType, scope, rawValue: value, context, status: "open" })
    .onConflictDoNothing({
      target: [
        schema.aliasExceptions.aliasType,
        schema.aliasExceptions.scope,
        schema.aliasExceptions.rawValue,
      ],
    });
}

/**
 * 人工认领：写 aliases 行（已存在则跳过——一次认领永久生效，不覆盖既有裁决），
 * 并将匹配的 open 异常置为 resolved。
 */
export async function claimAlias(
  db: DimDb,
  args: {
    aliasType: AliasType;
    rawValue: string;
    targetId: number;
    userId?: number;
    scope?: string;
  },
): Promise<void> {
  const value = normalizeAliasText(args.rawValue);
  if (!value) return;
  const scope = normalizeAliasScope(args.scope);
  await db
    .insert(schema.aliases)
    .values({
      aliasType: args.aliasType,
      scope,
      rawValue: value,
      targetId: args.targetId,
      createdBy: args.userId ?? null,
    })
    .onConflictDoNothing({
      target: [schema.aliases.aliasType, schema.aliases.scope, schema.aliases.rawValue],
    });
  const actualTarget = await resolveAliasInScope(db, args.aliasType, value, scope);
  if (actualTarget !== args.targetId) {
    throw new ApiError(
      409,
      `该别名在 ${scope} 作用域已认领到 ID ${actualTarget}；不能静默改绑`,
    );
  }
  await db
    .update(schema.aliasExceptions)
    .set({
      status: "resolved",
      resolvedTargetId: args.targetId,
      resolvedBy: args.userId ?? null,
      resolvedAt: new Date(),
    })
    .where(
      and(
        eq(schema.aliasExceptions.aliasType, args.aliasType),
        eq(schema.aliasExceptions.scope, scope),
        eq(schema.aliasExceptions.rawValue, value),
        eq(schema.aliasExceptions.status, "open"),
      ),
    );
}

/** 管道便捷入口：命中返回 targetId；未命中入异常队列并返回 null */
export async function resolveOrQueue(
  db: DimDb,
  aliasType: AliasType,
  rawValue: string,
  context: unknown,
  options: AliasResolutionOptions = {},
): Promise<number | null> {
  const targetId = await resolveAlias(db, aliasType, rawValue, options);
  if (targetId !== null) return targetId;
  await queueException(db, aliasType, rawValue, context, options);
  return null;
}

/**
 * 参考层导入便捷入口：别名优先；别名未命中时再做主档的**精确**自然键匹配；
 * 仍未命中或命中不唯一才入异常队列。
 *
 * 这不是模糊匹配，也不会自动写 alias：它只避免把已经等于 SKU/仓库/供应商等
 * 主档编码（或唯一名称）的原值误报为异常。若名称撞到多条主档，仍交人工裁决。
 */
export async function resolveKnownReference(
  db: DimDb,
  aliasType: AliasType,
  rawValue: string,
  options: AliasResolutionOptions = {},
): Promise<number | null> {
  const value = normalizeAliasText(rawValue);
  if (!value) return null;

  const aliasId = await resolveAlias(db, aliasType, value, options);
  if (aliasId !== null) return aliasId;

  const ids = await loadExactReferenceIds(db, aliasType, value, options);
  return ids.length === 1 ? ids[0] : null;
}

async function loadExactReferenceIds(
  db: DimDb,
  aliasType: AliasType,
  value: string,
  options: AliasResolutionOptions = {},
): Promise<number[]> {
  let rows: { id: number }[] = [];
  switch (aliasType) {
    case "sku_code": {
      const scope = normalizeAliasScope(options.scope);
      const identifierConditions = [
        eq(schema.skuIdentifiers.value, value),
        eq(schema.skuIdentifiers.active, true),
      ];
      if (scope === schema.GLOBAL_ALIAS_SCOPE) {
        identifierConditions.push(
          inArray(schema.skuIdentifiers.kind, ["external", "vendor", "customer", "legacy"]),
        );
      } else {
        identifierConditions.push(
          eq(schema.skuIdentifiers.kind, "external"),
          eq(schema.skuIdentifiers.scope, scope),
        );
      }
      rows = [
        ...await db.select({ id: schema.skus.id }).from(schema.skus).where(eq(schema.skus.code, value)),
        ...await db
          .select({ id: schema.skuIdentifiers.skuId })
          .from(schema.skuIdentifiers)
          .where(and(...identifierConditions)),
      ];
      break;
    }
    case "sku_barcode":
      rows = [
        ...await db.select({ id: schema.skus.id }).from(schema.skus).where(eq(schema.skus.barcode, value)),
        ...await db
          .select({ id: schema.skuIdentifiers.skuId })
          .from(schema.skuIdentifiers)
          .where(and(
            eq(schema.skuIdentifiers.kind, "gtin"),
            eq(schema.skuIdentifiers.value, value),
            eq(schema.skuIdentifiers.active, true),
          )),
      ];
      break;
    case "supplier_oem":
      rows = await db
        .select({ id: schema.suppliers.id })
        .from(schema.suppliers)
        .where(or(
          eq(schema.suppliers.code, value),
          eq(schema.suppliers.shortName, value),
          eq(schema.suppliers.name, value),
        ));
      break;
    case "brand":
      rows = await db
        .select({ id: schema.brands.id })
        .from(schema.brands)
        .where(or(
          eq(schema.brands.code, value),
          eq(schema.brands.nameCn, value),
          eq(schema.brands.nameEn, value),
        ));
      break;
    case "channel":
      rows = await db
        .select({ id: schema.channels.id })
        .from(schema.channels)
        .where(or(eq(schema.channels.code, value), eq(schema.channels.name, value)));
      break;
    case "warehouse":
      rows = await db
        .select({ id: schema.warehouses.id })
        .from(schema.warehouses)
        .where(or(eq(schema.warehouses.code, value), eq(schema.warehouses.name, value)));
      break;
  }

  return [...new Set(rows.map((row) => row.id))];
}

export async function resolveKnownOrQueue(
  db: DimDb,
  aliasType: AliasType,
  rawValue: string,
  context: unknown,
  options: AliasResolutionOptions = {},
): Promise<number | null> {
  const value = normalizeAliasText(rawValue);
  if (!value) return null;
  const aliasId = await resolveAlias(db, aliasType, value, options);
  if (aliasId !== null) return aliasId;
  const ids = await loadExactReferenceIds(db, aliasType, value, options);
  if (ids.length === 1) return ids[0];
  const exactMatchCount = ids.length;
  await queueException(db, aliasType, value, {
    ...((context && typeof context === "object") ? context : { context }),
    reason: exactMatchCount > 1 ? "exact_master_match_ambiguous" : "not_found",
    exactMatchCount,
  }, options);
  return null;
}
