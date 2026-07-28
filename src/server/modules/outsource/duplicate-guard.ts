/**
 * E3-03 重复下单守卫。
 *
 * 场景：同一 SKU 三天内已开过 BH/WO，再开一张系统一声不吭——尤其在"采纳建议后系统仍会
 * 再次建议"的历史缺陷背景下，这层守卫是必需的。
 *
 * 设计原则（重要）：**提示而非阻断**。业务确有合理的连续下单（追单、分批、紧急插单），
 * 硬拦会误伤并逼出绕过行为。故本模块只回答"近 N 天内该 SKU 有哪些未结单"，
 * 由 UI 在提交前展示，人工判断后继续或取消。
 *
 * 未结口径：BH/WO 处于非终态（draft/pending/approved/in_progress）——已完成/已关闭/作废不算。
 */
import { and, desc, gte, inArray, sql } from "drizzle-orm";
import { getDbAsync } from "@/db";
import { bhDocs, bhLines, woDocs } from "@/db/schema";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle PGlite/Postgres structural compatibility is narrowed by the surrounding service contract
type AnyDb = any;

/** 未结（活跃）状态——与单据状态机一致 */
const OPEN_STATUSES: ("draft" | "pending" | "approved" | "in_progress")[] = ["draft", "pending", "approved", "in_progress"];

export interface RecentOrderHit {
  skuId: number;
  docType: "BH" | "WO";
  docNo: string;
  status: string;
  qty: number;
  createdAt: string;
  daysAgo: number;
}

export interface DuplicateCheckResult {
  windowDays: number;
  /** 命中的未结单（按 SKU 分组便于 UI 呈现） */
  hitsBySku: Record<number, RecentOrderHit[]>;
  /** 命中 SKU 数 */
  skuHitCount: number;
}

/**
 * 查近 windowDays 天内、给定 SKU 的未结 BH/WO。
 * 只读，不写库，不抛错（守卫失败不应阻断业务）。
 */
export async function checkRecentOrders(
  skuIds: number[],
  windowDays = 7,
  dbArg?: AnyDb,
): Promise<DuplicateCheckResult> {
  const ids = [...new Set(skuIds)].filter((n) => Number.isInteger(n) && n > 0);
  if (ids.length === 0) return { windowDays, hitsBySku: {}, skuHitCount: 0 };
  const db: AnyDb = dbArg ?? (await getDbAsync());
  const since = new Date(Date.now() - Math.max(1, windowDays) * 86_400_000);
  const now = Date.now();
  const hitsBySku: Record<number, RecentOrderHit[]> = {};

  const push = (h: RecentOrderHit) => {
    (hitsBySku[h.skuId] ??= []).push(h);
  };

  // BH：经行表关联 SKU
  const bhRows: { skuId: number; docNo: string; status: string; qty: string; createdAt: Date }[] = await db
    .select({
      skuId: bhLines.skuId,
      docNo: bhDocs.docNo,
      status: bhDocs.status,
      qty: bhLines.qty,
      createdAt: bhDocs.createdAt,
    })
    .from(bhLines)
    .innerJoin(bhDocs, sql`${bhLines.bhId} = ${bhDocs.id}`)
    .where(and(inArray(bhLines.skuId, ids), inArray(bhDocs.status, OPEN_STATUSES), gte(bhDocs.createdAt, since)))
    .orderBy(desc(bhDocs.createdAt));
  for (const r of bhRows) {
    push({
      skuId: r.skuId,
      docType: "BH",
      docNo: r.docNo,
      status: r.status,
      qty: Number(r.qty ?? 0),
      createdAt: new Date(r.createdAt).toISOString().slice(0, 10),
      daysAgo: Math.floor((now - new Date(r.createdAt).getTime()) / 86_400_000),
    });
  }

  // WO：产成品 SKU 直接在单头
  const woRows: { skuId: number; docNo: string; status: string; qty: string; createdAt: Date }[] = await db
    .select({
      skuId: woDocs.productSkuId,
      docNo: woDocs.docNo,
      status: woDocs.status,
      qty: woDocs.qty,
      createdAt: woDocs.createdAt,
    })
    .from(woDocs)
    .where(and(inArray(woDocs.productSkuId, ids), inArray(woDocs.status, OPEN_STATUSES), gte(woDocs.createdAt, since)))
    .orderBy(desc(woDocs.createdAt));
  for (const r of woRows) {
    push({
      skuId: r.skuId,
      docType: "WO",
      docNo: r.docNo,
      status: r.status,
      qty: Number(r.qty ?? 0),
      createdAt: new Date(r.createdAt).toISOString().slice(0, 10),
      daysAgo: Math.floor((now - new Date(r.createdAt).getTime()) / 86_400_000),
    });
  }

  return { windowDays, hitsBySku, skuHitCount: Object.keys(hitsBySku).length };
}
