import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { users, workItems } from "@/db/schema";
import { GET as listGet } from "@/app/api/todo/route";
import { GET as detailGet } from "@/app/api/todo/[id]/route";
import { GET as statsGet } from "@/app/api/todo/stats/route";
import { GET as assigneesGet } from "@/app/api/todo/assignees/route";
import { SessionAuthError, type SessionUser } from "@/server/core/dto";
import { createTestDb } from "../helpers/db";

const deps = vi.hoisted(() => ({ db: vi.fn(), fresh: vi.fn(), token: vi.fn() }));
vi.mock("@/db", async (original) => ({ ...await original<typeof import("@/db")>(), getDbAsync: deps.db }));
vi.mock("@/server/core/dto", async (original) => ({ ...await original<typeof import("@/server/core/dto")>(), getFreshSessionUser: deps.fresh, getSessionUser: deps.token }));

describe("todo real read routes: server sorting and fresh authority", () => {
  let fixture: Awaited<ReturnType<typeof createTestDb>>;
  let freshUser: SessionUser;
  let hiddenId: number;
  beforeAll(async () => {
    fixture = await createTestDb(); deps.db.mockResolvedValue(fixture.db);
    const [me, other] = await fixture.db.insert(users).values([{ name: "计划", roles: ["pmc"] }, { name: "运营", roles: ["ops"] }]).returning();
    freshUser = { id: me.id, name: me.name, roles: ["pmc", "ops"], deptScope: ["pmc"], isApprover: false };
    const rows = await fixture.db.insert(workItems).values([
      { title: "late", assigneeId: me.id, assignerId: other.id, createdBy: other.id, dueDate: "2026-09-30" },
      { title: "early", assigneeId: me.id, assignerId: other.id, createdBy: other.id, dueDate: "2026-09-01" },
      { title: "hidden", assigneeId: other.id, assignerId: other.id, createdBy: other.id, ownerRole: "ops", dueDate: "2000-01-01" },
    ]).returning();
    hiddenId = rows[2].id;
  });
  afterAll(async () => { await fixture?.client.close(); });
  beforeEach(() => {
    deps.fresh.mockResolvedValue(freshUser);
    // A previously elevated token must not expand today's scope.
    deps.token.mockResolvedValue({ ...freshUser, roles: ["admin"], deptScope: null });
  });
  const req = (query: string, suffix = "") => new NextRequest(`http://localhost/api/todo${suffix}?${query}`);
  it("forwards sort parameters into the real query and preserves current department scope", async () => {
    const res = await listGet(req("view=all&sortBy=dueDate&sortOrder=asc&pageSize=1"));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.total).toBe(2);
    expect(data.rows.map((row: { title: string }) => row.title)).toEqual(["early"]);
  });
  it("invalid sort gives an actionable 400 rather than a different successful ordering", async () => {
    const res = await listGet(req("view=all&sortBy=not-a-column&sortOrder=asc"));
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain("排序无效");
  });
  it("old admin token cannot open an item outside the new department scope", async () => {
    const res = await detailGet(req("", `/${hiddenId}`), { params: Promise.resolve({ id: String(hiddenId) }) });
    expect(res.status).toBe(404);
  });
  it("summary counts use the same current scope as the list", async () => {
    const res = await statsGet(req("scope=summary", "/stats"));
    expect(res.status).toBe(200);
    expect((await res.json()).totals.open).toBe(2);
  });
  it.each(["list", "detail", "stats", "summary", "assignees"])("%s rejects a revoked session even if the old token remains readable", async route => {
    deps.fresh.mockRejectedValueOnce(new SessionAuthError("会话已失效，请重新登录"));
    const response = route === "list" ? await listGet(req(""))
      : route === "detail" ? await detailGet(req("", `/${hiddenId}`), { params: Promise.resolve({ id: String(hiddenId) }) })
        : route === "assignees" ? await assigneesGet(req("", "/assignees"))
          : await statsGet(req(route === "summary" ? "scope=summary" : "", "/stats"));
    expect(response.status).toBe(401);
  });
});
