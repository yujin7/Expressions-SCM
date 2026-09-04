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
import { getNumParam } from "@/server/core/params";
import { getReplenishSuggestions } from "@/server/modules/replenish/service";
import type { SessionUser } from "@/server/core/dto";
import { getInbox } from "@/server/modules/inbox/service";
import { notifyVisibleWhere } from "@/server/core/notify-audience";
import { getDbAsync } from "@/db";
import * as schema from "@/db/schema";
import { getRiskWorklist } from "@/server/modules/report/risk";
import { ROLE_LABELS, type Role } from "@/server/core/constants";
import { todayShanghai } from "@/server/modules/master/common";
import { dailyFromWindow, lastMonths } from "@/server/core/velocity";
import { getOnHandBySku, latestStocktakeRows, loadLatestStocktakeDates } from "@/server/core/stock-view";
import { num } from "@/server/core/svc";
import { salesWindow } from "@/server/core/sales-window";
import { getNextActions, type NextActionItem } from "@/server/modules/workbench/next-actions";
import {
  isSnoozed,
  loadExceptionMemory,
  recordExceptionsShown,
  shanghaiDay,
} from "@/server/modules/workbench/exception-dismissals";
import { markWorkbenchVisit, type VisitMarkerState } from "@/server/modules/workbench/visit-marker";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle PGlite/Postgres structural compatibility is narrowed by the surrounding service contract
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
  /**
   * W9：连续出现天数（含今天）。0 = 还没记过（本表刚建 / 首次出现当次尚未落账）。
   * 用来把"这条已经挂了 40 天没人点"变成看得见的事实——慢性被忽略本身就是要处理的问题。
   */
  daysShown?: number;
  /**
   * W2：本条自**当前登录人**上次访问以来有变化——键是新出现的，**或**同一条例外下的
   * 条目数变多了（`inventory_cover` 从 2 个 SKU 涨到 200 个 SKU，键一个字没变，
   * 只比键就会写出「上次访问后无新增」，而那正是最该被看见的一晚）。
   * 无登录人视角（每日摘要/推送）与首次访问一律 false。
   */
  newSinceLastVisit?: boolean;
  /** 上次访问时本条的条目数（未知/新出现 = null）——行上可显示「2 → 200」 */
  previousCount?: number | null;
  /** 本条相对上次访问的条目增量（无可比基线 = null；只增不减地标，减少不算新增） */
  countDelta?: number | null;
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
  /** C153：审计事件触发、当前状态复核后的有限下一步建议；只建议，不自动写单。 */
  nextActions: NextActionItem[];
  /**
   * W2「自上次访问以来」：比对基线对应的上次访问时刻与变化条数。
   * 无登录人视角（每日摘要）= null；首次访问 = since:null / newCount:0。
   *
   * `state` 三态（`firstVisit` 一个布尔量说不清「记忆表不可用」——迁移没跑时界面
   * 曾**永远**显示「首次访问」，一个坏掉的功能长期伪装成正常状态）：
   * `first_visit` 真首次 / `compared` 已比对 / `unavailable` 记忆表不可用。
   */
  sinceLastVisit: {
    since: string | null;
    /** 新出现的例外条数 */
    newCount: number;
    /** 键已存在、但条目数变多的例外条数（分类不变、里面的东西变多也是变化） */
    grownCount: number;
    firstVisit: boolean;
    state: VisitMarkerState;
  } | null;
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
  const sm = schema.salesMonthly;

  const { maxYm } = await salesWindow(db);
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
  /* 阈值必须读 sys_params.cover_alert_days（admin/params.ts:33 可调），不能写死 30——
     写死会导致业务在参数页把阈值改成 45，工作台首屏这张卡纹丝不动，
     而它下面所有页面（补货/驾驶舱/调拨）都已按 45 走，首屏与全站对不上。 */
  const alertDays = await getNumParam("cover_alert_days", 30, db);
  let lowCover = 0;
  for (const [skuId, qty] of onHand) {
    if (qty <= 0) continue;
    const s3 = sales3m.get(skuId) ?? 0;
    if (s3 <= 0) continue; // 无动销不算断货风险（与驾驶舱同口径）
    if (qty / dailyFromWindow(s3) < alertDays) lowCover++;
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
      { key: "lowCoverSkus", label: `可销天数<${alertDays} 成品`, value: lowCover, href: "/replenish", suffix: "个" },
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
  // 盘点期间收口（core/stock-view 唯一权威）：batch_stocks 每期一行，直接 count 会按期数翻倍
  const nearExpiryAllPeriods: { warehouseId: number; stocktakeDate: string }[] = await db
    .select({ warehouseId: schema.batchStocks.warehouseId, stocktakeDate: schema.batchStocks.stocktakeDate })
    .from(schema.batchStocks)
    .where(and(isNotNull(schema.batchStocks.expiryDate), sql`${schema.batchStocks.qty} > 0`, lte(schema.batchStocks.expiryDate, limit)));
  const nearExpiry = latestStocktakeRows(nearExpiryAllPeriods, await loadLatestStocktakeDates(db)).length;
  return {
    role: "ops",
    roleLabel: ROLE_LABELS.ops,
    metrics: [
      // 审计 #14：计数必须落到行清单页（/inventory/expiry），而不是总览
      { key: "nearExpiryBatches", label: "近效期批次（90天内）", value: nearExpiry, href: "/inventory/expiry", suffix: "批" },
      // 审计 #7：登录首屏的驾驶舱入口指向四屏（例外优先）；经营分析总览在侧栏「经营分析」
      { key: "dashboard", label: "驾驶舱四屏", value: null, href: "/cockpit" },
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
/** 例外计算结果：`visible` 已过打盹过滤，`all` 是过滤前的全量（访问标记必须用 `all`） */
export interface ExceptionSet { visible: ExceptionItem[]; all: ExceptionItem[] }

const exceptionsMemo = new WeakMap<object, { at: number; value: Promise<ExceptionSet> }>();

/**
 * 例外清单；`memoMs` 打开时同一 db 实例在该时长内复用上一次结果（驾驶舱多用户刷新不重复跑全量补货引擎）。
 * 缺省不记忆（测试与写后读一致性优先）。
 *
 * `applySnooze`（红队审计 A6）：**打盹是展示层策略，不是静音开关**——
 * exception-dismissals 的模块头、打盹路由文案与页面都写明「只影响展示」，
 * 可推送任务此前也走同一条过滤，于是四种角色里任何一人都能把一条 critical 例外的推送压 90 天。
 * 推送路径（jobs/notify.runExceptionNotify）传 `applySnooze: false` 拿到未过滤清单；
 * 展示路径保持缺省 true。`recordShown` 同理：只有**人真的看到了**才推进"连续出现天数"，
 * 定时任务传 false，否则那个计数量的是"例外存在了几天"，不是"有人看了几天"。
 */
export async function computeExceptionSet(
  db: AnyDb,
  opts?: { memoMs?: number; recordShown?: boolean; applySnooze?: boolean },
): Promise<ExceptionSet> {
  const memoMs = opts?.memoMs ?? 0;
  const recordShown = opts?.recordShown ?? true;
  const applySnooze = opts?.applySnooze ?? true;
  if (memoMs > 0) {
    const hit = exceptionsMemo.get(db as object);
    if (hit && Date.now() - hit.at < memoMs) return hit.value;
    const value = computeExceptionsUncached(db, recordShown, applySnooze);
    exceptionsMemo.set(db as object, { at: Date.now(), value });
    value.catch(() => exceptionsMemo.delete(db as object));
    return value;
  }
  return computeExceptionsUncached(db, recordShown, applySnooze);
}

/** 兼容既有调用方：只要可见清单（已过打盹过滤） */
export async function computeExceptions(
  db: AnyDb,
  opts?: { memoMs?: number; recordShown?: boolean; applySnooze?: boolean },
): Promise<ExceptionItem[]> {
  return (await computeExceptionSet(db, opts)).visible;
}

/**
 * W9 打盹与出现天数：算完例外后统一过一遍记忆表——
 * 打盹未到期的整条隐藏（连同它的计数，不留半条），其余标注连续出现天数并推进计数。
 * 记忆表出问题只降级为"没有 daysShown"，绝不让首屏 500：控制塔的可用性优先于这份增益。
 */
async function applyExceptionMemory(
  db: AnyDb,
  items: ExceptionItem[],
  recordShown: boolean,
  applySnooze = true,
): Promise<{ visible: ExceptionItem[]; all: ExceptionItem[] }> {
  const today = shanghaiDay();
  try {
    const memory = await loadExceptionMemory(db);
    // applySnooze=false（推送路径）：打盹只隐藏页面，不静音推送
    const visible = applySnooze ? items.filter((it) => !isSnoozed(memory.get(it.key), today)) : items;
    if (recordShown && visible.length) await recordExceptionsShown(db, visible.map((it) => it.key), today);
    const withDays = (it: ExceptionItem): ExceptionItem => {
      const mem = memory.get(it.key);
      const prior = Number(mem?.consecutiveDays ?? 0);
      // 本轮已把 today 记进去了（或本来就是今天）：连续天数 = 已记到今天的值
      const daysShown = !recordShown ? prior
        : mem?.lastShownOn === today ? prior
          : prior > 0 && mem?.lastShownOn === yesterdayOf(today) ? prior + 1
            : 1;
      return { ...it, daysShown };
    };
    /* `all` = **打盹过滤之前**的全量清单：访问标记必须以它为快照，
       否则一条被打盹 90 天的例外会在打盹到期那天冒充「上次访问后新增」。 */
    return { visible: visible.map(withDays), all: items.map(withDays) };
  } catch {
    return { visible: items, all: items }; // 记忆表不可用（迁移未跑等）时按无记忆展示，不隐藏也不标注
  }
}

function yesterdayOf(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
}

/**
 * 平台身份缺口（与 /report/decision-studio 的身份卡**同源**：同一个读模型、同一份缓存）。
 * 该读模型依赖外部观察数据，未就绪时返回 null——首屏宁可不显示这张卡，也不显示一个算不准的数。
 * 读模型不可用（迁移未跑、观察数据缺失）只降级为「没有这张卡」，绝不让工作台首屏 500。
 */
async function platformIdentityGap(
  db: AnyDb,
): Promise<{ unmapped: number; withCandidates: number; mappedAmountPct: number | null } | null> {
  try {
    const { loadPlatformSkuIdentityGap } = await import("@/server/modules/report/platform-sku-identity-gap");
    const gap = await loadPlatformSkuIdentityGap(db);
    if (gap.state !== "ready") return null;
    const unmapped = gap.totals.platformSkus - gap.totals.mappedSkus;
    return {
      unmapped: unmapped > 0 ? unmapped : 0,
      withCandidates: gap.totals.unmappedWithCandidates,
      mappedAmountPct: gap.totals.mappedAmountPct,
    };
  } catch {
    return null;
  }
}

async function computeExceptionsUncached(db: AnyDb, recordShown = true, applySnooze = true): Promise<ExceptionSet> {
  const today = todayShanghai();
  const out: ExceptionItem[] = [];

  // 1) 已过期库存待处置（金额未定，用数量+SKU数量化）
  //    盘点期间收口（core/stock-view 唯一权威）：两期并存时 SQL 直接 sum 会把同一批过期货算两遍
  const expiredAllPeriods: { skuId: number; warehouseId: number; stocktakeDate: string; qty: string }[] = await db
    .select({
      skuId: schema.batchStocks.skuId,
      warehouseId: schema.batchStocks.warehouseId,
      stocktakeDate: schema.batchStocks.stocktakeDate,
      qty: schema.batchStocks.qty,
    })
    .from(schema.batchStocks)
    .where(and(isNotNull(schema.batchStocks.expiryDate), sql`${schema.batchStocks.qty} > 0`, lte(schema.batchStocks.expiryDate, today)));
  const expiredRows = latestStocktakeRows(expiredAllPeriods, await loadLatestStocktakeDates(db));
  const expiredSkus = new Set(expiredRows.map((r) => r.skuId)).size;
  const expiredQty = expiredRows.reduce((s, r) => s + num(r.qty), 0);
  if (expiredSkus > 0) {
    out.push({
      key: "expired_stock",
      severity: "critical",
      title: "已过期库存待处置",
      impact: `${expiredSkus} 个 SKU · ${expiredQty.toLocaleString("zh-CN")} 件`,
      count: expiredSkus,
      href: "/report/risk?action=报废评审",
    });
  }

  // 2) 单据超时（时效看门狗）
  const docAging = await countWhere(db, schema.systemAlerts, and(eq(schema.systemAlerts.category, "doc_aging"), eq(schema.systemAlerts.status, "open")));
  if (docAging > 0) {
    out.push({ key: "doc_aging", severity: "high", title: "单据超时未流转", impact: `${docAging} 张单据停留超阈值`, count: docAging, href: "/alerts" });
  }
  // D56/D57：预警引擎投影的两类告警（同源计数，驾驶舱红卡与本处一致）——独立于单据超时是否存在
  const [spikeOpen, coverOpen] = await Promise.all([
    countWhere(db, schema.systemAlerts, and(eq(schema.systemAlerts.category, "sales_spike"), eq(schema.systemAlerts.status, "open"))),
    countWhere(db, schema.systemAlerts, and(eq(schema.systemAlerts.category, "inventory_cover"), eq(schema.systemAlerts.status, "open"))),
  ]);
  if (spikeOpen > 0) out.push({ key: "sales_spike", severity: "critical", title: "爆单预警（观察口径）", impact: `${spikeOpen} 个链接/SKU 连续 3 天涨幅超阈值`, count: spikeOpen, href: "/inventory/alerts?tab=spike" });
  if (coverOpen > 0) out.push({ key: "inventory_cover", severity: "high", title: "断货预警 S/A/B", impact: `${coverOpen} 个 SKU 可销天数低于阈值或已断货`, count: coverOpen, href: "/inventory/alerts?tab=cover" });

  // 3) 参考数据过期（新鲜度看门狗）
  const staleData = await countWhere(db, schema.systemAlerts, and(eq(schema.systemAlerts.category, "data_freshness"), eq(schema.systemAlerts.status, "open")));
  if (staleData > 0) {
    out.push({ key: "stale_data", severity: "high", title: "关键参考数据过期", impact: `${staleData} 类数据待重传（口径将失真）`, count: staleData, href: "/alerts" });
  }

  /* 4) 断货且已错过下单窗口（可销 < 生产周期）
     
     必须与 /replenish 同源：直接消费 getReplenishSuggestions 的行，而不是在这里
     重算一遍在库与可销天数。原实现只用系统在库（core/stock-view 全网口径）判 belowLead，
     而同一个 service 早已算出全管道口径 coverFull 与抑制结论——
     实测 111 条 critical 里 77 条在 coverFull 下已够生产周期、70 条系统根本给不出建议量
     （56 条被显式抑制、待人工核实覆盖缺口）。用户点红字进 /replenish 看到的是 80/91，
     两个数没有一个能解释另一个，最终整条 critical 被忽略。
     
     现在只计「系统自己也认为该下单」的 SKU：belowLead 且未被抑制。
     被抑制的条数照本系统「抑制≠隐藏」的铁律在 impact 里明写，不静默吞掉。 */
  {
    /* 代价与取舍（2026-07-26 实测，勿凭感觉重构）：
       复用 getReplenishSuggestions 使本块从 ~21ms 涨到 ~135ms，
       /api/workbench 整体热态 ~260ms。这是**用延迟换正确性**：
       首屏那个标红的数必须与用户点进去看到的页面同源，否则两个数互相解释不了，
       整条 critical 会被忽略（改之前正是如此）。
       **不要在这里加缓存**：首屏是可信度的地基，宁可慢 130ms 也不能显示陈旧的告急数；
       本仓已有前车之鉴——一个从未生效的 60s 缓存曾被当成立项理由，撑起了一整层预聚合表。
       真要提速，先按 skill `measure-first` 拿基线，再从 service 内部优化，不要在此分叉口径。 */
    const rep = await getReplenishSuggestions({ allRows: true }, db);
    /* 判据用 suggestQty != null，不用 belowLead。
       service.ts:421-441 里 suggestQty 只在「短缺落在行动窗口内 且 未被抑制 且 量>0」时非空
       ——这正是「引擎自己认为该下单」。而 belowLead 只说明可销 < 生产周期，
       红队实证：首版 55 条里有 14 条（25%）引擎判定「短缺在 57 天后、超出行动窗口，暂不建议下单」，
       与卡片文案「补货窗口迫近/已过」和我自己写的谓词描述都矛盾。 */
    const belowLead = rep.rows.filter((r) => r.suggestQty != null).length;
    const suppressed = rep.rows.filter((r) => r.suppressReason != null).length;
    if (belowLead > 0) {
      out.push({
        key: "below_lead",
        severity: "critical",
        title: "断货风险（可销 < 生产周期）",
        impact:
          `${belowLead} 个成品补货窗口迫近/已过（全网口径，与补货页同源` +
          `${rep.meta.snapDate ? `，快照 ${rep.meta.snapDate}` : ""}）` +
          (suppressed > 0 ? `；另有 ${suppressed} 个因全口径参考充足被抑制，待人工核实覆盖缺口` : ""),
        count: belowLead,
        href: "/replenish",
      });
    }
  }

  /* 5) 上线就绪三件事（2026-09-04 审计 #8）
     
     此前这里只有「成品缺生产周期」一条，还链到只读的 /report/data-health——
     看得见、改不了。新来的计划员看到的是一屏告警数，看不到「系统还没就绪、
     先把这三件事补上」。三条卡片都链到**能改的那个页面**：
       缺生产周期 → /master/supply-params?blockedOnly=1（与 replenish/pilot 的链接同一个）
       平台身份缺口 → 决策工作室身份页签（系统给候选、批量提交）
       缺单位成本 → 文件上传（sku_cost 模板，财务放行）
     口径都取自各自的权威读模型，不在这里另算一套。 */
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
    out.push({ key: "missing_lead", severity: "medium", title: "成品缺生产周期", impact: `${missingLead} 个成品无法推算下单日；补录页可批量按分层/品牌套用`, count: missingLead, href: "/master/supply-params?blockedOnly=1" });
  }

  // 5b) 缺单位成本：没有成本就没有库存金额、没有毛利、没有金额口径分层
  const missingCost = await countWhere(
    db,
    schema.skus,
    and(
      eq(schema.skus.skuType, "finished"),
      eq(schema.skus.active, true),
      sql`not exists (select 1 from sku_costs sc where sc.sku_id = ${schema.skus.id})`,
    ),
  );
  if (missingCost > 0) {
    out.push({
      key: "missing_cost",
      severity: "medium",
      title: "成品缺单位成本",
      impact: `${missingCost} 个成品没有 sku_costs：库存金额、毛利与金额口径分层都算不出`,
      count: missingCost,
      href: "/import/upload",
    });
  }

  // 5c) 平台身份缺口：外部销速/退款驱动都要先落到系统 SKU 才能用
  const identityGap = await platformIdentityGap(db);
  if (identityGap && identityGap.unmapped > 0) {
    out.push({
      key: "identity_gap",
      severity: "medium",
      title: "平台商品缺 SCM 身份",
      impact:
        `${identityGap.unmapped} 个平台 SKU 未认领`
        + (identityGap.mappedAmountPct != null ? `，销售额覆盖仅 ${identityGap.mappedAmountPct.toFixed(1)}%` : "")
        + (identityGap.withCandidates > 0 ? `；其中 ${identityGap.withCandidates} 个系统已给出候选，可一键确认` : ""),
      count: identityGap.unmapped,
      href: "/report/decision-studio?tab=identity",
    });
  }

  const sorted = out.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || b.count - a.count);
  return applyExceptionMemory(db, sorted, recordShown, applySnooze);
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

/**
 * @param user 当前登录人。**必须传全量身份**（id + roles + isApprover）——
 *   「待我审批」要按 approval_configs 审批域 + SoD 自审排除算，只有 roles/userId 算不出。
 *   不传（如每日摘要的全局视角）则两个与人相关的队列返回 0。
 */
export async function getWorkbenchFocus(
  roles: string[],
  dbArg?: AnyDb,
  user?: SessionUser,
): Promise<WorkbenchFocus> {
  const userId = user?.id;
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
  const [sections, exceptionSet, nextActions] = await Promise.all([
    Promise.all(builders.map(([, build]) => build(db))),
    planningRole ? computeExceptionSet(db) : Promise.resolve<ExceptionSet>({ visible: [], all: [] }),
    getNextActions(roles, db),
  ]);
  const myOpenDocs = userId != null ? await countMyOpenDocs(db, userId) : null;

  /* 冗余#7：五条队列一次汇总（工作台一处看全，不必逐个页面点） */
  /* 「待我审批」与「未读通知」两个数都必须与用户点进去看到的页面同源，否则徽标不可行动。
     此前两处各自手写查询：
       - 待我审批：只数 bh/wo/po/jg/stock 五表全量 pending，不看 approval_configs 审批域、
         不做 SoD 自审排除、漏掉 pc/fl/tl/sh/ct/js/pd 七类——是个与登录人无关的常量，
         七个角色一律显示 2，而 /api/inbox 实际为 admin=4 / ops01=0 / warehouse01=0。
         仓管点红色「待我审批 2」进去是空列表。
       - 未读通知：完全不带收件人条件，4 类角色恒显 8（实际可见 4），读完仍卡 4 且无法归零。
     现改为复用两处唯一权威：getInbox（审批域 + SoD）与 notifyVisibleWhere（收件人）。 */
  const [pendingDocs, unreadNotify, openAlerts, openReview, myTodo] = await Promise.all([
    user ? getInbox(user, db).then((r) => r.total) : Promise.resolve(0),
    user
      ? countWhere(db, schema.notifications, and(isNull(schema.notifications.readAt), notifyVisibleWhere(user)))
      : Promise.resolve(0),
    countWhere(db, schema.systemAlerts, eq(schema.systemAlerts.status, "open")),
    countWhere(db, schema.reviewItems, eq(schema.reviewItems.status, "open")),
    // D61 待办任务（work_items）：与 /todo「我的待办」同源（getTodoProgressBlock.mine）；无登录人视角时不出卡
    // 动态导入：todo/service → jobs/notify → workbench/focus → todo/stats 会成环（next build 收集页面数据时 TDZ 报错）
    user ? import("@/server/modules/todo/stats").then(({ getTodoProgressBlock }) => getTodoProgressBlock(user, db)).then((b) => b.mine) : Promise.resolve(null),
  ]);
  const exceptions = exceptionSet.visible;
  const queues = [
    { key: "inbox", label: "待我审批", count: pendingDocs, href: "/inbox" },
    ...(myTodo
      ? [{ key: "todo", label: myTodo.overdue > 0 ? `我的待办任务（逾期 ${myTodo.overdue}）` : "我的待办任务", count: myTodo.open, href: "/todo" }]
      : []),
    { key: "notify", label: "未读通知", count: unreadNotify, href: "/notifications" },
    { key: "alerts", label: "系统告警", count: openAlerts, href: "/alerts" },
    { key: "review", label: "待复核事项", count: openReview, href: "/review/checklist" },
    { key: "mine", label: "我发起的未完结", count: myOpenDocs ?? 0, href: "/inbox" },
  ];

  /* W2「自上次访问以来」：只标记，不排序、不评分、不过滤。
     无登录人视角（每日摘要 getWorkbenchFocus(roles, db)）跳过——那不是"某个人的上一次访问"。 */
  let sinceLastVisit: WorkbenchFocus["sinceLastVisit"] = null;
  let markedExceptions = exceptions;
  if (userId != null) {
    /* 快照用 `exceptionSet.all`（**打盹过滤之前**）+ 条目数：
       - 用过滤后的清单，一条打盹到期的老例外会冒充「新增」（它从没消失，只是被藏起来）；
       - 只用分类键，`inventory_cover` 从 2 个 SKU 涨到 200 个 SKU 会被判成「无新增」。 */
    const delta = await markWorkbenchVisit(
      db,
      userId,
      exceptionSet.all.map((e) => ({ k: e.key, c: e.count })),
    );
    const changed = new Set([...delta.newKeys, ...delta.grownKeys]);
    markedExceptions = exceptions.map((e) => {
      const before = delta.previousCounts[e.key] ?? null;
      return {
        ...e,
        newSinceLastVisit: changed.has(e.key),
        previousCount: before,
        countDelta: before == null ? null : e.count - before,
      };
    });
    sinceLastVisit = {
      since: delta.since,
      newCount: delta.newKeys.length,
      grownCount: delta.grownKeys.length,
      firstVisit: delta.firstVisit,
      state: delta.state,
    };
  }

  return {
    generatedAt: new Date().toISOString(),
    sections,
    exceptions: markedExceptions,
    nextActions,
    myOpenDocs,
    queues,
    sinceLastVisit,
  };
}
