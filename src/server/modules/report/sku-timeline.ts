/**
 * SKU 360 · 事件时间轴（只读报表层）。
 *
 * 单 SKU 全生命周期事件融合——把散落在五张页面的事件汇聚成一条按时间倒序的时间轴，
 * 便于「这个 SKU 到底发生了什么」的一屏排查。四源既有数据，不新增口径、不写库：
 * - 库存流水 stock_ledger（近 ~50 条）：过账/冲销/红字，qtyDelta 正负即出入方向；
 * - 在途存量单 transit_refs kind=fg_order：下单（orderDate）+ 预计入仓（expectDate）；
 * - 效期批次 batch_stocks（expiryDate 非空）：批次到期事件；
 * - 处置决定 review_items category=risk_disposal（refKey=SKU 编码）：风险处置登记。
 * 全表无金额字段，免脱敏；只读不写库。
 *
 * 2026-09-04：每条事件带 `href` 回链到来源单据/列表（流水按载体单据解析单号，其余按 SKU 筛选到来源列表），
 * 响应带 `sources`/`asOf` 供页面挂来源芯片——之前数字是死胡同，看到「出库 sh #12」也点不过去。
 */
import { and, desc, eq, inArray, isNotNull, or } from "drizzle-orm";
import { getDbAsync } from "@/db";
import * as schema from "@/db/schema";
import { shanghaiDay, todayShanghai } from "@/server/core/business-day";
import { ApiError } from "@/server/modules/master/common";
import { num } from "@/server/core/svc";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle PGlite/Postgres structural compatibility is narrowed by the surrounding service contract
type AnyDb = any;

/** 统一取 YYYY-MM-DD（上海业务日；无法解析 → 空串，事件仍保留） */
function ymd(v: unknown): string {
  return shanghaiDay(v as Parameters<typeof shanghaiDay>[0]) ?? "";
}

export type TimelineCategory = "stock" | "order" | "expiry" | "disposal" | "other";

export interface TimelineEvent {
  date: string; // YYYY-MM-DD
  type: string;
  category: TimelineCategory;
  title: string;
  detail: string | null;
  qty: number | null;
  /** 回链到来源单据（已解析单号）或来源列表（按 SKU 筛选）；无可回链 = null */
  href: string | null;
}

export interface TimelineSource {
  key: "stock_ledger" | "transit_refs" | "batch_stocks" | "review_items";
  label: string;
  /** 本次纳入的事件条数 */
  events: number;
}

export interface SkuTimeline {
  sku: { id: number; code: string; name: string };
  events: TimelineEvent[];
  /** 四源来源说明（页面来源芯片） */
  sources: TimelineSource[];
  /** 取数截至（上海业务日）——事实表实时读取，即查询当日 */
  asOf: string;
  /** 流水条数封顶（超出部分请去库存流水页看全量） */
  ledgerLimit: number;
}

const LEDGER_LIMIT = 50;

/** 流水载体单据 → 单据表 + 列表页（列表页按 ?q=单号 命中） */
const LEDGER_DOC_PAGES: Record<string, { table: "sh" | "fl" | "tl" | "ct" | "stock" | "js"; href: string }> = {
  sh: { table: "sh", href: "/matflow/sh" },
  sh_purchase_in: { table: "sh", href: "/matflow/sh" },
  sh_outsource_in: { table: "sh", href: "/matflow/sh" },
  spare_in: { table: "sh", href: "/matflow/sh" },
  fl_issue: { table: "fl", href: "/matflow/fl" },
  tl_return: { table: "tl", href: "/matflow/tl" },
  ct_return: { table: "ct", href: "/matflow/ct" },
  stock_doc: { table: "stock", href: "/inventory/docs" },
  opening: { table: "stock", href: "/inventory/docs" },
  count_adjust: { table: "stock", href: "/inventory/docs" },
  pd: { table: "stock", href: "/inventory/docs" },
  js_loss_writeoff: { table: "js", href: "/settlement/js" },
};

const DOC_TABLES = {
  sh: schema.shDocs,
  fl: schema.flDocs,
  tl: schema.tlDocs,
  ct: schema.ctDocs,
  stock: schema.stockDocs,
  js: schema.jsDocs,
} as const;

/** 按载体表批量解析单号：{table}:{id} → docNo */
async function resolveLedgerDocNos(
  db: AnyDb,
  rows: { sourceDocType: string; sourceDocId: number }[],
): Promise<Map<string, string>> {
  const idsByTable = new Map<keyof typeof DOC_TABLES, Set<number>>();
  for (const r of rows) {
    const page = LEDGER_DOC_PAGES[r.sourceDocType];
    if (!page) continue;
    const set = idsByTable.get(page.table) ?? new Set<number>();
    set.add(r.sourceDocId);
    idsByTable.set(page.table, set);
  }
  const out = new Map<string, string>();
  for (const [table, ids] of idsByTable) {
    const t = DOC_TABLES[table];
    const found: { id: number; docNo: string }[] = await db
      .select({ id: t.id, docNo: t.docNo })
      .from(t)
      .where(inArray(t.id, [...ids]));
    for (const f of found) out.set(`${table}:${f.id}`, f.docNo);
  }
  return out;
}

export async function getSkuTimeline(skuCodeOrId: string | number, dbArg?: AnyDb): Promise<SkuTimeline> {
  const db: AnyDb = dbArg ?? (await getDbAsync());
  const raw = String(skuCodeOrId ?? "").trim();

  /* ── SKU 解析（数字 → 先按 id，否则/回退按 code）── */
  const asId = /^\d+$/.test(raw) ? Number(raw) : null;
  let sku: { id: number; code: string; name: string } | undefined;
  if (asId != null) {
    [sku] = await db
      .select({ id: schema.skus.id, code: schema.skus.code, name: schema.skus.name })
      .from(schema.skus)
      .where(eq(schema.skus.id, asId));
  }
  if (!sku) {
    [sku] = await db
      .select({ id: schema.skus.id, code: schema.skus.code, name: schema.skus.name })
      .from(schema.skus)
      .where(eq(schema.skus.code, raw));
  }
  if (!sku) throw new ApiError(404, "SKU 不存在");

  const events: TimelineEvent[] = [];
  const codeQ = encodeURIComponent(sku.code);

  /* ── 库存流水（近 ~50 条，occurredAt desc）── */
  const sl = schema.stockLedger;
  const ledgerRows: {
    qtyDelta: string;
    sourceDocType: string;
    sourceDocId: number;
    action: string;
    occurredAt: Date | string;
  }[] = await db
    .select({
      qtyDelta: sl.qtyDelta,
      sourceDocType: sl.sourceDocType,
      sourceDocId: sl.sourceDocId,
      action: sl.action,
      occurredAt: sl.occurredAt,
    })
    .from(sl)
    .where(eq(sl.skuId, sku.id))
    .orderBy(desc(sl.occurredAt), desc(sl.id))
    .limit(LEDGER_LIMIT);
  const docNos = await resolveLedgerDocNos(db, ledgerRows);
  for (const r of ledgerRows) {
    const delta = num(r.qtyDelta);
    const page = LEDGER_DOC_PAGES[r.sourceDocType];
    const docNo = page ? docNos.get(`${page.table}:${r.sourceDocId}`) : undefined;
    events.push({
      date: ymd(r.occurredAt),
      type: "库存变动",
      category: "stock",
      title: `${delta >= 0 ? "入库" : "出库"} · ${docNo ?? `${r.sourceDocType} #${r.sourceDocId}`}`,
      detail: `过账动作 ${r.action}${docNo ? "" : `（载体 ${r.sourceDocType}）`}`,
      qty: delta,
      // 单号解析到 → 载体单据列表按单号定位；解析不到 → 库存流水页按 SKU 看全量
      href: page && docNo ? `${page.href}?q=${encodeURIComponent(docNo)}` : `/inventory/ledger?skuId=${sku.id}`,
    });
  }
  const ledgerCount = ledgerRows.length;

  /* ── 在途存量单 transit_refs kind=fg_order（下单 + 预计入仓）── */
  const tr = schema.transitRefs;
  const fgRows: {
    orderDate: string | null;
    expectDate: string | null;
    qty: string | null;
    progress: string | null;
    externalNo: string | null;
  }[] = await db
    .select({
      orderDate: tr.orderDate,
      expectDate: tr.expectDate,
      qty: tr.qty,
      progress: tr.progress,
      externalNo: tr.externalNo,
    })
    .from(tr)
    .where(and(eq(tr.kind, "fg_order"), or(eq(tr.skuId, sku.id), eq(tr.skuCode, sku.code))));
  let transitCount = 0;
  for (const r of fgRows) {
    const q = r.qty == null ? null : num(r.qty);
    const detailParts: string[] = [];
    if (r.progress) detailParts.push(`进度 ${r.progress}`);
    if (r.externalNo) detailParts.push(`用友单 ${r.externalNo}`);
    const detail = detailParts.length > 0 ? detailParts.join("；") : null;
    // 在途参考页「成品在途」页签的参数命名空间是 fg_*；用友单号能精确命中，否则按 SKU 编码
    const href = `/report/transit?tab=fg_order&fg_q=${encodeURIComponent(r.externalNo ?? sku.code)}`;
    if (r.orderDate) {
      events.push({ date: ymd(r.orderDate), type: "存量单", category: "order", title: "下单 · 存量单", detail, qty: q, href });
      transitCount += 1;
    }
    if (r.expectDate) {
      events.push({ date: ymd(r.expectDate), type: "预计入仓", category: "order", title: "预计入仓", detail, qty: q, href });
      transitCount += 1;
    }
  }

  /* ── 效期批次 batch_stocks（expiryDate 非空）── */
  const bs = schema.batchStocks;
  const batchRows: { batchNo: string | null; prodDate: string | null; expiryDate: string; qty: string }[] = await db
    .select({ batchNo: bs.batchNo, prodDate: bs.prodDate, expiryDate: bs.expiryDate, qty: bs.qty })
    .from(bs)
    .where(and(eq(bs.skuId, sku.id), isNotNull(bs.expiryDate)));
  for (const r of batchRows) {
    events.push({
      date: ymd(r.expiryDate),
      type: "效期",
      category: "expiry",
      title: `批次到期${r.batchNo ? ` · ${r.batchNo}` : ""}`,
      detail: r.prodDate ? `生产日期 ${ymd(r.prodDate)}` : null,
      qty: num(r.qty),
      // 效期页默认桶是「已过期」，回链要看该 SKU 全部批次 → bucket=all
      href: `/inventory/expiry?q=${codeQ}&bucket=all`,
    });
  }

  /* ── 处置决定 review_items category=risk_disposal（refKey=SKU 编码）── */
  const ri = schema.reviewItems;
  const dispRows: { title: string; detail: string | null; createdAt: Date | string }[] = await db
    .select({ title: ri.title, detail: ri.detail, createdAt: ri.createdAt })
    .from(ri)
    .where(and(eq(ri.category, "risk_disposal"), eq(ri.refKey, sku.code)));
  for (const r of dispRows) {
    events.push({
      date: ymd(r.createdAt),
      type: "处置决定",
      category: "disposal",
      title: r.title,
      detail: r.detail,
      qty: null,
      href: `/report/risk?q=${codeQ}`,
    });
  }

  /* ── 排序（日期倒序，新→旧）并封顶 ── */
  events.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

  return {
    sku,
    events: events.slice(0, 120),
    sources: [
      { key: "stock_ledger", label: "库存流水", events: ledgerCount },
      { key: "transit_refs", label: "在途存量单", events: transitCount },
      { key: "batch_stocks", label: "效期批次", events: batchRows.length },
      { key: "review_items", label: "处置决定", events: dispRows.length },
    ],
    asOf: todayShanghai(),
    ledgerLimit: LEDGER_LIMIT,
  };
}
