import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import * as s from "@/db/schema";
import type { SessionUser } from "@/server/core/dto";
import { getSopWorkspace } from "@/server/modules/replenish/sop-cycle";
import { GET, POST } from "@/app/api/replenish/sop/route";
import { GET as notificationGet } from "@/app/api/notifications/route";
import { createTestDb } from "../helpers/db";

let fixture: Awaited<ReturnType<typeof createTestDb>>, actor: SessionUser, token: SessionUser | null;
let cycleId: number, planId: number, newPlanId: number;
vi.mock("@/db", () => ({ getDbAsync: async () => fixture.db }));
vi.mock("@/server/auth", () => ({ auth: async () => token ? { user: { ...token, id: String(token.id) } } : null }));
beforeEach(async () => {
  fixture = await createTestDb();
  const [person] = await fixture.db.insert(s.users).values({ name: "导航计划员", roles: ["pmc"] }).returning();
  actor = { id: person.id, name: person.name, roles: person.roles, isApprover: false, sessionVersion: person.sessionVersion };
  token = actor;
  const plans = await fixture.db.insert(s.planningVersions).values(Array.from({ length: 56 }, (_, i) => ({
    name: `计划${i}`, weekStart: "2026-09-01", engineVersion: "qa", parameters: {}, sourceMeta: {}, lineCount: 0,
    suggestedCount: 0, suppressedCount: 0, digest: (i ? "b" : "a").repeat(64), idempotencyKey: crypto.randomUUID(), createdBy: actor.id,
    createdAt: new Date(Date.UTC(2020 + i, 0, 1)),
  }))).returning();
  planId = plans[0].id; newPlanId = plans[55].id;
  const cycles = await fixture.db.insert(s.sopCycles).values(Array.from({ length: 30 }, (_, i) => ({
    month: `${2020 + i}-01`, name: `周期${i}`, planningVersionId: i ? newPlanId : planId,
    planDigest: (i ? "b" : "a").repeat(64), idempotencyKey: crypto.randomUUID(), createdBy: actor.id,
  }))).returning();
  cycleId = cycles[0].id;
});
afterEach(async () => { vi.restoreAllMocks(); await fixture.client.close(); });
const get = (query = "") => GET(new NextRequest(`http://localhost/api/replenish/sop?${query}`));
const post = (body: object) => POST(new NextRequest("http://localhost/api/replenish/sop", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
}));

it("exact older cycle includes its actual older plan label and is not replaced by recent cycles", async () => {
  expect((await getSopWorkspace(actor, fixture.db)).cycles.some(c => c.id === cycleId)).toBe(false);
  const response = await get(`workspaceCycleId=${cycleId}`), body = await response.json();
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toContain("no-store");
  expect(body.cycles.find((c: { id: number }) => c.id === cycleId)).toMatchObject({ name: "周期0", plan: { id: planId, name: "计划0" } });
  expect(body.versions.find((p: { id: number }) => p.id === planId)).toMatchObject({ name: "计划0" });
  expect(body.cycles).toHaveLength(25);
});
it("batch read keeps each cycle/round decision separate and performs one decision query", async () => {
  const recent = (await fixture.db.select().from(s.sopCycles)).at(-1)!;
  await fixture.db.insert(s.sopDecisions).values([
    { cycleId, cycleVersion: 1, role: "pmc", decision: "agree", planDigest: "a".repeat(64), decidedBy: actor.id },
    { cycleId: recent.id, cycleVersion: 1, role: "ops", decision: "reject", note: "其他周期的说明", planDigest: "b".repeat(64), decidedBy: actor.id },
    { cycleId, cycleVersion: 2, role: "pmc", decision: "reject", note: "新一轮说明", planDigest: "a".repeat(64), decidedBy: actor.id },
  ]);
  await fixture.db.update(s.sopCycles).set({ version: 2 }).where(eq(s.sopCycles.id, cycleId));
  const reads = vi.spyOn(fixture.client, "query");
  const workspace = await getSopWorkspace(actor, fixture.db, { id: cycleId, only: false });
  const queries = reads.mock.calls.map(call => String(call[0]));
  expect(queries.filter(sql => sql.includes('from "sop_decisions"'))).toHaveLength(1);
  expect(queries.filter(sql => /^select/i.test(sql))).toHaveLength(6); // versions, preview, exact, missing plans, decisions, current freeze
  const old = workspace.cycles.find(c => c.id === cycleId)!;
  expect(old.decisions).toHaveLength(2);
  expect(old.currentDecisions.pmc).toMatchObject({ decision: "reject", note: "新一轮说明", cycleVersion: 2 });
  expect(old.decisions.filter(d => d.current)).toHaveLength(1);
  expect(workspace.cycles.find(c => c.id === recent.id)?.currentDecisions.ops?.note).toBe("其他周期的说明");
});
it("after an old cycle decision and plan change, POST still returns that exact cycle", async () => {
  const decision = await post({ action: "decide", cycleId, version: 1, role: "pmc", decision: "agree" });
  expect(decision.status).toBe(200);
  expect((await decision.json()).cycles.find((c: { id: number }) => c.id === cycleId).currentDecisions.pmc.decision).toBe("agree");
  const changed = await post({ action: "change_plan", cycleId, version: 1, planningVersionId: newPlanId });
  expect(changed.status).toBe(200);
  expect((await changed.json()).cycles.find((c: { id: number }) => c.id === cycleId)).toMatchObject({ version: 2, planningVersionId: newPlanId });
  const notes = await fixture.db.select().from(s.notifications);
  expect(notes.length).toBeGreaterThan(0);
  expect(notes.every(n => n.href === `/replenish/sop?cycleId=${cycleId}`)).toBe(true);
});
it("closing an old executing cycle returns its closed state and history, not an empty selection", async () => {
  await fixture.db.update(s.sopCycles).set({ status: "executing", frozenAt: new Date(), frozenBy: actor.id,
    executingAt: new Date(), executingBy: actor.id }).where(eq(s.sopCycles.id, cycleId));
  const closed = await post({ action: "transition", cycleId, version: 1, target: "closed" });
  expect(closed.status).toBe(200);
  expect((await closed.json()).cycles.find((c: { id: number }) => c.id === cycleId).status).toBe("closed");
});
it.each(["workspace", "history"])("%s deep read checks current role, not old token roles", async mode => {
  await fixture.db.update(s.users).set({ roles: ["warehouse"] }).where(eq(s.users.id, actor.id));
  expect((await get(`${mode === "workspace" ? "workspaceCycleId" : "cycleId"}=${cycleId}`)).status).toBe(403);
});
it.each(["disabled", "session", "anonymous"])("%s session cannot use an old bookmarked workspace", async mode => {
  if (mode === "anonymous") token = null;
  else await fixture.db.update(s.users).set(mode === "disabled" ? { active: false } : { sessionVersion: actor.sessionVersion! + 1 }).where(eq(s.users.id, actor.id));
  expect((await get(`workspaceCycleId=${cycleId}`)).status).toBe(401);
});
it("missing exact cycle stays 404, not a successful recent-period response", async () => {
  expect((await get("workspaceCycleId=2147483647")).status).toBe(404);
});
it("old notification targets are projected after audience filtering, without rewriting history", async () => {
  const [other] = await fixture.db.insert(s.users).values({ name: "其他收件人", roles: ["pmc"] }).returning();
  const [mine, hidden] = await fixture.db.insert(s.notifications).values([
    { channel: "in_app", title: "本人旧周期", body: "旧通知", userId: actor.id, targetRole: "pmc", href: "/replenish/sop", dedupeKey: `sop:${cycleId}:v1:await:pmc` },
    { channel: "in_app", title: "别人旧周期", body: "不应可见", userId: other.id, targetRole: "pmc", href: "/replenish/sop", dedupeKey: `sop:${cycleId}:v1:reject:pmc` },
  ]).returning();
  const response = await notificationGet(new NextRequest("http://localhost/api/notifications"));
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.rows.find((n: { id: number }) => n.id === mine.id).href).toBe(`/replenish/sop?cycleId=${cycleId}`);
  expect(body.rows.some((n: { id: number }) => n.id === hidden.id)).toBe(false);
  expect((await fixture.db.select().from(s.notifications).where(eq(s.notifications.id, mine.id)))[0]).toMatchObject({ href: "/replenish/sop", readAt: null });
});
