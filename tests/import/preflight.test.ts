import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import {
  assertImportPreflight,
  getImportPreflight,
  type ReleaseUser,
} from "@/server/modules/release/engine";
import { writeStagingRows } from "@/server/import/staging";
import { createTestDb } from "../helpers/db";

const finance: ReleaseUser = {
  id: 1,
  name: "财务",
  roles: ["finance"],
  isApprover: true,
};

async function seedJob(
  db: Awaited<ReturnType<typeof createTestDb>>["db"],
  args: {
    template: string;
    filename: string;
    status: "done";
    rowStatus: "validated" | "committed";
    quantities: number[];
    scope?: Record<string, unknown> | null;
  },
) {
  const [job] = await db
    .insert(schema.importJobs)
    .values({
      template: args.template,
      filename: args.filename,
      status: args.status,
      controlRows: args.quantities.length,
      createdBy: finance.id,
      scope: args.scope ?? null,
    })
    .returning({ id: schema.importJobs.id });
  await writeStagingRows(
    db,
    job.id,
    args.quantities.map((qty, index) => ({
      rowNo: index + 1,
      targetTable: "sales_monthly",
      payload: {
        skuCode: `SKU-${index + 1}`,
        channelRaw: "天猫",
        yearMonth: "2026-07",
        qty,
        _resolved: { skuId: index + 1 },
      },
      status: "validated" as const,
    })),
  );
  if (args.rowStatus === "committed") {
    await db
      .update(schema.stagingRows)
      .set({ status: "committed" })
      .where(eq(schema.stagingRows.importJobId, job.id));
  }
  return job;
}

describe("E3-13 导入版本预检", () => {
  it("比较最近已放行同范围版本，数量偏差超过 30% 时生成稳定阻塞 token", async () => {
    const { db } = await createTestDb();
    await db.insert(schema.users).values({ id: finance.id, name: finance.name });
    const baseline = await seedJob(db, {
      template: "sales",
      filename: "sales-june.xlsx",
      status: "done",
      rowStatus: "committed",
      quantities: Array.from({ length: 10 }, () => 100),
      scope: { mode: "full", brand: "EXP" },
    });
    const current = await seedJob(db, {
      template: "sales",
      filename: "sales-july.xlsx",
      status: "done",
      rowStatus: "validated",
      quantities: Array.from({ length: 10 }, () => 150),
      scope: { brand: "EXP", mode: "full" },
    });

    const first = await getImportPreflight(db, current.id);
    const second = await getImportPreflight(db, current.id);
    expect(first).toMatchObject({
      status: "blocked",
      baselineJobId: baseline.id,
      currentRows: 10,
      baselineRows: 10,
      addedRows: 10,
      removedRows: 10,
      unchangedRows: 0,
    });
    expect(first.reasons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          bucket: "sales_monthly",
          metric: "qty:qty",
          driftPct: "50.00",
        }),
      ]),
    );
    expect(first.token).toMatch(/^[a-f0-9]{64}$/);
    expect(second.token).toBe(first.token);
  });

  it("无说明或陈旧 token 均拒绝执行；正确说明被追加审计", async () => {
    const { db } = await createTestDb();
    await db.insert(schema.users).values({ id: finance.id, name: finance.name });
    await seedJob(db, {
      template: "sales",
      filename: "sales-june.xlsx",
      status: "done",
      rowStatus: "committed",
      quantities: Array.from({ length: 10 }, () => 100),
    });
    const current = await seedJob(db, {
      template: "sales",
      filename: "sales-july.xlsx",
      status: "done",
      rowStatus: "validated",
      quantities: Array.from({ length: 10 }, () => 200),
    });
    const preflight = await getImportPreflight(db, current.id);

    await expect(
      assertImportPreflight(db, finance, {
        jobIds: [current.id],
        dryRun: false,
      }),
    ).rejects.toMatchObject({ status: 409, code: "IMPORT_PREFLIGHT_BLOCKED" });
    await expect(
      assertImportPreflight(db, finance, {
        jobIds: [current.id],
        dryRun: false,
        preflightOverrides: {
          [String(current.id)]: { token: "0".repeat(64), reason: "已经核对范围" },
        },
      }),
    ).rejects.toMatchObject({ status: 409 });

    await assertImportPreflight(db, finance, {
      jobIds: [current.id],
      dryRun: false,
      preflightOverrides: {
        [String(current.id)]: {
          token: preflight.token,
          reason: "已经核对本月活动放量，增幅符合业务计划",
        },
      },
    });
    const audits = await db
      .select()
      .from(schema.auditLogs)
      .where(eq(schema.auditLogs.action, "preflight_override"));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      entity: "import_job",
      entityId: current.id,
      userId: finance.id,
    });
    expect(audits[0].after).toEqual(
      expect.objectContaining({
        reason: "已经核对本月活动放量，增幅符合业务计划",
      }),
    );
  });

  it("scope 不同或没有历史已放行行时不伪造基线", async () => {
    const { db } = await createTestDb();
    await db.insert(schema.users).values({ id: finance.id, name: finance.name });
    await seedJob(db, {
      template: "bom",
      filename: "ning.xlsx",
      status: "done",
      rowStatus: "committed",
      quantities: Array.from({ length: 12 }, () => 1),
      scope: { mode: "full", brandCode: "NING" },
    });
    const current = await seedJob(db, {
      template: "bom",
      filename: "expressions.xlsx",
      status: "done",
      rowStatus: "validated",
      quantities: Array.from({ length: 20 }, () => 1),
      scope: { mode: "full", brandCode: "EXP" },
    });

    const result = await getImportPreflight(db, current.id);
    expect(result.status).toBe("baseline_missing");
    expect(result.baselineJobId).toBeNull();
  });
});
