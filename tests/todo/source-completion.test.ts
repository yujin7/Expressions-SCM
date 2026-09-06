import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { alertEvents, reviewItems, systemAlerts, users } from "@/db/schema";
import type { SessionUser } from "@/server/core/dto";
import { createWorkItem, setWorkItemStatus } from "@/server/modules/todo/service";
import { createTestDb, type TestDb } from "../helpers/db";

describe("完成待办与来源处置是独立的业务事实", () => {
  let db: TestDb;
  let client: { close: () => Promise<void> };
  let actor: SessionUser;
  beforeAll(async () => {
    ({ db, client } = await createTestDb());
    const [user] = await db.insert(users).values({ name: "闭环测试计划员", roles: ["pmc"] }).returning();
    actor = { id: user.id, name: user.name, roles: ["pmc"], isApprover: false };
  });
  afterAll(async () => { await client.close(); });

  it("完成来源待办不知悉/关闭告警、不通过复核、不虚增告警学习事件", async () => {
    const [alert] = await db.insert(systemAlerts).values({
      category: "inventory_cover", title: "测试库存不足", ownerRole: "pmc", status: "open",
    }).returning();
    const [review] = await db.insert(reviewItems).values({
      category: "other", title: "测试人工复核", status: "open",
    }).returning();
    for (const source of [{ kind: "alert", id: alert.id }, { kind: "review", id: review.id }] as const) {
      const created = await createWorkItem({
        title: "跟进来源事实", assigneeId: actor.id, sourceKind: source.kind, sourceRef: String(source.id),
      }, actor, db);
      const done = await setWorkItemStatus(created.item.id, "done", actor, db);
      expect(done.status).toBe("done");
    }
    expect(await db.select().from(systemAlerts).where(eq(systemAlerts.id, alert.id))).toEqual([alert]);
    expect(await db.select().from(reviewItems).where(eq(reviewItems.id, review.id))).toEqual([review]);
    expect(await db.select().from(alertEvents).where(eq(alertEvents.alertId, alert.id))).toEqual([]);
  });
});
