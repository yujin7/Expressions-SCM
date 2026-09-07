import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { approvals, pcDocs, users } from "@/db/schema";
import { createTestDb, type TestDb } from "../helpers/db";
import { GET } from "@/app/api/outsource/pc/[id]/route";

let db: TestDb;
let close: () => Promise<void>;
let pcId: number;
let roles = ["admin"];
let signedIn = true;
vi.mock("@/db", () => ({ getDbAsync: async () => db }));
vi.mock("@/server/core/dto", async original => ({ ...await original<typeof import("@/server/core/dto")>(),
  getSessionUser: async () => { if (!signedIn) throw Error("No session"); return { id: 1, name: "查看者", roles, isApprover: true }; },
}));
const request = (id: string) => GET(new NextRequest(`http://localhost/api/outsource/pc/${id}`), { params: Promise.resolve({ id }) });
beforeAll(async () => {
  const created = await createTestDb(); db = created.db; close = () => created.client.close();
  const [maker, checker] = await db.insert(users).values([{ name: "改价申请人", roles: ["pmc"] }, { name: "价格审批人", roles: ["finance"] }]).returning();
  const [doc] = await db.insert(pcDocs).values({ docNo: "PC-NAV", createdBy: maker.id, status: "pending", target: "jg_fee", oldPrice: "2", newPrice: "1.9", deviationPct: "-5", scope: "unreceived_only" }).returning();
  pcId = doc.id;
  await db.insert(approvals).values({ docType: "pc", docId: pcId, approverId: checker.id, action: "reject", comment: "价格依据待补充" });
});
afterAll(async () => close());
it("detail supplies creator and approval facts without relying on a current list row", async () => {
  const response = await request(String(pcId)); expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ id: pcId, createdByName: "改价申请人", oldPrice: "2.00", approvals: [{ approverName: "价格审批人", comment: "价格依据待补充" }] });
});
it("the richer detail retains money masking", async () => {
  roles = ["warehouse"];
  const body = await (await request(String(pcId))).json();
  expect(body).not.toHaveProperty("oldPrice"); expect(body).not.toHaveProperty("newPrice"); expect(body).not.toHaveProperty("deviationPct");
});
it("absent and invalid identities have explicit errors", async () => {
  expect((await request("2147483647")).status).toBe(404);
  expect((await request("invalid")).status).toBe(400);
});
it("the detail still requires authentication", async () => {
  signedIn = false; expect((await request(String(pcId))).status).toBe(401);
});
