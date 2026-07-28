/**
 * E7-03：销量变化瀑布（bridge）+ KPI 异动自动归因（只读报表层）。
 *
 * 单源：sales_monthly（sm.skuId / sm.channelId / sm.yearMonth / sm.qty），不新增口径。
 * - 期间：默认 toYm = max(yearMonth)，fromYm = 其上一月（lastMonths(maxYm, 2)[0]，与全系统"近 N 月"同口径）；
 * - 维度：brand（skus.brandId → brands）/ channel（channels）/ sku（skus.code）；
 * - 分解：rules/waterfall.buildBridge 纯函数（首尾恒等式由该模块保证）；
 * - byDim：三个维度各自"最大单项贡献绝对值"，用于提示"哪个维度最能解释这次变化"；
 * - attribution：同一变化同时按 brand/channel 分解，各给 top3 正/负贡献，供自动归因文案。
 * 全表无金额字段，免脱敏；只读不写库。
 */
import { inArray, sql } from "drizzle-orm";
import { getDbAsync } from "@/db";
import * as schema from "@/db/schema";
import { lastMonths } from "@/server/core/velocity";
import { ApiError } from "@/server/modules/master/common";
import { buildBridge, type BridgeItem } from "@/server/rules/waterfall";
import { num } from "@/server/core/svc";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle PGlite/Postgres structural compatibility is narrowed by the surrounding service contract
type AnyDb = any;

const YM_RE = /^\d{4}-(?:0[1-9]|1[0-2])$/;
/** 无品牌 SKU 归口键（与真实品牌 code 不冲突） */
const NO_BRAND = "(未分配)";

export type BridgeDim = "brand" | "channel" | "sku";
const DIMS: BridgeDim[] = ["brand", "channel", "sku"];
export const DIM_LABELS: Record<BridgeDim, string> = { brand: "品牌", channel: "渠道", sku: "SKU" };

/** 单维度的正/负 top3 贡献（异动归因文案素材） */
export interface AttributionSide {
  ups: BridgeItem[];
  downs: BridgeItem[];
}

export interface SalesBridgeResult {
  dim: BridgeDim;
  fromYm: string;
  toYm: string;
  /** 可选月份（sales_monthly 全部月份，升序）——供 UI 月份选择器 */
  months: string[];
  from: number;
  to: number;
  total: number;
  items: BridgeItem[];
  othersDelta: number;
  /** 各维度"最大单项贡献绝对值"：越大说明该维度越能解释本次变化 */
  byDim: Record<BridgeDim, number>;
  /** 自动归因素材（品牌 + 渠道，各 top3 正/负） */
  attribution: { brand: AttributionSide; channel: AttributionSide };
}

/** 一个维度两期的键→数值 + 标签解析 */
interface DimMaps {
  prev: Map<string, number>;
  curr: Map<string, number>;
  labelOf: (k: string) => string;
}

function normYm(raw: string | undefined, field: string): string | undefined {
  const v = (raw ?? "").trim();
  if (!v) return undefined;
  if (!YM_RE.test(v)) throw new ApiError(400, `${field} 格式应为 YYYY-MM`);
  return v;
}

/** 解析期间：默认 toYm=数据最新月，fromYm=其上一月（lastMonths 唯一口径） */
async function resolveWindow(
  db: AnyDb,
  fromRaw?: string,
  toRaw?: string,
): Promise<{ fromYm: string; toYm: string; months: string[] }> {
  const sm = schema.salesMonthly;
  const monthRows: { ym: string }[] = await db
    .select({ ym: sm.yearMonth })
    .from(sm)
    .groupBy(sm.yearMonth)
    .orderBy(sm.yearMonth);
  const months = monthRows.map((r) => r.ym);
  const fromIn = normYm(fromRaw, "fromYm");
  const toIn = normYm(toRaw, "toYm");
  const maxYm = months.at(-1);
  if (!maxYm) return { fromYm: fromIn ?? "", toYm: toIn ?? "", months };
  const toYm = toIn ?? maxYm;
  const fromYm = fromIn ?? lastMonths(toYm, 2)[0];
  return { fromYm, toYm, months };
}

/** 两期 × 三维度取数（一次查询按 skuId / channelId 聚合，维度映射在内存完成） */
async function loadDims(db: AnyDb, fromYm: string, toYm: string): Promise<Record<BridgeDim, DimMaps>> {
  const sm = schema.salesMonthly;
  const months = Array.from(new Set([fromYm, toYm].filter(Boolean)));
  const empty = (): DimMaps => ({ prev: new Map(), curr: new Map(), labelOf: (k) => k });
  if (months.length === 0) return { brand: empty(), channel: empty(), sku: empty() };

  const skuRows: { ym: string; skuId: number; qty: string | null }[] = await db
    .select({ ym: sm.yearMonth, skuId: sm.skuId, qty: sql<string | null>`sum(${sm.qty})` })
    .from(sm)
    .where(inArray(sm.yearMonth, months))
    .groupBy(sm.yearMonth, sm.skuId);
  const chRows: { ym: string; channelId: number; qty: string | null }[] = await db
    .select({ ym: sm.yearMonth, channelId: sm.channelId, qty: sql<string | null>`sum(${sm.qty})` })
    .from(sm)
    .where(inArray(sm.yearMonth, months))
    .groupBy(sm.yearMonth, sm.channelId);

  /* ── 主档标签（SKU 只取有销量的；品牌/渠道主档小表全取） ── */
  const skuIds = Array.from(new Set(skuRows.map((r) => r.skuId)));
  const skuMeta: { id: number; code: string; name: string; brandId: number | null }[] = skuIds.length
    ? await db
        .select({ id: schema.skus.id, code: schema.skus.code, name: schema.skus.name, brandId: schema.skus.brandId })
        .from(schema.skus)
        .where(inArray(schema.skus.id, skuIds))
    : [];
  const skuById = new Map(skuMeta.map((s) => [s.id, s]));
  const brandRows: { id: number; code: string; nameCn: string }[] = await db
    .select({ id: schema.brands.id, code: schema.brands.code, nameCn: schema.brands.nameCn })
    .from(schema.brands);
  const brandById = new Map(brandRows.map((b) => [b.id, b]));
  const channelRows: { id: number; code: string; name: string }[] = await db
    .select({ id: schema.channels.id, code: schema.channels.code, name: schema.channels.name })
    .from(schema.channels);
  const channelById = new Map(channelRows.map((c) => [c.id, c]));

  /* ── 键：用可回跳的业务编码（品牌 code / 渠道 code / SKU code），标签用中文名 ── */
  const brandLabels = new Map<string, string>([[NO_BRAND, "未分配品牌"]]);
  const channelLabels = new Map<string, string>();
  const skuLabels = new Map<string, string>();

  const dims: Record<BridgeDim, DimMaps> = {
    brand: { prev: new Map(), curr: new Map(), labelOf: (k) => brandLabels.get(k) ?? k },
    channel: { prev: new Map(), curr: new Map(), labelOf: (k) => channelLabels.get(k) ?? k },
    sku: { prev: new Map(), curr: new Map(), labelOf: (k) => skuLabels.get(k) ?? k },
  };
  const bump = (m: Map<string, number>, k: string, v: number) => m.set(k, (m.get(k) ?? 0) + v);
  // fromYm === toYm 时同一行既是起点也是终点（净变化 0），故两侧独立判断而非 else if
  const isFrom = (ym: string) => ym === fromYm;
  const isTo = (ym: string) => ym === toYm;

  for (const r of skuRows) {
    const meta = skuById.get(r.skuId);
    if (!meta) continue;
    const qty = num(r.qty);
    const brand = meta.brandId == null ? null : brandById.get(meta.brandId);
    const bKey = brand?.code ?? NO_BRAND;
    if (brand) brandLabels.set(bKey, brand.nameCn);
    const sKey = meta.code;
    skuLabels.set(sKey, meta.name ? `${meta.code} ${meta.name}` : meta.code);
    if (isFrom(r.ym)) {
      bump(dims.brand.prev, bKey, qty);
      bump(dims.sku.prev, sKey, qty);
    }
    if (isTo(r.ym)) {
      bump(dims.brand.curr, bKey, qty);
      bump(dims.sku.curr, sKey, qty);
    }
  }
  for (const r of chRows) {
    const ch = channelById.get(r.channelId);
    const key = ch?.code ?? `渠道#${r.channelId}`;
    if (ch) channelLabels.set(key, ch.name);
    const qty = num(r.qty);
    if (isFrom(r.ym)) bump(dims.channel.prev, key, qty);
    if (isTo(r.ym)) bump(dims.channel.curr, key, qty);
  }
  return dims;
}

/** 某维度的 top3 正/负贡献（异动归因） */
function attributionOf(d: DimMaps): AttributionSide {
  const all = buildBridge(d.prev, d.curr, d.labelOf, Number.MAX_SAFE_INTEGER).items;
  return {
    ups: all.filter((i) => i.delta > 0).sort((a, b) => b.delta - a.delta).slice(0, 3),
    downs: all.filter((i) => i.delta < 0).sort((a, b) => a.delta - b.delta).slice(0, 3),
  };
}

/** 该维度最大单项贡献绝对值（全量，不受 topN 截断影响） */
function maxImpact(d: DimMaps): number {
  const all = buildBridge(d.prev, d.curr, d.labelOf, Number.MAX_SAFE_INTEGER).items;
  return all.length ? Math.abs(all[0].delta) : 0;
}

export async function getSalesBridge(
  query: { dim?: BridgeDim; fromYm?: string; toYm?: string },
  dbArg?: AnyDb,
): Promise<SalesBridgeResult> {
  const db: AnyDb = dbArg ?? (await getDbAsync());
  const dim: BridgeDim = DIMS.includes(query.dim as BridgeDim) ? (query.dim as BridgeDim) : "brand";
  const { fromYm, toYm, months } = await resolveWindow(db, query.fromYm, query.toYm);
  const emptySide = (): AttributionSide => ({ ups: [], downs: [] });
  if (!fromYm || !toYm) {
    return {
      dim, fromYm, toYm, months,
      from: 0, to: 0, total: 0, items: [], othersDelta: 0,
      byDim: { brand: 0, channel: 0, sku: 0 },
      attribution: { brand: emptySide(), channel: emptySide() },
    };
  }
  const dims = await loadDims(db, fromYm, toYm);
  const cur = dims[dim];
  const bridge = buildBridge(cur.prev, cur.curr, cur.labelOf, 8);
  return {
    dim,
    fromYm,
    toYm,
    months,
    from: bridge.from,
    to: bridge.to,
    total: bridge.total,
    items: bridge.items,
    othersDelta: bridge.othersDelta,
    byDim: { brand: maxImpact(dims.brand), channel: maxImpact(dims.channel), sku: maxImpact(dims.sku) },
    attribution: { brand: attributionOf(dims.brand), channel: attributionOf(dims.channel) },
  };
}

