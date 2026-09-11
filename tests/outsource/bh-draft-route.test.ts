import { beforeAll, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import * as s from "@/db/schema";
import { createTestDb, type TestDb } from "../helpers/db";
import { GET, PUT } from "@/app/api/outsource/bh/[id]/route";
import { createBh } from "@/server/modules/outsource/bh";
import type { SessionUser } from "@/server/core/dto";

let db: TestDb, maker: SessionUser, peer: SessionUser, skuId: number;
let token: SessionUser | null;
vi.mock("@/db", () => ({ getDbAsync: async () => db }));
// Keep the real fresh-session DB lookup; only the external Auth.js cookie decode is substituted.
vi.mock("@/server/auth", () => ({ auth: async () => token ? { user: { ...token, id: String(token.id) } } : null }));
beforeAll(async () => {
  ({ db } = await createTestDb());
  const people = await db.insert(s.users).values([{ name: "HTTP制单", roles: ["ops"] }, { name: "HTTP同事", roles: ["pmc"], isApprover: true }]).returning();
  [maker, peer] = people.map(u => ({ id: u.id, name: u.name, roles: u.roles, isApprover: u.isApprover, sessionVersion: u.sessionVersion }));
  await db.insert(s.approvalConfigs).values({ docType: "bh", approverRole: "pmc" });
  const [spu] = await db.insert(s.spus).values({ code: "HTTP-EDIT", nameCn: "HTTP草稿" }).returning();
  const [sku] = await db.insert(s.skus).values({ code: "HTTP-EDIT-1", name: "HTTP测试品", spuId: spu.id, skuType: "finished", baseUom: "盒" }).returning();
  skuId = sku.id;
});
const draft = () => createBh(maker, { lines: [{ skuId, qty: "1" }] }, db);
const body = () => ({ version: 1, reason: "HTTP纠正需求", lines: [{ skuId, qty: "3.125" }] });
const ctx = (id: number | string) => ({ params: Promise.resolve({ id: String(id) }) });
const request = (id: number | string, data: unknown = body()) => new NextRequest(`http://localhost/api/outsource/bh/${id}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(data) });

it("full PUT succeeds for the current maker and a stale replay returns 409", async () => {
  token = maker; const doc = await draft();
  expect((await PUT(request(doc.id), ctx(doc.id))).status).toBe(200);
  expect((await PUT(request(doc.id), ctx(doc.id))).status).toBe(409);
  expect((await db.select().from(s.bhLines).where(eq(s.bhLines.bhId, doc.id)))[0].qty).toBe("3.1250");
});
it("read access does not grant another person draft editing", async () => {
  token = peer; const doc = await draft();
  const detail = await GET(new NextRequest(`http://localhost/api/outsource/bh/${doc.id}`), ctx(doc.id));
  expect(detail.status).toBe(200); expect((await detail.json()).actions.edit).toBe(false);
  expect((await PUT(request(doc.id), ctx(doc.id))).status).toBe(403);
});
it("both action hints and edits reject revoked sessions without trusting old JWT roles", async () => {
  token = maker; const doc = await draft();
  await db.update(s.users).set({ sessionVersion: maker.sessionVersion! + 1 }).where(eq(s.users.id, maker.id));
  try {
    expect((await PUT(request(doc.id), ctx(doc.id))).status).toBe(401);
    expect((await GET(new NextRequest(`http://localhost/api/outsource/bh/${doc.id}`), ctx(doc.id))).status).toBe(401);
    expect((await db.select().from(s.bhDocs).where(eq(s.bhDocs.id, doc.id)))[0].version).toBe(1);
  } finally { await db.update(s.users).set({ sessionVersion: maker.sessionVersion }).where(eq(s.users.id, maker.id)); }
});
it("rejects unauthenticated, malformed ID, bad calendar and missing reason distinctly", async () => {
  const doc = await draft(); token = null;
  expect((await PUT(request(doc.id), ctx(doc.id))).status).toBe(401);
  token = maker;
  expect((await PUT(request("bad"), ctx("bad"))).status).toBe(400);
  expect((await PUT(request(doc.id, { ...body(), reason: "" }), ctx(doc.id))).status).toBe(400);
  expect((await PUT(request(doc.id, { ...body(), lines: [{ skuId, qty: "1", expectDate: "2026-02-30" }] }), ctx(doc.id))).status).toBe(400);
  for (const qty of ["abc", "1e3", "NaN"]) {
    expect((await PUT(request(doc.id, { ...body(), lines: [{ skuId, qty }] }), ctx(doc.id))).status).toBe(400);
  }
  expect((await PUT(request(999999), ctx(999999))).status).toBe(404);
});
