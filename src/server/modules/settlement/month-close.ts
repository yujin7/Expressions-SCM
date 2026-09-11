import {
  and,
  eq,
  gte,
  inArray,
  isNull,
  lt,
  ne,
  or,
  sql,
  type SQL,
  type AnyColumn,
} from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import * as schema from "@/db/schema";
import { writeAudit } from "@/server/core/audit";
import type { SessionUser } from "@/server/core/dto";
import { ApiError } from "@/server/modules/master/common";
import { type AnyDb, requireAnyRole, resolveDb } from "@/server/modules/outsource/common";
import { getJiediaoReport } from "@/server/modules/report/jiediao";
import { getPeriodLock, isPeriodClosed } from "@/server/modules/settlement/period-lock";
import { shanghaiMonthOf } from "@/server/core/business-day";

export const MONTH_CLOSE_DEFINITIONS = [
  { key: "data_release", title: "数据导入与放行收口", owner: "PMC / 财务", href: "/import/jobs" },
  { key: "operational_docs", title: "业务单据收口", owner: "PMC / 采购 / 仓管", href: "/workbench" },
  { key: "inventory_count", title: "库存盘点与差异调整", owner: "仓管 / 财务", href: "/inventory/count" },
  { key: "jst_reconciliation", title: "聚水潭出库对账", owner: "财务", href: "/jobs/recon" },
  { key: "borrow_reconciliation", title: "部门间借调对账", owner: "运营 / 财务", href: "/report/jiediao" },
  { key: "settlement_close", title: "委外结算收口", owner: "采购 / 财务", href: "/settlement/js" },
] as const;

export type MonthCloseKey = (typeof MONTH_CLOSE_DEFINITIONS)[number]["key"];
export type AutoState = "pass" | "attention" | "blocked";
export type ManualState = "pending" | "completed" | "waived";

interface AutomatedCheck {
  key: MonthCloseKey;
  autoState: AutoState;
  summary: string;
  evidence: Record<string, unknown>;
}

export interface MonthCloseCheck extends AutomatedCheck {
  title: string;
  owner: string;
  href: string;
  status: ManualState;
  note: string | null;
  completedByName: string | null;
  completedAt: Date | null;
  version: number;
  evidenceChanged: boolean;
  current: boolean;
}

export interface MonthCloseChecklist {
  month: string;
  generatedAt: string;
  /**
   * 该期间是否**真的**关账了——`period_locks` 是唯一权威（W2-1）。
   * 此前这里是 `month < 当前月` 的日历推断：它既不阻止任何过账，也不代表任何人签过字。
   */
  periodClosed: boolean;
  /** 关账人/时间/说明（未关账时为 null） */
  closedByName: string | null;
  closedAt: Date | null;
  closeNote: string | null;
  /** 最近一次重开（管理员）的时间与原因；从未重开为 null */
  reopenedAt: Date | null;
  reopenReason: string | null;
  /** 六项检查是否全部收口——关账的前置条件 */
  closable: boolean;
  /** 日历上是否已翻篇（旧 periodClosed 的含义，仅供文案用） */
  pastMonth: boolean;
  checks: MonthCloseCheck[];
  progress: { current: number; total: 6; percent: number };
  limitations: string[];
}

function monthRange(month: string): { start: Date; end: Date; startDate: string; endDate: string } {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new ApiError(400, "月份格式须为 YYYY-MM");
  const [year, value] = month.split("-").map(Number);
  const start = new Date(Date.UTC(year, value - 1, 1) - 8 * 60 * 60 * 1000);
  const end = new Date(Date.UTC(year, value, 1) - 8 * 60 * 60 * 1000);
  const endYear = value === 12 ? year + 1 : year;
  const endMonth = value === 12 ? 1 : value + 1;
  return {
    start,
    end,
    startDate: `${month}-01`,
    endDate: `${endYear}-${String(endMonth).padStart(2, "0")}-01`,
  };
}

async function countRows(db: AnyDb, table: PgTable, condition: SQL): Promise<number> {
  const [row] = await db.select({ count: sql<number>`count(*)::int` }).from(table).where(condition);
  return row?.count ?? 0;
}

function currentShanghaiMonth(now: Date): string {
  return shanghaiMonthOf(now);
}

async function buildAutomatedChecks(month: string, db: AnyDb): Promise<AutomatedCheck[]> {
  const range = monthRange(month);
  const createdInMonth = (column: AnyColumn) =>
    and(gte(column, range.start), lt(column, range.end))!;
  const updatedInMonth = (column: AnyColumn) =>
    and(gte(column, range.start), lt(column, range.end))!;

  /* C2 盘点归期必须按**业务日期**（pd_docs.biz_date），不能按录入时间。
     盘点差异调整是按 biz_date 落账的（inventory/count.countAdjustOccurredAt），
     所以 7/31 盘的、8/2 才录进来的那张单，它的流水属于 7 月。按 created_at 筛的话
     7 月清单看不见它 → 7 月照常关账 → 再去审批这张盘点必然撞期间锁 CLOSED_PERIOD 并整笔回滚，
     而 occurredAt 改不了 = 这张盘点单**永久无法审批**。
     biz_date 可空（存量单据没有这个事实，见 schema 注释），缺失时才回落 created_at。 */
  const countedInMonth = or(
    and(gte(schema.pdDocs.bizDate, range.startDate), lt(schema.pdDocs.bizDate, range.endDate)),
    and(isNull(schema.pdDocs.bizDate), gte(schema.pdDocs.createdAt, range.start), lt(schema.pdDocs.createdAt, range.end)),
  )!;

  const importScope = or(
    and(
      gte(schema.importJobs.sourceAsOf, range.startDate),
      lt(schema.importJobs.sourceAsOf, range.endDate),
    ),
    and(
      isNull(schema.importJobs.sourceAsOf),
      gte(schema.importJobs.createdAt, range.start),
      lt(schema.importJobs.createdAt, range.end),
    ),
  )!;
  const [
    importTotal,
    importActive,
    importFailed,
    bhOpen,
    woOpen,
    poOpen,
    jgOpen,
    flOpen,
    tlOpen,
    shOpen,
    ctOpen,
    stockOpen,
    countTotal,
    countOpen,
    countUnadjusted,
    reconTotal,
    reconOpen,
    jsOpen,
    completedJgWithoutJs,
    borrow,
  ] = await Promise.all([
    countRows(db, schema.importJobs, importScope),
    countRows(db, schema.importJobs, and(importScope, inArray(schema.importJobs.status, ["pending", "validating"]))!),
    countRows(db, schema.importJobs, and(importScope, eq(schema.importJobs.status, "failed"))!),
    countRows(db, schema.bhDocs, and(createdInMonth(schema.bhDocs.createdAt), inArray(schema.bhDocs.status, ["draft", "pending", "approved", "in_progress"]))!),
    countRows(db, schema.woDocs, and(createdInMonth(schema.woDocs.createdAt), inArray(schema.woDocs.status, ["draft", "pending", "approved", "in_progress"]))!),
    countRows(db, schema.poDocs, and(createdInMonth(schema.poDocs.createdAt), inArray(schema.poDocs.status, ["draft", "pending", "approved", "in_progress"]))!),
    countRows(db, schema.jgDocs, and(createdInMonth(schema.jgDocs.createdAt), inArray(schema.jgDocs.status, ["draft", "pending", "approved", "in_progress"]))!),
    countRows(db, schema.flDocs, and(createdInMonth(schema.flDocs.createdAt), inArray(schema.flDocs.status, ["draft", "pending", "approved", "in_progress"]))!),
    countRows(db, schema.tlDocs, and(createdInMonth(schema.tlDocs.createdAt), inArray(schema.tlDocs.status, ["draft", "pending", "approved", "in_progress"]))!),
    countRows(db, schema.shDocs, and(createdInMonth(schema.shDocs.createdAt), inArray(schema.shDocs.status, ["draft", "pending", "approved", "in_progress"]))!),
    countRows(db, schema.ctDocs, and(createdInMonth(schema.ctDocs.createdAt), inArray(schema.ctDocs.status, ["draft", "pending", "approved", "in_progress"]))!),
    countRows(db, schema.stockDocs, and(createdInMonth(schema.stockDocs.createdAt), inArray(schema.stockDocs.status, ["draft", "pending", "approved", "in_progress"]))!),
    countRows(db, schema.pdDocs, countedInMonth),
    countRows(db, schema.pdDocs, and(countedInMonth, inArray(schema.pdDocs.status, ["draft", "pending", "approved", "in_progress"]))!),
    countRows(
      db,
      schema.pdLines,
      and(
        sql`${schema.pdLines.pdId} IN (SELECT id FROM pd_docs WHERE (biz_date >= ${range.startDate} AND biz_date < ${range.endDate}) OR (biz_date IS NULL AND created_at >= ${range.start} AND created_at < ${range.end}))`,
        ne(schema.pdLines.bookQty, schema.pdLines.countedQty),
        isNull(schema.pdLines.adjustDocId),
      )!,
    ),
    countRows(db, schema.reconDiffs, and(gte(schema.reconDiffs.bizDate, range.startDate), lt(schema.reconDiffs.bizDate, range.endDate))!),
    countRows(db, schema.reconDiffs, and(gte(schema.reconDiffs.bizDate, range.startDate), lt(schema.reconDiffs.bizDate, range.endDate), eq(schema.reconDiffs.status, "open"))!),
    countRows(db, schema.jsDocs, and(createdInMonth(schema.jsDocs.createdAt), inArray(schema.jsDocs.status, ["draft", "pending", "approved", "in_progress"]))!),
    (async () => {
      const [row] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(schema.jgDocs)
        .leftJoin(schema.jsDocs, eq(schema.jsDocs.jgId, schema.jgDocs.id))
        .where(and(
          eq(schema.jgDocs.status, "completed"),
          updatedInMonth(schema.jgDocs.updatedAt),
          isNull(schema.jsDocs.id),
        ));
      return row?.count ?? 0;
    })(),
    getJiediaoReport(month, db),
  ]);

  const openDocs = {
    bh: bhOpen,
    wo: woOpen,
    po: poOpen,
    jg: jgOpen,
    fl: flOpen,
    tl: tlOpen,
    sh: shOpen,
    ct: ctOpen,
    stock: stockOpen,
  };
  const openDocTotal = Object.values(openDocs).reduce((sum, value) => sum + value, 0);
  return [
    {
      key: "data_release",
      autoState: importFailed > 0 ? "blocked" : importActive > 0 ? "attention" : "pass",
      summary: importFailed > 0
        ? `${importFailed} 个失败导入任务待处理`
        : importActive > 0
          ? `${importActive} 个导入任务尚未完成`
          : `本月范围 ${importTotal} 个导入任务，无失败或处理中任务`,
      evidence: { importTotal, importActive, importFailed, scope: "sourceAsOf，缺失时回落 createdAt" },
    },
    {
      key: "operational_docs",
      autoState: openDocTotal > 0 ? "attention" : "pass",
      summary: openDocTotal > 0 ? `${openDocTotal} 张本月业务单据仍在处理中` : "本月业务单据无未收口状态",
      evidence: { openDocTotal, byDocType: openDocs, statuses: ["draft", "pending", "approved", "in_progress"] },
    },
    {
      key: "inventory_count",
      autoState: countOpen > 0 || countUnadjusted > 0 ? "blocked" : countTotal === 0 ? "attention" : "pass",
      summary: countOpen > 0 || countUnadjusted > 0
        ? `${countOpen} 张盘点未完成，${countUnadjusted} 条差异未调整`
        : countTotal === 0
          ? "本月未发现盘点任务，需确认是否适用"
          : `${countTotal} 张盘点任务已收口且差异均有调整单`,
      evidence: {
        countTotal, countOpen, countUnadjusted,
        // C2：按盘点期（pd_docs.biz_date）归月，缺失才回落 created_at——补录的跨月盘点必须挡住它所属的那个月
        scope: "bizDate 自然月，缺失时回落 createdAt",
      },
    },
    {
      key: "jst_reconciliation",
      autoState: reconOpen > 0 ? "blocked" : reconTotal === 0 ? "attention" : "pass",
      summary: reconOpen > 0
        ? `${reconOpen} 条聚水潭对账差异仍未解释`
        : reconTotal === 0
          ? "本月未发现聚水潭对账结果，需确认数据源/适用性"
          : `${reconTotal} 条对账结果均已解释或解决`,
      evidence: { reconTotal, reconOpen, scope: "bizDate 自然月" },
    },
    {
      key: "borrow_reconciliation",
      autoState: "pass",
      summary: borrow.lines.length > 0
        ? `${new Set(borrow.lines.map((line) => line.docNo)).size} 张借调单、${borrow.lines.length} 行待业务签认`
        : "本月无借调记录，可确认无发生",
      evidence: {
        docCount: new Set(borrow.lines.map((line) => line.docNo)).size,
        lineCount: borrow.lines.length,
        warehouseCount: borrow.netByWarehouse.length,
      },
    },
    {
      key: "settlement_close",
      autoState: jsOpen > 0 || completedJgWithoutJs > 0 ? "blocked" : "pass",
      summary: jsOpen > 0 || completedJgWithoutJs > 0
        ? `${jsOpen} 张结算单未完成，${completedJgWithoutJs} 张本月完工 JG 尚无结算单`
        : "本月委外结算无待处理缺口",
      evidence: { jsOpen, completedJgWithoutJs },
    },
  ];
}

function sameEvidence(a: unknown, b: unknown): boolean {
  const stable = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, child]) => [key, stable(child)]),
      );
    }
    return value ?? null;
  };
  return JSON.stringify(stable(a)) === JSON.stringify(stable(b));
}

export async function getMonthCloseChecklist(
  month: string,
  dbArg?: AnyDb,
  now = new Date(),
): Promise<MonthCloseChecklist> {
  const db = await resolveDb(dbArg);
  const automated = await buildAutomatedChecks(month, db);
  const stored: {
    checkKey: string;
    status: string;
    note: string | null;
    evidence: unknown;
    completedAt: Date | null;
    version: number;
    completedByName: string | null;
  }[] = await db
    .select({
      checkKey: schema.monthCloseChecks.checkKey,
      status: schema.monthCloseChecks.status,
      note: schema.monthCloseChecks.note,
      evidence: schema.monthCloseChecks.evidence,
      completedAt: schema.monthCloseChecks.completedAt,
      version: schema.monthCloseChecks.version,
      completedByName: schema.users.name,
    })
    .from(schema.monthCloseChecks)
    .leftJoin(schema.users, eq(schema.monthCloseChecks.completedBy, schema.users.id))
    .where(eq(schema.monthCloseChecks.month, month));
  const byKey = new Map(stored.map((row) => [row.checkKey, row]));
  const checks: MonthCloseCheck[] = MONTH_CLOSE_DEFINITIONS.map((definition) => {
    const auto = automated.find((item) => item.key === definition.key)!;
    const saved = byKey.get(definition.key);
    const status = (saved?.status ?? "pending") as ManualState;
    const evidenceChanged = status !== "pending" && !sameEvidence(saved?.evidence, auto.evidence);
    return {
      ...definition,
      ...auto,
      status,
      note: saved?.note ?? null,
      completedByName: saved?.completedByName ?? null,
      completedAt: saved?.completedAt ?? null,
      version: saved?.version ?? 0,
      evidenceChanged,
      current: status !== "pending" && !evidenceChanged,
    };
  });
  const current = checks.filter((check) => check.current).length;
  const lock = await getPeriodLock(month, db);
  return {
    month,
    generatedAt: now.toISOString(),
    periodClosed: lock.closed,
    closedByName: lock.closedByName,
    closedAt: lock.closedAt,
    closeNote: lock.closeNote,
    reopenedAt: lock.reopenedAt,
    reopenReason: lock.reopenReason,
    closable: current === 6 && !lock.closed && month < currentShanghaiMonth(now),
    pastMonth: month < currentShanghaiMonth(now),
    checks,
    progress: { current, total: 6, percent: Math.round((current / 6) * 100) },
    limitations: [
      "本页是系统预关账与运营签认，不替代法定会计关账或 ERP 总账关账。",
      "系统证据实时重算；完成后证据变化会自动标为需复核。",
      "自动控制异常时只能填写原因后例外关闭，不能伪装为正常完成。",
      "「关账」写入期间锁：此后业务时间落在该月的过账（含红字冲销）一律被过账引擎拒绝，重开须管理员并留原因。",
    ],
  };
}

export async function updateMonthCloseCheck(
  user: SessionUser,
  input: {
    month: string;
    checkKey: MonthCloseKey;
    status: ManualState;
    note?: string | null;
    version: number;
  },
  dbArg?: AnyDb,
): Promise<MonthCloseChecklist> {
  requireAnyRole(user, "finance");
  const db = await resolveDb(dbArg);
  if (await isPeriodClosed(db, input.month)) {
    throw new ApiError(409, `期间 ${input.month} 已关账，请先由管理员重开后再修改签认`);
  }
  if (!MONTH_CLOSE_DEFINITIONS.some((item) => item.key === input.checkKey)) {
    throw new ApiError(400, "未知月结检查项");
  }
  if (!["pending", "completed", "waived"].includes(input.status)) throw new ApiError(400, "无效状态");
  const note = input.note?.trim() || null;
  if (input.status === "waived" && (note?.length ?? 0) < 5) {
    throw new ApiError(400, "例外关闭须填写至少 5 个字符的原因");
  }

  const current = await getMonthCloseChecklist(input.month, db);
  const check = current.checks.find((item) => item.key === input.checkKey)!;
  if (input.status === "completed" && check.autoState !== "pass") {
    throw new ApiError(409, "自动控制尚未通过；请先处理异常，或填写原因后例外关闭");
  }

  await db.transaction(async (tx: AnyDb) => {
    const [existing] = await tx
      .select()
      .from(schema.monthCloseChecks)
      .where(and(
        eq(schema.monthCloseChecks.month, input.month),
        eq(schema.monthCloseChecks.checkKey, input.checkKey),
      ));
    if ((existing?.version ?? 0) !== input.version) {
      throw new ApiError(409, `版本冲突：当前版本 ${existing?.version ?? 0}`);
    }
    const now = new Date();
    const values = input.status === "pending"
      ? {
          status: "pending",
          note: null,
          evidence: null,
          completedBy: null,
          completedAt: null,
          updatedAt: now,
        }
      : {
          status: input.status,
          note,
          evidence: check.evidence,
          completedBy: user.id,
          completedAt: now,
          updatedAt: now,
        };
    let entityId: number;
    if (existing) {
      const [updated] = await tx
        .update(schema.monthCloseChecks)
        .set({ ...values, version: sql`${schema.monthCloseChecks.version} + 1` })
        .where(and(
          eq(schema.monthCloseChecks.id, existing.id),
          eq(schema.monthCloseChecks.version, input.version),
        ))
        .returning({ id: schema.monthCloseChecks.id });
      if (!updated) throw new ApiError(409, "月结检查项已被其他用户更新");
      entityId = updated.id;
    } else {
      const [inserted] = await tx
        .insert(schema.monthCloseChecks)
        .values({ month: input.month, checkKey: input.checkKey, ...values })
        .returning({ id: schema.monthCloseChecks.id });
      entityId = inserted.id;
    }
    await writeAudit(tx, {
      userId: user.id,
      entity: "month_close_check",
      entityId,
      action: input.status === "pending" ? "reopen" : input.status,
      before: existing
        ? { month: input.month, checkKey: input.checkKey, status: existing.status, version: existing.version }
        : null,
      after: {
        month: input.month,
        checkKey: input.checkKey,
        status: input.status,
        note,
        evidence: input.status === "pending" ? null : check.evidence,
      },
    });
  });
  return getMonthCloseChecklist(input.month, db);
}
