import { describe, expect, it } from "vitest";
import { auditConnectorReadiness } from "@/jobs/audit-connectors";
import { jstLiveEvidenceBinding } from "@/server/integrations/jst";

describe("连接器安全就绪审计", () => {
  it("输出可附验收单的汇总，但不泄露凭据、租户、端点或获批接口值", () => {
    const env = {
      NODE_ENV: "test",
      JST_APP_KEY: "SECRET-JST-APP",
      JST_APP_SECRET: "SECRET-JST-SECRET",
      JST_ACCESS_TOKEN: "SECRET-JST-TOKEN",
      JST_SYNC_ACTOR_ID: "3",
      JST_LIVE_VERIFIED_AT: "2026-07-29T00:00:00Z",
      JST_LIVE_VERIFIED_REF: "UAT-20260729-JST-001",
      YY_APP_KEY: "SECRET-YY-APP",
      YY_APP_SECRET: "SECRET-YY-SECRET",
      YY_TENANT_ID: "SECRET-TENANT",
      YY_ORG_ID: "SECRET-ORG",
      YY_PRODUCT_PROFILE: "yonsuite",
      YY_APPROVED_API_CONTRACTS: "SECRET-CONTRACT@v1",
      YY_ALLOWED_HOSTS: "api.yonyoucloud.com,auth.yonyoucloud.com",
      YY_BASE_URL: "https://api.yonyoucloud.com",
      YY_TOKEN_URL: "https://auth.yonyoucloud.com/token",
    } satisfies NodeJS.ProcessEnv;
    env.JST_LIVE_VERIFIED_REF = `UAT-20260729-JST-${jstLiveEvidenceBinding(env)}`;
    const audit = auditConnectorReadiness(env, new Date("2026-07-30T12:00:00Z"));
    expect(audit.summary).toEqual({
      total: 4,
      codeReady: 3,
      configured: 2,
      explicitlyEnabled: 0,
      contractSetsSelected: 1,
      configurationReady: 1,
      operational: 0,
    });
    expect(audit.connectors.find((row) => row.key === "jst")).toMatchObject({
      configured: true,
      configurationReady: true,
      operational: false,
      identityClearanceState: "unknown",
      liveVerificationRef: env.JST_LIVE_VERIFIED_REF,
    });
    expect(audit.connectors.find((row) => row.key === "yy")).toMatchObject({
      implementation: "contract_only",
      configured: true,
      operational: false,
    });

    const serialized = JSON.stringify(audit);
    for (const secret of [
      "SECRET-JST-APP",
      "SECRET-JST-SECRET",
      "SECRET-JST-TOKEN",
      "SECRET-YY-APP",
      "SECRET-YY-SECRET",
      "SECRET-TENANT",
      "SECRET-ORG",
      "SECRET-CONTRACT",
      "api.yonyoucloud.com",
      "auth.yonyoucloud.com",
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });
});
