import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { users, workItems } from "@/db/schema";
import type { SessionUser } from "@/server/core/dto";
import { createWorkItem, isWorkItemVisible, listWorkItems, resolveTodoVisibility } from "@/server/modules/todo/service";
import { getTodoProgressBlock, getTodoStats } from "@/server/modules/todo/stats";
import { createTestDb, type TestDb } from "../helpers/db";

const NOW = new Date("2026-09-15T02:00:00Z");

/**
 * D62 可见性谓词唯一权威：listWorkItems(all) / getTodoStats / getTodoProgressBlock 三处必须让同一用户看到同一集合。
 */
describe("todo 可见性：list / stats / 第 4 屏三处共用 resolveTodoVisibility", () => {
  let db: TestDb;
  let admin: SessionUser;
  let me: SessionUser; // roles [pmc, ops]，deptScope [pmc] → ops 责任项被裁掉
  let other: SessionUser;
  const ids: Record<string, number> = {};

  beforeAll(async () => {
    ({ db } = await createTestDb());
    const mk = async (name: string, roles: string[]): Promise<SessionUser> => {
      const [u] = await db.insert(users).values({ name, roles, isApprover: false }).returning();
      return { id: u.id, name: u.name, roles, isApprover: false };
    };
    admin = await mk("管理员", ["admin"]);
    me = { ...(await mk("双角色", ["pmc", "ops"])), deptScope: ["pmc"] };
    other = await mk("旁人", ["purchasing"]);
    const add = async (tag: string, input: Parameters<typeof createWorkItem>[0], actor: SessionUser) => {
      const r = await createWorkItem(input, actor, db, { now: NOW });
      ids[tag] = r.item.id;
    };
    // 全部 alert 来源（进 stats 分母）、无截止日、状态 open（进第 4 屏 open）
    await add("assignedToMe", { title: "指派给我", assigneeId: me.id, sourceKind: "alert", sourceRef: "v1" }, admin);
    await add("assignedByMe", { title: "我指派", assigneeId: other.id, sourceKind: "alert", sourceRef: "v2" }, admin);
    // Read-only visibility fixture models a historical assigner; new non-admin creates cannot claim system source.
    await db.update(workItems).set({ assignerId: me.id }).where(eq(workItems.id, ids.assignedByMe));
    await add("rolePmc", { title: "pmc 责任项", assigneeId: other.id, ownerRole: "pmc", sourceKind: "alert", sourceRef: "v3" }, admin);
    await add("roleOps", { title: "ops 责任项（deptScope 裁掉）", assigneeId: other.id, ownerRole: "ops", sourceKind: "alert", sourceRef: "v4" }, admin);
    await add("unrelated", { title: "无关", assigneeId: other.id, sourceKind: "alert", sourceRef: "v5" }, admin);
    await add("rolePurchasing", { title: "purchasing 责任项", assigneeId: admin.id, ownerRole: "purchasing", sourceKind: "alert", sourceRef: "v6" }, admin);
  });

  async function visibleSets(user: SessionUser) {
    const list = await listWorkItems({ view: "all", page: 1, pageSize: 100 }, user, db);
    const raw = await db.select({ id: workItems.id, assigneeId: workItems.assigneeId, assignerId: workItems.assignerId, createdBy: workItems.createdBy, ownerRole: workItems.ownerRole }).from(workItems);
    const predicate = raw.filter((r) => isWorkItemVisible(r, user)).map((r) => r.id);
    const stats = await getTodoStats({ groupBy: "person", fromMonth: "2026-09", toMonth: "2026-09", now: NOW }, user, db);
    const block = await getTodoProgressBlock(user, db, { now: NOW });
    return {
      list: list.rows.map((r) => r.id).sort((a, b) => a - b),
      predicate: predicate.sort((a, b) => a - b),
      statsTotal: stats.rows.reduce((n, r) => n + r.total, 0),
      blockOpen: block.totals.open,
      byRole: block.byRole.map((r) => r.role),
    };
  }

  it("受限用户（deptScope=[pmc]）：三处一致 = 指派给我 ∪ 我指派 ∪ pmc 责任项；ops 责任项与无关项不可见", async () => {
    expect(resolveTodoVisibility(me)).toEqual({ all: false, roleKeys: ["pmc"] });
    const v = await visibleSets(me);
    const expected = [ids.assignedToMe, ids.assignedByMe, ids.rolePmc].sort((a, b) => a - b);
    expect(v.list).toEqual(expected);
    expect(v.predicate).toEqual(expected);
    expect(v.statsTotal).toBe(expected.length);
    expect(v.blockOpen).toBe(expected.length);
    expect(v.byRole).toEqual(["pmc"]);
  });

  it("同一用户去掉 deptScope：ops 责任项回到三处集合（谓词只有一处，deptScope 裁剪对三处同时生效）", async () => {
    const unscoped: SessionUser = { ...me, deptScope: null };
    expect(resolveTodoVisibility(unscoped)).toEqual({ all: false, roleKeys: ["pmc", "ops"] });
    const v = await visibleSets(unscoped);
    const expected = [ids.assignedToMe, ids.assignedByMe, ids.rolePmc, ids.roleOps].sort((a, b) => a - b);
    expect(v.list).toEqual(expected);
    expect(v.predicate).toEqual(expected);
    expect(v.statsTotal).toBe(expected.length);
    expect(v.blockOpen).toBe(expected.length);
    expect(v.byRole.sort()).toEqual(["ops", "pmc"]);
  });

  it("admin：全量；旁人（purchasing，无范围）：自己相关 ∪ purchasing 责任项", async () => {
    const a = await visibleSets(admin);
    expect(a.list).toHaveLength(6);
    expect(a.predicate).toEqual(a.list);
    expect(a.statsTotal).toBe(6);
    expect(a.blockOpen).toBe(6);
    expect(a.byRole).toHaveLength(7);
    const o = await visibleSets(other);
    const expected = [ids.assignedByMe, ids.rolePmc, ids.roleOps, ids.unrelated, ids.rolePurchasing].sort((x, y) => x - y);
    expect(o.list).toEqual(expected);
    expect(o.predicate).toEqual(expected);
    expect(o.statsTotal).toBe(expected.length);
    expect(o.blockOpen).toBe(expected.length);
  });
});
