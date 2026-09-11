import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { aliases, systemAlerts, users } from "@/db/schema";
import { createTestDb, type TestDb } from "../helpers/db";

const mocks = vi.hoisted(() => ({ db: null as unknown, getDb: vi.fn(), guard: vi.fn() }));
vi.mock("@/db", () => ({ getDbAsync: () => mocks.getDb() }));
vi.mock("@/server/modules/master/common", async original => ({
  ...await original<typeof import("@/server/modules/master/common")>(), guardRead: () => mocks.guard(),
}));
import { GET } from "@/app/api/alerts/route";

let db: TestDb;
let close: () => Promise<void>;
let userId: number;
const call = (keys: string[], extra: Record<string, string> = {}) => GET(new NextRequest(
  `http://localhost/api/alerts?${new URLSearchParams({ category: "inventory_cover", keys: JSON.stringify(keys), ...extra })}`,
));
beforeAll(async () => {
  const test = await createTestDb(); db = test.db; close = () => test.client.close(); mocks.db = db;
  const [user] = await db.insert(users).values({ name: "lookup", roles: ["pmc"] }).returning(); userId = user.id;
  await db.insert(systemAlerts).values(Array.from({ length: 502 }, (_, index) => ({
    category: "inventory_cover", dedupeKey: `inventory_cover:${index}`, title: `合成 ${index}`,
    ownerRole: "pmc", paramsSnapshot: { amount: "123.00", safeCount: index },
    ackedAt: index === 1 ? new Date("2026-09-08T00:00:00Z") : null,
  })));
  await db.insert(aliases).values([
    { aliasType: "channel", scope: "JIANDAOYUN", rawValue: "店,甲|特殊", targetId: 11 },
    { aliasType: "channel", scope: "JIANDAOYUN", rawValue: "店乙", targetId: 22 },
  ]);
  await db.insert(systemAlerts).values([
    { category: "sales_spike", dedupeKey: "sales_spike:platform:店,甲|特殊|SKU-1", title: "范围内" },
    { category: "sales_spike", dedupeKey: "sales_spike:platform:店乙|SKU-2", title: "范围外" },
  ]);
});
beforeEach(() => {
  mocks.getDb.mockReset().mockResolvedValue(mocks.db);
  mocks.guard.mockReset().mockResolvedValue({ id: userId, name: "lookup", roles: ["pmc"], isApprover: false });
});
afterAll(async () => { await close(); });

it("finds an old visible alert beyond the latest 500 and counts unacknowledged alerts over the whole category", async () => {
  const response = await call(["inventory_cover:0", "inventory_cover:1"], { page: "99", pageSize: "1" });
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.rows.map((r: { dedupeKey: string }) => r.dedupeKey)).toEqual(["inventory_cover:1", "inventory_cover:0"]);
  expect(body).toMatchObject({ total: 2, page: 1, pageSize: 2, unackedTotal: 501 });
});
it("empty keys return no rows but retain the scoped category count", async () => {
  const body = await (await call([])).json();
  expect(body).toMatchObject({ rows: [], total: 0, unackedTotal: 501 });
});
it("lookup preserves channel authorization, comma-containing identities, and money masking", async () => {
  mocks.guard.mockResolvedValue({ id: userId, name: "运营", roles: ["ops"], isApprover: false, channelScope: [11] });
  const response = await call(["sales_spike:platform:店,甲|特殊|SKU-1", "sales_spike:platform:店乙|SKU-2"], { category: "sales_spike" });
  const body = await response.json();
  expect(body.rows.map((r: { title: string }) => r.title)).toEqual(["范围内"]);
  expect(body).toMatchObject({ total: 1, unackedTotal: 1 });
  const inventory = await (await call(["inventory_cover:0"])).json();
  expect(inventory.rows[0].paramsSnapshot).toEqual({ safeCount: 0 });
});
const invalidLookups: Record<string, string>[] = [
  { keys: "not-json" }, { keys: "null" }, { keys: "[1]" }, { keys: "[\"\"]" },
  { keys: JSON.stringify(Array.from({ length: 101 }, (_, i) => `inventory_cover:${i}`)) },
  { keys: JSON.stringify(["中".repeat(800)]) }, { keys: "[]", category: "other" },
  { keys: "[]", status: "resolved" }, { keys: "[]", id: "1" },
];
it.each(invalidLookups)("invalid or ambiguous lookup fails before database reads: %j", async query => {
  const response = await GET(new NextRequest(`http://localhost/api/alerts?${new URLSearchParams({ category: "inventory_cover", ...query })}`));
  expect(response.status).toBe(400);
  expect(mocks.getDb).not.toHaveBeenCalled();
});
