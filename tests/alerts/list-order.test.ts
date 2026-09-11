import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as schema from "@/db/schema";
import { createTestDb, type TestDb } from "../helpers/db";
const ctx = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db", () => ({ getDbAsync: async () => ctx.db }));
vi.mock("@/server/modules/master/common", async (original) => ({
  ...await original<typeof import("@/server/modules/master/common")>(),
  guardRead: async () => ({ id: 1, name: "sort QA", roles: ["admin"], isApprover: false }),
}));
import { GET } from "@/app/api/alerts/route";

describe("alert order is applied before pagination", () => {
  let db: TestDb, client: { close(): Promise<void> };
  let ids: number[];
  beforeAll(async () => {
    ({ db, client } = await createTestDb()); ctx.db = db;
    const rows = await db.insert(schema.systemAlerts).values([
      { category: "sales_spike", title: "first inserted, newest business date", createdAt: new Date("2026-09-06"), lastHitAt: null, severity: "medium" },
      { category: "sales_spike", title: "second inserted, oldest business date", createdAt: new Date("2026-09-01"), lastHitAt: new Date("2026-09-04"), severity: "critical" },
      { category: "sales_spike", title: "date tie A", createdAt: new Date("2026-09-03"), lastHitAt: new Date("2026-09-05"), severity: "high" },
      { category: "sales_spike", title: "date tie B", createdAt: new Date("2026-09-03"), lastHitAt: null, severity: null },
      { category: "doc_aging", title: "filtered out", createdAt: new Date("2026-09-07"), severity: "critical" },
    ]).returning(); ids = rows.map(r => r.id);
  });
  afterAll(async () => client.close());
  async function page(query: string) {
    const res = await GET(new NextRequest(`http://scm.test/api/alerts?category=sales_spike&${query}`));
    expect(res.status).toBe(200);
    return await res.json() as { total: number; rows: { id: number }[] };
  }
  it("preserves the existing default newest-record-first ordering", async () => {
    expect((await page("pageSize=2")).rows.map(r => r.id)).toEqual([ids[3], ids[2]]);
  });
  it("sorts dates before slicing, with a stable ID tie-break", async () => {
    const p1 = await page("sort=createdAt&order=asc&pageSize=2&page=1");
    const p2 = await page("sort=createdAt&order=asc&pageSize=2&page=2");
    expect(p1.total).toBe(4);
    expect([...p1.rows, ...p2.rows].map(r => r.id)).toEqual([ids[1], ids[3], ids[2], ids[0]]);
    expect((await page("sort=createdAt&order=desc&pageSize=2")).rows.map(r => r.id)).toEqual([ids[0], ids[3]]);
  });
  it("keeps unknown latest hits last in both directions", async () => {
    expect((await page("sort=lastHitAt&order=asc")).rows.map(r => r.id)).toEqual([ids[1], ids[2], ids[3], ids[0]]);
    expect((await page("sort=lastHitAt&order=desc")).rows.map(r => r.id)).toEqual([ids[2], ids[1], ids[3], ids[0]]);
  });
  it("sorts severity by business priority, not alphabetical order", async () => {
    expect((await page("sort=severity&order=desc")).rows.map(r => r.id)).toEqual([ids[1], ids[2], ids[0], ids[3]]);
    expect((await page("sort=severity&order=asc")).rows.map(r => r.id)).toEqual([ids[0], ids[2], ids[1], ids[3]]);
  });
  it.each(["sort=garbage", "sort=createdAt&order=sideways", "sort=createdAt%3BDROP%20TABLE%20users"])("rejects invalid ordering %s", async query => {
    const res = await GET(new NextRequest(`http://scm.test/api/alerts?${query}`));
    expect(res.status).toBe(400);
  });
  it("an exact ID still ignores stale display sorting", async () => {
    const res = await GET(new NextRequest(`http://scm.test/api/alerts?id=${ids[0]}&sort=garbage&order=bad&page=99`));
    expect(res.status).toBe(200);
    expect((await res.json()).rows.map((r: { id: number }) => r.id)).toEqual([ids[0]]);
  });
});
