import { NextRequest } from "next/server";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import * as s from "@/db/schema";
import { GET, POST } from "@/app/api/replenish/sop/route";
import { createTestDb } from "../helpers/db";
import type { SessionUser } from "@/server/core/dto";

let fixture: Awaited<ReturnType<typeof createTestDb>>, token: SessionUser | null, actor: SessionUser, cycleId: number;
const key = "ec264aa1-38a0-4803-9643-f9371545d3b8";
vi.mock("@/db", () => ({ getDbAsync: async () => fixture.db }));
vi.mock("@/server/auth", () => ({ auth: async () => token ? { user: { ...token, id: String(token.id) } } : null }));
beforeAll(async () => {
  fixture = await createTestDb(); const db = fixture.db;
  const [u] = await db.insert(s.users).values({ name: "HTTP恢复计划", roles: ["pmc"] }).returning();
  actor = { id: u.id, name: u.name, roles: u.roles, isApprover: false, sessionVersion: u.sessionVersion }; token = actor;
  const [spu] = await db.insert(s.spus).values({ code: "HTTP-SOP", nameCn: "HTTP计划" }).returning();
  const [sku] = await db.insert(s.skus).values({ code: "HTTP-SOP-1", name: "HTTP计划品", spuId: spu.id, skuType: "finished", baseUom: "盒" }).returning();
  const [plan] = await db.insert(s.planningVersions).values({ name: "HTTP恢复", weekStart: "2026-09-01", engineVersion: "qa", parameters: {}, sourceMeta: {}, lineCount: 1, suggestedCount: 1, suppressedCount: 0, digest: "b".repeat(64), idempotencyKey: crypto.randomUUID(), createdBy: actor.id }).returning();
  await db.insert(s.planningVersionLines).values({ versionId: plan.id, skuId: sku.id, skuCode: sku.code, skuName: sku.name!, baseUom: "盒", suggestedQty: "1.0001", suppressed: false, orderWindowMissed: false, onHand: "0", inTransit: "0", daily: "1", safetyQty: "0", leadDays: 1, explanation: [] });
  const [cycle] = await db.insert(s.sopCycles).values({ month: "2026-09", name: "HTTP恢复周期", planningVersionId: plan.id, planDigest: plan.digest, status: "frozen", frozenBy: actor.id, frozenAt: new Date(), idempotencyKey: crypto.randomUUID(), createdBy: actor.id }).returning();
  cycleId = cycle.id;
});
afterAll(async () => { await fixture.client.close(); });
const get = (query: string) => GET(new NextRequest(`http://localhost/api/replenish/sop?${query}`));
const post = () => POST(new NextRequest("http://localhost/api/replenish/sop", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "execute_draft", cycleId, idempotencyKey: key }) }));

it("returns a minimal durable receipt, then read-only current document recovery with no-store", async () => {
  token = actor;
  const response = await post(); expect(response.status).toBe(201);
  const receipt = await response.json(); expect(Object.keys(receipt).sort()).toEqual(["draft", "requestKey"]);
  expect(receipt.requestKey).toBe(key);
  const audits = await fixture.db.select().from(s.auditLogs);
  const recovery = await get(`requestKey=${key}`); expect(recovery.status).toBe(200);
  expect(recovery.headers.get("cache-control")).toBe("private, no-store");
  expect(await recovery.json()).toMatchObject({ requestKey: key, document: { id: receipt.draft.id, status: "draft" }, lineCount: 1 });
  expect(await fixture.db.select().from(s.auditLogs)).toEqual(audits);
});
it.each(["cycleId=abc", "cycleId=", "cycleId=0", "cycleId=1.5", "cycleId=2147483648", "cycleId=1&cycleId=2", "requestKey=bad", `requestKey=${key}&cycleId=1`, `requestKey=${key}&requestKey=${key}`])("invalid query does not silently return the unfiltered workspace: %s", async query => {
  token = actor; expect((await get(query)).status).toBe(400);
});
it("fresh authentication and revocation are enforced at the HTTP boundary", async () => {
  token = null; expect((await get(`requestKey=${key}`)).status).toBe(401);
  token = actor;
  await fixture.db.update(s.users).set({ sessionVersion: actor.sessionVersion! + 1 }).where(eq(s.users.id, actor.id));
  expect((await get(`requestKey=${key}`)).status).toBe(401);
});
