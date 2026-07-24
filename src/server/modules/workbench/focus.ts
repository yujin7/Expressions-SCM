/**
 * 工作台角色化首屏（Round-3：数字必须真实、必须可点击到操作页）。
 *
 * 口径纪律：
 * - 全部为真实查询计数，不返回占位零；
 * - 可销天数口径与驾驶舱一致（全网在库 ÷ 近3月日均销，91 天）——本模块独立推导，
 *   不 import report/dashboard.ts（红队边界：互不依赖，口径漂移由测试守护）；
 * - 展示层聚合允许 Number()（非记账路径）；
 * - 时区 Asia/Shanghai（今日出入库的日界）。
 */
import { and, eq, gte, inArray, isNotNull, lte, sql } from "drizzle-orm";
import { getDbAsync } from "@/db";
import * as schema from "@/db/schema";
import { ROLE_LABELS, type Role } from "@/server/core/constants";
import { todayShanghai } from "@/server/modules/master/common";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = any;

export interface FocusMetric {
  key: string;
  label: string;
  /** null = 纯链接卡（如驾驶舱入口），UI 渲染「前往」 */
  value: number | null;
  href: string;
  suffix?: string;
}

export interface FocusSection {
  role: Role;
  roleLabel: string;
  metrics: FocusMetric[];
}

export interface WorkbenchFocus {
  generatedAt: string;
  sections: FocusSection[];
}

const num = (v: unknown): number => (v == null ? 0 : Number(v));

async function countWhere(db: AnyDb, table: AnyDb, where: unknown): Promise<number> {
  const [row] = await db.select({ c: sql<number>`count(*)::int` }).from(table).where(where);
  return row?.c ?? 0;
}

/** 由数据最新月回推 N 个月（与驾驶舱同规则，独立实现） */
function lastMonths(maxYm: string, n: number): string[] {
  const [y, m] = maxYm.split("-").map(Number);
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
  }
  return out.reverse();
}

function plusDays(ymd: string, days: number): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/* ── 仓管：今日出入库 / 待审批库存单 / 进行中盘点 ── */
async function warehouseSection(db: AnyDb): Promise<FocusSection> {
  const dayStart = new Date(`${todayShanghai()}T00:00:00+08:00`);
  const [docsToday, pendingStock, countsActive] = await Promise.all([
    countWhere(db, schema.stockDocs, and(eq(schema.stockDocs.status, "completed"), gte(schema.stockDocs.updatedAt, dayStart))),
    countWhere(db, schema.stockDocs, eq(schema.stockDocs.status, "pending")),
    countWhere(db, schema.pdDocs, inArray(schema.pdDocs.status, ["draft", "pending", "approved", "in_progress"])),
  ]);
  return {
    role: "warehouse",
    roleLabel: ROLE_LABELS.warehouse,
    metrics: [
      { key: "docsToday", label: "今日出入库单", value: docsToday, href: "/inventory/docs", suffix: "单" },
      { key: "pendingStockDocs", label: "待审批库存单", value: pendingStock, href: "/inventory/docs?status=pending", suffix: "单" },
      { key: "countTasks", label: "进行中盘点任务", value: countsActive, href: "/inventory/count", suffix: "个" },
    ],
  };
}

/* ── 采购：待供应商确认 PO / 执行中 PO / 未清 PC / R1 近7日拦截 ── */
async function purchasingSection(db: AnyDb): Promise<FocusSection> {
  const weekAgo = new Date(Date.now() - 7 * 86_400_000);
  const [poAwait, poRunning, pcPending, pc7d] = await Promise.all([
    countWhere(db, schema.poDocs, eq(schema.poDocs.status, "approved")),
    countWhere(db, schema.poDocs, eq(schema.poDocs.status, "in_progress")),
    countWhere(db, schema.pcDocs, eq(schema.pcDocs.status, "pending")),
    countWhere(db, schema.pcDocs, gte(schema.pcDocs.createdAt, weekAgo)),
  ]);
  return {
    role: "purchasing",
    roleLabel: ROLE_LABELS.purchasing,
    metrics: [
      { key: "poAwaitConfirm", label: "待供应商确认 PO", value: poAwait, href: "/outsource/po?status=approved", suffix: "单" },
      { key: "poInProgress", label: "执行中 PO", value: poRunning, href: "/outsource/po?status=in_progress", suffix: "单" },
      { key: "pcPending", label: "未清价格变更 PC", value: pcPending, href: "/outsource/pc?status=pending", suffix: "单" },
      { key: "pcLast7d", label: "R1 近7日拦截", value: pc7d, href: "/outsource/pc", suffix: "单" },
    ],
  };
}

/* ── PMC：可销天数<30 成品数 / 放行阻塞行 / 别名待认领 ── */
async function pmcSection(db: AnyDb): Promise<FocusSection> {
  const s = schema.stockSnapshots;
  const sm = schema.salesMonthly;
  const latest = db
    .select({
      warehouseId: s.warehouseId,
      skuId: s.skuId,
      maxDate: sql<string>`max(${s.bizDate})`.as("max_date"),
    })
    .from(s)
    .groupBy(s.warehouseId, s.skuId)
    .as("latest");

  const [{ maxYm }] = await db.select({ maxYm: sql<string | null>`max(${sm.yearMonth})` }).from(sm);
  const months3 = maxYm ? lastMonths(maxYm, 3) : [];

  const [balRows, snapRows, salesRows, blockedStaging, aliasOpen]: [
    { skuId: number; qty: string }[],
    { skuId: number; qty: string }[],
    { skuId: number; qty: string }[],
    number,
    number,
  ] = await Promise.all([
    db
      .select({ skuId: schema.stockBalances.skuId, qty: sql<string>`sum(${schema.stockBalances.qty})` })
      .from(schema.stockBalances)
      .innerJoin(schema.skus, eq(schema.stockBalances.skuId, schema.skus.id))
      .where(eq(schema.skus.skuType, "finished"))
      .groupBy(schema.stockBalances.skuId),
    db
      .select({ skuId: s.skuId, qty: s.qty })
      .from(s)
      .innerJoin(latest, and(eq(latest.warehouseId, s.warehouseId), eq(latest.skuId, s.skuId), eq(latest.maxDate, s.bizDate)))
      .innerJoin(schema.skus, eq(s.skuId, schema.skus.id))
      .where(eq(schema.skus.skuType, "finished")),
    db
      .select({ skuId: sm.skuId, qty: sql<string>`sum(${sm.qty})` })
      .from(sm)
      .where(months3.length ? inArray(sm.yearMonth, months3) : sql`false`)
      .groupBy(sm.skuId),
    countWhere(
      db,
      schema.stagingRows,
      and(inArray(schema.stagingRows.status, ["pending", "validated"]), isNotNull(schema.stagingRows.errorMsg)),
    ),
    countWhere(db, schema.aliasExceptions, eq(schema.aliasExceptions.status, "open")),
  ]);

  const onHand = new Map<number, number>();
  for (const r of balRows) onHand.set(r.skuId, (onHand.get(r.skuId) ?? 0) + num(r.qty));
  for (const r of snapRows) onHand.set(r.skuId, (onHand.get(r.skuId) ?? 0) + num(r.qty));
  const sales3m = new Map(salesRows.map((r) => [r.skuId, num(r.qty)]));
  let lowCover = 0;
  for (const [skuId, qty] of onHand) {
    if (qty <= 0) continue;
    const s3 = sales3m.get(skuId) ?? 0;
    if (s3 <= 0) continue; // 无动销不算断货风险（与驾驶舱 <30天 桶同口径）
    if (qty / (s3 / 91) < 30) lowCover++;
  }

  return {
    role: "pmc",
    roleLabel: ROLE_LABELS.pmc,
    metrics: [
      { key: "lowCoverSkus", label: "可销天数<30 成品", value: lowCover, href: "/replenish", suffix: "个" },
      { key: "blockedStaging", label: "放行阻塞行", value: blockedStaging, href: "/import/release", suffix: "行" },
      { key: "aliasOpen", label: "别名待认领", value: aliasOpen, href: "/import/exceptions", suffix: "项" },
    ],
  };
}

/* ── 财务：期初/盘点/结算待审批 / 对账未解释差异 / 结余未确认结算 ── */
async function financeSection(db: AnyDb): Promise<FocusSection> {
  const [openingPending, countPending, jsPending, reconOpen, [surplusRow]] = await Promise.all([
    countWhere(db, schema.stockDocs, and(eq(schema.stockDocs.subtype, "opening"), eq(schema.stockDocs.status, "pending"))),
    countWhere(db, schema.pdDocs, eq(schema.pdDocs.status, "pending")),
    countWhere(db, schema.jsDocs, eq(schema.jsDocs.status, "pending")),
    countWhere(db, schema.reconDiffs, eq(schema.reconDiffs.status, "open")),
    // 结余未确认：待审 JS 中存在负实际损耗行（= 委外仓真实结余未退，审批将被 SURPLUS_UNACKED 闸门拦截）
    db
      .select({ c: sql<number>`count(distinct ${schema.jsDocs.id})::int` })
      .from(schema.jsDocs)
      .innerJoin(schema.jsLines, eq(schema.jsLines.jsId, schema.jsDocs.id))
      .where(and(eq(schema.jsDocs.status, "pending"), sql`${schema.jsLines.actualLoss} < 0`)),
  ]);
  return {
    role: "finance",
    roleLabel: ROLE_LABELS.finance,
    metrics: [
      { key: "openingPending", label: "期初待审批", value: openingPending, href: "/inventory/docs?status=pending", suffix: "单" },
      { key: "countPending", label: "盘点待审批", value: countPending, href: "/inventory/count", suffix: "单" },
      { key: "jsPending", label: "结算待审批", value: jsPending, href: "/settlement/js?status=pending", suffix: "单" },
      { key: "reconOpen", label: "对账未解释差异", value: reconOpen, href: "/jobs/recon", suffix: "条" },
      { key: "jsSurplusUnacked", label: "结余未确认结算", value: surplusRow?.c ?? 0, href: "/settlement/js", suffix: "单" },
    ],
  };
}

/* ── 运营：近效期批次 / 驾驶舱入口 ── */
async function opsSection(db: AnyDb): Promise<FocusSection> {
  const limit = plusDays(todayShanghai(), 90);
  const nearExpiry = await countWhere(
    db,
    schema.batchStocks,
    and(isNotNull(schema.batchStocks.expiryDate), sql`${schema.batchStocks.qty} > 0`, lte(schema.batchStocks.expiryDate, limit)),
  );
  return {
    role: "ops",
    roleLabel: ROLE_LABELS.ops,
    metrics: [
      { key: "nearExpiryBatches", label: "近效期批次（90天内）", value: nearExpiry, href: "/report/dashboard", suffix: "批" },
      { key: "dashboard", label: "经营驾驶舱", value: null, href: "/report/dashboard" },
    ],
  };
}

const SECTION_BUILDERS: [Role, (db: AnyDb) => Promise<FocusSection>][] = [
  ["warehouse", warehouseSection],
  ["purchasing", purchasingSection],
  ["pmc", pmcSection],
  ["finance", financeSection],
  ["ops", opsSection],
];

/** 按当前用户角色计算聚焦区块；admin 全量可见；多角色叠加多区块 */
export async function getWorkbenchFocus(roles: string[], dbArg?: AnyDb): Promise<WorkbenchFocus> {
  const db: AnyDb = dbArg ?? (await getDbAsync());
  const isAdmin = roles.includes("admin");
  const builders = SECTION_BUILDERS.filter(([role]) => isAdmin || roles.includes(role));
  const sections = await Promise.all(builders.map(([, build]) => build(db)));
  return { generatedAt: new Date().toISOString(), sections };
}
