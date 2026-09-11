/**
 * 安全审计 S2：`ackAlert` 必须和 `closeAlert` 用同一条权限（告警 ownerRole 或 admin）。
 *
 * 修复前 ackAlert 只校验 id 合法 / 存在 / 未关闭，任何登录用户都能把**全部类别**的告警一次性"知悉"：
 * 知悉不改 status，但它清掉的是「未知悉」这个唯一的人工注意力信号——驾驶舱红线、工作台聚焦、
 * 通知作业都按 unacked 计数；而且 rules/alert-ack 在 ackResetAfterDays（缺省 7 天）内不再因再命中清知悉，
 * 等于替责任角色把警报静音一周。
 */
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import type { SessionUser } from "@/server/core/dto";
import { ackAlert, upsertAlerts } from "@/server/modules/alerts/engine";
import { createTestDb } from "../helpers/db";

const user = (id: number, roles: string[]): SessionUser => ({ id, name: roles.join("/"), roles, isApprover: false });

async function seed() {
  const { db } = await createTestDb();
  const [u] = await db.insert(schema.users).values({ name: "测试人", roles: ["admin"] }).returning();
  await upsertAlerts(db, {
    category: "sales_spike",
    candidates: [{ refKey: "S1", dedupeKey: "sales_spike:sku:1", title: "爆单", severity: "high", ownerRole: "pmc" }],
  });
  await upsertAlerts(db, {
    category: "legacy",
    candidates: [{ refKey: "L1", dedupeKey: "legacy:1", title: "无责任角色的历史告警", severity: "medium", ownerRole: null }],
  });
  const byKey = async (dedupeKey: string) => {
    const [a] = await db.select().from(schema.systemAlerts).where(eq(schema.systemAlerts.dedupeKey, dedupeKey));
    return a;
  };
  return { db, uid: u.id, owned: await byKey("sales_spike:sku:1"), ownerless: await byKey("legacy:1") };
}

describe("S2 已知悉的授权：ownerRole 或 admin", () => {
  it("仓管知悉 pmc 责任的告警 → 403，且 acked_by/acked_at 保持为空", async () => {
    const { db, uid, owned } = await seed();
    await expect(ackAlert(user(uid, ["warehouse"]), owned.id, db)).rejects.toMatchObject({ status: 403 });
    const [after] = await db.select().from(schema.systemAlerts).where(eq(schema.systemAlerts.id, owned.id));
    expect(after.ackedAt).toBeNull();
    expect(after.ackedBy).toBeNull();
    // 越权尝试也不留审计（事务整体回滚）
    expect(await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.entity, "system_alert"))).toHaveLength(0);
  });

  it("责任角色本人可以知悉：写 acked_by/acked_at + 审计 + alert_events", async () => {
    const { db, uid, owned } = await seed();
    const res = await ackAlert(user(uid, ["pmc"]), owned.id, db, "已在跟进");
    expect(res.id).toBe(owned.id);
    const [after] = await db.select().from(schema.systemAlerts).where(eq(schema.systemAlerts.id, owned.id));
    expect(after.ackedBy).toBe(uid);
    expect(after.ackedAt).not.toBeNull();
    expect(after.status).toBe("open"); // 知悉不改 status（事实闭环仍归引擎）
    const audits = await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.entity, "system_alert"));
    expect(audits.map((a) => a.action)).toEqual(["ack"]);
    const events = await db.select().from(schema.alertEvents).where(eq(schema.alertEvents.event, "ack"));
    expect(events).toHaveLength(1);
  });

  it("admin 可以知悉任何告警，包括 ownerRole 为空的历史行", async () => {
    const { db, uid, owned, ownerless } = await seed();
    await expect(ackAlert(user(uid, ["admin"]), owned.id, db)).resolves.toMatchObject({ id: owned.id });
    await expect(ackAlert(user(uid, ["admin"]), ownerless.id, db)).resolves.toMatchObject({ id: ownerless.id });
  });

  it("ownerRole 为空的历史行：非 admin 一律 403（与 closeAlert 同口径）", async () => {
    const { db, uid, ownerless } = await seed();
    for (const roles of [["pmc"], ["ops"], ["purchasing", "warehouse"]]) {
      await expect(ackAlert(user(uid, roles), ownerless.id, db)).rejects.toMatchObject({ status: 403 });
    }
  });

  it("权限先于状态判定：无权的人对已关闭告警得到 403 而不是 409（不泄露告警状态）", async () => {
    const { db, uid, owned } = await seed();
    await db.update(schema.systemAlerts).set({ status: "resolved", resolvedAt: new Date() }).where(eq(schema.systemAlerts.id, owned.id));
    await expect(ackAlert(user(uid, ["warehouse"]), owned.id, db)).rejects.toMatchObject({ status: 403 });
    await expect(ackAlert(user(uid, ["pmc"]), owned.id, db)).rejects.toMatchObject({ status: 409 });
  });
});
