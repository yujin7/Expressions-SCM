import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { brands } from "@/db/schema";
import { createTestDb, type TestDb } from "../helpers/db";
import { GET } from "@/app/api/master/brand/route";
import { ApiError } from "@/server/modules/master/common";

const state = vi.hoisted(() => ({ db: null as TestDb | null, guard: vi.fn() }));
vi.mock("@/db", () => ({ getDbAsync: async () => state.db }));
vi.mock("@/server/modules/master/common", async (original) => ({
  ...await original<typeof import("@/server/modules/master/common")>(), guardRead: state.guard,
}));
let close: () => Promise<void>;
let ids: number[];
async function request(query: Record<string, string> = {}) {
  const response = await GET(new NextRequest(`http://fixture.local/api/master/brand?${new URLSearchParams(query)}`));
  return { status: response.status, body: await response.json() as { data: { id: number; code: string; nameCn: string }[]; total: number } };
}
beforeAll(async () => {
  const fixture = await createTestDb();
  state.db = fixture.db;
  close = () => fixture.client.close();
  const inserted = await fixture.db.insert(brands).values(Array.from({ length: 211 }, (_, i) => ({
    code: `QA-${String(i + 1).padStart(3, "0")}`, nameCn: i < 201 ? "同名品牌" : `尾页品牌 ${i + 1}`, sortOrder: 0,
  }))).returning({ id: brands.id });
  ids = inserted.map((row) => row.id);
});
afterAll(async () => { await close?.(); });
beforeEach(() => { state.guard.mockReset().mockResolvedValue({ id: 1, roles: ["admin"] }); });

describe("brand list honest pagination and exact selected values", () => {
  it("counts all matching rows, with stable id tie-breaking across pages", async () => {
    const a = await request({ page: "1", pageSize: "50" });
    const b = await request({ page: "2", pageSize: "50" });
    expect(a.status).toBe(200);
    expect(a.body.total).toBe(211);
    expect(b.body.total).toBe(211);
    expect(a.body.data.map((row) => row.id)).toEqual(ids.slice(0, 50));
    expect(b.body.data.map((row) => row.id)).toEqual(ids.slice(50, 100));
    expect(new Set([...a.body.data, ...b.body.data].map((row) => row.id)).size).toBe(100);
    expect((await request({ q: "尾页", pageSize: "2" })).body).toMatchObject({ total: 10, data: expect.any(Array) });
  });

  it("resolves IDs/codes/names exactly without using page offsets or silently truncating total", async () => {
    const tail = await request({ selectedValues: JSON.stringify([ids[210]]), page: "99", pageSize: "1" });
    expect(tail.body).toMatchObject({ total: 1, data: [{ id: ids[210] }] });
    expect((await request({ selectedValues: '["QA-211"]' })).body.data[0].id).toBe(ids[210]);
    const duplicate = await request({ selectedValues: '["同名品牌"]' });
    expect(duplicate.body.total).toBe(201);
    expect(duplicate.body.data).toHaveLength(200);
    expect((await request({ selectedValues: "[]" })).body).toEqual({ data: [], total: 0 });
    expect((await request({ q: "尾页", selectedValues: '["同名品牌"]' })).body.total).toBe(0);
    expect((await request({ selectedValues: JSON.stringify([String(ids[210])]) })).body.total).toBe(0);
  });

  it.each(["null", "{}", "[0]", '[""]', "[1.2]", "bad", JSON.stringify(Array.from({ length: 51 }, (_, i) => i + 1))])("rejects invalid exact lookup %s", async (selectedValues) => {
    expect((await request({ selectedValues })).status).toBe(400);
  });

  it("retains authorization before any list or exact lookup", async () => {
    state.guard.mockRejectedValue(new ApiError(401, "请先登录"));
    expect((await request({ selectedValues: JSON.stringify([ids[210]]) })).status).toBe(401);
  });
});
