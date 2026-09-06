import { describe, expect, it } from "vitest";
import { identityBulkPayload, identityBulkReport, mergeIdentityBulk, unconfirmedIdentityBulk, type IdentityBulkKind } from "@/app/(app)/report/decision-studio/identity-bulk-result";
const item = { skuId: 42, skuCode: "QA-42", shopName: "QA", platformSkuId: "external-42", barcode: "4006381333931" };
const response = { total: 1, claimed: 1, alreadyClaimed: 0, failed: 0, readModels: "refreshed", results: [{ ...item, ok: true, created: true }] };
describe("identity bulk result binds every result to the reviewed submission", () => {
  it.each(["tmall", "pdd", "barcode"] as const)("%s payload contains only intended write fields", kind => {
    const payload = identityBulkPayload(kind, [item]);
    expect(JSON.stringify(payload)).not.toContain("skuCode");
    expect(payload.items[0]).toEqual(kind === "barcode" ? { skuId: 42, barcode: item.barcode }
      : { skuId: 42, shopName: "QA", platformSkuId: "external-42", ...(kind === "pdd" ? { platform: "pdd" } : {}) });
  });
  it("maps actual barcode fill and unchanged results separately", () => {
    expect(identityBulkReport("barcode", [item], { filled: 0, unchanged: 1, conflicts: 0, readModels: "deferred", results: [{ skuId: 42, status: "unchanged" }] }))
      .toMatchObject({ readModels: "deferred", rows: [{ status: "unchanged" }] });
  });
  it.each([
    null, {}, { ...response, results: [] }, { ...response, claimed: 0 },
    { ...response, readModels: "pretend" },
    { ...response, results: [{ ...response.results[0], skuId: 99 }] },
    { ...response, results: [{ ...response.results[0], shopName: "another shop" }] },
    { ...response, results: [{ ...response.results[0], platformSkuId: "another identity" }] },
    { ...response, results: [{ ...response.results[0], created: undefined }] },
  ])("rejects missing, inconsistent or foreign results instead of counting them as success", bad => {
    expect(() => identityBulkReport("tmall", [item], bad)).toThrow(/结果未确认/);
  });
  it("legacy/unknown errors are not blindly retryable or displayed as raw SQL", () => {
    const result = identityBulkReport("tmall", [item], { ...response, claimed: 0, failed: 1, results: [{ ...item, ok: false, error: "SQL: private value" }] });
    expect(result.rows[0].status).toBe("unconfirmed");
    expect(JSON.stringify(result)).not.toContain("SQL");
  });
  it.each(["tmall", "pdd", "barcode"] as IdentityBulkKind[])("%s retry merges only attempted rows and retains earlier successes", kind => {
    const second = { ...item, skuId: 99, skuCode: "QA-99" };
    const before = unconfirmedIdentityBulk(kind, [item, second]);
    before.rows[0].status = "saved";
    before.rows[1].status = "rejected";
    const retry = unconfirmedIdentityBulk(kind, [second]);
    const after = mergeIdentityBulk(before, retry);
    expect(after.rows.map(row => row.status)).toEqual(["saved", "unconfirmed"]);
    expect(before.rows[1].status).toBe("rejected");
    expect(after.rows).toHaveLength(2);
  });
});
