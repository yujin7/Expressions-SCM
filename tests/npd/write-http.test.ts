import { NextRequest } from "next/server";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import * as s from "@/db/schema";
import type { SessionUser } from "@/server/core/dto";
import { POST, PATCH } from "@/app/api/npd/projects/route";
import { PATCH as taskRoute } from "@/app/api/npd/tasks/route";
import { createTestDb, type TestDb } from "../helpers/db";

let db: TestDb, close: () => Promise<void>, actor: SessionUser | null, projectId: number, taskId: number;
const fresh = vi.fn(async () => { if (!actor) throw Error("No session"); return actor; });
vi.mock("@/db", () => ({ getDbAsync: async () => db }));
vi.mock("@/server/core/dto", async original => ({ ...await original<typeof import("@/server/core/dto")>(), getFreshSessionUser: async () => fresh() }));
const req = (method: string, body: unknown) => new NextRequest("http://localhost/api/npd/projects", { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const input = () => ({ intent: "first_order", projectId, version: 1, qty: "1.25", requestKey: "f7b81974-82e5-4530-9bb5-8818515fa403" });
beforeAll(async () => {
  const fixture = await createTestDb(); db = fixture.db; close = () => fixture.client.close();
  const [user] = await db.insert(s.users).values({ name: "NPD HTTP", roles: ["pmc"] }).returning();
  actor = { id: user.id, name: user.name, roles: ["pmc"], isApprover: false };
  const [spu] = await db.insert(s.spus).values({ code: "NPD-HTTP", nameCn: "HTTP新品" }).returning();
  await db.insert(s.skus).values({ code: "NPD-HTTP", spuId: spu.id, skuType: "finished", baseUom: "盒" });
  const [project] = await db.insert(s.npdProjects).values({ name: "HTTP项目", skuCode: "NPD-HTTP", startDate: "2026-09-01", createdBy: user.id }).returning(); projectId = project.id;
  const [task] = await db.insert(s.npdTasks).values({ projectId, seq: 1, name: "HTTP节点", days: 1 }).returning(); taskId = task.id;
});
afterAll(async () => close());
it("rejects old clients without version/request identity rather than making unprotected writes", async () => {
  expect((await POST(req("POST", { ...input(), requestKey: undefined }))).status).toBe(400);
  expect((await PATCH(req("PATCH", { projectId, status: "done" }))).status).toBe(400);
  expect((await taskRoute(req("PATCH", { taskId, status: "done" }))).status).toBe(400);
  expect(await db.select().from(s.bhDocs)).toHaveLength(0);
});
it("returns 201 for new draft, 200 for exact replay, 409 for changed content", async () => {
  const response = await POST(req("POST", input())); expect(response.status).toBe(201);
  const created = await response.json();
  const replay = await POST(req("POST", input())); expect(replay.status).toBe(200);
  expect(await replay.json()).toEqual({ ...created, replayed: true });
  expect((await POST(req("POST", { ...input(), qty: "2" }))).status).toBe(409);
});
it("each HTTP write rechecks fresh authorization, including a previously successful replay", async () => {
  const saved = actor;
  try {
    actor = { ...actor!, roles: ["warehouse"] };
    expect((await POST(req("POST", input()))).status).toBe(403);
    expect((await PATCH(req("PATCH", { projectId, version: 2, status: "done" }))).status).toBe(403);
    actor = null;
    expect((await POST(req("POST", input()))).status).toBe(401);
    expect((await taskRoute(req("PATCH", { taskId, version: 2, status: "done" }))).status).toBe(401);
    expect(fresh).toHaveBeenCalled();
  } finally { actor = saved; }
});
