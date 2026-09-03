import { beforeAll, describe, expect, it } from "vitest";
import { users } from "@/db/schema";
import type { SessionUser } from "@/server/core/dto";
import { createWorkItem, setWorkItemStatus } from "@/server/modules/todo/service";
import { getTodoProgressBlock, getTodoStats } from "@/server/modules/todo/stats";
import { createTestDb, type TestDb } from "../helpers/db";

const DAY = 86_400_000;
const T0 = new Date("2026-09-02T02:00:00Z"); // 上海 09-02 10:00
const NOW = new Date("2026-09-15T02:00:00Z"); // 上海 09-15

describe("todo/stats：按人×月 / 角色×月 完成率与按时率（manual 不计入）", () => {
  let db: TestDb;
  let admin: SessionUser;
  let pmc: SessionUser;
  let ops: SessionUser;

  beforeAll(async () => {
    ({ db } = await createTestDb());
    const mk = async (name: string, roles: string[]): Promise<SessionUser> => {
      const [u] = await db.insert(users).values({ name, roles, isApprover: false }).returning();
      return { id: u.id, name: u.name, roles, isApprover: false };
    };
    admin = await mk("管理员", ["admin"]);
    pmc = await mk("计划", ["pmc"]);
    ops = await mk("运营", ["ops"]);

    // pmc：4 条系统来源 + 1 条手工
    const a1 = await createWorkItem({ title: "按时完成", assigneeId: pmc.id, ownerRole: "pmc", sourceKind: "alert", sourceRef: "1", dueDate: "2026-09-10" }, admin, db, { now: T0 });
    await setWorkItemStatus(a1.item.id, "done", pmc, db, { now: new Date(T0.getTime() + 2 * DAY) });
    const a2 = await createWorkItem({ title: "晚完成", assigneeId: pmc.id, ownerRole: "pmc", sourceKind: "alert", sourceRef: "2", dueDate: "2026-09-03" }, admin, db, { now: T0 });
    await setWorkItemStatus(a2.item.id, "done", pmc, db, { now: new Date(T0.getTime() + 5 * DAY) });
    await createWorkItem({ title: "逾期未完成", assigneeId: pmc.id, ownerRole: "pmc", sourceKind: "review", sourceRef: "3", dueDate: "2026-09-05" }, admin, db, { now: T0 });
    const a4 = await createWorkItem({ title: "取消", assigneeId: pmc.id, ownerRole: "pmc", sourceKind: "alert", sourceRef: "4" }, admin, db, { now: T0 });
    await setWorkItemStatus(a4.item.id, "cancelled", pmc, db, { now: new Date(T0.getTime() + DAY) });
    const m = await createWorkItem({ title: "手工不计", assigneeId: pmc.id, ownerRole: "pmc", dueDate: "2026-09-01" }, admin, db, { now: T0 });
    await setWorkItemStatus(m.item.id, "done", pmc, db, { now: new Date(T0.getTime() + 60_000) });
    // ops：1 条系统来源未完成、无截止
    await createWorkItem({ title: "ops 项", assigneeId: ops.id, ownerRole: "ops", sourceKind: "alert", sourceRef: "5" }, admin, db, { now: T0 });
  });

  it("按人×月：total 4（手工不计）、done 2、onTime 1、overdue 2（1 完成不按时 + 1 逾期未完成）、cancelled 1；完成率 2/3、按时率 1/2", async () => {
    const s = await getTodoStats({ groupBy: "person", fromMonth: "2026-09", toMonth: "2026-09", now: NOW }, admin, db);
    const row = s.rows.find((r) => r.groupKey === String(pmc.id));
    expect(row).toMatchObject({ month: "2026-09", total: 4, done: 2, onTime: 1, overdue: 2, cancelled: 1, suspicious: 0 });
    expect(row?.completionRate).toBe(66.7);
    expect(row?.onTimeRate).toBe(50);
  });

  it("按角色×月：pmc 与 ops 各一行；非 admin 只见本人/本角色", async () => {
    const s = await getTodoStats({ groupBy: "role", fromMonth: "2026-09", toMonth: "2026-09", now: NOW }, admin, db);
    expect(s.rows.map((r) => r.groupKey).sort()).toEqual(["ops", "pmc"]);
    const opsView = await getTodoStats({ groupBy: "role", fromMonth: "2026-09", toMonth: "2026-09", now: NOW }, ops, db);
    expect(opsView.rows.map((r) => r.groupKey)).toEqual(["ops"]);
    expect(opsView.rows[0]).toMatchObject({ total: 1, done: 0, completionRate: 0, onTimeRate: null });
  });

  it("第 4 屏数据块：mine/totals/byRole 与指标 id 登记", async () => {
    const b = await getTodoProgressBlock(pmc, db, { now: NOW });
    expect(b.metricIds).toEqual(["todoOpen", "todoOverdue", "todoCompletionRate"]);
    expect(b.mine).toEqual({ open: 1, overdue: 1 });
    expect(b.byRole.map((r) => r.role)).toEqual(["pmc"]);
    expect(b.byRole[0]).toMatchObject({ open: 1, overdue: 1, doneThisMonth: 2, completionRate: 66.7 });
    const ab = await getTodoProgressBlock(admin, db, { now: NOW });
    expect(ab.totals.open).toBe(2);
    expect(ab.byRole.length).toBe(7);
    expect(ab.href).toBe("/todo");
  });
});
