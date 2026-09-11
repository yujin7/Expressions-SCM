import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { auditLogs, notifications, users, workItems } from "@/db/schema";
import type { SessionUser } from "@/server/core/dto";
import type { AnyDb } from "@/server/core/svc";
import { createWorkItem, patchWorkItem, setWorkItemStatus } from "@/server/modules/todo/service";
import { dispatchNotifications } from "@/jobs/notify";
import { createTestDb, type TestDb } from "../helpers/db";

// No external configuration or HTTP is used. Enqueue and SQL writes stay real;
// delivery availability is synthetic and dispatch always receives an explicit sender.
vi.mock("@/jobs/notify", async (original) => ({
  ...await original<typeof import("@/jobs/notify")>(),
  isFeishuAppConfigured: () => true,
}));

describe("待办 + 审计 + outbox 同事务，不以 best-effort 隐藏丢通知", () => {
  let db: TestDb;
  let client: Awaited<ReturnType<typeof createTestDb>>["client"];
  let admin: SessionUser;
  let assigneeId: number;
  let otherId: number;
  let sequence = 0;

  beforeAll(async () => {
    ({ db, client } = await createTestDb());
    const seeded = await db.insert(users).values([
      { name: "合成管理员", roles: ["admin"] },
      { name: "合成责任人", roles: ["pmc"], feishuUnionId: "synthetic_union_a" },
      { name: "合成新责任人", roles: ["pmc"], feishuUnionId: "synthetic_union_b" },
    ]).returning();
    admin = { id: seeded[0].id, name: seeded[0].name, roles: ["admin"], isApprover: false };
    assigneeId = seeded[1].id;
    otherId = seeded[2].id;
  });
  afterEach(async () => {
    await client.exec("DROP TRIGGER IF EXISTS test_todo_outbox_failure ON notifications; DROP FUNCTION IF EXISTS test_todo_outbox_failure();");
  });
  afterAll(async () => { await client?.close(); });

  async function snapshot(target: AnyDb = db) {
    return {
      items: await target.select().from(workItems).orderBy(workItems.id),
      audits: await target.select().from(auditLogs).orderBy(auditLogs.id),
      outbox: await target.select().from(notifications).orderBy(notifications.id),
    };
  }

  async function scenario(kind: "create" | "reopen" | "reassign") {
    const input = { title: `合成原子入队-${++sequence}`, assigneeId, sourceKind: "review" as const, sourceRef: `atomic-${sequence}` };
    if (kind === "create") return (target: AnyDb) => createWorkItem(input, admin, target);
    const { item } = await createWorkItem(input, admin, db);
    if (kind === "reopen") {
      await setWorkItemStatus(item.id, "done", admin, db);
      return (target: AnyDb) => createWorkItem(input, admin, target);
    }
    return (target: AnyDb) => patchWorkItem(item.id, { assigneeId: otherId, status: "done" }, admin, target);
  }

  async function failChannel(channel: "in_app" | "feishu") {
    // Fixed enum in an isolated test DB; no production connection or immutable-table mutation.
    await client.exec(`
      CREATE FUNCTION test_todo_outbox_failure() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.channel = '${channel}' THEN RAISE EXCEPTION 'synthetic outbox insert failure'; END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER test_todo_outbox_failure BEFORE INSERT ON notifications
      FOR EACH ROW EXECUTE FUNCTION test_todo_outbox_failure();
    `);
  }

  it.each(["create", "reopen", "reassign"] as const)("%s：业务回调返回前两渠道已入同一事务；提交前中断全部回滚", async (kind) => {
    const act = await scenario(kind);
    const before = await snapshot();
    const interrupted = new Proxy(db, {
      get(target, key, receiver) {
        if (key !== "transaction") return Reflect.get(target, key, receiver);
        return (callback: (tx: AnyDb) => Promise<unknown>) => db.transaction(async (tx) => {
          await callback(tx);
          const inside = await snapshot(tx);
          expect(inside.outbox).toHaveLength(before.outbox.length + 2);
          expect(inside.outbox.slice(-2).map((row: typeof notifications.$inferSelect) => row.status)).toEqual(["pending", "pending"]);
          throw new Error("synthetic interruption before commit");
        });
      },
    });
    await expect(act(interrupted)).rejects.toThrow("synthetic interruption before commit");
    expect(await snapshot()).toEqual(before);
  });

  it.each([
    ["create", "in_app"], ["create", "feishu"],
    ["reopen", "in_app"], ["reopen", "feishu"],
    ["reassign", "in_app"], ["reassign", "feishu"],
  ] as const)("%s：%s 数据库入队失败不返回假成功；事项/审计/另一渠道一起回滚", async (kind, channel) => {
    const act = await scenario(kind);
    const before = await snapshot();
    await failChannel(channel);
    await expect(act(db)).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
  });

  it("已提交后发送失败不撤销事项，持久 failed 行可被后续分发重试且不再创建通知", async () => {
    const { item } = await createWorkItem({ title: "合成发送重试", assigneeId }, admin, db);
    const before = await snapshot();
    const failingSender = { sendText: vi.fn().mockRejectedValue(new Error("synthetic network failure")) };
    await dispatchNotifications(db, { webhookUrl: null, appClient: failingSender });
    const failed = await snapshot();
    expect(failed.items).toEqual(before.items);
    expect(failed.audits).toEqual(before.audits);
    expect(failed.outbox).toHaveLength(before.outbox.length);
    const key = `task:${item.id}:assigned:feishu`;
    expect(failed.outbox.find((row: typeof notifications.$inferSelect) => row.dedupeKey === key)).toMatchObject({ status: "failed", attemptCount: 1 });
    const succeedingSender = { sendText: vi.fn().mockResolvedValue({}) };
    await dispatchNotifications(db, { webhookUrl: null, appClient: succeedingSender });
    const retried = await snapshot();
    expect(retried.items).toEqual(before.items);
    expect(retried.audits).toEqual(before.audits);
    expect(retried.outbox).toHaveLength(before.outbox.length);
    expect(retried.outbox.find((row: typeof notifications.$inferSelect) => row.dedupeKey === key)).toMatchObject({ status: "sent", attemptCount: 2 });
    expect(succeedingSender.sendText.mock.calls.some(([payload]) => payload.receiveId === "synthetic_union_a")).toBe(true);
  });

  it("自身事项和 active 指纹重放无需通知，通知表故障也不制造额外业务变更", async () => {
    const input = { title: "合成幂等", assigneeId, sourceKind: "alert" as const, sourceRef: `noop-${++sequence}` };
    const created = await createWorkItem(input, admin, db);
    const before = await snapshot();
    await failChannel("in_app");
    expect((await createWorkItem(input, admin, db)).created).toBe(false);
    expect(await snapshot()).toEqual(before);
    const self = await createWorkItem({ title: "合成自留", assigneeId: admin.id }, admin, db);
    expect(self.created).toBe(true);
    expect((await snapshot()).outbox).toEqual(before.outbox);
    expect(created.created).toBe(true);
  });

  it("告警来源仍仅入站内队列，不因为原子化重复发送飞书", async () => {
    await failChannel("feishu");
    const { item } = await createWorkItem({ title: "合成告警去重", assigneeId, sourceKind: "alert", sourceRef: `alert-${++sequence}` }, admin, db);
    const rows = await db.select().from(notifications).where(eq(notifications.dedupeKey, `task:${item.id}:assigned`));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ channel: "in_app", status: "pending", userId: assigneeId });
  });
});
