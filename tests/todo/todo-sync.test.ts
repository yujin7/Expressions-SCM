import { beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { notifications, reviewItems, systemAlerts, users, workItems } from "@/db/schema";
import { runTodoSync } from "@/jobs/todo-sync";
import { createTestDb, type TestDb } from "../helpers/db";

const NOW = new Date("2026-09-03T01:00:00Z"); // 上海 09-03 09:00

describe("jobs/todo-sync：告警/复核投影为待办 + 到期提醒", () => {
  let db: TestDb;
  let adminId: number;
  let pmcId: number;

  beforeAll(async () => {
    ({ db } = await createTestDb());
    const [a] = await db.insert(users).values({ name: "管理员", roles: ["admin"], isApprover: false }).returning();
    adminId = a.id;
    const [p] = await db.insert(users).values({ name: "计划", roles: ["pmc"], isApprover: false, feishuUnionId: "on_pmc" }).returning();
    pmcId = p.id;
    await db.insert(systemAlerts).values([
      { category: "sales_spike", refKey: "sku:CP1", title: "CP1 爆单", detail: "3 天连超", severity: "high", status: "open" },
      { category: "data_freshness", refKey: "jst", title: "聚水潭过期", detail: null, severity: "medium", status: "open" },
      { category: "doc_aging", refKey: "po:PO9", title: "已解决", detail: null, severity: "high", status: "resolved" },
    ]);
    await db.insert(reviewItems).values([
      { category: "blocked_release", refType: "sku", refKey: "CP2", title: "阻断发布", status: "open" },
      { category: "spu_cluster", refType: "spu", refKey: "P1", title: "普通复核（不投影）", status: "open" },
    ]);
  });

  it("首轮：open 告警 + blocked 复核 → 待办；按责任角色指派（pmc→计划，admin→管理员）；已解决告警与普通复核不投影", async () => {
    const s = await runTodoSync(db, { now: NOW, feishuConfigured: false });
    expect(s.actorId).toBe(adminId);
    expect(s.projection).toMatchObject({ scanned: 3, created: 3, reopened: 0, matched: 0, unassigned: 0 });
    const items = await db.select().from(workItems);
    expect(items).toHaveLength(3);
    const spike = items.find((i) => i.sourceKind === "alert" && i.title === "CP1 爆单");
    expect(spike).toMatchObject({ assigneeId: pmcId, ownerRole: "pmc", priority: "high", dueDate: "2026-09-06" });
    const fresh = items.find((i) => i.title === "聚水潭过期");
    expect(fresh).toMatchObject({ assigneeId: adminId, ownerRole: "admin", priority: "normal" });
    // 告警来源 → 只有站内定向，无飞书私聊（告警已群发，避免双发）
    const fs = await db.select().from(notifications).where(eq(notifications.channel, "feishu"));
    expect(fs).toHaveLength(0);
    // 站内定向：pmc 收到爆单告警 + 阻断复核（两者责任角色都是 pmc）各一条 assigned
    const blocked = items.find((i) => i.sourceKind === "review" && i.title === "阻断发布");
    expect(blocked).toMatchObject({ assigneeId: pmcId, ownerRole: "pmc", priority: "high" });
    const inApp = await db.select().from(notifications).where(and(eq(notifications.channel, "in_app"), eq(notifications.userId, pmcId)));
    expect(inApp.map((n) => n.dedupeKey).sort()).toEqual([`task:${spike!.id}:assigned`, `task:${blocked!.id}:assigned`].sort());
  });

  it("审阅修复：来源告警关闭后其投影待办自动取消（审计 cancel），不再计入逾期", async () => {
    await db.update(systemAlerts).set({ status: "resolved", autoResolved: true, resolvedAt: NOW }).where(eq(systemAlerts.refKey, "jst"));
    const s = await runTodoSync(db, { now: new Date(NOW.getTime() + 60_000), feishuConfigured: false });
    expect(s.autoClosed).toEqual({ scanned: 1, cancelled: 1 });
    const fresh = (await db.select().from(workItems)).find((i) => i.title === "聚水潭过期");
    expect(fresh?.status).toBe("cancelled");
    // 再跑：无新的过期项
    const s2 = await runTodoSync(db, { now: new Date(NOW.getTime() + 120_000), feishuConfigured: false });
    expect(s2.autoClosed).toEqual({ scanned: 0, cancelled: 0 });
  });

  it("再跑一轮：全部命中既有项，不新建（已取消的过期项不再是候选，因为告警已 resolved）", async () => {
    const s = await runTodoSync(db, { now: NOW, feishuConfigured: false });
    expect(s.projection).toMatchObject({ created: 0, reopened: 0, matched: 2, failed: 0 });
    expect(await db.select().from(workItems)).toHaveLength(3); // 含 1 条已自动取消
  });

  it("到期提醒：今天到期/已逾期的未完成待办 → task:{id}:due:{today}，每天一次；配置飞书且绑定 union_id 时另发私聊", async () => {
    const late = new Date("2026-09-08T01:00:00Z"); // 上海 09-08：爆单待办（截止 09-06）已逾期
    const s1 = await runTodoSync(db, { now: late, feishuConfigured: true });
    expect(s1.reminders.scanned).toBeGreaterThanOrEqual(1);
    const items = await db.select().from(workItems);
    const spike = items.find((i) => i.title === "CP1 爆单")!;
    const inApp = await db.select().from(notifications).where(eq(notifications.dedupeKey, `task:${spike.id}:due:2026-09-08`));
    expect(inApp).toHaveLength(1);
    expect(inApp[0]).toMatchObject({ channel: "in_app", userId: pmcId, severity: "high" });
    const fs = await db.select().from(notifications).where(eq(notifications.dedupeKey, `task:${spike.id}:due:2026-09-08:feishu`));
    expect(fs).toHaveLength(1);
    expect(fs[0].userId).toBe(pmcId);
    // 同一天再跑：不重复
    const s2 = await runTodoSync(db, { now: late, feishuConfigured: true });
    expect(s2.reminders.enqueued).toBe(0);
  });
});
