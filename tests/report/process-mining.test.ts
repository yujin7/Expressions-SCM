import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { auditLogs, users } from "@/db/schema";
import { writeAudit } from "@/server/core/audit";
import {
  getProcessMining,
  guardProcessMining,
} from "@/server/modules/report/process-mining";
import { createTestDb } from "../helpers/db";

const admin = { id: 1, name: "管理员", roles: ["admin"], isApprover: false };
const pmc = { id: 2, name: "计划", roles: ["pmc"], isApprover: false };
const finance = { id: 3, name: "财务", roles: ["finance"], isApprover: false };
const warehouse = { id: 4, name: "仓库", roles: ["warehouse"], isApprover: false };

describe("C154 process mining service", () => {
  it("the single audit writer persists canonical event identity for every new write", async () => {
    const { db } = await createTestDb();
    await db.insert(users).values({ id: 1, name: "管理员", roles: ["admin"] });
    await writeAudit(db, {
      userId: 1,
      entity: "bh",
      entityId: 9,
      action: "approve",
      after: { docNo: "BH-CANONICAL" },
    });
    const [row] = await db.select().from(auditLogs).where(eq(auditLogs.entityId, 9));
    expect(row).toMatchObject({
      canonicalEvent: "doc.bh.approve",
      eventDomain: "doc",
      eventVersion: "event-v1",
      isStateChange: true,
    });
  });

  it("isolates roles and applies entity/window filters without rewriting legacy events", async () => {
    const { db } = await createTestDb();
    await db.insert(users).values([
      { id: 1, name: "管理员", roles: ["admin"] },
      { id: 2, name: "计划", roles: ["pmc"] },
      { id: 3, name: "财务", roles: ["finance"] },
      { id: 4, name: "仓库", roles: ["warehouse"] },
    ]);
    const values = [
      { userId: 1, entity: "bh", entityId: 1, action: "create", createdAt: new Date("2026-07-20T00:00:00Z") },
      { userId: 1, entity: "bh", entityId: 1, action: "submit", createdAt: new Date("2026-07-20T02:00:00Z") },
      { userId: 2, entity: "bh", entityId: 1, action: "approve", createdAt: new Date("2026-07-20T05:00:00Z") },
      { userId: 1, entity: "po", entityId: 2, action: "create", createdAt: new Date("2026-07-21T00:00:00Z") },
      { userId: 1, entity: "po", entityId: 2, action: "submit", createdAt: new Date("2026-07-21T01:00:00Z") },
      { userId: 1, entity: "bh", entityId: 3, action: "create", createdAt: new Date("2025-01-01T00:00:00Z") },
    ];
    await db.insert(auditLogs).values(values);
    await writeAudit(db, {
      userId: 2,
      entity: "bh",
      entityId: 4,
      action: "create",
      after: { docNo: "BH-V1" },
    });

    const now = new Date("2026-07-27T00:00:00Z");
    const all = await getProcessMining(admin, { windowDays: 30, entity: "all" }, db, now);
    expect(all.sourceEventCount).toBe(6);
    expect(all.summary.cases).toBe(3);
    expect(all.summary.analyzableCases).toBe(2);
    expect(all.summary.versionedEvents).toBe(1);

    const bh = await getProcessMining(pmc, { windowDays: 30, entity: "bh" }, db, now);
    expect(bh.summary.totalEvents).toBe(4);
    expect(bh.cases.every((item) => item.entity === "bh")).toBe(true);
    await expect(getProcessMining(warehouse, {}, db, now)).rejects.toThrow("仅管理员、生产计划或财务");
    expect(() => guardProcessMining(finance)).not.toThrow();
  });

  it("rejects unsupported windows and entity names", async () => {
    const { db } = await createTestDb();
    await expect(getProcessMining(admin, { windowDays: 7 }, db)).rejects.toThrow("窗口只支持");
    await expect(getProcessMining(admin, { entity: "user" }, db)).rejects.toThrow("不支持的流程对象");
  });
});
