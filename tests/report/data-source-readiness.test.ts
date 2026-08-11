import { describe, expect, it } from "vitest";

import * as schema from "@/db/schema";
import { loadDataSourceReadiness } from "@/server/modules/report/data-source-readiness";
import { createTestDb } from "../helpers/db";

describe("三方数据来源证据矩阵", () => {
  it("区分内部事实、成功观察、最新失败和仅有契约", async () => {
    const { db, client } = await createTestDb();
    try {
      const [actor] = await db.insert(schema.users).values({ name: "数据责任人" }).returning();
      const [job] = await db.insert(schema.importJobs).values({
        template: "jdy_observation",
        filename: "jdy-observation",
        sourceAsOf: "2026-08-11",
        createdBy: actor.id,
        status: "done",
      }).returning();
      await db.insert(schema.integrationRuns).values([
        {
          connector: "jdy",
          stream: "tmall-sku-sales-observation",
          idempotencyKey: "jdy-success",
          status: "succeeded",
          sourceRows: 10,
          stagedRows: 9,
          rejectedRows: 1,
          importJobId: job.id,
          startedAt: new Date("2026-08-12T01:00:00.000Z"),
          finishedAt: new Date("2026-08-12T01:01:00.000Z"),
        },
        {
          connector: "jdy",
          stream: "tmall-sku-sales-observation",
          idempotencyKey: "jdy-latest-failed",
          status: "failed",
          error: "schema drift",
          startedAt: new Date("2026-08-12T02:00:00.000Z"),
          finishedAt: new Date("2026-08-12T02:01:00.000Z"),
        },
      ]);
      await db.insert(schema.aliasExceptions).values({
        aliasType: "sku_barcode",
        scope: "JIANDAOYUN",
        rawValue: "6901",
        status: "open",
      });

      const result = await loadDataSourceReadiness(db, {
        env: {} as NodeJS.ProcessEnv,
        now: new Date("2026-08-12T04:00:00.000Z"),
      });

      expect(result.map((row) => row.key)).toEqual(["SCM", "JIANDAOYUN", "JST", "YONYOU"]);
      expect(result[0]).toMatchObject({ state: "operational", configured: true });
      expect(result.find((row) => row.key === "JIANDAOYUN")).toMatchObject({
        state: "observation",
        successfulStreams: 1,
        latestFailedStreams: 1,
        sourceRows: 10,
        stagedRows: 9,
        rejectedRows: 1,
        sourceAsOfStart: "2026-08-11",
        sourceAsOfEnd: "2026-08-11",
        openIdentityExceptions: 1,
        observedIdentities: 1,
      });
      expect(result.find((row) => row.key === "JST")).toMatchObject({
        state: "contract_only",
        contractSelectionState: "not_required",
        selectedContractCount: 0,
      });
      expect(result.find((row) => row.key === "YONYOU")?.state).toBe("contract_only");
    } finally {
      await client.close();
    }
  });
});
