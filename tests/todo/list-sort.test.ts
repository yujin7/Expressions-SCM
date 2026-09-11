import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { users, workItems } from "@/db/schema";
import type { SessionUser } from "@/server/core/dto";
import { listWorkItems } from "@/server/modules/todo/service";
import { createTestDb } from "../helpers/db";

describe("todo sorting applies before pagination and after visibility", () => {
  let fixture: Awaited<ReturnType<typeof createTestDb>>;
  let actor: SessionUser;
  beforeAll(async () => {
    fixture = await createTestDb();
    const [me, other] = await fixture.db.insert(users).values([{ name: "排序核对", roles: ["pmc"] }, { name: "他人", roles: ["ops"] }]).returning();
    actor = { id: me.id, name: me.name, roles: ["pmc"], isApprover: false };
    await fixture.db.insert(workItems).values(Array.from({ length: 25 }, (_, i) => ({
      title: `item-${i}`, assigneeId: me.id, assignerId: other.id, createdBy: other.id,
      status: (["cancelled", "done", "in_progress", "open"] as const)[i % 4],
      completedAt: i % 4 === 1 ? new Date(Date.UTC(2026, 8, i + 2)) : null,
      priority: (["low", "normal", "high"] as const)[i % 3],
      dueDate: i === 0 ? null : `2026-09-${String(i).padStart(2, "0")}`,
      createdAt: new Date(Date.UTC(2026, 8, i + 1)),
    })));
    await fixture.db.insert(workItems).values({ title: "不可见项", assigneeId: other.id, assignerId: other.id, createdBy: other.id, priority: "high", dueDate: "2000-01-01" });
  });
  afterAll(async () => { await fixture?.client.close(); });
  const list = (sortBy?: string, sortOrder?: string, page = 1) => listWorkItems({ view: "all", page, pageSize: 10, sortBy, sortOrder } as Parameters<typeof listWorkItems>[0], actor, fixture.db);
  it("finds the earliest deadline across statuses, not only the already-fetched page", async () => {
    const result = await list("dueDate", "asc");
    expect(result.total).toBe(25);
    expect(result.rows.map(r => r.dueDate)).toEqual(Array.from({ length: 10 }, (_, i) => `2026-09-${String(i + 1).padStart(2, "0")}`));
  });
  it("keeps missing deadlines last in both directions and pages without duplicates", async () => {
    for (const order of ["asc", "desc"]) {
      const pages = await Promise.all([1, 2, 3].map(page => list("dueDate", order, page)));
      const rows = pages.flatMap(page => page.rows);
      expect(new Set(rows.map(r => r.id)).size).toBe(25);
      expect(rows.at(-1)?.dueDate).toBeNull();
      expect(rows[0].dueDate).toBe(order === "asc" ? "2026-09-01" : "2026-09-24");
    }
  });
  it("sorts by the actual workflow status, reversible across the entire queue", async () => {
    expect((await list("status", "desc")).rows[0].status).toBe("cancelled");
    expect((await list("status", "asc")).rows[0].status).toBe("open");
  });
  it("supports priority and created-time sorting independent of status", async () => {
    expect((await list("priority", "asc")).rows.slice(0, 8).every(r => r.priority === "high")).toBe(true);
    expect((await list("priority", "desc")).rows.slice(0, 9).every(r => r.priority === "low")).toBe(true);
    expect((await list("createdAt", "desc")).rows[0].title).toBe("item-24");
  });
  it.each([["arbitrarySql", "asc"], ["priority", "drop table"], [undefined, "desc"]])("rejects invalid sort %s/%s instead of silently ignoring it", async (field, order) => {
    await expect(list(field, order)).rejects.toMatchObject({ status: 400 });
  });
});
