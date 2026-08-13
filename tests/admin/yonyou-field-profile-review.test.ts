import { describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import { getYonyouFieldProfileReview } from "@/server/modules/admin/health";
import { toCsv } from "@/server/modules/report/export";
import { createTestDb } from "../helpers/db";

describe("用友无值字段映射评审包", () => {
  it("只输出字段证据与待评审列，不泄露请求或源数据值", async () => {
    const { db } = await createTestDb();
    const [run] = await db.insert(schema.integrationRuns).values({
      connector: "yy",
      stream: "yonbip-digitalmodel-vendor-list",
      idempotencyKey: "yy:profile-review:1",
      status: "succeeded",
      requestScope: {
        contract: "供应商档案列表查询",
        schemaVersion: "yonyou-observation-v1",
        shapeFingerprint: "{data:{rows:[{bankAccount:string,code:string,mobile:string}]}}",
        schemaDrift: true,
        schemaBaselineRunId: 7,
        request: { mobile: "13800000000", password: "NEVER_EXPORT" },
        fieldProfile: {
          version: "yonyou-field-profile/v1",
          totalRecords: 2,
          sampledRecords: 2,
          fieldCount: 3,
          sensitiveFieldCount: 2,
          sensitiveCategories: ["contact", "financial"],
          truncated: false,
          fields: [
            {
              path: "bankAccount",
              types: ["string"],
              presentInRecords: 1,
              optional: true,
              nullable: false,
              sensitiveCategory: "financial",
            },
            {
              path: "code",
              types: ["string"],
              presentInRecords: 2,
              optional: false,
              nullable: false,
              sensitiveCategory: null,
            },
            {
              path: "=formula-like-field",
              types: ["null", "string"],
              presentInRecords: 2,
              optional: false,
              nullable: true,
              sensitiveCategory: "contact",
            },
          ],
        },
      },
      sourceRows: 2,
      stagedRows: 2,
      startedAt: new Date("2026-08-13T00:00:00.000Z"),
      finishedAt: new Date("2026-08-13T00:01:00.000Z"),
    }).returning();

    const review = await getYonyouFieldProfileReview(run.id, db);
    expect(review).toMatchObject({
      runId: run.id,
      stream: "yonbip-digitalmodel-vendor-list",
      contract: "供应商档案列表查询",
      schemaVersion: "yonyou-observation-v1",
      schemaDrift: true,
      schemaBaselineRunId: 7,
      totalRecords: 2,
      sampledRecords: 2,
      fieldCount: 3,
      sensitiveFieldCount: 2,
      truncated: false,
    });
    expect(review.shapeFingerprintHash).toMatch(/^[0-9a-f]{64}$/);
    expect(review.rows).toEqual([
      expect.objectContaining({
        fieldPath: "bankAccount",
        coveragePercent: "50.0%",
        optional: true,
        sensitiveCategory: "financial",
        sensitiveCategoryLabel: "财务",
        mappingStatus: "待评审",
        targetField: "",
      }),
      expect.objectContaining({
        fieldPath: "code",
        coveragePercent: "100.0%",
        sensitiveCategory: "",
        sensitiveCategoryLabel: "非敏感",
      }),
      expect.objectContaining({
        fieldPath: "=formula-like-field",
        types: "null | string",
        nullable: true,
      }),
    ]);
    const serialized = JSON.stringify(review);
    expect(serialized).not.toContain("13800000000");
    expect(serialized).not.toContain("NEVER_EXPORT");
    expect(serialized).not.toContain("request");
    expect(serialized).not.toContain("shapeFingerprint\"");

    const csv = toCsv(review.rows as unknown as Record<string, unknown>[], [
      { key: "fieldPath", title: "字段路径" },
    ]);
    expect(csv).toContain("'=formula-like-field");
  });

  it("拒绝非用友运行和损坏画像", async () => {
    const { db } = await createTestDb();
    const [jst] = await db.insert(schema.integrationRuns).values({
      connector: "jst",
      stream: "inventory-total-delta",
      idempotencyKey: "jst:not-yonyou",
      status: "succeeded",
      finishedAt: new Date("2026-08-13T00:01:00.000Z"),
    }).returning();
    await expect(getYonyouFieldProfileReview(jst.id, db))
      .rejects.toThrow(/不是用友字段观察批次/);

    const [broken] = await db.insert(schema.integrationRuns).values({
      connector: "yy",
      stream: "broken",
      idempotencyKey: "yy:broken-profile",
      status: "succeeded",
      finishedAt: new Date("2026-08-13T00:01:00.000Z"),
      requestScope: {
        fieldProfile: {
          version: "yonyou-field-profile/v1",
          totalRecords: 1,
          sampledRecords: 1,
          fieldCount: 2,
          sensitiveFieldCount: 0,
          fields: [],
        },
      },
    }).returning();
    await expect(getYonyouFieldProfileReview(broken.id, db))
      .rejects.toThrow(/画像损坏或超出受控范围/);
  });
});
