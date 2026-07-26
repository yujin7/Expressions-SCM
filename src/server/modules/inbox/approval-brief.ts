/**
 * E3-06 审批简报卡。
 *
 * 问题：审批人批一张 BH 要自己开四个页面查上下文（这个 SKU 缺不缺？是不是刚下过单？
 * 建议是系统给的还是人拍的？历史上这类建议被采纳后真到货了吗？）。
 * 结果是"凭单据本身"审批——而单据上恰恰没有判断所需的信息。
 *
 * 本模块在**审批那一刻**把上下文拼好送到眼前，全部复用既有唯一口径模块：
 * - 在库/销速/可销 → core/stock-view + core/velocity
 * - 未结供给 → core/supply（唯一定义）
 * - 重复下单 → outsource/duplicate-guard（同一守卫，不另写一套判定）
 * 只读、不写库；失败不得阻断审批（调用方 catch 后照常渲染审批按钮）。
 */
import {  eq, inArray } from "drizzle-orm";
import { coverDays } from "@/server/core/stock-view";
import { getDbAsync } from "@/db";
import * as schema from "@/db/schema";
import { ApiError } from "@/server/modules/master/common";
import { getSkuFacts } from "@/server/core/sku-facts";
import { checkRecentOrders } from "@/server/modules/outsource/duplicate-guard";
import { num, r1 } from "@/server/core/svc";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = any;

export interface BriefLine {
  skuId: number;
  code: string;
  name: string;
  baseUom: string;
  /** 本单该 SKU 的数量 */
  docQty: number;
  onHand: number;
  daily: number;
  daysCover: number | null;
  openSupply: number;
  /** 近 7 天该 SKU 的其他未结单（重复下单信号） */
  recentOrders: { docType: string; docNo: string; status: string; daysAgo: number }[];
  /** 本行的关注点（供审批人一眼扫到） */
  flags: string[];
}

export interface ApprovalBrief {
  docType: string;
  docId: number;
  docNo: string;
  /** 单据来源：是系统建议生成的草稿，还是人工直录 */
  origin: { fromSuggestion: boolean; note: string };
  lines: BriefLine[];
  /** 整单关注点汇总 */
  summary: { lineCount: number; flaggedLines: number; totalQty: number };
}

/** 支持简报的单据类型（当前：BH——数量型需求单，审批最需要上下文） */
const SUPPORTED = new Set(["bh"]);

export async function getApprovalBrief(docType: string, docId: number, dbArg?: AnyDb): Promise<ApprovalBrief> {
  const t = String(docType ?? "").toLowerCase();
  if (!SUPPORTED.has(t)) throw new ApiError(400, `暂不支持该单据类型的审批简报：${docType}`);
  const db: AnyDb = dbArg ?? (await getDbAsync());

  const [doc] = await db.select().from(schema.bhDocs).where(eq(schema.bhDocs.id, docId));
  if (!doc) throw new ApiError(404, "单据不存在");

  const lines: { skuId: number; qty: string }[] = await db
    .select({ skuId: schema.bhLines.skuId, qty: schema.bhLines.qty })
    .from(schema.bhLines)
    .where(eq(schema.bhLines.bhId, docId));
  if (lines.length === 0) {
    return {
      docType: t, docId, docNo: doc.docNo,
      origin: { fromSuggestion: false, note: "单据无明细行" },
      lines: [], summary: { lineCount: 0, flaggedLines: 0, totalQty: 0 },
    };
  }
  const skuIds = [...new Set(lines.map((l) => l.skuId))];

  /* 来源：审计里若有 draft_bh/first_order_draft 指向本单号，说明是系统建议产物 */
  const auditRows: { action: string; after: unknown }[] = await db
    .select({ action: schema.auditLogs.action, after: schema.auditLogs.after })
    .from(schema.auditLogs)
    .where(inArray(schema.auditLogs.action, ["draft_bh", "first_order_draft"]));
  const fromSuggestion = auditRows.some((r) => (r.after as { docNo?: string } | null)?.docNo === doc.docNo);

  /* 主档 + 在库 + 销速 */
  const skuRows: { id: number; code: string; name: string; baseUom: string }[] = await db
    .select({ id: schema.skus.id, code: schema.skus.code, name: schema.skus.name, baseUom: schema.skus.baseUom })
    .from(schema.skus)
    .where(inArray(schema.skus.id, skuIds));
  const skuById = new Map(skuRows.map((s) => [s.id, s]));

  /*
   * 在库 / 销速 / 未结供给：core/sku-facts 一次装配。
   * 此前这里自己写了一遍「Σstock_balances + 各仓最新快照」——与 master/sku-brief.ts
   * 是同一段复制品。审批简报是**做审批决定当下**看的那张卡，在库算错就是直接
   * 拿错的数字批单据，所以这里必须走唯一权威而不是第二实现。
   */
  const facts = await getSkuFacts(db, { skuIds });
  const onHandBySku = new Map<number, number>([...facts.bySku].map(([id, f]) => [id, f.onHand]));
  const dailyBySku = new Map<number, number>([...facts.bySku].map(([id, f]) => [id, f.daily]));

  /* 重复下单守卫（同一守卫）；未结供给已随 facts 装配 */
  const dup = await checkRecentOrders(skuIds, 7, db);

  const briefLines: BriefLine[] = lines.map((l) => {
    const sku = skuById.get(l.skuId);
    const onHand = onHandBySku.get(l.skuId) ?? 0;
    const daily = dailyBySku.get(l.skuId) ?? 0;
    const cover = coverDays(onHand, daily);
    const openSupply = facts.bySku.get(l.skuId)?.openSupply ?? 0;
    // 排除本单自身（本单尚未成为未结单，但同 SKU 的其他单要提示）
    const recent = (dup.hitsBySku[l.skuId] ?? []).filter((h) => h.docNo !== doc.docNo);

    const flags: string[] = [];
    if (recent.length > 0) flags.push(`近 7 天已有 ${recent.length} 张未结单`);
    if (cover != null && cover > 180) flags.push(`可销 ${Math.round(cover)} 天，库存已充裕`);
    if (openSupply > 0 && cover != null && cover > 60) flags.push(`另有在途/在制 ${Math.round(openSupply)}`);
    if (daily <= 0 && onHand > 0) flags.push("该 SKU 近 3 月无动销");

    return {
      skuId: l.skuId,
      code: sku?.code ?? `#${l.skuId}`,
      name: sku?.name ?? "",
      baseUom: sku?.baseUom ?? "",
      docQty: num(l.qty),
      onHand: r1(onHand),
      daily: r1(daily),
      daysCover: cover == null ? null : r1(cover),
      openSupply: r1(openSupply),
      recentOrders: recent.map((h) => ({ docType: h.docType, docNo: h.docNo, status: h.status, daysAgo: h.daysAgo })),
      flags,
    };
  });

  return {
    docType: t,
    docId,
    docNo: doc.docNo,
    origin: {
      fromSuggestion,
      note: fromSuggestion
        ? "由系统建议生成的草稿（补货建议/NPD 首单）——建议量已含安全库存与逐日推演"
        : "人工直录单据——系统未参与数量测算",
    },
    lines: briefLines,
    summary: {
      lineCount: briefLines.length,
      flaggedLines: briefLines.filter((l) => l.flags.length > 0).length,
      totalQty: r1(briefLines.reduce((a, l) => a + l.docQty, 0)),
    },
  };
}
