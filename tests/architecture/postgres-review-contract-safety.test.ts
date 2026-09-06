import { describe, expect, it } from "vitest";
import { reviewContractConnectionString } from "../../scripts/verify-postgres-review-atomicity";

const allowed = "postgres://fixture:synthetic-only@127.0.0.1:50397/scm_contract_test";

describe("review PostgreSQL proof admission (no connection or .env loading)", () => {
  it.each([undefined, "", "0", "true"])("rejects missing or non-explicit mutation consent %s", (consent) => {
    expect(() => reviewContractConnectionString({ DATABASE_URL: allowed, SCM_ALLOW_MUTATING_PG_CONTRACT: consent }))
      .toThrow(/SCM_ALLOW_MUTATING_PG_CONTRACT=1/);
  });

  it.each([
    undefined,
    "pglite:.data/dev",
    "postgres://fixture:synthetic-only@db.example.com/scm_contract_test",
    "postgres://fixture:synthetic-only@127.0.0.1/scm_production",
    "postgres://fixture:synthetic-only@127.0.0.1/scm_contract_",
    "postgres://fixture:synthetic-only@127.0.0.1/scm_contract_test?host=external.example.com",
    "postgres://fixture:synthetic-only@127.0.0.1/scm_contract_test?options=-c%20session_replication_role%3Dreplica",
    "postgres://fixture:synthetic-only@127.0.0.1/scm_contract_test#override",
  ])("rejects a non-disposable/non-loopback/overridden database URL %s", (url) => {
    expect(() => reviewContractConnectionString({ DATABASE_URL: url, SCM_ALLOW_MUTATING_PG_CONTRACT: "1" })).toThrow();
  });

  it.each([
    allowed,
    "postgresql://fixture:synthetic-only@localhost:5432/scm_contract_ci_42",
    "postgres://fixture:synthetic-only@[::1]:5432/scm_contract_ci",
  ])("accepts only an explicitly opted-in disposable loopback URL %s", (url) => {
    expect(reviewContractConnectionString({ DATABASE_URL: ` ${url} `, SCM_ALLOW_MUTATING_PG_CONTRACT: "1" })).toBe(url);
  });

  it("does not include supplied credentials in validation errors", () => {
    try {
      reviewContractConnectionString({ DATABASE_URL: "postgres://fixture:do-not-echo@external.example/scm_contract_test", SCM_ALLOW_MUTATING_PG_CONTRACT: "1" });
      throw new Error("validation unexpectedly passed");
    } catch (error) {
      expect(String(error)).not.toContain("do-not-echo");
      expect(String(error)).toContain("requires loopback PostgreSQL");
    }
  });
});
