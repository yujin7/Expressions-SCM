/**
 * 经营驾驶舱（BI Dashboard）聚合层。
 *
 * 口径纪律：
 * - 全部为只读报表口径（R13 doctrine：报表呈现，不自动开单）；
 * - 数量跨 SKU 直加仅作参考（与余额页合计行同一口径警示）；
 * - 库存「全网口径」= 自有仓实时账 + 快照仓最新快照（D20，快照带数据日期）；
 * - 可销天数 = 全网在库 ÷ 近三月日均销（销量文件为全渠道口径，故用全网库存对齐分子分母）；
 * - 金额（结算）仅 admin/finance 可见——在本层按角色裁剪，不出序列化边界。
 * - 展示层聚合允许 Number()（非记账路径；记账运算仍走 decimal 工具）。
 */
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { getDbAsync } from "@/db";
import { getNumParam } from "@/server/core/params";
import { getRiskWorklist } from "@/server/modules/report/risk";
import * as schema from "@/db/schema";
import { lastMonths } from "@/server/core/velocity";
import { getLatestSnapshotRows, daysLeftOf, EXPIRY_TIER_DAYS } from "@/server/core/stock-view";
import { num, r1 } from "@/server/core/svc";
import { salesWindow } from "@/server/core/sales-window";
import { todayShanghai } from "@/server/modules/master/common";
import { participatesInNormalSalesMovement } from "@/server/rules/sku-standardization";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle PGlite/Postgres structural compatibility is narrowed by the surrounding service contract
type AnyDb = any;

export interface DashboardData {
  generatedAt: string;
  kpi: {
    skuActive: number;
    spuCount: number;
    ownStockQty: number;
    snapStockQty: number;
    /** E1-09：跨 SKU 直加的量纲明细（按基础单位分组，前 6 组）——裸数字必须可拆 */
    stockByUom: { uom: string; qty: number }[];
    snapDate: string | null;
    salesLastMonth: number;
    lastMonth: string | null;
    expiryRiskQty: number; // ≤6月 + 已到期（七段位前三段）
    slowMoverCount: number;
    /** 有库存的样品 SKU 数（库存仍计入总量，仅从正常销售动销统计分开） */
    sampleStockSkuCount: number;
    /** 有库存但尚未完成人工用途分类的 SKU 数 */
    unclassifiedStockSkuCount: number;
    pendingApprovals: number;
    reviewBacklog: number; // 开放别名 + 阻塞 staging 行
    riskActionCount: number; // 行动类处置条目数（不含滞销关注——#7 防告警疲劳）
  };
  /** 销量口径窗口（动态推导）：trend/结构图=近6月，销速=近3月 */
  salesWindow: { months6: string[]; months3: string[] };
  salesTrend: { month: string; total: number; [brand: string]: number | string }[];
  trendBrands: string[];
  channelMix: { name: string; qty: number }[];
  brandSales: { name: string; qty: number }[];
  topSkus: { code: string; name: string; qty: number; lifecycle: string }[];
  warehouseStock: { name: string; qty: number; mode: "realtime" | "snapshot"; bizDate: string | null }[];
  expiryBuckets: { bucket: string; qty: number; batches: number }[];
  expiryRiskTop: { code: string; name: string; warehouse: string; expiryDate: string; daysLeft: number; qty: number; lifecycle: string }[];
  coverBuckets: { bucket: string; count: number }[];
  slowTop: { code: string; name: string; onHand: number; sales3m: number; daysCover: number | null; lifecycle: string }[];
  outsource: { docType: string; label: string; total: number; byStatus: Record<string, number> }[];
  settlement: { docs: number; amountSum: string } | null; // 仅 admin/finance
  insights: string[];
}

/* ── 模块级 60s 缓存 ──
 * 键必须含角色（结算金额块按角色裁剪——admin/finance 与其他角色的报文不同形）；
 * 仅在 dbArg 为空（生产 route 路径）且非测试环境时启用——测试传 db、口径校验须见实时数据。 */
interface DashboardCacheEntry {
  value: DashboardData;
  expiresAt: number;
}
const dashboardCache = new Map<string, DashboardCacheEntry>();
const DASHBOARD_TTL_MS = 60_000;

export function clearDashboardCache(): void {
  dashboardCache.clear();
}

export async function getDashboard(roles: string[], dbArg?: AnyDb): Promise<DashboardData> {
  const bypass = dbArg !== undefined || process.env.NODE_ENV === "test";
  const key = [...roles].sort().join(",");
  if (!bypass) {
    const hit = dashboardCache.get(key);
    if (hit && hit.expiresAt > Date.now()) return hit.value;
  }
  const value = await computeDashboard(roles, dbArg);
  if (!bypass) dashboardCache.set(key, { value, expiresAt: Date.now() + DASHBOARD_TTL_MS });
  return value;
}

async function computeDashboard(roles: string[], dbArg?: AnyDb): Promise<DashboardData> {
  const db: AnyDb = dbArg ?? (await getDbAsync());
  const today = new Date();
  const todayStr = todayShanghai(); // 效期天数的午夜锚点（与效期页/风险页同源）

  /* ── 基础主档计数 ── */
  const [[{ skuActive }], [{ spuCount }]] = await Promise.all([
    db.select({ skuActive: sql<number>`count(*)::int` }).from(schema.skus).where(eq(schema.skus.active, true)),
    db.select({ spuCount: sql<number>`count(*)::int` }).from(schema.spus),
  ]);

  /* ── 销量：月×品牌趋势 / 渠道 / 品牌 / TOP SKU（窗口动态推导） ── */
  const sm = schema.salesMonthly;
  const { maxYm } = await salesWindow(db);
  const months6 = maxYm ? lastMonths(maxYm, 6) : [];
  const months3 = maxYm ? lastMonths(maxYm, 3) : [];
  const monthBrand: { month: string; brand: string | null; qty: string }[] = await db
    .select({
      month: sm.yearMonth,
      brand: schema.brands.nameCn,
      qty: sql<string>`sum(${sm.qty})`,
    })
    .from(sm)
    .innerJoin(schema.skus, eq(sm.skuId, schema.skus.id))
    .leftJoin(schema.brands, eq(schema.skus.brandId, schema.brands.id))
    .where(months6.length ? inArray(sm.yearMonth, months6) : sql`false`)
    .groupBy(sm.yearMonth, schema.brands.nameCn)
    .orderBy(sm.yearMonth);

  const brandTotals = new Map<string, number>();
  for (const r of monthBrand) {
    const b = r.brand ?? "未知";
    brandTotals.set(b, (brandTotals.get(b) ?? 0) + num(r.qty));
  }
  const topBrands = [...brandTotals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k]) => k);
  const months = [...new Set(monthBrand.map((r) => r.month))].sort();
  const salesTrend = months.map((m) => {
    const row: DashboardData["salesTrend"][number] = { month: m, total: 0 };
    for (const b of topBrands) row[b] = 0;
    row["其他"] = 0;
    for (const r of monthBrand.filter((x) => x.month === m)) {
      const q = num(r.qty);
      const b = r.brand ?? "未知";
      row.total += q;
      if (topBrands.includes(b)) row[b] = (row[b] as number) + q;
      else row["其他"] = (row["其他"] as number) + q;
    }
    row.total = Math.round(row.total);
    for (const k of [...topBrands, "其他"]) row[k] = Math.round(row[k] as number);
    return row;
  });

  const channelRows: { name: string; qty: string }[] = await db
    .select({ name: schema.channels.name, qty: sql<string>`sum(${sm.qty})` })
    .from(sm)
    .innerJoin(schema.channels, eq(sm.channelId, schema.channels.id))
    .where(months6.length ? inArray(sm.yearMonth, months6) : sql`false`)
    .groupBy(schema.channels.name);
  const channelMix = channelRows
    .map((r) => ({ name: r.name, qty: Math.round(num(r.qty)) }))
    .sort((a, b) => b.qty - a.qty);

  const brandSales = [...brandTotals.entries()]
    .map(([name, qty]) => ({ name, qty: Math.round(qty) }))
    .sort((a, b) => b.qty - a.qty);

  const topSkuRows: { code: string; name: string; qty: string; lifecycle: string }[] = await db
    .select({ code: schema.skus.code, name: schema.skus.name, lifecycle: schema.skus.lifecycle, qty: sql<string>`sum(${sm.qty})` })
    .from(sm)
    .innerJoin(schema.skus, eq(sm.skuId, schema.skus.id))
    .where(months6.length ? inArray(sm.yearMonth, months6) : sql`false`)
    .groupBy(schema.skus.code, schema.skus.name, schema.skus.lifecycle)
    .orderBy(sql`sum(${sm.qty}) desc`)
    .limit(10);
  const topSkus = topSkuRows.map((r) => ({ ...r, qty: Math.round(num(r.qty)) }));

  /* ── 库存：自有仓实时 + 快照仓最新 ── */
  const balRows: { warehouseId: number; skuId: number; qty: string }[] = await db
    .select({ warehouseId: schema.stockBalances.warehouseId, skuId: schema.stockBalances.skuId, qty: sql<string>`sum(${schema.stockBalances.qty})` })
    .from(schema.stockBalances)
    .groupBy(schema.stockBalances.warehouseId, schema.stockBalances.skuId);
  const snapRows = (await getLatestSnapshotRows(db)).map((r) => ({ ...r, qty: num(r.qty) }));
  const whRows: { id: number; name: string; accountingMode: string }[] = await db
    .select({ id: schema.warehouses.id, name: schema.warehouses.name, accountingMode: schema.warehouses.accountingMode })
    .from(schema.warehouses);
  const whName = new Map(whRows.map((w) => [w.id, w]));

  const whAgg = new Map<number, { qty: number; mode: "realtime" | "snapshot"; bizDate: string | null }>();
  const onHandBySku = new Map<number, number>();
  /* E1-09：量纲明细——加载 skuId→baseUom，累计各单位小计 */
  const skuCaliberRows: { id: number; baseUom: string; commercialRole: string }[] =
    await db.select({
      id: schema.skus.id,
      baseUom: schema.skus.baseUom,
      commercialRole: schema.skus.commercialRole,
    }).from(schema.skus);
  const uomBySku = new Map<number, string>(
    skuCaliberRows.map((r) => [r.id, r.baseUom ?? "未标"]),
  );
  const commercialRoleBySku = new Map<number, string>(
    skuCaliberRows.map((r) => [r.id, r.commercialRole]),
  );
  const qtyByUom = new Map<string, number>();
  const addUom = (skuId: number, q: number) => {
    const u = uomBySku.get(skuId) ?? "未标";
    qtyByUom.set(u, (qtyByUom.get(u) ?? 0) + q);
  };
  let ownStockQty = 0;
  for (const r of balRows) {
    const q = num(r.qty);
    if (q === 0) continue;
    ownStockQty += q;
    addUom(r.skuId, q);
    onHandBySku.set(r.skuId, (onHandBySku.get(r.skuId) ?? 0) + q);
    const e = whAgg.get(r.warehouseId) ?? { qty: 0, mode: "realtime" as const, bizDate: null };
    e.qty += q;
    whAgg.set(r.warehouseId, e);
  }
  let snapStockQty = 0;
  let snapDate: string | null = null;
  for (const r of snapRows) {
    snapStockQty += r.qty;
    addUom(r.skuId, r.qty);
    onHandBySku.set(r.skuId, (onHandBySku.get(r.skuId) ?? 0) + r.qty);
    if (snapDate == null || r.bizDate > snapDate) snapDate = r.bizDate;
    const e = whAgg.get(r.warehouseId) ?? { qty: 0, mode: "snapshot" as const, bizDate: r.bizDate };
    e.qty += r.qty;
    e.mode = "snapshot";
    e.bizDate = r.bizDate;
    whAgg.set(r.warehouseId, e);
  }
  const warehouseStock = [...whAgg.entries()]
    .map(([id, e]) => ({
      name: whName.get(id)?.name ?? `#${id}`,
      qty: Math.round(e.qty),
      mode: e.mode,
      bizDate: e.bizDate,
    }))
    .sort((a, b) => b.qty - a.qty)
    .slice(0, 14);

  /* ── 可销天数（全网口径）与滞销 ── */
  const sales3mRows: { skuId: number; qty: string }[] = await db
    .select({ skuId: sm.skuId, qty: sql<string>`sum(${sm.qty})` })
    .from(sm)
    .where(months3.length ? inArray(sm.yearMonth, months3) : sql`false`)
    .groupBy(sm.skuId);
  const sales3m = new Map(sales3mRows.map((r) => [r.skuId, num(r.qty)]));

  const slowThreshold = await getNumParam("slow_days_threshold", 180, dbArg);
  const COVER_BUCKETS = [
    { bucket: "<30天", max: 30 },
    { bucket: "30-60天", max: 60 },
    { bucket: "60-90天", max: 90 },
    { bucket: "90-180天", max: 180 },
    { bucket: ">180天", max: Infinity },
  ];
  const coverCount = new Map<string, number>(COVER_BUCKETS.map((b) => [b.bucket, 0]));
  coverCount.set("无动销", 0);
  interface SlowRow { skuId: number; onHand: number; s3m: number; daysCover: number | null }
  const slowCandidates: SlowRow[] = [];
  let sampleStockSkuCount = 0;
  let unclassifiedStockSkuCount = 0;
  for (const [skuId, onHand] of onHandBySku) {
    if (onHand <= 0) continue;
    const commercialRole = commercialRoleBySku.get(skuId) ?? "unclassified";
    if (commercialRole === "sample") sampleStockSkuCount++;
    if (commercialRole === "unclassified") unclassifiedStockSkuCount++;
    // 非销售用途仍在库存总量，但不制造正常销售“无动销/滞销”噪音。
    if (!participatesInNormalSalesMovement(commercialRole)) continue;
    const s3 = sales3m.get(skuId) ?? 0;
    if (s3 <= 0) {
      coverCount.set("无动销", coverCount.get("无动销")! + 1);
      slowCandidates.push({ skuId, onHand, s3m: 0, daysCover: null });
      continue;
    }
    const days = onHand / (s3 / 91);
    const b = COVER_BUCKETS.find((x) => days < x.max)!;
    coverCount.set(b.bucket, coverCount.get(b.bucket)! + 1);
    if (days > slowThreshold) slowCandidates.push({ skuId, onHand, s3m: s3, daysCover: days });
  }
  const coverBuckets = [...COVER_BUCKETS.map((b) => b.bucket), "无动销"].map((bucket) => ({
    bucket,
    count: coverCount.get(bucket) ?? 0,
  }));
  const slowMoverCount = slowCandidates.length;
  const slowSorted = slowCandidates.sort((a, b) => b.onHand - a.onHand).slice(0, 10);
  const slowSkuInfo: { id: number; code: string; name: string; lifecycle: string }[] = slowSorted.length
    ? await db
        .select({ id: schema.skus.id, code: schema.skus.code, name: schema.skus.name, lifecycle: schema.skus.lifecycle })
        .from(schema.skus)
        .where(inArray(schema.skus.id, slowSorted.map((s) => s.skuId)))
    : [];
  const skuInfoMap = new Map(slowSkuInfo.map((s) => [s.id, s]));
  const slowTop = slowSorted.map((s) => ({
    code: skuInfoMap.get(s.skuId)?.code ?? `#${s.skuId}`,
    name: skuInfoMap.get(s.skuId)?.name ?? "",
    lifecycle: skuInfoMap.get(s.skuId)?.lifecycle ?? "on_sale",
    onHand: Math.round(s.onHand),
    sales3m: Math.round(s.s3m),
    daysCover: s.daysCover == null ? null : Math.round(s.daysCover),
  }));

  /* ── 效期六段位（批次参考层） ── */
  const batchRows: { skuId: number; warehouseId: number; expiryDate: string | null; qty: string }[] = await db
    .select({
      skuId: schema.batchStocks.skuId,
      warehouseId: schema.batchStocks.warehouseId,
      expiryDate: schema.batchStocks.expiryDate,
      qty: schema.batchStocks.qty,
    })
    .from(schema.batchStocks)
    .where(isNotNull(schema.batchStocks.expiryDate));
  // R15 七段位（04 §3 裁决：互斥左闭右开——已到期/(0,3月]/(3,6月]/(6,12月]/(12,18月]/(18,24月]/>24月）
  const EXP_BUCKETS = [
    { bucket: "已到期", min: -Infinity, max: 0 },
    { bucket: "0-3月", min: 0, max: EXPIRY_TIER_DAYS.m3 },
    { bucket: "3-6月", min: EXPIRY_TIER_DAYS.m3, max: EXPIRY_TIER_DAYS.m6 },
    { bucket: "6-12月", min: EXPIRY_TIER_DAYS.m6, max: EXPIRY_TIER_DAYS.m12 },
    { bucket: "12-18月", min: EXPIRY_TIER_DAYS.m12, max: EXPIRY_TIER_DAYS.m18 },
    { bucket: "18-24月", min: EXPIRY_TIER_DAYS.m18, max: EXPIRY_TIER_DAYS.m24 },
    { bucket: ">24月", min: EXPIRY_TIER_DAYS.m24, max: Infinity },
  ];
  const expAgg = new Map<string, { qty: number; batches: number }>(EXP_BUCKETS.map((b) => [b.bucket, { qty: 0, batches: 0 }]));
  let expiryRiskQty = 0; // 由段位聚合后统一赋值（同源口径）
  const riskRows: { skuId: number; warehouseId: number; expiryDate: string; daysLeft: number; qty: number }[] = [];
  for (const r of batchRows) {
    const q = num(r.qty);
    if (q <= 0 || !r.expiryDate) continue;
    /* 效期剩余天数走 core/stock-view.daysLeftOf（午夜锚点），不要拿「此刻」去减。
       用 today.getTime()（当前时刻）时，明天到期的批次算出 floor(24h−14h)/24h = 0，
       而效期页/风险页是午夜减午夜得 1——**驾驶舱恒少 1 天**，且首桶判据是
       daysLeft <= 0，于是明天才到期的货在驾驶舱被计进「已过期」与 expiryRiskQty。 */
    const daysLeft = daysLeftOf(todayStr, r.expiryDate);
    const b = EXP_BUCKETS.find((x) => daysLeft > x.min && daysLeft <= x.max) ?? EXP_BUCKETS[EXP_BUCKETS.length - 1];
    const e = expAgg.get(b.bucket)!;
    e.qty += q;
    e.batches++;
    if (daysLeft <= 183) { // ≤6月（含 183 边界，与段位 (3,6月] 右闭一致）
      riskRows.push({ skuId: r.skuId, warehouseId: r.warehouseId, expiryDate: r.expiryDate, daysLeft, qty: q });
    }
  }
  const expiryBuckets = EXP_BUCKETS.map((b) => ({
    bucket: b.bucket,
    qty: Math.round(expAgg.get(b.bucket)!.qty),
    batches: expAgg.get(b.bucket)!.batches,
  }));
  // KPI 与图同源（RT4 UX-P1-1）：风险量 = 前三段位（已到期+0-3月+3-6月）之和，只取整一次
  expiryRiskQty = expiryBuckets.slice(0, 3).reduce((a, b) => a + b.qty, 0);
  const riskTop = riskRows.sort((a, b) => a.daysLeft - b.daysLeft || b.qty - a.qty).slice(0, 10);
  const riskSkuInfo: { id: number; code: string; name: string; lifecycle: string }[] = riskTop.length
    ? await db
        .select({ id: schema.skus.id, code: schema.skus.code, name: schema.skus.name, lifecycle: schema.skus.lifecycle })
        .from(schema.skus)
        .where(inArray(schema.skus.id, [...new Set(riskTop.map((r) => r.skuId))]))
    : [];
  const riskSkuMap = new Map(riskSkuInfo.map((s) => [s.id, s]));
  const expiryRiskTop = riskTop.map((r) => ({
    code: riskSkuMap.get(r.skuId)?.code ?? `#${r.skuId}`,
    name: riskSkuMap.get(r.skuId)?.name ?? "",
    lifecycle: riskSkuMap.get(r.skuId)?.lifecycle ?? "on_sale",
    warehouse: whName.get(r.warehouseId)?.name ?? `#${r.warehouseId}`,
    expiryDate: r.expiryDate,
    daysLeft: r.daysLeft,
    qty: Math.round(r.qty),
  }));

  /* ── 委外执行漏斗 + 待办 ── */
  const DOC_TABLES: { docType: string; label: string; table: AnyDb }[] = [
    { docType: "bh", label: "备货申请", table: schema.bhDocs },
    { docType: "wo", label: "委外工单", table: schema.woDocs },
    { docType: "po", label: "采购订单", table: schema.poDocs },
    { docType: "jg", label: "加工通知", table: schema.jgDocs },
    { docType: "sh", label: "收货检验", table: schema.shDocs },
    { docType: "js", label: "结算单", table: schema.jsDocs },
  ];
  const outsource: DashboardData["outsource"] = [];
  let pendingApprovals = 0;
  for (const d of DOC_TABLES) {
    const rows: { status: string; c: number }[] = await db
      .select({ status: d.table.status, c: sql<number>`count(*)::int` })
      .from(d.table)
      .groupBy(d.table.status);
    const byStatus: Record<string, number> = {};
    let total = 0;
    for (const r of rows) {
      byStatus[r.status] = r.c;
      total += r.c;
      if (r.status === "pending") pendingApprovals += r.c;
    }
    outsource.push({ docType: d.docType, label: d.label, total, byStatus });
  }
  const [{ pendingStock }] = await db
    .select({ pendingStock: sql<number>`count(*)::int` })
    .from(schema.stockDocs)
    .where(eq(schema.stockDocs.status, "pending"));
  pendingApprovals += pendingStock;

  const [[{ openExc }], [{ blockedStaging }]] = await Promise.all([
    db.select({ openExc: sql<number>`count(*)::int` }).from(schema.aliasExceptions).where(eq(schema.aliasExceptions.status, "open")),
    db
      .select({ blockedStaging: sql<number>`count(*)::int` })
      .from(schema.stagingRows)
      .where(and(inArray(schema.stagingRows.status, ["pending", "validated"]), isNotNull(schema.stagingRows.errorMsg))),
  ]);
  const reviewBacklog = openExc + blockedStaging;

  /* ── 结算金额（敏感：仅 admin/finance） ── */
  let settlement: DashboardData["settlement"] = null;
  if (roles.includes("admin") || roles.includes("finance")) {
    const [row] = await db
      .select({ docs: sql<number>`count(*)::int`, amountSum: sql<string>`coalesce(sum(${schema.jsDocs.settleAmount}), '0')` })
      .from(schema.jsDocs);
    settlement = { docs: row.docs, amountSum: String(row.amountSum) };
  }

  /* ── KPI 收口 ── */
  const lastMonth = months.length ? months[months.length - 1] : null;
  const salesLastMonth = lastMonth ? (salesTrend.find((r) => r.month === lastMonth)?.total as number) ?? 0 : 0;

  /* ── 智能洞察（纯计算陈述，报表口径，不代决策） ── */
  const insights: string[] = [];
  if (months.length >= 2) {
    const prev = salesTrend[salesTrend.length - 2].total as number;
    const cur = salesLastMonth;
    if (prev > 0) {
      const pct = r1(((cur - prev) / prev) * 100);
      insights.push(`${lastMonth} 全渠道销量 ${cur.toLocaleString("zh-CN")}，环比${pct >= 0 ? "增长" : "下降"} ${Math.abs(pct)}%`);
    }
  }
  if (channelMix.length > 0) {
    const totalCh = channelMix.reduce((a, c) => a + c.qty, 0);
    const share = r1((channelMix[0].qty / Math.max(totalCh, 1)) * 100);
    insights.push(`渠道集中度：「${channelMix[0].name}」占近半年销量 ${share}%${share > 50 ? "，单一渠道依赖偏高" : ""}`);
  }
  if (brandSales.length > 0) {
    const totalB = brandSales.reduce((a, c) => a + c.qty, 0);
    insights.push(`品牌结构：「${brandSales[0].name}」占 ${r1((brandSales[0].qty / Math.max(totalB, 1)) * 100)}%，前三品牌合计 ${r1((brandSales.slice(0, 3).reduce((a, c) => a + c.qty, 0) / Math.max(totalB, 1)) * 100)}%`);
  }
  const expired = expiryBuckets.find((b) => b.bucket === "已到期");
  const within3m = expiryBuckets.find((b) => b.bucket === "0-3月");
  if ((expired?.qty ?? 0) > 0 || (within3m?.qty ?? 0) > 0) {
    insights.push(`效期风险：已到期 ${expired?.qty.toLocaleString("zh-CN") ?? 0}（${expired?.batches ?? 0} 批）、3 个月内到期 ${within3m?.qty.toLocaleString("zh-CN") ?? 0}（${within3m?.batches ?? 0} 批）——建议优先促销/处置`);
  }
  if (slowMoverCount > 0) {
    const worst = slowTop[0];
    insights.push(`滞销：${slowMoverCount} 个 SKU 可销天数超 ${slowThreshold} 天或无动销${worst ? `，最大压库「${worst.code}」在库 ${worst.onHand.toLocaleString("zh-CN")}` : ""}`);
  }
  if (sampleStockSkuCount > 0 || unclassifiedStockSkuCount > 0) {
    insights.push(
      `SKU 用途：有库存样品 ${sampleStockSkuCount} 个，另有 ${unclassifiedStockSkuCount} 个尚未分类；样品已从正常销售滞销统计分开，未分类仍保留在统计中等待业务确认`,
    );
  }
  const short = coverBuckets.find((b) => b.bucket === "<30天");
  if ((short?.count ?? 0) > 0) {
    insights.push(`断货风险：${short!.count} 个 SKU 可销天数不足 30 天，建议核对在途后评估补货（R11 净需求）`);
  }
  if (reviewBacklog > 0) {
    insights.push(`数据健康：${openExc} 条别名待认领、${blockedStaging} 行导入阻塞——见放行工作台与复核清单`);
  }
  if (snapDate) {
    const age = Math.floor((today.getTime() - new Date(`${snapDate}T00:00:00+08:00`).getTime()) / 86_400_000);
    if (age > 3) insights.push(`快照仓数据已 ${age} 天未更新（${snapDate}）——全仓视图仅供参考，RPA/快照导入接通后自动刷新`);
  }

  /* ── F 项：风险处置工作台汇总（同库同事务级只读；驾驶舱缓存 60s 吸收成本） ── */
  const risk = await getRiskWorklist({ pageSize: 1 }, dbArg);
  const watchCount = risk.byAction["滞销关注"] ?? 0;
  const riskActionCount = risk.total - watchCount; // #7：行动类（报废/禁售/商务/促销/优先出库），关注类不混入紧迫计数
  const scrapCount = risk.byAction["报废评审"] ?? 0;
  const banCount = risk.byAction["禁售隔离"] ?? 0;
  if (riskActionCount > 0) {
    insights.push(
      `风险处置：${riskActionCount} 个 SKU 需行动${scrapCount > 0 ? `（报废评审 ${scrapCount}` : "（"}${banCount > 0 ? `、禁售隔离 ${banCount}` : ""}）另有滞销关注 ${watchCount}——见「风险库存处置」工作台`,
    );
  }

  return {
    generatedAt: today.toISOString(),
    salesWindow: { months6, months3 },
    kpi: {
      skuActive,
      spuCount,
      ownStockQty: Math.round(ownStockQty),
      snapStockQty: Math.round(snapStockQty),
      snapDate,
      salesLastMonth,
      lastMonth,
      expiryRiskQty: Math.round(expiryRiskQty),
      slowMoverCount,
      sampleStockSkuCount,
      unclassifiedStockSkuCount,
      pendingApprovals,
      reviewBacklog,
      riskActionCount,
      stockByUom: [...qtyByUom.entries()].map(([uom, qty]) => ({ uom, qty: Math.round(qty) })).sort((a, b) => b.qty - a.qty).slice(0, 6),
    },
    salesTrend,
    trendBrands: [...topBrands, "其他"],
    channelMix,
    brandSales,
    topSkus,
    warehouseStock,
    expiryBuckets,
    expiryRiskTop,
    coverBuckets,
    slowTop,
    outsource,
    settlement,
    insights,
  };
}
