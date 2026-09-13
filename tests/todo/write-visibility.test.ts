import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, like } from "drizzle-orm";
import { auditLogs, notifications, users, userDataScopes, workItems } from "@/db/schema";
import { deptKeyToTargetId } from "@/server/core/data-scope";
import type { SessionUser } from "@/server/core/dto";
import { assignWorkItem, listWorkItems, setWorkItemStatus, type WorkItemStatus } from "@/server/modules/todo/service";
import { GET } from "@/app/api/todo/[id]/route";
import { createTestDb, type TestDb } from "../helpers/db";

// Authentication is synthetic; route visibility, services, audit and notification enqueue remain real.
const dependencies = vi.hoisted(() => ({ getFreshSessionUser: vi.fn(), getDbAsync: vi.fn() }));
vi.mock("@/db", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/db")>(), getDbAsync: dependencies.getDbAsync,
}));
vi.mock("@/server/core/dto", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/server/core/dto")>(), getFreshSessionUser: dependencies.getFreshSessionUser,
}));

const NOW = new Date("2026-09-06T05:00:00Z");
type Person = "restricted" | "unscoped" | "admin" | "unrelated" | "owner" | "destination";

describe("todo 写权限必须服从实际读可见性（D62）", () => {
  let db: TestDb;
  let client: Awaited<ReturnType<typeof createTestDb>>["client"] | undefined;
  const people = {} as Record<Person, SessionUser>;

  beforeAll(async () => {
    ({ db, client } = await createTestDb());
    dependencies.getDbAsync.mockResolvedValue(db);
    const seed = async (key: Person, roles: string[], deptScope?: string[] | null) => {
      const [user] = await db.insert(users).values({ name: `合成-${key}`, roles, active: true }).returning();
      people[key] = { id: user.id, name: user.name, roles, deptScope, isApprover: false };
      if (deptScope?.length) await db.insert(userDataScopes).values(deptScope.map(role => ({ userId: user.id, scopeKind: "dept", targetId: deptKeyToTargetId(role), createdBy: user.id })));
    };
    await seed("restricted", ["pmc", "ops"], ["pmc"]);
    await seed("unscoped", ["ops"], null);
    await seed("admin", ["admin"], ["pmc"]);
    await seed("unrelated", ["finance"], null);
    await seed("owner", ["ops"], null);
    await seed("destination", ["ops"], null);
  });
  afterAll(async () => { await client?.close(); });

  async function item(overrides: Partial<typeof workItems.$inferInsert> = {}) {
    const [row] = await db.insert(workItems).values({
      title: "合成部门隔离待办", assigneeId: people.owner.id, assignerId: people.owner.id,
      createdBy: people.owner.id, ownerRole: "ops", status: "open", sourceKind: "manual",
      createdAt: new Date("2026-09-01T00:00:00Z"), updatedAt: new Date("2026-09-01T00:00:00Z"),
      ...overrides,
    }).returning();
    return row;
  }

  async function snapshot(id: number) {
    return {
      item: await db.select().from(workItems).where(eq(workItems.id, id)),
      audit: await db.select().from(auditLogs).where(and(eq(auditLogs.entity, "work_item"), eq(auditLogs.entityId, id))).orderBy(auditLogs.id),
      notifications: await db.select().from(notifications).where(like(notifications.dedupeKey, `task:${id}:%`)).orderBy(notifications.id),
    };
  }

  async function expectVisibility(id: number, actor: SessionUser, visible: boolean) {
    const list = await listWorkItems({ view: "all", q: `#${id}`, page: 1, pageSize: 20 }, actor, db);
    expect(list.rows.map((row) => row.id)).toEqual(visible ? [id] : []);
    expect(list.total).toBe(visible ? 1 : 0);
    dependencies.getFreshSessionUser.mockResolvedValue(actor);
    const response = await GET(new NextRequest(`http://localhost/api/todo/${id}`), { params: Promise.resolve({ id: String(id) }) });
    expect(response.status).toBe(visible ? 200 : 404);
    if (visible) expect((await response.json()).id).toBe(id);
  }

  async function expectDeniedUnchanged(id: number, write: () => Promise<unknown>, status = 403) {
    const before = await snapshot(id);
    let error: unknown;
    try { await write(); } catch (caught) { error = caught; }
    expect.soft(error).toMatchObject({ status });
    expect(await snapshot(id)).toEqual(before);
  }

  it.each<WorkItemStatus>(["in_progress", "done", "cancelled", "open"])("隐藏的 ops 待办不得改为 %s（含同状态无操作）", async (status) => {
    const row = await item();
    await expectVisibility(row.id, people.restricted, false);
    await expectDeniedUnchanged(row.id, () => setWorkItemStatus(row.id, status, people.restricted, db, { now: NOW }));
  });

  it.each(["destination", "owner"] as const)("隐藏待办不得改派给 %s（含相同责任人无操作）", async (target) => {
    const row = await item();
    await expectVisibility(row.id, people.restricted, false);
    await expectDeniedUnchanged(row.id, () => assignWorkItem(row.id, people[target].id, people.restricted, db, { now: NOW }));
  });

  it.each(["done", "cancelled"] as const)("隐藏的 %s 终态也不得重开或改派", async (status) => {
    const row = await item({ status, completedAt: status === "done" ? new Date("2026-09-02T00:00:00Z") : null });
    await expectVisibility(row.id, people.restricted, false);
    await expectDeniedUnchanged(row.id, () => setWorkItemStatus(row.id, "open", people.restricted, db, { now: NOW }));
    await expectDeniedUnchanged(row.id, () => assignWorkItem(row.id, people.destination.id, people.restricted, db, { now: NOW }));
  });

  it.each(["assigneeId", "assignerId", "createdBy"] as const)("%s 直接关系仍允许跨部门读取、状态变更和改派", async (relation) => {
    const row = await item({ [relation]: people.restricted.id });
    await expectVisibility(row.id, people.restricted, true);
    expect(await setWorkItemStatus(row.id, "in_progress", people.restricted, db, { now: NOW })).toMatchObject({ status: "in_progress" });
    expect(await assignWorkItem(row.id, people.destination.id, people.restricted, db, { now: NOW })).toMatchObject({ assigneeId: people.destination.id });
    const effects = await snapshot(row.id);
    expect(effects.audit.map((event) => event.action)).toEqual(["update", "assign"]);
    expect(effects.notifications).toHaveLength(1);
    expect(effects.notifications[0]).toMatchObject({ channel: "in_app", userId: people.destination.id });
  });

  it.each(["admin", "unscoped"] as const)("%s 保留全量/未限制同角色写权限", async (key) => {
    const row = await item();
    await expectVisibility(row.id, people[key], true);
    expect(await setWorkItemStatus(row.id, "in_progress", people[key], db, { now: NOW })).toMatchObject({ status: "in_progress" });
    expect(await assignWorkItem(row.id, people.destination.id, people[key], db, { now: NOW })).toMatchObject({ assigneeId: people.destination.id });
  });

  it("无关系且无责任角色的用户仍拒绝，不产生审计或通知", async () => {
    const row = await item();
    await expectVisibility(row.id, people.unrelated, false);
    await expectDeniedUnchanged(row.id, () => setWorkItemStatus(row.id, "done", people.unrelated, db, { now: NOW }));
    await expectDeniedUnchanged(row.id, () => assignWorkItem(row.id, people.destination.id, people.unrelated, db, { now: NOW }));
  });

  it.each(["done", "cancelled"] as const)("可见的 %s 不能直接改派，但直接关系可重开后改派", async (status) => {
    const row = await item({ status, createdBy: people.restricted.id, completedAt: status === "done" ? new Date("2026-09-02T00:00:00Z") : null });
    await expectVisibility(row.id, people.restricted, true);
    await expectDeniedUnchanged(row.id, () => assignWorkItem(row.id, people.destination.id, people.restricted, db, { now: NOW }), 409);
    expect(await setWorkItemStatus(row.id, "open", people.restricted, db, { now: NOW })).toMatchObject({ status: "open", completedAt: null });
    expect(await assignWorkItem(row.id, people.destination.id, people.restricted, db, { now: NOW })).toMatchObject({ assigneeId: people.destination.id });
  });
});
