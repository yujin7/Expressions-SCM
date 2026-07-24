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
import { and, eq, gte, inArray, isNotNull, isNull, lte, sql } from "drizzle-orm";
import { getDbAsync } from "@/db";
import * as schema from "@/db/schema";
import { getRiskWorklist } from "@/server/modules/report/risk";
import { ROLE_LABELS, type Role } from "@/server/core/constants";
import { todayShanghai } from "@/server/modules/master/common";
import { dailyFromWindow, lastMonths } from "@/server/core/velocity";
import { getOnHandBySku } from "@/server/core/stock-view";
import { num } from "@/server/core/svc";

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

export type ExceptionSeverity = "critical" | "high" | "medium";
export interface ExceptionItem {
  key: string;
  severity: ExceptionSeverity;
  title: string;
  /** 量化影响（金额/数量/天数——对标控制塔的 impact 排序） */
  impact: string;
  count: number;
  href: string;
}

export interface WorkbenchFocus {
  generatedAt: string;
  sections: FocusSection[];
  /** 我发起的未完结单据（BH/WO/PO/JG/库存单，draft+pending；未传 userId = null） */
  myOpenDocs: number | null;
  /** 冗余#7 统一入口：五条待处理队列计数（各自生命周期不同，不合并，只汇总一处呈现） */
  queues: { key: string; label: string; count: number; href: string }[];
  /** #6 控制塔：跨域异常，按严重度+影响排序（登录第一屏「今天最需要处理的事」） */
  exceptions: ExceptionItem[];
}

async function countWhere(db: AnyDb, table: AnyDb, where: unknown): Promise<number> {
  const [row] = await db.select({ c: sql<number>`count(*)::int` }).from(table).where(where);
  return row?.c ?? 0;
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

  const [{ maxYm }] = await db.select({ maxYm: sql<string | null>`max(${sm.yearMonth})` }).from(sm);
  const months3 = maxYm ? lastMonths(maxYm, 3) : [];

  const onHandView = await getOnHandBySku(db, { finishedOnly: true }); // core/stock-view 唯一在库口径
  const [salesRows, blockedStaging, aliasOpen]: [
    { skuId: number; qty: string }[],
    number,
    number,
  ] = await Promise.all([
    db
      .select({ skuId: sm.skuId, qty: sql<string>`sum(${sm.qty})` })
      .from(sm)
      .where(months3.length ? inArray(sm.yearMonth, months3) : sql`false`)
      .groupBy(sm.skuId),
    db
      .select({ c: sql<number>`count(*)::int` })
      .from(schema.stagingRows)
      .innerJoin(schema.importJobs, eq(schema.stagingRows.importJobId, schema.importJobs.id))
      .where(
        and(
          inArray(schema.stagingRows.status, ["pending", "validated"]),
          isNotNull(schema.stagingRows.errorMsg),
          gte(schema.importJobs.createdAt, new Date(Date.now() - 7 * 86_400_000)),
        ),
      )
      .then((r: { c: number }[]) => r[0]?.c ?? 0),
    countWhere(db, schema.aliasExceptions, eq(schema.aliasExceptions.status, "open")),
  ]);

  const onHand = new Map<number, number>();
  for (const [id, v] of onHandView.bySku) onHand.set(id, num(v));
  const sales3m = new Map(salesRows.map((r) => [r.skuId, num(r.qty)]));
  let lowCover = 0;
  for (const [skuId, qty] of onHand) {
    if (qty <= 0) continue;
    const s3 = sales3m.get(skuId) ?? 0;
    if (s3 <= 0) continue; // 无动销不算断货风险（与驾驶舱 <30天 桶同口径）
    if (qty / dailyFromWindow(s3) < 30) lowCover++;
  }

  /* 计划视角扩展（Wave T）：风险处置/NPD/数据新鲜度 */
  const [riskActions, npdActive, staleData] = await Promise.all([
    getRiskWorklist({ pageSize: 1 }, db).then((r) => r.total - (r.byAction["滞销关注"] ?? 0)),
    countWhere(db, schema.npdProjects, eq(schema.npdProjects.status, "active")),
    countWhere(
      db,
      schema.systemAlerts,
      and(eq(schema.systemAlerts.category, "data_freshness"), eq(schema.systemAlerts.status, "open")),
    ),
  ]);

  return {
    role: "pmc",
    roleLabel: ROLE_LABELS.pmc,
    metrics: [
      { key: "lowCoverSkus", label: "可销天数<30 成品", value: lowCover, href: "/replenish", suffix: "个" },
      { key: "riskActions", label: "需行动处置 SKU", value: riskActions, href: "/report/risk", suffix: "个" },
      { key: "npdActive", label: "进行中 NPD 项目", value: npdActive, href: "/npd", suffix: "个" },
      { key: "staleData", label: "参考数据过期提醒", value: staleData, href: "/review/checklist", suffix: "项" },
      { key: "blockedStaging", label: "放行阻塞行（近7日新增）", value: blockedStaging, href: "/import/release", suffix: "行" },
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

const SEVERITY_RANK: Record<ExceptionSeverity, number> = { critical: 0, high: 1, medium: 2 };

/** #6 控制塔：跨域异常聚合（均为廉价聚合查询，登录首屏可承受） */
export async function computeExceptions(db: AnyDb): Promise<ExceptionItem[]> {
  const today = todayShanghai();
  const out: ExceptionItem[] = [];

  // 1) 已过期库存待处置（金额未定，用数量+SKU数量化）
  const [expired] = await db
    .select({
      skus: sql<number>`count(distinct ${schema.batchStocks.skuId})::int`,
      qty: sql<string>`coalesce(sum(${schema.batchStocks.qty}),0)`,
    })
    .from(schema.batchStocks)
    .where(and(isNotNull(schema.batchStocks.expiryDate), sql`${schema.batchStocks.qty} > 0`, lte(schema.batchStocks.expiryDate, today)));
  if ((expired?.skus ?? 0) > 0) {
    out.push({
      key: "expired_stock",
      severity: "critical",
      title: "已过期库存待处置",
      impact: `${expired.skus} 个 SKU · ${num(expired.qty).toLocaleString("zh-CN")} 件`,
      count: expired.skus,
      href: "/report/risk?action=报废评审",
    });
  }

  // 2) 单据超时（时效看门狗）
  const docAging = await countWhere(db, schema.systemAlerts, and(eq(schema.systemAlerts.category, "doc_aging"), eq(schema.systemAlerts.status, "open")));
  if (docAging > 0) {
    out.push({ key: "doc_aging", severity: "high", title: "单据超时未流转", impact: `${docAging} 张单据停留超阈值`, count: docAging, href: "/alerts" });
  }

  // 3) 参考数据过期（新鲜度看门狗）
  const staleData = await countWhere(db, schema.systemAlerts, and(eq(schema.systemAlerts.category, "data_freshness"), eq(schema.systemAlerts.status, "open")));
  if (staleData > 0) {
    out.push({ key: "stale_data", severity: "high", title: "关键参考数据过期", impact: `${staleData} 类数据待重传（口径将失真）`, count: staleData, href: "/alerts" });
  }

  // 4) 断货且已错过下单窗口（可销 < 生产周期）——取样估算：可销天数<生产周期的成品数
  const sm = schema.salesMonthly;
  const [{ maxYm }] = await db.select({ maxYm: sql<string | null>`max(${sm.yearMonth})` }).from(sm);
  const months3 = maxYm ? lastMonths(maxYm, 3) : [];
  if (months3.length) {
    const rows: { skuId: number; sales3m: string; onHand: string; leadDays: number | null }[] = await db
      .select({
        skuId: schema.skus.id,
        sales3m: sql<string>`coalesce((select sum(q) from (select sum(${sm.qty}) q from sales_monthly where sku_id=${schema.skus.id} and year_month in (${sql.join(months3, sql`,`)})) t),0)`,
        onHand: sql<string>`coalesce((select sum(qty) from stock_balances where sku_id=${schema.skus.id}),0)`,
        leadDays: schema.skuParams.normalLeadDays,
      })
      .from(schema.skus)
      .leftJoin(schema.skuParams, eq(schema.skuParams.skuId, schema.skus.id))
      .where(and(eq(schema.skus.skuType, "finished"), eq(schema.skus.active, true)));
    let belowLead = 0;
    for (const r of rows) {
      const daily = num(r.sales3m) / 91;
      if (daily <= 0 || r.leadDays == null || r.leadDays <= 0) continue;
      const cover = num(r.onHand) / daily;
      if (cover < r.leadDays) belowLead++;
    }
    if (belowLead > 0) {
      out.push({ key: "below_lead", severity: "critical", title: "断货风险（可销 < 生产周期）", impact: `${belowLead} 个成品补货窗口迫近/已过`, count: belowLead, href: "/replenish" });
    }
  }

  // 5) 成品缺生产周期（阻断投影/补货判定）
  const missingLead = await countWhere(
    db,
    schema.skus,
    and(
      eq(schema.skus.skuType, "finished"),
      eq(schema.skus.active, true),
      sql`not exists (select 1 from sku_params sp where sp.sku_id = ${schema.skus.id} and sp.normal_lead_days > 0)`,
    ),
  );
  if (missingLead > 0) {
    out.push({ key: "missing_lead", severity: "medium", title: "成品缺生产周期", impact: `${missingLead} 个成品无法推算下单日`, count: missingLead, href: "/report/data-health?missing=生产周期" });
  }

  return out.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || b.count - a.count);
}

/** 按当前用户角色计算聚焦区块；admin 全量可见；多角色叠加多区块 */
async function countMyOpenDocs(db: AnyDb, userId: number): Promise<number> {
  const tables = [schema.bhDocs, schema.woDocs, schema.poDocs, schema.jgDocs, schema.stockDocs];
  const counts = await Promise.all(
    tables.map((t) =>
      countWhere(db, t, and(eq(t.createdBy, userId), inArray(t.status, ["draft", "pending"]))),
    ),
  );
  return counts.reduce((a, b) => a + b, 0);
}

export async function getWorkbenchFocus(roles: string[], dbArg?: AnyDb, userId?: number): Promise<WorkbenchFocus> {
  const db: AnyDb = dbArg ?? (await getDbAsync());
  const isAdmin = roles.includes("admin");
  const builders = SECTION_BUILDERS.filter(([role]) => isAdmin || roles.includes(role));
  // #9 角色化落地：用户本角色区块优先（按其 roles 顺序），admin 保持规范序
  if (!isAdmin) {
    const priority = (role: Role) => {
      const i = roles.indexOf(role);
      return i === -1 ? 99 : i;
    };
    builders.sort((a, b) => priority(a[0]) - priority(b[0]));
  }
  const planningRole = isAdmin || roles.some((r) => ["pmc", "purchasing", "ops", "warehouse"].includes(r));
  const [sections, exceptions] = await Promise.all([
    Promise.all(builders.map(([, build]) => build(db))),
    planningRole ? computeExceptions(db) : Promise.resolve<ExceptionItem[]>([]),
  ]);
  const myOpenDocs = userId != null ? await countMyOpenDocs(db, userId) : null;

  /* 冗余#7：五条队列一次汇总（工作台一处看全，不必逐个页面点） */
  const [pendingDocs, unreadNotify, openAlerts, openReview] = await Promise.all([
    Promise.all([schema.bhDocs, schema.woDocs, schema.poDocs, schema.jgDocs, schema.stockDocs].map((t) =>
      countWhere(db, t, eq(t.status, "pending")))).then((a) => a.reduce((x, y) => x + y, 0)),
    userId != null
      ? countWhere(db, schema.notifications, and(isNull(schema.notifications.readAt), inArray(schema.notifications.status, ["pending", "sent", "skipped"])))
      : Promise.resolve(0),
    countWhere(db, schema.systemAlerts, eq(schema.systemAlerts.status, "open")),
    countWhere(db, schema.reviewItems, eq(schema.reviewItems.status, "open")),
  ]);
  const queues = [
    { key: "inbox", label: "待我审批", count: pendingDocs, href: "/inbox" },
    { key: "notify", label: "未读通知", count: unreadNotify, href: "/notifications" },
    { key: "alerts", label: "系统告警", count: openAlerts, href: "/alerts" },
    { key: "review", label: "待复核事项", count: openReview, href: "/review/checklist" },
    { key: "mine", label: "我发起的未完结", count: myOpenDocs ?? 0, href: "/inbox" },
  ];
  return { generatedAt: new Date().toISOString(), sections, exceptions, myOpenDocs, queues };
}
