import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { auditLogs, notifications, users, userDataScopes, workItems } from "@/db/schema";
import type { SessionUser } from "@/server/core/dto";
import { deptKeyToTargetId } from "@/server/core/data-scope";
import { createWorkItem, patchWorkItem } from "@/server/modules/todo/service";
import { appendWorkItemNote, getWorkItemNoteResult, listWorkItemHistory } from "@/server/modules/todo/history";
import { createTestDb, type TestDb } from "../helpers/db";

let db: TestDb, client: Awaited<ReturnType<typeof createTestDb>>["client"];
beforeAll(async () => { ({ db, client } = await createTestDb()); });
afterAll(async () => { await client?.close(); });
async function fixture() {
  const [actor, owner] = await db.insert(users).values([
    { name: "合成当前身份", roles: ["admin"], active: true },
    { name: "合成独立负责人", roles: ["pmc"], active: true },
  ]).returning();
  const user: SessionUser = { id: actor.id, name: actor.name, roles: actor.roles, isApprover: false, sessionVersion: actor.sessionVersion };
  const [item] = await db.insert(workItems).values({ title: "合成角色范围待办", assigneeId: owner.id, assignerId: owner.id, createdBy: owner.id, ownerRole: "pmc", status: "open", sourceKind: "manual" }).returning();
  return { user, owner, item };
}
async function facts() { return { tasks: await db.select().from(workItems), audits: await db.select().from(auditLogs), notifications: await db.select().from(notifications) }; }
const kinds = ["create", "patch", "note", "history", "result"] as const;
function invoke(kind: typeof kinds[number], f: Awaited<ReturnType<typeof fixture>>) {
  if (kind === "create") return createWorkItem({ title: "合成创建", assigneeId: f.owner.id }, f.user, db);
  if (kind === "patch") return patchWorkItem(f.item.id, { status: "done" }, f.user, db);
  if (kind === "note") return appendWorkItemNote(f.item.id, { note: "合成当前资格跟进", requestId: randomUUID() }, f.user, db);
  if (kind === "result") return getWorkItemNoteResult(f.item.id, randomUUID(), f.user, db);
  return listWorkItemHistory(f.item.id, {}, f.user, db);
}
it.each(kinds)("%s rejects disabled current actor without task/audit/outbox effects", async kind => {
  const f = await fixture(); await db.update(users).set({ active: false }).where(eq(users.id, f.user.id));
  const before = await facts(); await expect(invoke(kind, f)).rejects.toMatchObject({ status: 403 }); expect(await facts()).toEqual(before);
});
it.each(kinds)("%s rejects revoked session without effects", async kind => {
  const f = await fixture(); await db.update(users).set({ sessionVersion: f.user.sessionVersion! + 1 }).where(eq(users.id, f.user.id));
  const before = await facts(); await expect(invoke(kind, f)).rejects.toMatchObject({ status: 401 }); expect(await facts()).toEqual(before);
});
it.each(["patch", "note", "history", "result"] as const)("%s uses database roles instead of a stale admin", async kind => {
  const f = await fixture(); await db.update(users).set({ roles: ["warehouse"] }).where(eq(users.id, f.user.id));
  const before = await facts(); await expect(invoke(kind, f)).rejects.toMatchObject({ status: kind === "patch" ? 403 : 404 }); expect(await facts()).toEqual(before);
});
it.each(["patch", "note", "history", "result"] as const)("%s uses current database department scope", async kind => {
  const f = await fixture(); await db.update(users).set({ roles: ["pmc", "ops"] }).where(eq(users.id, f.user.id));
  await db.insert(userDataScopes).values({ userId: f.user.id, scopeKind: "dept", targetId: deptKeyToTargetId("ops"), createdBy: f.owner.id });
  const before = await facts(); await expect(invoke(kind, f)).rejects.toMatchObject({ status: kind === "patch" ? 403 : 404 }); expect(await facts()).toEqual(before);
});
it("source fingerprints require current admin even after an earlier route guard allowed them", async () => {
  const f = await fixture(); await db.update(users).set({ roles: ["ops"] }).where(eq(users.id, f.user.id));
  const before = await facts();
  await expect(createWorkItem({ title: "不得伪造告警来源", assigneeId: f.owner.id, sourceKind: "alert", sourceRef: "synthetic-authority" }, f.user, db)).rejects.toMatchObject({ status: 403 });
  expect(await facts()).toEqual(before);
});
it("current legal role wins over stale role and spoofed name; no-op/replay remain authorized", async () => {
  const f = await fixture(); const stale = { ...f.user, roles: ["warehouse"], name: "伪造显示名" };
  await expect(patchWorkItem(f.item.id, { status: "in_progress" }, stale, db)).resolves.toMatchObject({ status: "in_progress" });
  const input = { note: "合成可重试跟进记录", requestId: randomUUID() };
  const first = await appendWorkItemNote(f.item.id, input, stale, db);
  expect(await appendWorkItemNote(f.item.id, input, stale, db)).toEqual({ eventId: first.eventId, replayed: true });
  await db.update(users).set({ active: false }).where(eq(users.id, f.user.id));
  await expect(patchWorkItem(f.item.id, { status: "in_progress" }, f.user, db)).rejects.toMatchObject({ status: 403 });
  await expect(appendWorkItemNote(f.item.id, input, f.user, db)).rejects.toMatchObject({ status: 403 });
});
