import { describe, expect, it, vi } from "vitest";
const logger = vi.hoisted(() => vi.fn());
vi.mock("@/server/core/logger", () => ({ log: logger, persistErrorLog: vi.fn() }));
import { identityBulkError } from "@/server/modules/master/identity-bulk-error";
import { ApiError } from "@/server/modules/master/common";
const context = { operation: "claim" as const, userId: 1, skuId: 42 };
describe("bulk identity errors preserve business refusal, not SQL or false certainty", () => {
  it.each([400, 403, 404, 409])("keeps an explicit %s business refusal actionable", status => {
    expect(identityBulkError(new ApiError(status, "请先人工裁决归属"), context)).toEqual({ error: "请先人工裁决归属", errorKind: "business" });
  });
  it.each([new Error("SQL params: private-value"), new ApiError(500, "internal secret"), null])("does not expose unexpected errors or claim rollback", error => {
    logger.mockClear();
    const result = identityBulkError(error, context);
    expect(result.errorKind).toBe("unconfirmed");
    expect(result.error).toContain("勿重复提交");
    expect(JSON.stringify(result)).not.toMatch(/private-value|internal secret|SQL params/);
    expect(JSON.stringify(logger.mock.calls)).not.toMatch(/private-value|internal secret|SQL params/);
    expect(logger).toHaveBeenCalledOnce();
  });
});
