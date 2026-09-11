import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { ackAlert, closeAlert, upsertAlerts } from "@/server/modules/alerts/engine";
import { createTestDb } from "../helpers/db";

async function fixture() {
  const { db, client } = await createTestDb();
  const [owner, other] = await db.insert(schema.users).values([
    { name: "计划甲", roles: ["pmc"] }, { name: "计划乙", roles: ["pmc"] },
  ]).returning();
  await upsertAlerts(db, { category: "sales_spike", candidates: [
    { refKey: "REPLAY", dedupeKey: "sales_spike:replay", title: "合成告警", severity: "high", ownerRole: "pmc" },
  ] });
  const [alert] = await db.select().from(schema.systemAlerts);
  const actor = { id: owner.id, name: owner.name, roles: ["pmc"], isApprover: false };
  return { db, client, alert, actor, other: { ...actor, id: other.id, name: other.name } };
}

describe("manual alert actions keep state, event and audit consistent", () => {
  it("a real severity reset allows another acknowledgement on the same day without losing its evidence", async () => {
    const { db, client, alert, actor, other } = await fixture();
    try {
      await ackAlert(actor, alert.id, db, "首次已核实");
      const reset = await upsertAlerts(db, { category: "sales_spike", candidates: [
        { refKey: "REPLAY", dedupeKey: "sales_spike:replay", title: "风险升级", severity: "critical", ownerRole: "pmc" },
      ] });
      expect(reset.ackReset).toBe(1);
      const receipt = await ackAlert(other, alert.id, db, "升级后重新核实");
      expect(await ackAlert(actor, alert.id, db, "旧请求重放")).toEqual(receipt);
      const events = await db.select().from(schema.alertEvents).where(eq(schema.alertEvents.event, "ack"))
        .orderBy(schema.alertEvents.id);
      expect(events).toHaveLength(2);
      expect(events[0]).toMatchObject({ actorId: actor.id, note: "首次已核实" });
      expect(events[1]).toMatchObject({ actorId: other.id, note: "升级后重新核实" });
      expect(events[1].idempotencyKey).toContain(`:after:${events[0].id}`);
      const [row] = await db.select().from(schema.systemAlerts).where(eq(schema.systemAlerts.id, alert.id));
      expect(row.ackedBy).toBe(other.id);
      expect(row.ackedAt?.toISOString()).toBe(receipt.ackedAt);
      expect(await db.select().from(schema.auditLogs)).toHaveLength(2);
    } finally { await client.close(); }
  });

  it("repeated acknowledgement returns the original receipt without replacing the person, note or timestamp", async () => {
    const { db, client, alert, actor, other } = await fixture();
    try {
      const first = await ackAlert(actor, alert.id, db, "已核实");
      expect(await ackAlert(other, alert.id, db, "重放不得覆盖")).toEqual(first);
      const [row] = await db.select().from(schema.systemAlerts).where(eq(schema.systemAlerts.id, alert.id));
      expect(row.ackedBy).toBe(actor.id);expect(row.ackedAt?.toISOString()).toBe(first.ackedAt);
      const audits = await db.select().from(schema.auditLogs);
      expect(audits).toHaveLength(1);expect(audits[0].after).toMatchObject({ note: "已核实" });
      expect(await db.select().from(schema.alertEvents).where(eq(schema.alertEvents.event, "ack"))).toHaveLength(1);
      expect(row.status).toBe("open");
    } finally { await client.close(); }
  });

  it("a historical acknowledgement is not extended by a later retry", async () => {
    const { db, client, alert, actor } = await fixture();
    try {
      const original = new Date("2026-09-01T01:00:00Z");
      await db.update(schema.systemAlerts).set({ ackedAt: original, ackedBy: actor.id }).where(eq(schema.systemAlerts.id, alert.id));
      expect(await ackAlert(actor, alert.id, db)).toEqual({ id: alert.id, ackedAt: original.toISOString() });
      expect(await db.select().from(schema.auditLogs)).toHaveLength(0);
      expect(await db.select().from(schema.alertEvents).where(eq(schema.alertEvents.event, "ack"))).toHaveLength(0);
    } finally { await client.close(); }
  });

  it("replay still checks responsibility and closed status before returning a receipt", async () => {
    const { db, client, alert, actor } = await fixture();
    try {
      await ackAlert(actor, alert.id, db);
      await expect(ackAlert({ ...actor, roles: ["warehouse"] }, alert.id, db)).rejects.toMatchObject({ status: 403 });
      await closeAlert(actor, alert.id, "fixed", null, db);
      await expect(ackAlert(actor, alert.id, db)).rejects.toMatchObject({ status: 409 });
    } finally { await client.close(); }
  });

  it.each([null, "", " \n\t "])("rejects manual close without explanatory text at the service boundary: %j", async note => {
    const { db, client, alert, actor } = await fixture();
    try {
      await expect(closeAlert(actor, alert.id, "manual", note, db)).rejects.toMatchObject({ status: 400 });
      const [row] = await db.select().from(schema.systemAlerts);expect(row.status).toBe("open");
      expect(await db.select().from(schema.auditLogs)).toHaveLength(0);
      expect(await db.select().from(schema.alertEvents).where(eq(schema.alertEvents.event, "close"))).toHaveLength(0);
    } finally { await client.close(); }
  });

  it("valid manual close preserves one trimmed explanation and rejects another close", async () => {
    const { db, client, alert, actor } = await fixture();
    try {
      await closeAlert(actor, alert.id, "manual", "  合成QA已核对  ", db);
      await expect(closeAlert(actor, alert.id, "fixed", "不得覆盖", db)).rejects.toMatchObject({ status: 409 });
      const events = await db.select().from(schema.alertEvents).where(eq(schema.alertEvents.event, "close"));
      expect(events).toHaveLength(1);expect(events[0]).toMatchObject({ reasonCode: "manual", note: "合成QA已核对" });
      expect(await db.select().from(schema.auditLogs)).toHaveLength(1);
    } finally { await client.close(); }
  });
});
