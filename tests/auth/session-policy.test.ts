import { describe, expect, it } from "vitest";
import { AUTH_SESSION_MAX_AGE, withinSessionLifetime } from "@/server/auth/session-policy";

describe("eight-hour session policy", () => {
  const now = 1_800_000_000;
  it("allows current tokens but ends at the earlier of signed expiry and eight hours", () => {
    expect(AUTH_SESSION_MAX_AGE).toBe(28_800);
    expect(withinSessionLifetime({ iat: now - 10, exp: now + 100 }, now)).toBe(true);
    expect(withinSessionLifetime({ iat: now - 10, exp: now }, now)).toBe(false);
    expect(withinSessionLifetime({ iat: now - 28_799, exp: now + 30 * 86_400 }, now)).toBe(true);
    expect(withinSessionLifetime({ iat: now - 28_800, exp: now + 30 * 86_400 }, now)).toBe(false);
  });
  it("rejects missing or malformed time claims without consulting the database", () => {
    for (const token of [null, {}, { iat: now }, { exp: now + 100 }, { iat: "today", exp: now + 100 }, { iat: NaN, exp: Infinity }]) {
      expect(withinSessionLifetime(token, now)).toBe(false);
    }
  });
  it("permits only the existing small future clock tolerance", () => {
    expect(withinSessionLifetime({ iat: now + 15, exp: now + 100 }, now)).toBe(true);
    expect(withinSessionLifetime({ iat: now + 16, exp: now + 100 }, now)).toBe(false);
  });
});
