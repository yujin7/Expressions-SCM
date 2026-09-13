import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { users } from "@/db/schema";
import { GET } from "@/app/api/todo/assignees/route";
import { listTodoAssignees } from "@/server/modules/todo/assignees";
import { createTestDb } from "../helpers/db";

const deps = vi.hoisted(() => ({ db: vi.fn(), fresh: vi.fn() }));
vi.mock("@/db", async original => ({ ...await original<typeof import("@/db")>(), getDbAsync: deps.db }));
vi.mock("@/server/core/dto", async original => ({ ...await original<typeof import("@/server/core/dto")>(), getFreshSessionUser: deps.fresh }));

describe("bounded, identity-aware todo directory", () => {
  let fixture: Awaited<ReturnType<typeof createTestDb>>;
  let ids: number[];
  let inactiveId: number;
  beforeAll(async () => {
    fixture = await createTestDb(); deps.db.mockResolvedValue(fixture.db); deps.fresh.mockResolvedValue({ id: 1, roles: ["pmc"] });
    const rows = await fixture.db.insert(users).values(Array.from({ length: 63 }, (_, i) => ({ name: "同名计划员", roles: [i === 62 ? "ops" : "pmc"] }))).returning();
    ids = rows.map(row => row.id);
    const [inactive] = await fixture.db.insert(users).values({ name: "停用", active: false, roles: ["pmc"] }).returning(); inactiveId = inactive.id;
    await fixture.db.insert(users).values({ name: "百分%下划_反斜\\", roles: [] });
  });
  afterAll(async () => { await fixture?.client.close(); });
  const list = (query = "") => listTodoAssignees(new URLSearchParams(query), fixture.db);
  it("never downloads the full directory by default; same-name ordering is stable by ID", async () => {
    const first = await list("q=同名"), next = await list("q=同名&page=2");
    expect(first.total).toBe(63); expect(first.rows.map(row => row.id)).toEqual(ids.slice(0, 50));
    expect(next.rows.map(row => row.id)).toEqual(ids.slice(50));
    expect(new Set([...first.rows, ...next.rows].map(row => row.id)).size).toBe(63);
    expect(Object.keys(first.rows[0]).sort()).toEqual(["id", "name", "roles"]);
  });
  it("searches Chinese roles, canonical roles and exact ID without using names as identity", async () => {
    expect((await list("q=运营")).rows.map(row => row.id)).toEqual([ids[62]]);
    expect((await list("q=OPS")).rows.map(row => row.id)).toEqual([ids[62]]);
    expect((await list(`q=%23${ids[62]}`)).rows.map(row => row.id)).toEqual([ids[62]]);
  });
  it("exact hydration reaches beyond page one, but never returns disabled or excluded users", async () => {
    const query = new URLSearchParams({ selectedValues: JSON.stringify([ids[62], inactiveId]), q: "不匹配", page: "8" });
    expect((await list(query.toString())).rows.map(row => row.id)).toEqual([ids[62]]);
    query.set("excludeId", String(ids[62])); expect(await list(query.toString())).toEqual({ rows: [], total: 0 });
    expect((await list(`q=同名&excludeId=${ids[0]}`)).total).toBe(62);
  });
  it.each(["%", "_", "\\"])("treats SQL wildcard %s as literal search text", async q => {
    const result = await list(new URLSearchParams({ q }).toString());
    expect(result.rows).toHaveLength(1); expect(result.total).toBe(1);
  });
  it.each(["page=0", "page=1.5", "pageSize=51", "pageSize=0", "excludeId=-1", "q=a&q=b", "unknown=1", "selectedValues=%5B%22同名计划员%22%5D", "selectedValues=oops", "q=%00"])("rejects %s rather than silently dropping the filter", async query => {
    const response = await GET(new NextRequest(`http://localhost/api/todo/assignees?${query}`));
    expect(response.status).toBe(400);
  });
  it("the actual authenticated route exposes total and no-store with minimal fields", async () => {
    const response = await GET(new NextRequest("http://localhost/api/todo/assignees?pageSize=2"));
    expect(response.status).toBe(200); expect(deps.fresh).toHaveBeenCalled();
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const payload = await response.json(); expect(payload.rows).toHaveLength(2); expect(payload.total).toBe(64);
    expect(Object.keys(payload.rows[0]).sort()).toEqual(["id", "name", "roles"]);
  });
});
