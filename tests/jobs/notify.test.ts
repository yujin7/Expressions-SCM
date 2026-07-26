/** #8 通知发件箱测试（jobs/notify.ts） */
import { describe, it, expect, beforeAll } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "../helpers/db";
import { notifications } from "@/db/schema";
import { dispatchNotifications, enqueueNotification } from "@/jobs/notify";

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
});
