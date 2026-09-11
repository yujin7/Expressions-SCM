/**
 * 待办统计取消细分（闭环审计 #9 + 红队审计 A7）：来源告警被引擎自动关闭（autoResolved）而取消
 * vs 来源告警被**人工**关闭而取消 vs 直接取消待办；宽/严两种完成率并列——
 * 等看门狗关掉告警不算完成，把来源告警按「不处理/误报」关掉也不算完成。
 */
import { beforeAll, describe, expect, it } from "vitest";
import { systemAlerts, users } from "@/db/schema";
import type { SessionUser } from "@/server/core/dto";
import { createWorkItem, setWorkItemStatus } from "@/server/modules/todo/service";
import { getTodoStats, TODO_STATS_CALIBER } from "@/server/modules/todo/stats";
import { createTestDb, type TestDb } from "../helpers/db";

const T0 = new Date("2026-09-02T02:00:00Z");
const NOW = new Date("2026-09-15T02:00:00Z");
const DAY = 86_400_000;

describe("todo/stats：cancelled 拆分 + 严口径完成率", () => {
  let db: TestDb;
  let admin: SessionUser;
  let pmc: SessionUser;

  beforeAll(async () => {
    ({ db } = await createTestDb());
    const mk = async (name: string, roles: string[]): Promise<SessionUser> => {
      const [u] = await db.insert(users).values({ name, roles, isApprover: false }).returning();
      return { id: u.id, name: u.name, roles, isApprover: false };
    };
    admin = await mk("管理员", ["admin"]);
    pmc = await mk("计划", ["pmc"]);
    const [auto] = await db.insert(systemAlerts).values({ category: "inventory_cover", title: "引擎自动关闭", status: "resolved", autoResolved: true, resolvedAt: T0 }).returning();
    const [manual] = await db.insert(systemAlerts).values({ category: "inventory_cover", title: "人工关闭", status: "resolved", autoResolved: false, resolvedAt: T0 }).returning();

    const w1 = await createWorkItem({ title: "来源自动关闭", assigneeId: pmc.id, ownerRole: "pmc", sourceKind: "alert", sourceRef: String(auto.id) }, admin, db, { now: T0 });
    await setWorkItemStatus(w1.item.id, "cancelled", admin, db, { now: new Date(T0.getTime() + DAY), note: "来源告警已关闭，自动取消" });
    const w2 = await createWorkItem({ title: "来源人工关闭", assigneeId: pmc.id, ownerRole: "pmc", sourceKind: "alert", sourceRef: String(manual.id) }, admin, db, { now: T0 });
    await setWorkItemStatus(w2.item.id, "cancelled", admin, db, { now: new Date(T0.getTime() + DAY), note: "来源告警已关闭，自动取消" });
    const w3 = await createWorkItem({ title: "复核项人工取消", assigneeId: pmc.id, ownerRole: "pmc", sourceKind: "review", sourceRef: "7" }, admin, db, { now: T0 });
    await setWorkItemStatus(w3.item.id, "cancelled", pmc, db, { now: new Date(T0.getTime() + DAY) });
    const w4 = await createWorkItem({ title: "真完成", assigneeId: pmc.id, ownerRole: "pmc", sourceKind: "alert", sourceRef: "999", dueDate: "2026-09-10" }, admin, db, { now: T0 });
    await setWorkItemStatus(w4.item.id, "done", pmc, db, { now: new Date(T0.getTime() + 2 * DAY) });
    await createWorkItem({ title: "未完成", assigneeId: pmc.id, ownerRole: "pmc", sourceKind: "alert", sourceRef: "998" }, admin, db, { now: T0 });
  });

  it("取消拆三桶：来源自动关闭 1 / 来源人工关闭 1 / 直接取消待办 1；宽口径 1/2=50%", async () => {
    const s = await getTodoStats({ groupBy: "person", fromMonth: "2026-09", toMonth: "2026-09", now: NOW }, admin, db);
    const row = s.rows.find((r) => r.groupKey === String(pmc.id));
    expect(row).toMatchObject({
      total: 5, done: 1, cancelled: 3,
      cancelledBySourceClose: 1, cancelledBySourceManualClose: 1, cancelledByHuman: 1,
    });
    expect(row?.completionRate).toBe(50);
    expect(s.caliber).toBe(TODO_STATS_CALIBER);
    expect(s.caliber).toContain("完成率（严）");
  });

  it("红队 A7：把来源告警人工关掉不再是完成率的逃生口——严口径分母 = 5 − 1（只减直接取消），1/4 = 25%", async () => {
    const s = await getTodoStats({ groupBy: "person", fromMonth: "2026-09", toMonth: "2026-09", now: NOW }, admin, db);
    const row = s.rows.find((r) => r.groupKey === String(pmc.id));
    // 修复前：来源人工关闭并进 cancelledByHuman → 严口径分母 5 − 2 = 3 → 33.3%（关一条告警就把完成率抬 8 个点）
    expect(row?.completionRateStrict).toBe(25);
    expect(TODO_STATS_CALIBER).toContain("或人工关闭");
    expect(TODO_STATS_CALIBER).toContain("逃生口");
  });
});
