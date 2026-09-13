import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { users, workItems } from "@/db/schema";
import type { SessionUser } from "@/server/core/dto";
import { writeAudit } from "@/server/core/audit";
import { appendWorkItemNote, listWorkItemHistory } from "@/server/modules/todo/history";
import { GET, POST } from "@/app/api/todo/[id]/history/route";
import { createTestDb, type TestDb } from "../helpers/db";

const deps = vi.hoisted(() => ({ db: vi.fn(), user: vi.fn(), fail: false }));
vi.mock("@/db", async original => ({ ...await original<typeof import("@/db")>(), getDbAsync: deps.db }));
vi.mock("@/server/core/dto", async original => ({ ...await original<typeof import("@/server/core/dto")>(), getFreshSessionUser: deps.user }));
vi.mock("@/server/core/audit", async original => {
  const actual = await original<typeof import("@/server/core/audit")>();
  return { ...actual, writeAudit: async (...args: Parameters<typeof actual.writeAudit>) => {
    await actual.writeAudit(...args);
    if (deps.fail) throw new Error("synthetic failure after audit append");
  } };
});
let db: TestDb, client: Awaited<ReturnType<typeof createTestDb>>["client"];
let owner: SessionUser, stranger: SessionUser;
beforeAll(async () => {
  ({ db, client } = await createTestDb()); deps.db.mockResolvedValue(db);
  const seeded = await db.insert(users).values([{ name: "合成计划员", roles: ["pmc"], active: true }, { name: "无关仓管", roles: ["warehouse"], active: true }]).returning();
  [owner, stranger] = seeded.map(u => ({ id: u.id, name: u.name, roles: u.roles as SessionUser["roles"], isApprover: false }));
});
afterAll(async () => { await client?.close(); });
async function item(status = "open") {
  const [row] = await db.insert(workItems).values({ title: "合成产能跟进", assigneeId: owner.id, assignerId: owner.id, createdBy: owner.id,
    status, sourceKind: "manual", updatedAt: new Date("2026-09-01T00:00:00Z"), completedAt: status === "done" ? new Date("2026-09-01T00:00:00Z") : null }).returning();
  return row;
}
const req = (id: number, body: unknown) => new NextRequest(`http://localhost/api/todo/${id}/history`, { method: "POST", body: JSON.stringify(body) });
const ctx = (id: number) => ({ params: Promise.resolve({ id: String(id) }) });

it("appends evidence without changing status, completion or reopen-window timestamps", async () => {
  const row = await item("done"), input = { note: "已向工厂核对可交付日期", requestId: randomUUID() };
  const result = await appendWorkItemNote(row.id, input, owner, db);
  expect(result.replayed).toBe(false);
  expect((await db.select().from(workItems).where(eq(workItems.id, row.id)))[0]).toEqual(row);
  const history = await listWorkItemHistory(row.id, {}, owner, db);
  expect(history.rows).toHaveLength(1);
  expect(history.rows[0]).toMatchObject({ id: result.eventId, note: input.note, action: "follow_up", actorName: owner.name, requestId: input.requestId });
});
it("replay returns the same event; changed content or another visible actor cannot reuse its token", async () => {
  const row = await item(), input = { note: "待工厂提供书面依据", requestId: randomUUID() };
  const first = await appendWorkItemNote(row.id, input, owner, db);
  expect(await appendWorkItemNote(row.id, input, owner, db)).toEqual({ eventId: first.eventId, replayed: true });
  await expect(appendWorkItemNote(row.id, { ...input, note: "另一份完全不同的内容" }, owner, db)).rejects.toMatchObject({ status: 409 });
  await expect(appendWorkItemNote(row.id, input, { ...stranger, roles: ["admin"] }, db)).rejects.toMatchObject({ status: 404 });
  await db.update(users).set({ roles: ["admin"] }).where(eq(users.id, stranger.id));
  try { await expect(appendWorkItemNote(row.id, input, stranger, db)).rejects.toMatchObject({ status: 409 }); }
  finally { await db.update(users).set({ roles: ["warehouse"] }).where(eq(users.id, stranger.id)); }
  expect((await listWorkItemHistory(row.id, {}, owner, db)).rows).toHaveLength(1);
});
it("list and append both enforce the existing item scope before replay", async () => {
  const row = await item(), input = { note: "合成不应越权的记录", requestId: randomUUID() };
  await appendWorkItemNote(row.id, input, owner, db);
  await expect(listWorkItemHistory(row.id, {}, stranger, db)).rejects.toMatchObject({ status: 404 });
  await expect(appendWorkItemNote(row.id, input, stranger, db)).rejects.toMatchObject({ status: 404 });
});
it("rolls back a failed audit append and a deliberate retry creates exactly one event", async () => {
  const row = await item(), input = { note: "故障后安全确认同一记录", requestId: randomUUID() };
  deps.fail = true;
  try { await expect(appendWorkItemNote(row.id, input, owner, db)).rejects.toThrow("synthetic failure"); } finally { deps.fail = false; }
  expect((await listWorkItemHistory(row.id, {}, owner, db)).rows).toEqual([]);
  expect((await appendWorkItemNote(row.id, input, owner, db)).replayed).toBe(false);
});
it("history projects only safe work-item fields and includes pre-existing completion notes", async () => {
  const row = await item();
  await writeAudit(db, { userId: owner.id, entity: "work_item", entityId: row.id, action: "complete", after: { note: "历史完成依据可见", status: "done", bankAccount: "DO-NOT-LEAK" }, ip: "DO-NOT-LEAK" });
  await writeAudit(db, { userId: owner.id, entity: "supplier", entityId: row.id, action: "complete", after: { note: "DO-NOT-LEAK" } });
  const result = await listWorkItemHistory(row.id, {}, owner, db);
  expect(result.rows).toHaveLength(1); expect(result.rows[0]).toMatchObject({ note: "历史完成依据可见", status: "done" });
  expect(JSON.stringify(result)).not.toContain("DO-NOT-LEAK");
});
it("keyset pagination stays stable when a newer follow-up arrives between pages", async () => {
  const row = await item();
  for (let i = 0; i < 23; i++) await appendWorkItemNote(row.id, { note: `合成第${i}次跟进记录`, requestId: randomUUID() }, owner, db);
  const first = await listWorkItemHistory(row.id, {}, owner, db);
  expect(first.rows).toHaveLength(20); expect(first.nextBefore).not.toBeNull();
  await appendWorkItemNote(row.id, { note: "分页期间新增跟进记录", requestId: randomUUID() }, owner, db);
  const second = await listWorkItemHistory(row.id, { before: first.nextBefore! }, owner, db);
  expect(second.rows).toHaveLength(3); expect(second.nextBefore).toBeNull();
  expect(new Set([...first.rows, ...second.rows].map(e => e.id)).size).toBe(23);
});
it("HTTP uses fresh session, strict payload/cursor and acknowledges new versus replay", async () => {
  const row = await item(), input = { note: "经过真实路由保存跟进", requestId: randomUUID() }; deps.user.mockResolvedValue(owner);
  expect((await POST(req(row.id, input), ctx(row.id))).status).toBe(201);
  expect((await POST(req(row.id, input), ctx(row.id))).status).toBe(200);
  for (const bad of [{ ...input, status: "done" }, { ...input, note: " " }, { ...input, requestId: "bad" }]) expect((await POST(req(row.id, bad), ctx(row.id))).status).toBe(400);
  for (const q of ["before=", "before=0", "before=x", "before=1&before=2", "unknown=1"]) expect((await GET(new NextRequest(`http://localhost/api/todo/${row.id}/history?${q}`), ctx(row.id))).status).toBe(400);
  deps.user.mockResolvedValue(stranger);
  expect((await GET(new NextRequest(`http://localhost/api/todo/${row.id}/history`), ctx(row.id))).status).toBe(404);
  expect((await POST(req(row.id, input), ctx(row.id))).status).toBe(404);
  expect(deps.user).toHaveBeenCalled();
});
