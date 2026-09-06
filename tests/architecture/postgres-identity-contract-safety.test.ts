import { afterEach, describe, expect, it, vi } from "vitest";
const constructors = vi.hoisted(() => ({ Client: vi.fn(), Pool: vi.fn() }));
vi.mock("pg", () => ({ default: constructors }));
import { verifySkuIdentityConcurrency } from "../../scripts/verify-postgres-sku-identity-concurrency";

afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });
describe.each(["gtin/gtin", "fill/fill", "fill/gtin"] as const)("PostgreSQL identity %s admission", mode => {
  it.each([
    { consent: "0", url: "postgres://fixture@127.0.0.1/scm_contract_qa" },
    { consent: "1", url: "postgres://fixture@127.0.0.1/scm_production" },
    { consent: "1", url: "postgres://fixture@external.invalid/scm_contract_qa" },
    { consent: "1", url: "postgres://fixture@127.0.0.1/scm_contract_qa?host=external.invalid" },
  ])("rejects before creating a database client: %j", async ({ consent, url }) => {
    vi.stubEnv("DATABASE_URL", url);
    vi.stubEnv("SCM_ALLOW_MUTATING_PG_CONTRACT", consent);
    await expect(verifySkuIdentityConcurrency(mode)).rejects.toThrow();
    expect(constructors.Client).not.toHaveBeenCalled();
    expect(constructors.Pool).not.toHaveBeenCalled();
  });
});
