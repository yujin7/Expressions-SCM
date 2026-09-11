import { expect, it } from "vitest";
import { businessDateSchema } from "@/server/core/business-date-schema";
import { supplierSchema } from "@/server/modules/master/schemas";
import { createShSchema } from "@/server/modules/matflow/schemas";
import { createWoSchema, generateDocsSchema } from "@/server/modules/outsource/schemas";
import { jgPlanSchema, jgReviseDueSchema } from "@/server/modules/outsource/jg";
import { auditQuerySchema } from "@/server/modules/admin/audit";
import { releaseSnapshotsBody } from "@/server/modules/release/schemas";
import { createFeeRef, updateFeeRef } from "@/server/modules/master/feeref";
import { recordDataProductOutcome } from "@/server/modules/report/data-product-outcome";

const fields = [
  ["supplier licence", supplierSchema.innerType().shape.licenseExpiry],
  ["receipt production", createShSchema.shape.lines.element.shape.prodDate],
  ["work order due", createWoSchema.shape.dueDate],
  ["generated JG due", generateDocsSchema.shape.jg.unwrap().shape.dueDate],
  ["JG requested packaging", jgPlanSchema.shape.pkgRequiredDate],
  ["JG supplier reply", jgPlanSchema.shape.pkgSupplierReplyDate],
  ["JG packaging ready", jgPlanSchema.shape.pkgReadyDate],
  ["JG revised due", jgReviseDueSchema.shape.newDate],
  ["snapshot business date", releaseSnapshotsBody.shape.bizDate],
] as const;
it.each(fields)("%s rejects impossible calendar dates without throwing from safeParse", (_name, schema) => {
  for (const value of ["2026-02-29", "2026-04-31", "2026-13-01", "2026-00-01", "0000-01-01", "bad"]) {
    expect(schema.safeParse(value).success).toBe(false);
  }
  expect(schema.safeParse("2024-02-29").success).toBe(true);
});
it("shared validator respects leap-century rules and bounded four-digit years", () => {
  for (const value of ["1900-02-29", "2100-02-29", "10000-01-01"]) expect(businessDateSchema.safeParse(value).success).toBe(false);
  expect(businessDateSchema.parse("2000-02-29")).toBe("2000-02-29");
});
it("audit bounds reject invalid/reversed dates and retain inclusive same-day windows", () => {
  expect(auditQuerySchema.safeParse({ from: "2026-09-12", to: "2026-09-11" }).success).toBe(false);
  expect(auditQuerySchema.safeParse({ from: "2026-02-29" }).success).toBe(false);
  expect(auditQuerySchema.safeParse({ from: "2024-02-29", to: "2024-02-29" }).success).toBe(true);
});
it("fee-reference create and update reject invalid dates before opening any database", async () => {
  await expect(createFeeRef({ id: 1 }, { skuId: 1, supplierId: 1, effectiveDate: "2026-02-29" })).rejects.toMatchObject({ name: "ZodError" });
  await expect(updateFeeRef({ id: 1 }, 1, { effectiveDate: "2026-04-31" })).rejects.toMatchObject({ name: "ZodError" });
});
it("outcome recording rejects impossible business dates before resolving a product or database", async () => {
  await expect(recordDataProductOutcome({ id: 1, name: "QA", roles: ["admin"], isApprover: false }, {
    productId: "qa", decisionRef: "QA-123", businessDate: "2026-02-29", decision: "accepted", result: "pending",
    note: "日期测试", idempotencyKey: "00000000-0000-4000-8000-000000000001",
  })).rejects.toMatchObject({ name: "ZodError" });
});
