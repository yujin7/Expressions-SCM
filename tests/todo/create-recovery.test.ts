import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { auditLogs, notifications, users, workItems } from "@/db/schema";
import type { SessionUser } from "@/server/core/dto";
import { writeAudit } from "@/server/core/audit";
import { createWorkItem, getWorkItemCreationResult, patchWorkItem } from "@/server/modules/todo/service";
import { GET, POST } from "@/app/api/todo/route";
import { createTestDb, type TestDb } from "../helpers/db";
const deps = vi.hoisted(() => ({ db: vi.fn(), user: vi.fn(), fail: false }));
vi.mock("@/db", async original => ({ ...await original<typeof import("@/db")>(), getDbAsync: deps.db }));
vi.mock("@/server/core/dto", async original => ({ ...await original<typeof import("@/server/core/dto")>(), getFreshSessionUser: deps.user }));
vi.mock("@/server/core/audit", async original => {
  const actual = await original<typeof import("@/server/core/audit")>();
  return { ...actual, writeAudit: async (...args: Parameters<typeof actual.writeAudit>) => { await actual.writeAudit(...args); if (deps.fail) throw Error("synthetic failure after creation audit"); } };
});
let db: TestDb, client: Awaited<ReturnType<typeof createTestDb>>["client"], actor: SessionUser, other: SessionUser;
beforeAll(async () => {
  ({ db, client } = await createTestDb()); deps.db.mockResolvedValue(db);
  const people = await db.insert(users).values([{ name: "合成创建人", roles: ["pmc"] }, { name: "合成其他管理员", roles: ["admin"] }]).returning();
  [actor, other] = people.map(u => ({ id: u.id, name: u.name, roles: u.roles, isApprover: false, sessionVersion: u.sessionVersion }));
});
afterAll(async () => { await client?.close(); });
const input = () => ({ requestId: randomUUID(), title: "合成采购跟进", detail: "原始依据完整保留", assigneeId: other.id, ownerRole: "pmc" as const, priority: "high" as const, dueDate: "2026-09-20", sourceRef: "PO-合成-001" });
const facts = async () => ({ tasks: await db.select().from(workItems), audits: await db.select().from(auditLogs), notices: await db.select().from(notifications) });
it("same request and UUID case replay one task/audit/outbox; a new request permits intentional identical work", async () => {
  const v = input(), first = await createWorkItem(v, actor, db), before = await facts();
  const replay = await createWorkItem({ ...v, requestId: v.requestId.toUpperCase() }, actor, db);
  expect(replay).toMatchObject({ created: false, reopened: false, item: { id: first.item.id } }); expect(await facts()).toEqual(before);
  expect((await createWorkItem({ ...v, requestId: randomUUID() }, actor, db)).item.id).not.toBe(first.item.id);
});
it("uses immutable original intent, not current assignee, state or mutable title; recovery does not notify again", async () => {
  const v = input(), first = await createWorkItem(v, actor, db);
  await patchWorkItem(first.item.id, { assigneeId: actor.id, status: "done" }, actor, db);
  await db.update(workItems).set({ title: "后来更正的标题", detail: "后来更新的明细" }).where(eq(workItems.id, first.item.id));
  await db.update(users).set({ active: false }).where(eq(users.id, other.id));
  try {
    const before = await facts(); const replay = await createWorkItem(v, actor, db);
    expect(replay.item).toMatchObject({ id: first.item.id, status: "done", title: "后来更正的标题", assigneeId: actor.id });
    const result = await getWorkItemCreationResult(v.requestId, actor, db);
    expect(result.originalIntent).toMatchObject({ title: v.title, detail: v.detail, assigneeId: other.id }); expect(await facts()).toEqual(before);
  } finally { await db.update(users).set({ active: true }).where(eq(users.id, other.id)); }
});
it.each(["title", "detail", "assigneeId", "ownerRole", "priority", "dueDate", "sourceRef"] as const)("same key changed %s conflicts without effects", async field => {
  const v = input(); await createWorkItem(v, actor, db); const before = await facts();
  const changed = { title: "不同标题", detail: "不同明细", assigneeId: actor.id, ownerRole: "ops", priority: "normal", dueDate: "2026-09-21", sourceRef: "另一引用" };
  await expect(createWorkItem({ ...v, [field]: changed[field] }, actor, db)).rejects.toMatchObject({ status: 409 }); expect(await facts()).toEqual(before);
});
it("current actor and original writer are enforced for missing, found and replayed results", async () => {
  const v = input(); await createWorkItem(v, actor, db);
  await expect(getWorkItemCreationResult(v.requestId, other, db)).rejects.toMatchObject({ status: 403 });
  await expect(createWorkItem(v, other, db)).rejects.toMatchObject({ status: 403 });
  await db.update(users).set({ active: false }).where(eq(users.id, actor.id));
  try { for (const key of [v.requestId, randomUUID()]) await expect(getWorkItemCreationResult(key, actor, db)).rejects.toMatchObject({ status: 403 });
    await expect(createWorkItem(v, actor, db)).rejects.toMatchObject({ status: 403 }); }
  finally { await db.update(users).set({ active: true }).where(eq(users.id, actor.id)); }
  await expect(getWorkItemCreationResult(v.requestId, { ...actor, sessionVersion: -1 }, db)).rejects.toMatchObject({ status: 401 });
});
it("database unique receipt rejects a bypass duplicate and failed audit rolls back task and notifications", async () => {
  const v = input(), first = await createWorkItem(v, actor, db), before = await facts();
  await expect(writeAudit(db, { userId: actor.id, entity: "work_item", entityId: first.item.id, action: "create", after: { requestId: v.requestId.toUpperCase() } })).rejects.toThrow();
  expect(await facts()).toEqual(before); deps.fail = true;
  const failed = input(); try { await expect(createWorkItem(failed, actor, db)).rejects.toThrow("synthetic failure"); } finally { deps.fail = false; }
  expect(await facts()).toEqual(before); expect((await getWorkItemCreationResult(failed.requestId, actor, db)).itemId).toBeNull();
  expect((await createWorkItem(failed, actor, db)).created).toBe(true);
});
it("HTTP requires a valid key, keeps legitimate manual references, normalizes forged sources, and provides strict no-store lookup", async () => {
  deps.user.mockResolvedValue(actor); const v = input();
  const post = (body: unknown) => POST(new NextRequest("http://localhost/api/todo", { method: "POST", body: JSON.stringify(body) }));
  for (const bad of [null, [], { ...v, requestId: undefined }, { ...v, requestId: "bad" }, { ...v, unexpected: true }]) expect((await post(bad)).status).toBe(400);
  const res = await post(v); expect(res.status).toBe(201); const body = await res.json(); expect(body).toMatchObject({ requestId: v.requestId, created: true });
  const get = await GET(new NextRequest(`http://localhost/api/todo?mode=create-result&requestId=${v.requestId}`));
  expect(get.headers.get("cache-control")).toContain("no-store"); expect(await get.json()).toMatchObject({ itemId: body.itemId, originalIntent: { sourceRef: v.sourceRef } });
  expect((await post(v)).status).toBe(200);
  const spoof = await post({ ...input(), sourceKind: "alert" }); expect(spoof.status).toBe(201); const created = await spoof.json();
  expect((await db.select().from(workItems).where(eq(workItems.id, created.itemId)))[0]).toMatchObject({ sourceKind: "manual", sourceRef: null });
  for (const q of ["mode=create-result", `mode=create-result&requestId=${v.requestId}&page=1`, `mode=create-result&requestId=${v.requestId}&requestId=${v.requestId}`, "mode=unknown"]) expect((await GET(new NextRequest(`http://localhost/api/todo?${q}`))).status).toBe(400);
});
