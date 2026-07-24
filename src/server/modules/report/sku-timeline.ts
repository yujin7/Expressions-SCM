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
 */
import { and, desc, eq, isNotNull, or } from "drizzle-orm";
import { getDbAsync } from "@/db";
import * as schema from "@/db/schema";
import { ApiError } from "@/server/modules/master/common";
import { num } from "@/server/core/svc";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = any;

/** 统一取 YYYY-MM-DD：date 列已是字符串直接截取；timestamp 列（Date）按上海时区格式化 */
function ymd(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v.slice(0, 10);
  const d = v instanceof Date ? v : new Date(String(v));
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(d);
}

export type TimelineCategory = "stock" | "order" | "expiry" | "disposal" | "other";

export interface TimelineEvent {
  date: string; // YYYY-MM-DD
  type: string;
  category: TimelineCategory;
  title: string;
  detail: string | null;
  qty: number | null;
}

export interface SkuTimeline {
  sku: { id: number; code: string; name: string };
  events: TimelineEvent[];
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
    .limit(50);
  for (const r of ledgerRows) {
    const delta = num(r.qtyDelta);
    events.push({
      date: ymd(r.occurredAt),
      type: "库存变动",
      category: "stock",
      title: `${delta >= 0 ? "入库" : "出库"} · ${r.sourceDocType} #${r.sourceDocId}`,
      detail: `过账动作 ${r.action}`,
      qty: delta,
    });
  }

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
  for (const r of fgRows) {
    const q = r.qty == null ? null : num(r.qty);
    const detailParts: string[] = [];
    if (r.progress) detailParts.push(`进度 ${r.progress}`);
    if (r.externalNo) detailParts.push(`用友单 ${r.externalNo}`);
    const detail = detailParts.length > 0 ? detailParts.join("；") : null;
    if (r.orderDate) {
      events.push({ date: ymd(r.orderDate), type: "存量单", category: "order", title: "下单 · 存量单", detail, qty: q });
    }
    if (r.expectDate) {
      events.push({ date: ymd(r.expectDate), type: "预计入仓", category: "order", title: "预计入仓", detail, qty: q });
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
    });
  }

  /* ── 排序（日期倒序，新→旧）并封顶 ── */
  events.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

  return { sku, events: events.slice(0, 120) };
}
