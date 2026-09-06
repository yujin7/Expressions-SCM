import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import * as schema from "@/db/schema";
import type { SessionUser } from "@/server/core/dto";
import { createTestDb, type TestDb } from "../helpers/db";

const mocks = vi.hoisted(() => ({ db: null as unknown, user: null as unknown }));
vi.mock("@/db", () => ({ getDbAsync: vi.fn(async () => mocks.db) }));
vi.mock("@/server/modules/master/common", async (original) => ({
  ...await original<typeof import("@/server/modules/master/common")>(), guardRead: async () => mocks.user,
}));
import { GET } from "@/app/api/alerts/route";
import { computeExceptions, getWorkbenchFocus } from "@/server/modules/workbench/focus";
import { runExceptionNotify } from "@/jobs/notify";

describe("workbench alert counts are pending queues, not fresh risk facts", () => {
  let db: TestDb;
  let client: { close(): Promise<void> };
  let user: SessionUser;
  let channelA: number;
  let channelB: number;
  beforeAll(async () => {
    ({ db, client } = await createTestDb()); mocks.db = db;
    const [actor] = await db.insert(schema.users).values({ name: "队列核对计划员", roles: ["pmc"] }).returning();
    user = { id: actor.id, name: actor.name, roles: ["pmc"], isApprover: false };
    const channels = await db.insert(schema.channels).values([
      { code: "scope-a", name: "渠道A", kind: "platform" }, { code: "scope-b", name: "渠道B", kind: "platform" },
    ]).returning();
    channelA = channels[0].id; channelB = channels[1].id;
    await db.insert(schema.aliases).values([
      { aliasType: "channel", scope: "JIANDAOYUN", rawValue: "店A", targetId: channelA },
      { aliasType: "channel", scope: "JIANDAOYUN", rawValue: "店B", targetId: channelB },
    ]);
    await db.insert(schema.systemAlerts).values([
      ...["店A", "店B", "未映射店"].map((shop) => ({
        category: "sales_spike", refKey: `${shop}|SKU`, dedupeKey: `sales_spike:platform:${shop}|SKU`,
        title: "历史爆单", detail: "只描述当时证据", severity: "critical", status: "open",
        lastHitAt: new Date("2020-01-01T00:00:00Z"), paramsSnapshot: { consecutiveDays: 5 },
      })),
      { category: "sales_spike", refKey: "mixed", dedupeKey: "sales_spike:sku:99", title: "跨店", detail: "店铺 店A、店B；历史", status: "open" },
      ...["doc_aging", "inventory_cover", "data_freshness"].map((category) => ({
        category, refKey: category, dedupeKey: category, title: "历史未关", status: "open", lastHitAt: new Date("2020-01-01T00:00:00Z"),
      })),
      { category: "sales_spike", refKey: "closed", dedupeKey: "closed", title: "已关", status: "resolved" },
    ]);
  });
  afterAll(async () => client.close());

  async function targetTotal(href: string, actor = user) {
    mocks.user = actor;
    const response = await GET(new NextRequest(`http://scm.test${href}`));
    expect(response.status).toBe(200);
    return (await response.json()).total as number;
  }

  it("keeps historical open alerts visible without claiming a current fixed three-day spike", async () => {
    const items = await computeExceptions(db, { recordShown: false });
    const spike = items.find((i) => i.key === "sales_spike")!;
    expect(spike.count).toBe(4);
    expect(spike.title).toContain("待复核");
    expect(spike.impact).toContain("4 条未关闭告警");
    expect(spike.impact).toContain("未关闭不代表当前仍在爆单");
    expect(spike.impact).not.toContain("连续 3 天");
    expect((await db.select().from(schema.systemAlerts)).filter((r) => r.status === "open")).toHaveLength(7);
    expect(await db.select().from(schema.alertEvents)).toHaveLength(0);
  });

  it("all four queue cards link to precisely the rows counted, not a newer analytical read model", async () => {
    const items = await computeExceptions(db, { recordShown: false });
    for (const [key, category] of [["doc_aging", "doc_aging"], ["sales_spike", "sales_spike"], ["inventory_cover", "inventory_cover"], ["stale_data", "data_freshness"]]) {
      const item = items.find((i) => i.key === key)!;
      expect(item.impact).toContain("条未关闭告警");
      expect(item.href).toBe(`/alerts?category=${category}&status=open`);
      expect(await targetTotal(item.href)).toBe(item.count);
    }
  });

  it("restricted workbench counts match the alert list, excluding mixed and unmapped shops", async () => {
    const restricted: SessionUser = { ...user, channelScope: [channelA] };
    const focus = await getWorkbenchFocus(restricted.roles, db, restricted);
    const spike = focus.exceptions.find((i) => i.key === "sales_spike")!;
    expect(spike.count).toBe(1);
    expect(await targetTotal(spike.href, restricted)).toBe(1);
    const queue = focus.queues.find((q) => q.key === "alerts")!;
    expect(queue.count).toBe(4);
    expect(await targetTotal(queue.href, restricted)).toBe(queue.count);
  });

  it("never reuses a global memo for channel-restricted counts or a different scope", async () => {
    await computeExceptions(db, { memoMs: 60_000 });
    for (const [scope, expected] of [[[channelA], 1], [[channelB], 1], [[], 0]] as [number[], number][]) {
      const items = await computeExceptions(db, { memoMs: 60_000, user: { ...user, channelScope: scope }, recordShown: false });
      expect(items.find((i) => i.key === "sales_spike")?.count ?? 0).toBe(expected);
    }
    const admin = await computeExceptions(db, { memoMs: 60_000, user: { ...user, roles: ["admin"], channelScope: [] }, recordShown: false });
    expect(admin.find((i) => i.key === "sales_spike")?.count).toBe(4);
  });

  it("shared notification content names the global pending queue and remains deduplicated", async () => {
    const first = await runExceptionNotify(db);
    expect(first.enqueued).toBe(4);
    expect((await runExceptionNotify(db)).enqueued).toBe(0);
    const notes = await db.select().from(schema.notifications);
    const spike = notes.find((n) => n.dedupeKey?.startsWith("sales_spike:"))!;
    expect(spike.body).toContain("全局 4 条未关闭告警");
    expect(spike.body).toContain("列表按查看者权限展示");
    expect(spike.body).not.toContain("连续 3 天");
    expect(spike.href).toBe("/alerts?category=sales_spike&status=open");
    expect(await db.select().from(schema.alertEvents)).toHaveLength(0);
  });
});
