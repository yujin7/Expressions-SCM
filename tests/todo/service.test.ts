import { beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { auditLogs, notifications, users, workItems } from "@/db/schema";
import type { SessionUser } from "@/server/core/dto";
import {
  assignWorkItem,
  createWorkItem,
  listWorkItems,
  setWorkItemStatus,
  REOPEN_WINDOW_DAYS,
} from "@/server/modules/todo/service";
import { createTestDb, type TestDb } from "../helpers/db";

const DAY = 86_400_000;

describe("todo/service：创建/指派/状态机/指纹去重/reopen/可疑关闭/审计/通知", () => {
  let db: TestDb;
  let admin: SessionUser;
  let pmc: SessionUser;
  let pmc2: SessionUser;
  let ops: SessionUser;

  beforeAll(async () => {
    ({ db } = await createTestDb());
    const mk = async (name: string, roles: string[], unionId?: string): Promise<SessionUser> => {
      const [u] = await db.insert(users).values({ name, roles, isApprover: false, feishuUnionId: unionId ?? null }).returning();
      return { id: u.id, name: u.name, roles, isApprover: false };
    };
    admin = await mk("管理员", ["admin"]);
    pmc = await mk("计划A", ["pmc"], "on_pmc_a");
    pmc2 = await mk("计划B", ["pmc"]);
    ops = await mk("运营", ["ops"]);
  });

  it("手工创建：写 work_items + 审计 create + 站内定向通知（dedupeKey task:{id}:assigned）", async () => {
    const r = await createWorkItem({ title: "跟进供应商交期", assigneeId: pmc.id, ownerRole: "pmc", priority: "high", dueDate: "2026-09-10" }, admin, db);
    expect(r.created).toBe(true);
    expect(r.item.status).toBe("open");
    expect(r.item.assigneeName).toBe("计划A");
    const audits = await db.select().from(auditLogs).where(and(eq(auditLogs.entity, "work_item"), eq(auditLogs.entityId, r.item.id)));
    expect(audits.map((a) => a.action)).toEqual(["create"]);
    const [n] = await db.select().from(notifications).where(eq(notifications.dedupeKey, `task:${r.item.id}:assigned`));
    expect(n).toBeDefined();
    expect(n.channel).toBe("in_app");
    expect(n.userId).toBe(pmc.id);
    // 未配置飞书 → 不产生 feishu 行
    const fs = await db.select().from(notifications).where(eq(notifications.dedupeKey, `task:${r.item.id}:assigned:feishu`));
    expect(fs).toHaveLength(0);
  });

  it("自己给自己建的待办不通知", async () => {
    const r = await createWorkItem({ title: "自留", assigneeId: pmc.id }, pmc, db);
    const rows = await db.select().from(notifications).where(eq(notifications.dedupeKey, `task:${r.item.id}:assigned`));
    expect(rows).toHaveLength(0);
  });

  it("指纹去重：同 source_kind+source_ref 且未完成 → 返回既有项不新建", async () => {
    const a = await createWorkItem({ title: "告警 A", assigneeId: pmc.id, sourceKind: "alert", sourceRef: "1001" }, admin, db);
    const b = await createWorkItem({ title: "告警 A 再触发", assigneeId: pmc2.id, sourceKind: "alert", sourceRef: "1001" }, admin, db);
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.reopened).toBe(false);
    expect(b.item.id).toBe(a.item.id);
    expect(b.item.assigneeId).toBe(pmc.id); // 不改既有指派
    const all = await db.select().from(workItems).where(and(eq(workItems.sourceKind, "alert"), eq(workItems.sourceRef, "1001")));
    expect(all).toHaveLength(1);
  });

  it("7 天内同指纹再触发 → reopen（审计 reopen），超过 7 天 → 新建", async () => {
    const t0 = new Date("2026-08-01T02:00:00Z");
    const a = await createWorkItem({ title: "复核 R", assigneeId: pmc.id, sourceKind: "review", sourceRef: "77" }, admin, db, { now: t0 });
    // 完成于 t0+1 天（> 10 分钟，不可疑）
    const done = await setWorkItemStatus(a.item.id, "done", pmc, db, { now: new Date(t0.getTime() + DAY) });
    expect(done.status).toBe("done");
    expect(done.suspicious).toBe(false);
    // 3 天后再触发 → reopen
    const again = await createWorkItem({ title: "复核 R 再触发", assigneeId: pmc.id, sourceKind: "review", sourceRef: "77" }, admin, db, { now: new Date(t0.getTime() + 4 * DAY) });
    expect(again.created).toBe(false);
    expect(again.reopened).toBe(true);
    expect(again.item.id).toBe(a.item.id);
    expect(again.item.status).toBe("open");
    expect(again.item.completedAt).toBeNull();
    // 审阅修复：reopen 采用本次指派（旧责任人可能已离职）
    const swapped = await setWorkItemStatus(a.item.id, "done", pmc, db, { now: new Date(t0.getTime() + 4 * DAY + 60_000) });
    expect(swapped.status).toBe("done");
    const re2 = await createWorkItem({ title: "复核 R 换人", assigneeId: pmc2.id, ownerRole: "pmc", sourceKind: "review", sourceRef: "77" }, admin, db, { now: new Date(t0.getTime() + 4 * DAY + 120_000) });
    expect(re2.reopened).toBe(true);
    expect(re2.item.assigneeId).toBe(pmc2.id);
    await setWorkItemStatus(a.item.id, "open", pmc2, db, { now: new Date(t0.getTime() + 4 * DAY + 180_000) }).catch(() => undefined);
    const audits = await db.select().from(auditLogs).where(and(eq(auditLogs.entity, "work_item"), eq(auditLogs.entityId, a.item.id)));
    expect(audits.map((x) => x.action).slice(0, 5)).toEqual(["create", "complete", "reopen", "complete", "reopen"]);
    // 关闭后超过 7 天再触发 → 新建
    await setWorkItemStatus(a.item.id, "done", pmc, db, { now: new Date(t0.getTime() + 5 * DAY) });
    const later = await createWorkItem({ title: "复核 R 很久后", assigneeId: pmc.id, sourceKind: "review", sourceRef: "77" }, admin, db, { now: new Date(t0.getTime() + (5 + REOPEN_WINDOW_DAYS + 1) * DAY) });
    expect(later.created).toBe(true);
    expect(later.item.id).not.toBe(a.item.id);
  });

  it("创建后 <10 分钟即完成 → suspicious=true 并写入审计 after", async () => {
    const t0 = new Date("2026-09-01T01:00:00Z");
    const r = await createWorkItem({ title: "秒关", assigneeId: pmc.id, sourceKind: "alert", sourceRef: "2002" }, admin, db, { now: t0 });
    const done = await setWorkItemStatus(r.item.id, "done", pmc, db, { now: new Date(t0.getTime() + 3 * 60_000) });
    expect(done.suspicious).toBe(true);
    const [a] = await db.select().from(auditLogs).where(and(eq(auditLogs.entity, "work_item"), eq(auditLogs.entityId, r.item.id), eq(auditLogs.action, "complete")));
    expect((a.after as { suspicious: boolean }).suspicious).toBe(true);
  });

  it("状态机：done→in_progress 非法；无关人员 403；取消后可重开", async () => {
    const r = await createWorkItem({ title: "状态机", assigneeId: pmc.id, ownerRole: "pmc" }, admin, db);
    await expect(setWorkItemStatus(r.item.id, "done", ops, db)).rejects.toMatchObject({ status: 403 });
    await setWorkItemStatus(r.item.id, "in_progress", pmc2, db); // 同责任角色可操作
    await expect(setWorkItemStatus(r.item.id, "done", pmc, db).then((x) => setWorkItemStatus(x.id, "in_progress", pmc, db))).rejects.toMatchObject({ status: 409 });
    const cancelled = await setWorkItemStatus(r.item.id, "open", pmc, db).then((x) => setWorkItemStatus(x.id, "cancelled", pmc, db));
    expect(cancelled.status).toBe("cancelled");
    const reopened = await setWorkItemStatus(r.item.id, "open", pmc, db);
    expect(reopened.status).toBe("open");
  });

  it("改派：审计 assign、通知新责任人（task:{id}:reassigned）；已完成不可改派", async () => {
    const r = await createWorkItem({ title: "改派", assigneeId: pmc.id }, admin, db);
    const moved = await assignWorkItem(r.item.id, pmc2.id, admin, db);
    expect(moved.assigneeId).toBe(pmc2.id);
    const [n] = await db.select().from(notifications).where(eq(notifications.dedupeKey, `task:${r.item.id}:reassigned`));
    expect(n.userId).toBe(pmc2.id);
    await setWorkItemStatus(r.item.id, "done", pmc2, db);
    await expect(assignWorkItem(r.item.id, pmc.id, admin, db)).rejects.toMatchObject({ status: 409 });
  });

  it("列表：mine 只看指派给我；all 非 admin 只见我相关 + 本角色责任项；admin 全量", async () => {
    await createWorkItem({ title: "ops 自己的", assigneeId: ops.id, ownerRole: "ops" }, ops, db);
    const mineOps = await listWorkItems({ view: "mine", page: 1, pageSize: 50 }, ops, db);
    expect(mineOps.rows.every((x) => x.assigneeId === ops.id)).toBe(true);
    const allOps = await listWorkItems({ view: "all", page: 1, pageSize: 50 }, ops, db);
    expect(allOps.rows.every((x) => x.assigneeId === ops.id || x.assignerId === ops.id || x.createdBy === ops.id || x.ownerRole === "ops")).toBe(true);
    const allAdmin = await listWorkItems({ view: "all", page: 1, pageSize: 50 }, admin, db);
    expect(allAdmin.total).toBeGreaterThan(allOps.total);
    const byId = await listWorkItems({ view: "all", q: `#${allAdmin.rows[0].id}`, page: 1, pageSize: 50 }, admin, db);
    expect(byId.rows.map((x) => x.id)).toEqual([allAdmin.rows[0].id]);
  });
});
