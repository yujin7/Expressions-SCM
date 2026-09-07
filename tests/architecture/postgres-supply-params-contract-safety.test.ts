import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { supplyParamsContractConnectionString } from "../../scripts/verify-postgres-supply-params";

it("supply-parameter concurrency proof rejects business databases and missing consent before connection", () => {
  const valid = "postgres://qa:synthetic@127.0.0.1:5432/scm_contract_test";
  expect(() => supplyParamsContractConnectionString({ DATABASE_URL: valid })).toThrow(/SCM_ALLOW_MUTATING/);
  for (const value of [valid.replace("scm_contract_test", "scm"), valid.replace("127.0.0.1", "external.example"), valid + "?host=external.example", "invalid"]) {
    expect(() => supplyParamsContractConnectionString({ DATABASE_URL: value, SCM_ALLOW_MUTATING_PG_CONTRACT: "1" })).toThrow();
  }
  expect(supplyParamsContractConnectionString({ DATABASE_URL: valid, SCM_ALLOW_MUTATING_PG_CONTRACT: "1" })).toBe(valid);
});
it("the row-lock proof is included in the existing isolated PostgreSQL CI job", () => {
  const ci = readFileSync(".github/workflows/ci.yml", "utf8");
  expect(ci).toContain("run: node --import tsx scripts/verify-postgres-supply-params.ts");
});
