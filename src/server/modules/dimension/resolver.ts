/**
 * 别名解析器（《04》§4 管道核心复用件）：
 * 仓库 40+ 别名、渠道别名、OEM 简码、SKU 三码全走同一机制。
 * 解析不到 = 进异常队列人工认领一次，永久生效——摩擦只发生一次。
 *
 * 注意：已知变体（调拨在途/在途调拨、唯品/唯品会、多多/拼多多）不在代码里硬编码，
 * 它们以 aliases 数据行的形式由 seed / 人工认领写入。
 */
import { and, eq } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as schema from "@/db/schema";
import type { AliasType } from "@/db/schema";

/** 兼容 node-postgres / PGlite / 事务句柄的最小 db 类型 */
export type DimDb = PgDatabase<PgQueryResultHKT, typeof schema>;

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

/** 归一后精确查 aliases；未命中返回 null（不猜测、不模糊匹配——歧义交人裁决） */
export async function resolveAlias(
  db: DimDb,
  aliasType: AliasType,
  rawValue: string,
): Promise<number | null> {
  const value = normalizeAliasText(rawValue);
  if (!value) return null;
  const [row] = await db
    .select({ targetId: schema.aliases.targetId })
    .from(schema.aliases)
    .where(and(eq(schema.aliases.aliasType, aliasType), eq(schema.aliases.rawValue, value)));
  return row ? row.targetId : null;
}

/** 入异常队列（幂等：UNIQUE(aliasType, rawValue) 冲突即跳过，同值只排队一次） */
export async function queueException(
  db: DimDb,
  aliasType: AliasType,
  rawValue: string,
  context: unknown,
): Promise<void> {
  const value = normalizeAliasText(rawValue);
  if (!value) return;
  await db
    .insert(schema.aliasExceptions)
    .values({ aliasType, rawValue: value, context, status: "open" })
    .onConflictDoNothing({
      target: [schema.aliasExceptions.aliasType, schema.aliasExceptions.rawValue],
    });
}

/**
 * 人工认领：写 aliases 行（已存在则跳过——一次认领永久生效，不覆盖既有裁决），
 * 并将匹配的 open 异常置为 resolved。
 */
export async function claimAlias(
  db: DimDb,
  args: { aliasType: AliasType; rawValue: string; targetId: number; userId?: number },
): Promise<void> {
  const value = normalizeAliasText(args.rawValue);
  if (!value) return;
  await db
    .insert(schema.aliases)
    .values({
      aliasType: args.aliasType,
      rawValue: value,
      targetId: args.targetId,
      createdBy: args.userId ?? null,
    })
    .onConflictDoNothing({ target: [schema.aliases.aliasType, schema.aliases.rawValue] });
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
): Promise<number | null> {
  const targetId = await resolveAlias(db, aliasType, rawValue);
  if (targetId !== null) return targetId;
  await queueException(db, aliasType, rawValue, context);
  return null;
}
