import { NextRequest } from "next/server";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { skuParams, auditLogs } from "@/db/schema";
import type { SessionUser } from "@/server/core/dto";
import { POST } from "@/app/api/master/supply-params/bulk/route";
import { GET } from "@/app/api/master/supply-params/route";
import { PATCH } from "@/app/api/master/sku/[id]/supply-params/route";
import { createTestDb, type TestDb } from "../helpers/db";
import { seedTierWorld, type TierWorld } from "../helpers/tier-seed";

let db: TestDb, w: TierWorld, close: () => Promise<void>, actor: SessionUser | null;
vi.mock("@/db", async original => ({ ...await original<typeof import("@/db")>(), getDbAsync: async () => db }));
vi.mock("@/server/core/dto", async original => ({ ...await original<typeof import("@/server/core/dto")>(), getFreshSessionUser: async () => {
  if (!actor) throw Error("No session"); return actor;
} }));
vi.mock("@/server/auth", () => ({ auth: async () => actor ? { user: { id: String(actor.id), roles: actor.roles } } : null }));
const req = (body: unknown) => new NextRequest("http://localhost/api/master/supply-params/bulk", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
beforeAll(async () => { const fixture = await createTestDb(); db = fixture.db; close = () => fixture.client.close(); w = await seedTierWorld(db); actor = w.pmc; });
afterAll(async () => close());
const batch = () => ({ scope: { kind: "ids", ids: [w.sku.A] }, values: { normalLeadDays: 30 } });

it("HTTP write requires preview and cannot accept an empty or fabricated receipt", async () => {
  for (const input of [null, {}, batch(), { ...batch(), expectedPreview: "" }, { ...batch(), expectedPreview: "a".repeat(64) }]) {
    expect([400, 409]).toContain((await POST(req(input))).status);
  }
  expect(await db.select().from(skuParams).where(eq(skuParams.skuId, w.sku.A))).toHaveLength(0);
});
it("dry-run followed by exact confirmation writes once, then stale preview refuses", async () => {
  const response = await POST(req({ ...batch(), dryRun: true })); expect(response.status).toBe(200);
  const preview = await response.json();
  expect(await db.select().from(auditLogs).where(eq(auditLogs.entity, "sku_params"))).toHaveLength(0);
  expect((await POST(req({ ...batch(), expectedPreview: preview.previewKey }))).status).toBe(200);
  expect((await POST(req({ ...batch(), expectedPreview: preview.previewKey }))).status).toBe(409);
  expect(await db.select().from(auditLogs).where(eq(auditLogs.entity, "sku_params"))).toHaveLength(1);
});
it("confirmation binds actor and rechecks current permission", async () => {
  const input = { ...batch(), values: { logisticsLeadDays: 12 } };
  const preview = await (await POST(req({ ...input, dryRun: true }))).json();
  const original = actor;
  try {
    actor = w.purchasing;
    expect((await POST(req({ ...input, expectedPreview: preview.previewKey }))).status).toBe(409);
    actor = { ...w.pmc, roles: ["warehouse"] };
    expect((await POST(req({ ...input, expectedPreview: preview.previewKey }))).status).toBe(403);
    actor = null;
    expect((await POST(req({ ...input, expectedPreview: preview.previewKey }))).status).toBe(401);
  } finally { actor = original; }
});
it("single PATCH returns a stable stale-value conflict without partial field updates", async () => {
  const response = await PATCH(new NextRequest(`http://localhost/api/master/sku/${w.sku.A}/supply-params`, {
    method: "PATCH", body: JSON.stringify({ normalLeadDays: 40, logisticsLeadDays: 10, expected: { normalLeadDays: null, logisticsLeadDays: null } }),
  }), { params: Promise.resolve({ id: String(w.sku.A) }) });
  expect(response.status).toBe(409); expect((await response.json()).error).toContain("已变化");
  expect((await db.select().from(skuParams).where(eq(skuParams.skuId, w.sku.A)))[0].logisticsLeadDays).toBeNull();
});
it("malformed filters refuse instead of silently broadening the population", async () => {
  for (const q of ["brandId=bad", "brandId=-1", "brandId=0", "skuType=typo", "missing=typo", "tier=Z", "blockedOnly=yes"]) {
    expect((await GET(new NextRequest(`http://localhost/api/master/supply-params?${q}`))).status, q).toBe(400);
  }
  const response = await GET(new NextRequest("http://localhost/api/master/supply-params?q=TIER-A&missing="));
  expect(response.status).toBe(200); expect((await response.json()).total).toBe(1);
});
