import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { auditLogs, notifications, users, workItems } from "@/db/schema";
import type { SessionUser } from "@/server/core/dto";
import { writeAudit } from "@/server/core/audit";
import { listWorkItemHistory } from "@/server/modules/todo/history";
import { cancelWorkItemMutation, createWorkItem, getWorkItemMutationResult, patchWorkItem } from "@/server/modules/todo/service";
import { GET, PATCH, POST } from "@/app/api/todo/[id]/route";
import { createTestDb, type TestDb } from "../helpers/db";
const deps = vi.hoisted(() => ({ db: vi.fn(), user: vi.fn(), fail: false }));
vi.mock("@/db", async original => ({ ...await original<typeof import("@/db")>(), getDbAsync: deps.db }));
vi.mock("@/server/core/dto", async original => ({ ...await original<typeof import("@/server/core/dto")>(), getFreshSessionUser: deps.user }));
vi.mock("@/server/core/audit", async original => {
  const actual = await original<typeof import("@/server/core/audit")>();
  return { ...actual, writeAudit: async (...args: Parameters<typeof actual.writeAudit>) => { await actual.writeAudit(...args); if (deps.fail) throw Error("synthetic mutation audit failure"); } };
});
let db: TestDb, client: Awaited<ReturnType<typeof createTestDb>>["client"], actor: SessionUser, other: SessionUser;
beforeAll(async () => {
  ({ db, client } = await createTestDb()); deps.db.mockResolvedValue(db);
  const people = await db.insert(users).values([{ name: "合成操作者", roles: ["pmc"] }, { name: "合成管理员", roles: ["admin"] }]).returning();
  [actor, other] = people.map(u => ({ id: u.id, name: u.name, roles: u.roles, isApprover: false, sessionVersion: u.sessionVersion }));
});
afterAll(async () => { await client?.close(); });
const task = async () => (await createWorkItem({ title: "合成状态恢复", assigneeId: actor.id }, actor, db)).item;
const facts = async () => ({ tasks: await db.select().from(workItems), audits: await db.select().from(auditLogs), notices: await db.select().from(notifications) });
const cancellation = (row: { version: number }) => ({ mode: "cancel-mutation" as const, requestId: randomUUID(), expectedVersion: row.version, status: "done" as const, assigneeId: null, note: null });
it("cancellation fences the original key durably without changing task, version, timestamp or notifications", async () => {
  const row = await task(), input = cancellation(row), before = await facts();
  const saved = await cancelWorkItemMutation(row.id, input, actor, db), after = await facts();
  expect(saved).toMatchObject({ receipt: { cancelled: true, originalResult: { status: "open", version: 1 } }, current: { status: "open", version: 1 } });
  expect(after.tasks).toEqual(before.tasks); expect(after.notices).toEqual(before.notices); expect(after.audits).toHaveLength(before.audits.length + 1);
  expect(await cancelWorkItemMutation(row.id, { ...input, requestId: input.requestId.toUpperCase() }, actor, db)).toEqual(saved);
  expect(await getWorkItemMutationResult(row.id, input.requestId, actor, db)).toEqual(saved);
  expect((await listWorkItemHistory(row.id, {}, actor, db)).rows[0]).toMatchObject({ action: "mutation_cancelled", status: null, assigneeId: null, requestId: null });
  const patch = { requestId: input.requestId, expectedVersion: input.expectedVersion, status: input.status, note: input.note };
  await expect(patchWorkItem(row.id, patch, actor, db)).rejects.toMatchObject({ status: 409 }); expect(await facts()).toEqual(after);
  // A deliberate new action uses a new key and current version, rather than reusing the cancelled one.
  expect(await patchWorkItem(row.id, { ...patch, requestId: randomUUID() }, actor, db)).toMatchObject({ status: "done", version: 2 });
  expect((await getWorkItemMutationResult(row.id, input.requestId, actor, db)).receipt).toEqual(saved.receipt);
});
it("cancellation after committed save returns the original save, never an undo", async () => {
  const row = await task(), input = cancellation(row);
  const saved = await patchWorkItem(row.id, { requestId: input.requestId, expectedVersion: 1, status: "done" }, actor, db), before = await facts();
  const result = await cancelWorkItemMutation(row.id, input, actor, db);
  expect(result.receipt).toEqual(saved.mutationReceipt); expect(result.receipt?.cancelled).toBeUndefined(); expect(await facts()).toEqual(before);
});
it("stale missing request is obsolete, not a fabricated cancellation; future version is rejected", async () => {
  const row = await task(), input = cancellation(row);
  await patchWorkItem(row.id, { status: "in_progress" }, actor, db); const before = await facts();
  expect(await cancelWorkItemMutation(row.id, input, actor, db)).toMatchObject({ receipt: null, current: { version: 2 } });
  await expect(cancelWorkItemMutation(row.id, { ...input, expectedVersion: 3 }, actor, db)).rejects.toMatchObject({ status: 409 }); expect(await facts()).toEqual(before);
});
it.each(["status", "assigneeId", "note", "expectedVersion"] as const)("cancelled key rejects changed %s and other actor/task ownership", async field => {
  const row = await task(), another = await task(), input = cancellation(row);
  await cancelWorkItemMutation(row.id, input, actor, db); const before = await facts();
  const changes = { status: "in_progress", assigneeId: other.id, note: "改变内容", expectedVersion: 2 };
  await expect(cancelWorkItemMutation(row.id, { ...input, [field]: changes[field] }, actor, db)).rejects.toMatchObject({ status: 409 });
  await expect(cancelWorkItemMutation(row.id, input, other, db)).rejects.toMatchObject({ status: 403 });
  await expect(cancelWorkItemMutation(another.id, input, actor, db)).rejects.toMatchObject({ status: 409 }); expect(await facts()).toEqual(before);
});
it("cancellation audit failure rolls back the fence and preserves ability to retry", async () => {
  const row = await task(), input = cancellation(row), before = await facts(); deps.fail = true;
  try { await expect(cancelWorkItemMutation(row.id, input, actor, db)).rejects.toThrow("synthetic mutation audit failure"); } finally { deps.fail = false; }
  expect(await facts()).toEqual(before); expect((await getWorkItemMutationResult(row.id, input.requestId, actor, db)).receipt).toBeNull();
  expect((await cancelWorkItemMutation(row.id, input, actor, db)).receipt?.cancelled).toBe(true);
});
it("cancellation rechecks current actor/session/scope, without requiring the old target to remain active", async () => {
  const row = await task(), input = { ...cancellation(row), assigneeId: other.id };
  await db.update(users).set({ active: false }).where(eq(users.id, actor.id));
  try { await expect(cancelWorkItemMutation(row.id, input, actor, db)).rejects.toMatchObject({ status: 403 }); }
  finally { await db.update(users).set({ active: true }).where(eq(users.id, actor.id)); }
  await expect(cancelWorkItemMutation(row.id, input, { ...actor, sessionVersion: -1 }, db)).rejects.toMatchObject({ status: 401 });
  const [outsider] = await db.insert(users).values({ name: "合成范围外取消", roles: ["ops"] }).returning();
  await expect(cancelWorkItemMutation(row.id, input, { ...actor, id: outsider.id, sessionVersion: outsider.sessionVersion }, db)).rejects.toMatchObject({ status: 404 });
  await db.update(users).set({ active: false }).where(eq(users.id, other.id));
  try { expect((await cancelWorkItemMutation(row.id, input, actor, db)).receipt?.cancelled).toBe(true); }
  finally { await db.update(users).set({ active: true }).where(eq(users.id, other.id)); }
});
it("POST only accepts complete cancellation intent and returns a private durable receipt", async () => {
  deps.user.mockResolvedValue(actor); const row = await task(), input = cancellation(row), ctx = { params: Promise.resolve({ id: String(row.id) }) };
  const post = (body: unknown, query = "") => POST(new NextRequest(`http://localhost/api/todo/${row.id}${query}`, { method: "POST", body: JSON.stringify(body) }), ctx);
  for (const body of [null, [], { ...input, mode: "cancel-task" }, { ...input, requestId: undefined }, { ...input, expectedVersion: undefined }, { ...input, status: undefined }, { ...input, note: undefined }, { ...input, extra: true }]) expect((await post(body)).status).toBe(400);
  expect((await post(input, "?mode=cancel-mutation")).status).toBe(400);
  const response = await post(input); expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toContain("no-store");
  expect(await response.json()).toMatchObject({ receipt: { cancelled: true }, current: { version: 1, status: "open" } });
});
it("replays immutable completion receipt after reopening without completing again", async () => {
  const row = await task(), input = { requestId: randomUUID(), expectedVersion: row.version, status: "done" as const, note: "合成结果依据" };
  const saved = await patchWorkItem(row.id, input, actor, db);
  expect(saved).toMatchObject({ version: 2, status: "done", replayed: false, mutationReceipt: { originalIntent: { expectedVersion: 1, status: "done", note: input.note }, originalResult: { status: "done", version: 2 } } });
  await patchWorkItem(row.id, { status: "open" }, actor, db);
  const before = await facts(), replay = await patchWorkItem(row.id, { ...input, requestId: input.requestId.toUpperCase() }, actor, db);
  expect(replay).toMatchObject({ status: "open", version: 3, replayed: true, mutationReceipt: saved.mutationReceipt });
  const found = await getWorkItemMutationResult(row.id, input.requestId, actor, db);
  expect(found).toMatchObject({ receipt: saved.mutationReceipt, current: { status: "open", version: 3 } }); expect(await facts()).toEqual(before);
});
it("fresh key with stale version rejects, including state changed away and back in the same millisecond", async () => {
  const row = await task(), now = new Date("2026-09-13T01:00:00.000Z");
  await patchWorkItem(row.id, { status: "in_progress" }, actor, db, { now });
  await patchWorkItem(row.id, { status: "open" }, actor, db, { now });
  const before = await facts();
  await expect(patchWorkItem(row.id, { requestId: randomUUID(), expectedVersion: row.version, status: "done" }, actor, db)).rejects.toMatchObject({ status: 409 });
  expect(await facts()).toEqual(before);
});
it("successful no-op consumes its original key but does not change version or updatedAt", async () => {
  const row = await task(), input = { requestId: randomUUID(), expectedVersion: row.version, status: "open" as const };
  const saved = await patchWorkItem(row.id, input, actor, db);
  expect(saved).toMatchObject({ version: row.version, updatedAt: row.updatedAt, mutationReceipt: { originalResult: { version: 1, status: "open" } } });
  await patchWorkItem(row.id, { status: "done" }, actor, db); const before = await facts();
  expect(await patchWorkItem(row.id, input, actor, db)).toMatchObject({ status: "done", replayed: true }); expect(await facts()).toEqual(before);
});
it("combined status and assignment has exactly one receipt; disabled original target does not break replay", async () => {
  const row = await task(), input = { requestId: randomUUID(), expectedVersion: row.version, status: "in_progress" as const, assigneeId: other.id };
  const saved = await patchWorkItem(row.id, input, actor, db);
  expect(saved).toMatchObject({ version: 2, status: "in_progress", assigneeId: other.id });
  const receipts = (await db.select().from(auditLogs)).filter(a => (a.after as { mutationRequestId?: string })?.mutationRequestId === input.requestId);
  expect(receipts).toHaveLength(1);
  await patchWorkItem(row.id, { assigneeId: actor.id }, actor, db);
  await db.update(users).set({ active: false }).where(eq(users.id, other.id));
  try { const before = await facts(); expect(await patchWorkItem(row.id, input, actor, db)).toMatchObject({ assigneeId: actor.id, replayed: true, mutationReceipt: saved.mutationReceipt }); expect(await facts()).toEqual(before); }
  finally { await db.update(users).set({ active: true }).where(eq(users.id, other.id)); }
});
it.each(["status", "assigneeId", "note", "expectedVersion"] as const)("same key changed %s rejects without effects", async field => {
  const row = await task(), input = { requestId: randomUUID(), expectedVersion: row.version, status: "in_progress" as const, assigneeId: actor.id, note: "原依据" };
  await patchWorkItem(row.id, input, actor, db); const before = await facts();
  const changes = { status: "done", assigneeId: other.id, note: "另一依据", expectedVersion: 2 };
  await expect(patchWorkItem(row.id, { ...input, [field]: changes[field] }, actor, db)).rejects.toMatchObject({ status: 409 }); expect(await facts()).toEqual(before);
});
it("current identity, original writer and current scope protect found, missing and replay results", async () => {
  const row = await task(), input = { requestId: randomUUID(), expectedVersion: row.version, status: "done" as const };
  await patchWorkItem(row.id, input, actor, db);
  await expect(getWorkItemMutationResult(row.id, input.requestId, other, db)).rejects.toMatchObject({ status: 403 });
  await expect(patchWorkItem(row.id, input, other, db)).rejects.toMatchObject({ status: 403 });
  await db.update(users).set({ active: false }).where(eq(users.id, actor.id));
  try { for (const key of [input.requestId, randomUUID()]) await expect(getWorkItemMutationResult(row.id, key, actor, db)).rejects.toMatchObject({ status: 403 });
    await expect(patchWorkItem(row.id, input, actor, db)).rejects.toMatchObject({ status: 403 }); }
  finally { await db.update(users).set({ active: true }).where(eq(users.id, actor.id)); }
  await expect(getWorkItemMutationResult(row.id, input.requestId, { ...actor, sessionVersion: -1 }, db)).rejects.toMatchObject({ status: 401 });
  const [unrelated] = await db.insert(users).values({ name: "合成无权人员", roles: ["ops"] }).returning();
  await expect(getWorkItemMutationResult(row.id, randomUUID(), { ...actor, id: unrelated.id, roles: ["admin"], sessionVersion: unrelated.sessionVersion }, db)).rejects.toMatchObject({ status: 404 });
});
it("request key cannot be moved to a different task; DB uniqueness rejects bypass and case variants", async () => {
  const a = await task(), b = await task(), requestId = randomUUID();
  await patchWorkItem(a.id, { requestId, expectedVersion: a.version, status: "done" }, actor, db); const before = await facts();
  await expect(patchWorkItem(b.id, { requestId, expectedVersion: b.version, status: "done" }, actor, db)).rejects.toMatchObject({ status: 409 });
  await expect(writeAudit(db, { userId: actor.id, entity: "work_item", entityId: b.id, action: "assign", after: { mutationRequestId: requestId.toUpperCase() } })).rejects.toThrow(); expect(await facts()).toEqual(before);
});
it("audit failure rolls back mutation, version, receipt and outbox; same request can be retried", async () => {
  const row = await task(), input = { requestId: randomUUID(), expectedVersion: row.version, assigneeId: other.id, status: "done" as const };
  const before = await facts(); deps.fail = true;
  try { await expect(patchWorkItem(row.id, input, actor, db)).rejects.toThrow("synthetic mutation audit failure"); } finally { deps.fail = false; }
  expect(await facts()).toEqual(before); expect((await getWorkItemMutationResult(row.id, input.requestId, actor, db)).receipt).toBeNull();
  expect(await patchWorkItem(row.id, input, actor, db)).toMatchObject({ replayed: false, version: 2 });
});
it("fingerprint auto-reopen increments the same version authority", async () => {
  const input = { title: "合成系统任务", assigneeId: actor.id, sourceKind: "review" as const, sourceRef: randomUUID() };
  const row = (await createWorkItem(input, other, db)).item;
  await patchWorkItem(row.id, { status: "done" }, actor, db);
  const reopened = await createWorkItem(input, other, db); expect(reopened.item).toMatchObject({ id: row.id, status: "open", version: 3 });
  await expect(patchWorkItem(row.id, { requestId: randomUUID(), expectedVersion: 1, status: "done" }, actor, db)).rejects.toMatchObject({ status: 409 });
});
it("HTTP requires a paired key/version, rejects unknown fields/queries, and returns private original result", async () => {
  deps.user.mockResolvedValue(actor); const row = await task(), ctx = { params: Promise.resolve({ id: String(row.id) }) };
  const input = { requestId: randomUUID(), expectedVersion: row.version, status: "done" };
  const patch = (body: unknown) => PATCH(new NextRequest(`http://localhost/api/todo/${row.id}`, { method: "PATCH", body: JSON.stringify(body) }), ctx);
  for (const body of [null, [], { status: "done" }, { ...input, requestId: undefined }, { ...input, expectedVersion: undefined }, { ...input, expectedVersion: 0 }, { ...input, other: true }]) expect((await patch(body)).status).toBe(400);
  const saved = await patch(input); expect(saved.status).toBe(200); expect(await saved.json()).toMatchObject({ version: 2, replayed: false, mutationReceipt: { requestId: input.requestId } });
  const get = (q: string) => GET(new NextRequest(`http://localhost/api/todo/${row.id}?${q}`), ctx);
  const found = await get(`mode=mutation-result&requestId=${input.requestId}`); expect(found.headers.get("cache-control")).toContain("no-store"); expect(await found.json()).toMatchObject({ receipt: { requestId: input.requestId }, current: { version: 2 } });
  for (const q of ["mode=mutation-result", `mode=mutation-result&requestId=${input.requestId}&page=1`, `mode=mutation-result&requestId=${input.requestId}&requestId=${input.requestId}`, "mode=wrong&requestId=bad"]) expect((await get(q)).status).toBe(400);
});
