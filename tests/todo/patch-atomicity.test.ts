import { NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, like } from "drizzle-orm";
import { auditLogs, notifications, users, workItems } from "@/db/schema";
import type { SessionUser } from "@/server/core/dto";
import type { WorkItemStatus } from "@/server/modules/todo/service";
import { PATCH } from "@/app/api/todo/[id]/route";
import { createTestDb, type TestDb } from "../helpers/db";

// Only session/DB entry and a narrowly selected audit fault are synthetic.
// The actual route, item writes, successful audit writes and notification enqueue execute.
const dependencies = vi.hoisted(() => ({
  failComplete: false, getDbAsync: vi.fn(), getFreshSessionUser: vi.fn(),
}));
vi.mock("@/db", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/db")>(), getDbAsync: dependencies.getDbAsync,
}));
vi.mock("@/server/core/dto", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/server/core/dto")>(),
  getFreshSessionUser: dependencies.getFreshSessionUser,
}));
vi.mock("@/server/core/audit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/core/audit")>();
  return {
    ...actual,
    writeAudit: async (...args: Parameters<typeof actual.writeAudit>) => {
      if (dependencies.failComplete && args[1].action === "complete") {
        throw new Error("synthetic complete audit failure");
      }
      return actual.writeAudit(...args);
    },
  };
});

describe("同一次待办 PATCH 的改派与状态变更必须原子提交", () => {
  let db: TestDb;
  let client: Awaited<ReturnType<typeof createTestDb>>["client"] | undefined;
  let actor: SessionUser;
  let originalAssignee: number;
  let newAssignee: number;

  beforeAll(async () => {
    ({ db, client } = await createTestDb());
    dependencies.getDbAsync.mockResolvedValue(db);
    const seeded = await db.insert(users).values([
      { name: "合成管理员", roles: ["admin"], active: true },
      { name: "合成原责任人", roles: ["ops"], active: true },
      { name: "合成新责任人", roles: ["ops"], active: true },
    ]).returning();
    actor = { id: seeded[0].id, name: seeded[0].name, roles: ["admin"], isApprover: false };
    originalAssignee = seeded[1].id;
    newAssignee = seeded[2].id;
    dependencies.getFreshSessionUser.mockResolvedValue(actor);
  });
  afterAll(async () => { await client?.close(); });

  async function seedItem(status: WorkItemStatus = "open") {
    const [row] = await db.insert(workItems).values({
      title: "合成原子改派完成", assigneeId: originalAssignee, assignerId: actor.id,
      createdBy: actor.id, ownerRole: "ops", status, sourceKind: "manual",
      createdAt: new Date("2026-09-01T00:00:00Z"), updatedAt: new Date("2026-09-01T00:00:00Z"),
      completedAt: status === "done" ? new Date("2026-09-01T01:00:00Z") : null,
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

  function patch(id: number, body: { assigneeId?: number; status?: WorkItemStatus; note?: string } = {
    assigneeId: newAssignee, status: "done", note: "合成联合操作",
  }) {
    return PATCH(new NextRequest(`http://localhost/api/todo/${id}`, {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...body, requestId: randomUUID(), expectedVersion: 1 }),
    }), { params: Promise.resolve({ id: String(id) }) });
  }

  it("完成审计失败时，改派、状态、审计与通知全部保持请求前状态", async () => {
    const row = await seedItem();
    const before = await snapshot(row.id);
    dependencies.failComplete = true;
    let response: Response;
    try {
      response = await patch(row.id);
    } finally {
      dependencies.failComplete = false;
    }
    expect(response.status).toBe(500);
    expect(await snapshot(row.id)).toEqual(before);
  });

  it("无故障时精确保留改派和完成两条审计及一次站内通知", async () => {
    const row = await seedItem();
    const response = await patch(row.id);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: row.id, assigneeId: newAssignee, status: "done" });
    const after = await snapshot(row.id);
    expect(after.item[0]).toMatchObject({ assigneeId: newAssignee, status: "done" });
    expect(after.item[0].completedAt).toBeInstanceOf(Date);
    expect(after.audit.map((event) => event.action)).toEqual(["assign", "complete"]);
    expect(after.audit[0]).toMatchObject({ before: { assigneeId: originalAssignee }, after: { assigneeId: newAssignee } });
    expect(after.audit[1]).toMatchObject({ before: { status: "open" }, after: { status: "done" } });
    expect(after.notifications).toHaveLength(1);
    const eventId = (after.audit[0].after as { notificationEventId: string }).notificationEventId;
    expect(eventId).toMatch(/^[0-9a-f-]{36}$/);
    expect(after.notifications[0]).toMatchObject({ userId: newAssignee, channel: "in_app", dedupeKey: `task:${row.id}:reassigned:${eventId}` });
  });

  it("通知入队数据库失败返回 500，而非返回已完成；联合改派/完成/审计一起回滚", async () => {
    const row = await seedItem();
    const before = await snapshot(row.id);
    await client!.exec(`
      CREATE FUNCTION test_patch_outbox_failure() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'synthetic patch outbox failure'; END $$;
      CREATE TRIGGER test_patch_outbox_failure BEFORE INSERT ON notifications
      FOR EACH ROW EXECUTE FUNCTION test_patch_outbox_failure();
    `);
    let response: Response;
    try {
      response = await patch(row.id);
    } finally {
      await client!.exec("DROP TRIGGER test_patch_outbox_failure ON notifications; DROP FUNCTION test_patch_outbox_failure();");
    }
    expect(response.status).toBe(500);
    expect(await snapshot(row.id)).toEqual(before);
  });

  it.each(["done", "cancelled"] as const)("%s 终态不能用联合改派与重开绕过改派限制，拒绝后无副作用", async (status) => {
    const row = await seedItem(status);
    const before = await snapshot(row.id);
    const response = await patch(row.id, { assigneeId: newAssignee, status: "open", note: "合成终态联合请求" });
    expect(response.status).toBe(409);
    expect(await snapshot(row.id)).toEqual(before);
  });

  it.each(["open", "in_progress"] as const)("%s 同责任人与同状态联合 noop 只保留原回执，不改时间或通知", async (status) => {
    const row = await seedItem(status);
    const before = await snapshot(row.id);
    const response = await patch(row.id, { assigneeId: originalAssignee, status, note: "noop 不单独落备注" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      id: row.id, assigneeId: originalAssignee, status,
      createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(), completedAt: null,
    });
    const after = await snapshot(row.id);
    expect(after.item).toEqual(before.item);
    expect(after.notifications).toEqual(before.notifications);
    expect(after.audit).toHaveLength(before.audit.length + 1);
    expect(after.audit.at(-1)).toMatchObject({ action: "update", isStateChange: false, after: { mutationResult: { version: 1, status } } });
  });

  it.each([
    ["done", "cancelled"],
    ["cancelled", "done"],
  ] as const)("非法终态流转 %s → %s 返回 409，保留全部事实与副作用", async (from, to) => {
    // Every transition from open is valid; status-only isolates the actual transition
    // guard instead of letting the terminal-assignment guard reject first.
    const row = await seedItem(from);
    const before = await snapshot(row.id);
    const response = await patch(row.id, { status: to });
    expect(response.status).toBe(409);
    expect(await snapshot(row.id)).toEqual(before);
  });
});
