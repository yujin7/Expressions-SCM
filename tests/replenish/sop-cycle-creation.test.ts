import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import * as s from "@/db/schema";
import * as audit from "@/server/core/audit";
import type { SessionUser } from "@/server/core/dto";
import { createSopCycle, changeSopPlan, getSopCycleCreationResult, getSopWorkspace } from "@/server/modules/replenish/sop-cycle";
import { GET, POST } from "@/app/api/replenish/sop/route";
import { createTestDb } from "../helpers/db";

let fixture: Awaited<ReturnType<typeof createTestDb>>, actor: SessionUser, other: SessionUser, token: SessionUser | null;
let planId: number, nextPlanId: number;
const key = "ec264aa1-38a0-4803-9643-f9371545d3b8";
const request = (change = {}) => ({ month: "2026-09", name: "月度供需", planningVersionId: planId, idempotencyKey: key, ...change });
vi.mock("@/db", () => ({ getDbAsync: async () => fixture.db }));
vi.mock("@/server/auth", () => ({ auth: async () => token ? { user: { ...token, id: String(token.id) } } : null }));
beforeEach(async () => {
  fixture = await createTestDb();
  const people = await fixture.db.insert(s.users).values([{ name: "原发起人", roles: ["pmc"] }, { name: "其他计划", roles: ["pmc"] }]).returning();
  [actor, other] = people.map(u => ({ id: u.id, name: u.name, roles: u.roles, isApprover: false, sessionVersion: u.sessionVersion }));
  token = actor;
  const plans = await fixture.db.insert(s.planningVersions).values(["a", "b"].map(digest => ({
    name: digest, weekStart: "2026-09-01", engineVersion: "qa", parameters: {}, sourceMeta: {}, lineCount: 0,
    suggestedCount: 0, suppressedCount: 0, digest: digest.repeat(64), idempotencyKey: crypto.randomUUID(), createdBy: actor.id,
  }))).returning();
  [planId, nextPlanId] = plans.map(p => p.id);
});
afterEach(async () => { vi.restoreAllMocks(); await fixture.client.close(); });
const get = (query: string) => GET(new NextRequest(`http://localhost/api/replenish/sop?${query}`));
const post = (input = request()) => POST(new NextRequest("http://localhost/api/replenish/sop", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "create", ...input }) }));

it("canonical key and trimmed name replay original intent, not a subsequently changed plan", async () => {
  const db = fixture.db;
  const first = await createSopCycle(actor, request({ name: " 月度供需 " }), db);
  await changeSopPlan(actor, { cycleId: first.id, version: 1, planningVersionId: nextPlanId }, db);
  const before = await db.select().from(s.auditLogs);
  expect(await createSopCycle(actor, request({ idempotencyKey: key.toUpperCase() }), db)).toMatchObject({ id: first.id, version: 2, planningVersionId: nextPlanId });
  expect(await getSopCycleCreationResult(actor, key, db)).toMatchObject({ requestKey: key,
    cycle: { id: first.id, planningVersionId: nextPlanId }, originalIntent: { month: "2026-09", name: "月度供需", planningVersionId: planId, planDigest: "a".repeat(64) } });
  expect(await db.select().from(s.auditLogs)).toEqual(before);
  await expect(createSopCycle(actor, request({ planningVersionId: nextPlanId }), db)).rejects.toMatchObject({ status: 409 });
});
it.each(["month", "name", "plan"])("changed %s on the original key is refused without new effects", async part => {
  await createSopCycle(actor, request(), fixture.db);
  const before = await fixture.db.select().from(s.auditLogs);
  const change = part === "month" ? { month: "2026-10" } : part === "name" ? { name: "另一计划" } : { planningVersionId: nextPlanId };
  await expect(createSopCycle(actor, request(change), fixture.db)).rejects.toMatchObject({ status: 409 });
  expect(await fixture.db.select().from(s.sopCycles)).toHaveLength(1);
  expect(await fixture.db.select().from(s.auditLogs)).toEqual(before);
});
it("older than 24 cycles and closed originals are still recovered exactly", async () => {
  const db = fixture.db, first = await createSopCycle(actor, request(), db);
  await db.update(s.sopCycles).set({ status: "closed", frozenBy: actor.id, frozenAt: new Date(), executingBy: actor.id, executingAt: new Date(), closedBy: actor.id, closedAt: new Date() }).where(eq(s.sopCycles.id, first.id));
  await db.insert(s.sopCycles).values(Array.from({ length: 25 }, (_, i) => ({ month: `${2030 + Math.floor(i / 12)}-${String(i % 12 + 1).padStart(2, "0")}`,
    name: `合成后续${i}`, planningVersionId: planId, planDigest: "a".repeat(64), idempotencyKey: crypto.randomUUID(), createdBy: actor.id })));
  expect((await getSopWorkspace(actor, db)).cycles.some(c => c.id === first.id)).toBe(false);
  expect(await createSopCycle(actor, request(), db)).toMatchObject({ id: first.id, status: "closed" });
  const response = await get(`workspaceCycleId=${first.id}`);
  expect(response.status).toBe(200);
  expect((await response.json()).cycles.some((c: { id: number }) => c.id === first.id)).toBe(true);
  expect((await getSopCycleCreationResult(actor, key, db)).cycle?.status).toBe("closed");
});
it("old uppercase keys recover without rewriting history; case-collision history refuses ambiguity", async () => {
  const first = await createSopCycle(actor, request(), fixture.db);
  await fixture.db.update(s.sopCycles).set({ idempotencyKey: key.toUpperCase() }).where(eq(s.sopCycles.id, first.id));
  expect((await createSopCycle(actor, request(), fixture.db)).id).toBe(first.id);
  expect((await fixture.db.select().from(s.sopCycles))[0].idempotencyKey).toBe(key.toUpperCase());
  await fixture.db.insert(s.sopCycles).values({ month: "2026-10", name: "历史歧义", planningVersionId: planId, planDigest: "a".repeat(64), idempotencyKey: key, createdBy: actor.id });
  await expect(createSopCycle(actor, request(), fixture.db)).rejects.toThrow("历史歧义");
  await expect(getSopCycleCreationResult(actor, key, fixture.db)).rejects.toThrow("历史歧义");
});
it.each(["missing", "duplicate", "wrong_actor", "invalid"])("%s creation audit is explicit unknown, never guessed from current state", async mode => {
  const [cycle] = await fixture.db.insert(s.sopCycles).values({ month: "2026-09", name: "月度供需", planningVersionId: planId, planDigest: "a".repeat(64), idempotencyKey: key, createdBy: actor.id }).returning();
  if (mode !== "missing") await audit.writeAudit(fixture.db, { userId: mode === "wrong_actor" ? other.id : actor.id,
    entity: "sop_cycle", entityId: cycle.id, action: "create", after: mode === "invalid" ? {} : { ...request(), planDigest: "a".repeat(64) } });
  if (mode === "duplicate") await audit.writeAudit(fixture.db, { userId: actor.id, entity: "sop_cycle", entityId: cycle.id, action: "create", after: { ...request(), planDigest: "a".repeat(64) } });
  const before = await fixture.db.select().from(s.auditLogs);
  expect(await getSopCycleCreationResult(actor, key, fixture.db)).toMatchObject({ cycle: { id: cycle.id }, originalIntent: null });
  await expect(createSopCycle(actor, request(), fixture.db)).rejects.toThrow("创建依据缺失或冲突");
  expect(await fixture.db.select().from(s.auditLogs)).toEqual(before);
});
it("another current planner cannot claim or discover a request receipt", async () => {
  await createSopCycle(actor, request(), fixture.db);
  await expect(createSopCycle(other, request(), fixture.db)).rejects.toMatchObject({ status: 403 });
  await expect(getSopCycleCreationResult(other, key, fixture.db)).rejects.toMatchObject({ status: 403 });
});
it.each(["role", "inactive", "session"])("current %s loss refuses both replay and lookup", async loss => {
  await createSopCycle(actor, request(), fixture.db);
  await fixture.db.update(s.users).set(loss === "role" ? { roles: ["warehouse"] } : loss === "inactive" ? { active: false } : { sessionVersion: actor.sessionVersion! + 1 }).where(eq(s.users.id, actor.id));
  const status = loss === "session" ? 401 : 403;
  await expect(createSopCycle(actor, request(), fixture.db)).rejects.toMatchObject({ status });
  await expect(getSopCycleCreationResult(actor, key, fixture.db)).rejects.toMatchObject({ status });
  expect((await get(`createRequestKey=${key}`)).status).toBe(loss === "inactive" ? 401 : status);
});
it("audit failure rolls back the cycle and key; same request can then succeed", async () => {
  const spy = vi.spyOn(audit, "writeAudit").mockRejectedValueOnce(Error("audit fault"));
  await expect(createSopCycle(actor, request(), fixture.db)).rejects.toThrow("audit fault");
  expect(await fixture.db.select().from(s.sopCycles)).toHaveLength(0);
  expect((await getSopCycleCreationResult(actor, key, fixture.db)).cycle).toBeNull();
  spy.mockRestore(); await createSopCycle(actor, request(), fixture.db);
  expect(await fixture.db.select().from(s.sopCycles)).toHaveLength(1);
});
it("HTTP returns exact small receipt, then read-only recovery; never includes another workspace in POST", async () => {
  const response = await post(); expect(response.status).toBe(201);
  const receipt = await response.json(); expect(Object.keys(receipt).sort()).toEqual(["cycle", "requestKey"]);
  const result = await get(`createRequestKey=${key}`); expect(result.status).toBe(200);
  expect(result.headers.get("cache-control")).toBe("private, no-store");
  expect(await result.json()).toMatchObject({ requestKey: key, cycle: receipt.cycle });
  token = null; expect((await get(`createRequestKey=${key}`)).status).toBe(401);
});
it.each(["createRequestKey=bad", `createRequestKey=${key}&requestKey=${key}`, `createRequestKey=${key}&cycleId=1`,
  `createRequestKey=${key}&createRequestKey=${key}`, "workspaceCycleId=0", "workspaceCycleId=1&workspaceCycleId=2", "workspaceCycleId=1&cycleId=1", "unknown=1"])("invalid query refuses instead of silently showing latest: %s", async query => {
  expect((await get(query)).status).toBe(400);
});
it.each(["0000-09", "2026-13", "26-09"])("invalid month %s creates nothing", async month => {
  expect((await post(request({ month }))).status).toBe(400);
  expect(await fixture.db.select().from(s.sopCycles)).toHaveLength(0);
});
