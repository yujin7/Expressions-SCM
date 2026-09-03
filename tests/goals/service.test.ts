import { beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { auditLogs, departmentGoals, reportReadModelCache, users } from "@/db/schema";
import type { SessionUser } from "@/server/core/dto";
import {
  computeAttainment,
  createGoal,
  extractPeriodValue,
  getGoalsBlock,
  listGoals,
  refreshAutoActuals,
  resolveAutoActual,
  updateGoal,
} from "@/server/modules/goals/service";
import { createTestDb, type TestDb } from "../helpers/db";

describe("goals/service：部门目标 CRUD / auto 实际值 / 达成度 / 权限", () => {
  let db: TestDb;
  let admin: SessionUser;
  let pmc: SessionUser;
  let purchasing: SessionUser;

  beforeAll(async () => {
    ({ db } = await createTestDb());
    const mk = async (name: string, roles: string[]): Promise<SessionUser> => {
      const [u] = await db.insert(users).values({ name, roles, isApprover: false }).returning();
      return { id: u.id, name: u.name, roles, isApprover: false };
    };
    admin = await mk("管理员", ["admin"]);
    pmc = await mk("计划", ["pmc"]);
    purchasing = await mk("采购", ["purchasing"]);
    // 已登记读模型缓存：账期达成率（G 域）与库存占比（A 域）的两种常见形状
    await db.insert(reportReadModelCache).values([
      { key: "supplier-payment-term/v1", sourceBinding: "test", payload: { rows: [{ period: "2026-Q3", paymentTermAttainment: 40 }] } },
      { key: "inventory-sales-ratio/v1", sourceBinding: "test", payload: { byPeriod: { "2026-09": { inventorySalesRatio: "48.6" } } } },
    ]);
  });

  it("达成度：up = 实际/目标，down = 目标/实际，decimal 一位小数；分母 0 → null", () => {
    expect(computeAttainment("100", "40", "up")).toBe("40.0");
    expect(computeAttainment("47", "48.6", "down")).toBe("96.7");
    expect(computeAttainment("47", "0", "down")).toBeNull();
    expect(computeAttainment("47", null, "down")).toBeNull();
  });

  it("extractPeriodValue 支持 rows[] / byPeriod{} / 顶层 period 三种形状；不命中 → null", () => {
    expect(extractPeriodValue({ rows: [{ month: "2026-09", value: 12.5 }] }, "2026-09", ["value"])).toBe("12.5");
    expect(extractPeriodValue({ latestMonth: "2026-09", summary: { turns: 6.2 } }, "2026-09", ["turns"])).toBe("6.2");
    expect(extractPeriodValue({ latestMonth: "2026-08", summary: { turns: 6.2 } }, "2026-09", ["turns"])).toBeNull();
    expect(extractPeriodValue("nope", "2026-09", ["x"])).toBeNull();
  });

  it("createGoal：auto 指标从读模型取值（取到 → actual=auto；取不到 → null，不编造）；写审计", async () => {
    const g = await createGoal({ deptKey: "purchasing", period: "2026-Q3", metricKey: "paymentTermAttainment", targetValue: "100" }, purchasing, db);
    expect(g).toMatchObject({ direction: "up", actualValue: "40.0000", actualSource: "auto", attainment: "40.0", attained: false, autoStatus: "ok", editable: true });
    const none = await createGoal({ deptKey: "purchasing", period: "2026-Q4", metricKey: "onTimeRate", targetValue: "95" }, admin, db);
    expect(none).toMatchObject({ actualValue: null, actualSource: null, autoStatus: "unavailable", attainment: null });
    const audits = await db.select().from(auditLogs).where(and(eq(auditLogs.entity, "department_goal"), eq(auditLogs.entityId, g.id)));
    expect(audits.map((a) => a.action)).toEqual(["create"]);
  });

  it("权限：非本部门 403；未登记指标 400；同键重复 → 唯一约束冲突", async () => {
    await expect(createGoal({ deptKey: "pmc", period: "2026-09", metricKey: "inventorySalesRatio", targetValue: "47" }, purchasing, db)).rejects.toMatchObject({ status: 403 });
    await expect(createGoal({ deptKey: "pmc", period: "2026-09", metricKey: "notAMetric", targetValue: "1" }, pmc, db)).rejects.toMatchObject({ status: 400 });
    const ok = await createGoal({ deptKey: "pmc", period: "2026-09", metricKey: "inventorySalesRatio", targetValue: "47" }, pmc, db);
    expect(ok).toMatchObject({ direction: "down", actualValue: "48.6000", attained: false, attainment: "96.7" });
    await expect(createGoal({ deptKey: "pmc", period: "2026-09", metricKey: "inventorySalesRatio", targetValue: "45" }, pmc, db)).rejects.toThrow();
  });

  it("updateGoal：手工实际值必附证据（否则 400）；证据落 note 与审计；manual 行不被 auto 回填覆盖", async () => {
    const g = await createGoal({ deptKey: "pmc", period: "2026-Q3", metricKey: "qcPassRate", targetValue: "98", direction: "up" }, pmc, db);
    expect(g.actualSource).toBeNull();
    await expect(updateGoal(g.id, { actualValue: "97.5" }, pmc, db)).rejects.toThrow();
    const u = await updateGoal(g.id, { actualValue: "97.5", evidence: "质检月报 2026-09" }, pmc, db);
    expect(u).toMatchObject({ actualValue: "97.5000", actualSource: "manual", attained: false, attainment: "99.5" });
    expect(u.note).toContain("质检月报 2026-09");
    await expect(updateGoal(g.id, { targetValue: "90" }, purchasing, db)).rejects.toMatchObject({ status: 403 });
    // 把 auto 指标的行改成 manual，再 refresh 不覆盖
    const list = await listGoals({ period: "2026-Q3" }, admin, db);
    const pay = list.rows.find((r) => r.metricKey === "paymentTermAttainment")!;
    await updateGoal(pay.id, { actualValue: "55", evidence: "财务口径修正" }, admin, db);
    const s = await refreshAutoActuals(db, { actorId: admin.id });
    expect(s.scanned).toBeGreaterThanOrEqual(1);
    const [row] = await db.select().from(departmentGoals).where(eq(departmentGoals.id, pay.id));
    expect(row.actualValue).toBe("55.0000");
    expect(row.actualSource).toBe("manual");
  });

  it("refreshAutoActuals：读模型更新后回填并写审计 refresh；resolveAutoActual 未知指标 → null", async () => {
    await db.update(reportReadModelCache)
      .set({ payload: { rows: [{ period: "2026-Q4", onTimeRate: "91.2" }] }, builtAt: new Date() })
      .where(eq(reportReadModelCache.key, "supplier-payment-term/v1"));
    await db.insert(reportReadModelCache).values({ key: "purchase-order-metrics/v2", sourceBinding: "t", payload: { items: [{ quarter: "2026-Q4", otif: 91.2 }] } });
    const s = await refreshAutoActuals(db, { period: "2026-Q4", actorId: admin.id });
    expect(s).toMatchObject({ updated: 1, unavailable: 0 });
    const list = await listGoals({ period: "2026-Q4" }, admin, db);
    expect(list.rows[0]).toMatchObject({ metricKey: "onTimeRate", actualValue: "91.2000", actualSource: "auto", attained: false });
    const audits = await db.select().from(auditLogs).where(and(eq(auditLogs.entity, "department_goal"), eq(auditLogs.entityId, list.rows[0].id)));
    expect(audits.map((a) => a.action)).toEqual(["create", "refresh"]);
    expect(await resolveAutoActual(db, "qcPassRate", "2026-Q4")).toEqual({ value: null, sourceKey: null, builtAt: null });
  });

  it("listGoals：全员可见全部部门，editableDepts 只含本部门；D62 受限用户只见范围内部门", async () => {
    const view = await listGoals({}, purchasing, db);
    expect(view.deptKeys).toHaveLength(7);
    expect(view.editableDepts).toEqual(["purchasing"]);
    expect(view.rows.some((r) => r.deptKey === "pmc" && r.editable === false)).toBe(true);
    const restricted: SessionUser = { ...purchasing, deptScope: ["purchasing"] };
    const scoped = await listGoals({}, restricted, db);
    expect(scoped.deptKeys).toEqual(["purchasing"]);
    expect(scoped.rows.every((r) => r.deptKey === "purchasing")).toBe(true);
    await expect(listGoals({ deptKey: "pmc" }, restricted, db)).rejects.toMatchObject({ status: 403 });
  });

  it("第 4 屏数据块：本月 + 本季；byDept 汇总与 metricIds", async () => {
    const b = await getGoalsBlock(admin, db, { now: new Date("2026-09-10T02:00:00Z") });
    expect(b.periods).toEqual({ month: "2026-09", quarter: "2026-Q3" });
    expect(b.metricIds).toEqual(["goalAttainment"]);
    const pmcRow = b.byDept.find((d) => d.deptKey === "pmc")!;
    expect(pmcRow).toMatchObject({ total: 2, withActual: 2, attained: 0, attainmentRate: "0.0", editable: true });
    const purch = b.byDept.find((d) => d.deptKey === "purchasing")!;
    expect(purch).toMatchObject({ total: 1, withActual: 1, attained: 0 });
    expect(b.href).toBe("/goals");
  });
});
