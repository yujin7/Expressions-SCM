/**
 * DW1 维度种子（幂等，可重复执行）：8 品牌 + 10 渠道 + 品牌/渠道别名行 + 调拨在途仓库别名。
 * 独立成模块以便测试直接调用（seed.ts 末尾追加调用）。
 */
import { and, eq } from "drizzle-orm";
import * as schema from "./schema";
import type { AliasType, ChannelKind } from "./schema";
import type { DimDb } from "@/server/modules/dimension/resolver";

export type SeedCounts = Record<string, { inserted: number; skipped: number }>;

const BRAND_SEEDS: { code: string; nameCn: string; nameEn: string | null; sortOrder: number }[] = [
  { code: "NING", nameCn: "NING", nameEn: "NING", sortOrder: 1 },
  { code: "EXP", nameCn: "EXPRESSIONS", nameEn: "EXPRESSIONS", sortOrder: 2 },
  { code: "DEV", nameCn: "DEVIANCE", nameEn: "DEVIANCE", sortOrder: 3 },
  { code: "B2F", nameCn: "BORN2FLY", nameEn: "BORN2FLY", sortOrder: 4 },
  { code: "LYUV", nameCn: "LYUV", nameEn: "LYUV", sortOrder: 5 },
  { code: "ABS", nameCn: "爱碧生", nameEn: null, sortOrder: 6 },
  { code: "DWS", nameCn: "黛雯丝", nameEn: null, sortOrder: 7 },
  { code: "WC", nameCn: "微初", nameEn: null, sortOrder: 8 },
];

/** 品牌别名（中英合并：爱碧生↔ABS 等；值→brands.code） */
const BRAND_ALIAS_SEEDS: [string, string][] = [
  ["爱碧生", "ABS"],
  ["黛雯丝", "DWS"],
  ["微初", "WC"],
  ["国内品牌LYUV", "LYUV"],
  ["BORN2FLY", "B2F"],
  ["EXPRESSIONS", "EXP"],
  ["DEVIANCE", "DEV"],
];

const CHANNEL_SEEDS: { code: string; name: string; kind: ChannelKind }[] = [
  { code: "tmall", name: "天猫", kind: "platform" },
  { code: "pdd", name: "拼多多", kind: "platform" },
  { code: "jd", name: "京东", kind: "platform" },
  { code: "vip", name: "唯品会", kind: "platform" },
  { code: "douyin", name: "抖音商品卡", kind: "platform" },
  { code: "biz", name: "商务", kind: "dept" },
  { code: "private", name: "私域", kind: "dept" },
  { code: "brand", name: "品牌中心", kind: "dept" },
  { code: "overseas", name: "海外", kind: "dept" },
  { code: "channel", name: "渠道", kind: "dept" },
];

/** 渠道别名（值→channels.code） */
const CHANNEL_ALIAS_SEEDS: [string, string][] = [
  ["唯品", "vip"],
  ["多多", "pdd"],
  ["商务达播", "biz"],
  ["拼多多-得物", "pdd"],
];

async function insertAliasOnce(
  db: DimDb,
  aliasType: AliasType,
  rawValue: string,
  targetId: number,
  bump: (table: string, inserted: boolean) => void,
) {
  const [exists] = await db
    .select({ id: schema.aliases.id })
    .from(schema.aliases)
    .where(and(eq(schema.aliases.aliasType, aliasType), eq(schema.aliases.rawValue, rawValue)));
  if (exists) {
    bump("aliases", false);
    return;
  }
  await db.insert(schema.aliases).values({ aliasType, rawValue, targetId, note: "seed" });
  bump("aliases", true);
}

export async function seedDimensions(db: DimDb): Promise<SeedCounts> {
  const counts: SeedCounts = {};
  const bump = (table: string, inserted: boolean) => {
    counts[table] ??= { inserted: 0, skipped: 0 };
    counts[table][inserted ? "inserted" : "skipped"]++;
  };

  // ---------- 品牌 ----------
  const brandIds: Record<string, number> = {};
  for (const b of BRAND_SEEDS) {
    const [exists] = await db.select().from(schema.brands).where(eq(schema.brands.code, b.code));
    if (exists) {
      brandIds[b.code] = exists.id;
      bump("brands", false);
      continue;
    }
    const [created] = await db.insert(schema.brands).values(b).returning();
    brandIds[b.code] = created.id;
    bump("brands", true);
  }

  // ---------- 渠道 ----------
  const channelIds: Record<string, number> = {};
  for (const c of CHANNEL_SEEDS) {
    const [exists] = await db.select().from(schema.channels).where(eq(schema.channels.code, c.code));
    if (exists) {
      channelIds[c.code] = exists.id;
      bump("channels", false);
      continue;
    }
    const [created] = await db.insert(schema.channels).values(c).returning();
    channelIds[c.code] = created.id;
    bump("channels", true);
  }

  // ---------- 品牌/渠道别名行（变体是数据，不是代码） ----------
  for (const [raw, code] of BRAND_ALIAS_SEEDS) {
    await insertAliasOnce(db, "brand", raw, brandIds[code], bump);
  }
  for (const [raw, code] of CHANNEL_ALIAS_SEEDS) {
    await insertAliasOnce(db, "channel", raw, channelIds[code], bump);
  }

  // ---------- 仓库别名：调拨在途/在途调拨 变体（仅当在途仓已建） ----------
  const [transitWh] = await db
    .select({ id: schema.warehouses.id })
    .from(schema.warehouses)
    .where(eq(schema.warehouses.code, "WH-ZT"));
  if (transitWh) {
    for (const raw of ["调拨在途", "在途调拨"]) {
      await insertAliasOnce(db, "warehouse", raw, transitWh.id, bump);
    }
  }

  return counts;
}
