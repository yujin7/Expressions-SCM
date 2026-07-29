/** #8 通知发件箱测试（jobs/notify.ts） */
import { describe, it, expect, beforeAll } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "../helpers/db";
import * as schema from "@/db/schema";
import { notifications } from "@/db/schema";
import {
  dispatchNotifications,
  enqueueNotification,
  runDecisionDigestNotify,
} from "@/jobs/notify";

describe("通知发件箱", () => {
  let db: TestDb;
  beforeAll(async () => {
    ({ db } = await createTestDb());
  });

  it("enqueue 幂等：同 dedupeKey 只入队一次", async () => {
    const a = await enqueueNotification(db, { channel: "in_app", title: "t", body: "b", dedupeKey: "k1:2026-07-24" });
    const b = await enqueueNotification(db, { channel: "in_app", title: "t", body: "b", dedupeKey: "k1:2026-07-24" });
    expect(a).toBe(true);
    expect(b).toBe(false);
    const rows = await db.select().from(notifications).where(eq(notifications.dedupeKey, "k1:2026-07-24"));
    expect(rows.length).toBe(1);
  });

  it("dispatch：in_app 直接 sent；feishu 无 URL → skipped", async () => {
    await enqueueNotification(db, { channel: "in_app", title: "站内", body: "b", dedupeKey: "in:1" });
    await enqueueNotification(db, { channel: "feishu", title: "飞书", body: "b", dedupeKey: "fs:1" });
    const s = await dispatchNotifications(db, { webhookUrl: null });
    expect(s.sent).toBeGreaterThanOrEqual(1); // 至少 in_app 那条（含前一测试的 k1）
    expect(s.skipped).toBeGreaterThanOrEqual(1); // 飞书无 URL
    const [fs] = await db.select().from(notifications).where(eq(notifications.dedupeKey, "fs:1"));
    expect(fs.status).toBe("skipped");
    expect(fs.error).toContain("FEISHU_WEBHOOK_URL");
    const [inapp] = await db.select().from(notifications).where(eq(notifications.dedupeKey, "in:1"));
    expect(inapp.status).toBe("sent");
    expect(inapp.sentAt).not.toBeNull();
  });

  it("dispatch：无 pending 时返回全 0", async () => {
    const s = await dispatchNotifications(db, { webhookUrl: null });
    expect(s).toEqual({ sent: 0, skipped: 0, failed: 0 });
  });

  it("dispatch：应用机器人失败时回退 webhook，仍只把 outbox 标记一次 sent", async () => {
    await enqueueNotification(db, {
      channel: "feishu",
      title: "回退",
      body: "应用发送失败",
      dedupeKey: "fs:fallback",
    });
    const appClient = { sendText: async () => { throw new Error("app unavailable"); } };
    const previousFetch = globalThis.fetch;
    const calls: unknown[] = [];
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      calls.push(init);
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    try {
      const result = await dispatchNotifications(db, {
        appClient,
        webhookUrl: "https://example.invalid/webhook",
      });
      expect(result.sent).toBe(1);
      expect(calls).toHaveLength(1);
      const [row] = await db.select().from(notifications)
        .where(eq(notifications.dedupeKey, "fs:fallback"));
      expect(row.status).toBe("sent");
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it("dispatch：网络失败行在下一轮重试，不会永久卡在 failed", async () => {
    await enqueueNotification(db, {
      channel: "feishu",
      title: "重试",
      body: "下一轮恢复",
      dedupeKey: "fs:retry",
    });
    const first = await dispatchNotifications(db, {
      appClient: { sendText: async () => { throw new Error("temporary"); } },
      webhookUrl: null,
    });
    expect(first.failed).toBe(1);
    const second = await dispatchNotifications(db, {
      appClient: { sendText: async () => ({ messageId: "ok" }) },
      webhookUrl: null,
    });
    expect(second.sent).toBe(1);
    const [row] = await db.select().from(notifications)
      .where(eq(notifications.dedupeKey, "fs:retry"));
    expect(row.status).toBe("sent");
    expect(row.error).toBeNull();
  });

  it("周度决策摘要：同一数据月只入队一次", async () => {
    const [brand] = await db.insert(schema.brands).values({
      code: "EXP",
      nameCn: "Expressions",
    }).returning();
    const [channel] = await db.insert(schema.channels).values({
      code: "tmall",
      name: "天猫",
      kind: "platform",
    }).returning();
    const [spu] = await db.insert(schema.spus).values({
      code: "P99100",
      nameCn: "摘要测试",
    }).returning();
    const [sku] = await db.insert(schema.skus).values({
      code: "CS99100",
      name: "摘要货品",
      spuId: spu.id,
      baseUom: "支",
      skuType: "finished",
      brandId: brand.id,
    }).returning();
    await db.insert(schema.salesMonthly).values([
      { skuId: sku.id, channelId: channel.id, yearMonth: "2026-06", qty: "100" },
      { skuId: sku.id, channelId: channel.id, yearMonth: "2026-07", qty: "120" },
    ]);

    const first = await runDecisionDigestNotify(db);
    const replay = await runDecisionDigestNotify(db);

    expect(first).toEqual({ enqueued: 1, month: "2026-07" });
    expect(replay).toEqual({ enqueued: 0, month: "2026-07" });
    const [row] = await db.select().from(notifications)
      .where(eq(notifications.dedupeKey, "decision-digest:2026-07"));
    expect(row.href).toBe("/report/decision-studio?tab=review");
    expect(row.targetRole).toBe("pmc");
  });
});
