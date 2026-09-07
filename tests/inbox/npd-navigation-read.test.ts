import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { npdProjects, npdTasks, users } from "@/db/schema";
import { GET } from "@/app/api/npd/projects/route";
import { createTestDb, type TestDb } from "../helpers/db";

let db: TestDb;
let close: () => Promise<void>;
let id: number;
let signedIn = true;
const external = vi.hoisted(() => ({ observations: vi.fn(async () => []), readiness: vi.fn(async () => []) }));
vi.mock("@/db", () => ({ getDbAsync: async () => db }));
vi.mock("@/server/modules/report/jiandaoyun-supporting-observation", () => ({ loadJiandaoyunSupportingObservations: external.observations }));
vi.mock("@/server/modules/report/data-source-readiness", () => ({ loadDataSourceReadiness: external.readiness }));
vi.mock("@/components/product-external-decision-evidence", () => ({ buildProductExternalDecisionEvidenceBrief: () => ({ surface: "launch-readiness" }) }));
vi.mock("@/server/core/dto", async original => ({ ...await original<typeof import("@/server/core/dto")>(),
  getSessionUser: async () => { if (!signedIn) throw Error("No session"); return { id: 1, name: "查看者", roles: ["ops"], isApprover: false }; },
}));
const request = (query = "") => GET(new NextRequest(`http://localhost/api/npd/projects?${query}`));
beforeAll(async () => {
  const test = await createTestDb(); db = test.db; close = () => test.client.close();
  const [user] = await db.insert(users).values({ name: "计划员", roles: ["pmc"] }).returning();
  const [project] = await db.insert(npdProjects).values({ name: "项目准确读取", startDate: "2026-09-01", createdBy: user.id }).returning(); id = project.id;
  await db.insert(npdTasks).values({ projectId: id, seq: 1, name: "配方验证", days: 2, planStart: "2026-09-01", planEnd: "2026-09-03" });
});
beforeEach(() => { signedIn = true; vi.clearAllMocks(); });
afterAll(async () => close());
it("project facts do not wait for or call external evidence", async () => {
  const response = await request("view=projects");
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ projects: [{ id, taskTotal: 1 }] });
  expect(external.observations).not.toHaveBeenCalled(); expect(external.readiness).not.toHaveBeenCalled();
});
it("detail is identity bound and independent of supporting evidence", async () => {
  const response = await request(`id=${id}`);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ project: { id }, tasks: [{ name: "配方验证" }] });
  expect(external.readiness).not.toHaveBeenCalled();
});
it("evidence has its own response, while legacy combined consumers remain compatible", async () => {
  const evidence = await (await request("view=evidence")).json();
  expect(evidence).toHaveProperty("supportingObservations"); expect(evidence).not.toHaveProperty("projects");
  const legacy = await (await request()).json();
  expect(legacy).toHaveProperty("projects"); expect(legacy).toHaveProperty("supportingObservations"); expect(legacy).toHaveProperty("externalDecisionEvidence");
});
it.each(["id=", "id=0", "id=-1", "id=1.2", "id=NaN", "id=2147483648", "id=1&id=2", "view=bad", "view=projects&view=evidence"])("invalid selection %s is 400 rather than an unfiltered list or 500", async query => {
  expect((await request(query)).status).toBe(400);
  expect(external.readiness).not.toHaveBeenCalled();
});
it("missing project remains 404 and anonymous reads remain 401", async () => {
  expect((await request("id=2147483647")).status).toBe(404);
  signedIn = false; expect((await request("view=projects")).status).toBe(401);
});
