/**
 * 安全审计 S1：金额型指标（METRICS.unit = "money"）的实际值绝不能经 department_goals 漏给非价格角色。
 *
 * 泄露路径（修复前真实存在）：`costSavingYtd` 的 auto 取值 = purchase-order-metrics 的
 * `summary.costSaving.savingYtd`——正是 stripPurchaseOrderMoney 对非价格角色扣住的那笔钱；
 * 它被写进 `department_goals.actual_value`，再以 `actualValue` 下发（该键不在 SENSITIVE_FIELDS，也不该在：
 * 同一列还承载周转次数这类全员可见的数）。于是运营给自己部门建一条 costSavingYtd 目标 +
 * POST /api/goals/refresh，就能把降本额读回来；驾驶舱第 4 屏 goalHistory 是同一个洞的第二个出口。
 *
 * 本测试钉住三件事：
 * 1. 非价格角色**建不了**金额指标目标（写侧先拒）；
 * 2. 由 admin 建、引擎回填之后，非价格角色从 listGoals / getGoalsBlock / loadGoalHistory 与
 *    /api/goals 路由拿到的都是 actualValue=null + autoStatus="withheld"（不是 0、不是假数），
 *    达成度一并扣住（保留达成度等于把 实际÷目标 的除法送出去）；
 * 3. 价格可见角色照常拿到真值（闸门不是把功能关掉）。
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { departmentGoals, reportReadModelCache, users } from "@/db/schema";
import type { SessionUser } from "@/server/core/dto";
import {
  createGoal, getGoalsBlock, isMoneyMetric, listGoals, refreshAutoActuals, updateGoal,
} from "@/server/modules/goals/service";
import { loadGoalHistory } from "@/server/modules/report/cockpit-trends";
import { PURCHASE_ORDER_METRICS_KEY } from "@/server/modules/report/purchase-order-metrics";
import { METRICS } from "@/components/metrics";
import { createTestDb, type TestDb } from "../helpers/db";

const SAVING = "123456.78"; // 只此一处出现的金额：断言"整段响应里不含它"才有意义
const PERIOD = "2026-Q3";
const PERIOD2 = "2026-Q2";

const mocks = vi.hoisted(() => ({ db: null as unknown, guardRead: vi.fn() }));
vi.mock("@/db", () => ({ getDbAsync: vi.fn(async () => mocks.db) }));
vi.mock("@/server/modules/master/common", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/server/modules/master/common")>();
  return { ...original, guardRead: mocks.guardRead };
});

const { GET: goalsGet } = await import("@/app/api/goals/route");

interface Ctx { db: TestDb; admin: SessionUser; ops: SessionUser; finance: SessionUser }

async function seed(): Promise<Ctx> {
  const { db } = await createTestDb();
  mocks.db = db;
  const mk = async (name: string, roles: string[]): Promise<SessionUser> => {
    const [u] = await db.insert(users).values({ name, roles, isApprover: false }).returning();
    return { id: u.id, name: u.name, roles, isApprover: false };
  };
  const admin = await mk("管理员", ["admin"]);
  const ops = await mk("运营", ["ops"]);
  const finance = await mk("财务", ["finance"]);
  // PurchaseOrderMetrics 的最小真实形状：金额只在 summary.costSaving.savingYtd
  await db.insert(reportReadModelCache).values({
    key: PURCHASE_ORDER_METRICS_KEY,
    sourceBinding: "test",
    payload: { key: PURCHASE_ORDER_METRICS_KEY, year: 2026, month: "2026-09", summary: { costSaving: { savingYtd: SAVING } }, byMonth: [] },
  });
  return { db, admin, ops, finance };
}

/** admin 建两期金额目标并回填（loadGoalHistory 单期不成序列，故建两期） */
async function seedMoneyGoals(ctx: Ctx) {
  for (const period of [PERIOD, PERIOD2]) {
    await createGoal({ deptKey: "ops", period, metricKey: "costSavingYtd", targetValue: "200000" }, ctx.admin, ctx.db);
  }
  await refreshAutoActuals(ctx.db, { actorId: ctx.admin.id });
}

describe("S1 金额型部门目标：非价格角色一律扣住实际值", () => {
  let ctx: Ctx;
  beforeEach(async () => { ctx = await seed(); });

  it("指标注册表就是金额判定的唯一权威（costSavingYtd = money，周转次数不是）", () => {
    expect(METRICS.costSavingYtd.unit).toBe("money");
    expect(isMoneyMetric("costSavingYtd")).toBe(true);
    expect(isMoneyMetric("turns")).toBe(false);
  });

  it("写侧：运营建不了金额指标目标（403，且不落库）；非金额指标照常能建", async () => {
    await expect(createGoal({ deptKey: "ops", period: PERIOD, metricKey: "costSavingYtd", targetValue: "100" }, ctx.ops, ctx.db))
      .rejects.toMatchObject({ status: 403 });
    expect(await ctx.db.select().from(departmentGoals).where(eq(departmentGoals.metricKey, "costSavingYtd"))).toHaveLength(0);
    const ok = await createGoal({ deptKey: "ops", period: PERIOD, metricKey: "turns", targetValue: "8" }, ctx.ops, ctx.db);
    expect(ok.metricKey).toBe("turns");
  });

  it("读侧：回填后的降本额对运营为 withheld；财务/管理员见真值", async () => {
    await seedMoneyGoals(ctx);
    // 值确实落库了（不是"没取到"）
    const [row] = await ctx.db.select().from(departmentGoals).where(eq(departmentGoals.period, PERIOD));
    expect(row.actualValue).toBe("123456.7800");

    const opsList = await listGoals({ period: PERIOD }, ctx.ops, ctx.db);
    const opsRow = opsList.rows.find((r) => r.metricKey === "costSavingYtd")!;
    expect(opsRow).toMatchObject({ actualValue: null, autoStatus: "withheld", valueWithheld: true, attainment: null, attained: null });
    expect(JSON.stringify(opsList)).not.toContain("123456");

    const finList = await listGoals({ period: PERIOD }, ctx.finance, ctx.db);
    const finRow = finList.rows.find((r) => r.metricKey === "costSavingYtd")!;
    expect(finRow.actualValue).toBe("123456.7800");
    expect(finRow.valueWithheld).toBe(false);
    expect(finRow.attainment).not.toBeNull();
  });

  it("第 4 屏数据块与目标达成历史同一道闸：运营两条出口都拿不到数", async () => {
    await seedMoneyGoals(ctx);
    const block = await getGoalsBlock(ctx.ops, ctx.db, { now: new Date("2026-09-10T02:00:00Z") });
    expect(JSON.stringify(block)).not.toContain("123456");
    expect(block.rows.find((r) => r.metricKey === "costSavingYtd")).toMatchObject({ actualValue: null, autoStatus: "withheld" });
    // 扣住的行不进达成率分母（否则达成率反过来暴露"达没达成"）
    expect(block.byDept.find((d) => d.deptKey === "ops")!.withActual).toBe(0);

    const opsHistory = await loadGoalHistory(ctx.db, ctx.ops);
    const opsSeries = opsHistory.series.find((s) => s.metricKey === "costSavingYtd")!;
    expect(opsSeries.points.every((p) => p.actualValue === null && p.valueWithheld && p.attainment === null)).toBe(true);
    expect(JSON.stringify(opsHistory)).not.toContain("123456");

    const finHistory = await loadGoalHistory(ctx.db, ctx.finance);
    expect(finHistory.series.find((s) => s.metricKey === "costSavingYtd")!.points.some((p) => p.actualValue === "123456.7800")).toBe(true);
  });

  it("/api/goals 路由（列表与第 4 屏 summary）对运营都不含金额", async () => {
    await seedMoneyGoals(ctx);
    mocks.guardRead.mockResolvedValue(ctx.ops);
    for (const qs of ["", "?scope=summary"]) {
      const res = await goalsGet(new NextRequest(`http://localhost/api/goals${qs}`));
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).not.toContain("123456");
      expect(text).toContain("withheld");
    }
    mocks.guardRead.mockResolvedValue(ctx.finance);
    const finRes = await goalsGet(new NextRequest("http://localhost/api/goals"));
    expect(await finRes.text()).toContain("123456.7800");
  });

  it("运营也不能改金额目标（改目标即可反推口径）", async () => {
    await seedMoneyGoals(ctx);
    const [row] = await ctx.db.select().from(departmentGoals).where(eq(departmentGoals.period, PERIOD));
    await expect(updateGoal(row.id, { targetValue: "1" }, ctx.ops, ctx.db)).rejects.toMatchObject({ status: 403 });
  });
});
