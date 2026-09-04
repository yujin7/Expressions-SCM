import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { auditLogs, importJobs, monthCloseChecks, users } from "@/db/schema";
import type { SessionUser } from "@/server/core/dto";
import {
  getMonthCloseChecklist,
  updateMonthCloseCheck,
} from "@/server/modules/settlement/month-close";
import { createTestDb, type TestDb } from "../helpers/db";

describe("month-end six-control workflow", () => {
  let db: TestDb;
  let finance: SessionUser;

  beforeAll(async () => {
    ({ db } = await createTestDb());
    const [user] = await db
      .insert(users)
      .values({ name: "月结财务", roles: ["finance"] })
      .returning();
    finance = { id: user.id, name: user.name, roles: ["finance"], isApprover: false };
  });

  it("derives six honest controls and does not call missing evidence passed", async () => {
    const result = await getMonthCloseChecklist(
      "2026-07",
      db,
      new Date("2026-08-02T04:00:00.000Z"),
    );
    expect(result.checks).toHaveLength(6);
    /* W2-1：periodClosed 现在是 period_locks 的事实，不再是「月份小于当前月」的日历推断。
       日历意义上翻篇了，但没人关过账——所以 periodClosed=false、pastMonth=true。 */
    expect(result.periodClosed).toBe(false);
    expect(result.pastMonth).toBe(true);
    expect(result.checks.find((item) => item.key === "data_release")).toMatchObject({
      autoState: "pass",
      status: "pending",
    });
    expect(result.checks.find((item) => item.key === "inventory_count")).toMatchObject({
      autoState: "attention",
      summary: expect.stringContaining("未发现盘点任务"),
    });
    expect(result.checks.find((item) => item.key === "jst_reconciliation")).toMatchObject({
      autoState: "attention",
      summary: expect.stringContaining("未发现聚水潭对账结果"),
    });
  });

  it("allows normal completion only for passed controls and requires a waiver reason", async () => {
    const initial = await getMonthCloseChecklist("2026-07", db);
    const dataRelease = initial.checks.find((item) => item.key === "data_release")!;
    const completed = await updateMonthCloseCheck(finance, {
      month: "2026-07",
      checkKey: "data_release",
      status: "completed",
      version: dataRelease.version,
    }, db);
    expect(completed.checks.find((item) => item.key === "data_release")).toMatchObject({
      status: "completed",
      current: true,
      version: 1,
      completedByName: "月结财务",
    });

    const countCheck = completed.checks.find((item) => item.key === "inventory_count")!;
    await expect(updateMonthCloseCheck(finance, {
      month: "2026-07",
      checkKey: "inventory_count",
      status: "completed",
      version: countCheck.version,
    }, db)).rejects.toMatchObject({ status: 409 });
    await expect(updateMonthCloseCheck(finance, {
      month: "2026-07",
      checkKey: "inventory_count",
      status: "waived",
      note: "短",
      version: countCheck.version,
    }, db)).rejects.toMatchObject({ status: 400 });

    const waived = await updateMonthCloseCheck(finance, {
      month: "2026-07",
      checkKey: "inventory_count",
      status: "waived",
      note: "本月无仓库盘点安排，财务确认不适用",
      version: countCheck.version,
    }, db);
    expect(waived.checks.find((item) => item.key === "inventory_count")).toMatchObject({
      status: "waived",
      current: true,
      note: "本月无仓库盘点安排，财务确认不适用",
    });

    const logs = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.entity, "month_close_check"));
    expect(logs.map((row) => row.action)).toEqual(["completed", "waived"]);
  });

  it("automatically invalidates stale sign-off when underlying evidence changes", async () => {
    await db.insert(importJobs).values({
      template: "inventory",
      filename: "failed-july.xlsx",
      sourceAsOf: "2026-07-31",
      status: "failed",
      createdBy: finance.id,
    });
    const result = await getMonthCloseChecklist("2026-07", db);
    expect(result.checks.find((item) => item.key === "data_release")).toMatchObject({
      autoState: "blocked",
      status: "completed",
      evidenceChanged: true,
      current: false,
    });
    expect(result.progress.current).toBe(1);
  });

  it("enforces database status, key, month, and waiver invariants", async () => {
    await expect(db.insert(monthCloseChecks).values({
      month: "2026-13",
      checkKey: "data_release",
      status: "pending",
    })).rejects.toThrow();
    await expect(db.insert(monthCloseChecks).values({
      month: "2026-08",
      checkKey: "not_real",
      status: "pending",
    })).rejects.toThrow();
    await expect(db.insert(monthCloseChecks).values({
      month: "2026-08",
      checkKey: "data_release",
      status: "waived",
      completedBy: finance.id,
      completedAt: new Date(),
    })).rejects.toThrow();
  });
});
