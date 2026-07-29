import { describe, expect, it } from "vitest";
import { EXPIRY_TIER_DAYS } from "@/server/core/stock-view";
import { expiryBucketOf } from "@/server/modules/inventory/expiry-list";

describe("效期批次七段位", () => {
  it("在每个共享阈值边界前后落入唯一正确段位", () => {
    expect(expiryBucketOf(-1)).toBe("expired");
    expect(expiryBucketOf(0)).toBe("expired");
    expect(expiryBucketOf(1)).toBe("m3");
    expect(expiryBucketOf(EXPIRY_TIER_DAYS.m3)).toBe("m3");
    expect(expiryBucketOf(EXPIRY_TIER_DAYS.m3 + 1)).toBe("m6");
    expect(expiryBucketOf(EXPIRY_TIER_DAYS.m6)).toBe("m6");
    expect(expiryBucketOf(EXPIRY_TIER_DAYS.m6 + 1)).toBe("m12");
    expect(expiryBucketOf(EXPIRY_TIER_DAYS.m12)).toBe("m12");
    expect(expiryBucketOf(EXPIRY_TIER_DAYS.m12 + 1)).toBe("m18");
    expect(expiryBucketOf(EXPIRY_TIER_DAYS.m18)).toBe("m18");
    expect(expiryBucketOf(EXPIRY_TIER_DAYS.m18 + 1)).toBe("m24");
    expect(expiryBucketOf(EXPIRY_TIER_DAYS.m24)).toBe("m24");
    expect(expiryBucketOf(EXPIRY_TIER_DAYS.m24 + 1)).toBe("rest");
  });
});
