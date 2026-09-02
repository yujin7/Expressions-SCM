import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import * as schema from "@/db/schema";
import {
  configuredJstGovernedObservationContracts,
  syncJstGovernedObservation,
  type JstObservationClient,
} from "@/server/integrations/jst-observation-sync";
import { loadStagedRows } from "@/server/modules/release/engine/common";
import { createTestDb } from "../helpers/db";

async function seededDb() {
  const { db, client } = await createTestDb();
  const [actor] = await db.insert(schema.users).values({
    username: "jst_observer",
    name: "聚水潭观察责任人",
    passwordHash: "x",
    active: true,
  }).returning();
  return { db, client, actorId: actor.id };
}

function evidence(envelopeSink: unknown[]) {
  return async (_connector: string, _stream: string, envelope: unknown) => {
    envelopeSink.push(envelope);
    const bytes = JSON.stringify(envelope);
    return { relativePath: "integration-evidence/jst/test.json", hash: "a".repeat(64), bytes };
  };
}

describe("聚水潭商品/采购入库受控观察", () => {
  it("契约选择显式、去重，并拒绝未知流", () => {
    expect(configuredJstGovernedObservationContracts({
      JST_OBSERVATION_SYNC_CONTRACTS: "item-master,inbound-receipts-daily,item-master",
    } as unknown as NodeJS.ProcessEnv)).toEqual(["item-master", "inbound-receipts-daily"]);
    expect(configuredJstGovernedObservationContracts({} as NodeJS.ProcessEnv)).toEqual([]);
    expect(() => configuredJstGovernedObservationContracts({
      JST_OBSERVATION_SYNC_CONTRACTS: "orders-daily",
    } as unknown as NodeJS.ProcessEnv)).toThrow("未知契约");
  });

  it("商品主档只进 releaseBlocked staging；同源信封重放不重复", async () => {
    const { db, client, actorId } = await seededDb();
    try {
      const envelopes: unknown[] = [];
      const sourceClient: JstObservationClient = {
        fetchItemsModified: vi.fn(async () => [{
          skuCode: "JST-SKU-1",
          itemId: "ITEM-1",
          name: "观察商品",
          propertiesValue: "50ml",
          enabled: "1",
          brand: "EXPRESSIONS",
          supplierId: "8",
          modifiedAt: "2026-08-13 10:00:00",
        }]),
        fetchInboundReceiptsModified: vi.fn(),
      };

      const first = await syncJstGovernedObservation(db, {
        client: sourceClient,
        contract: "item-master",
        sourceAsOf: "2026-08-13",
        actorId,
        writeEvidence: evidence(envelopes),
      });
      const replay = await syncJstGovernedObservation(db, {
        client: sourceClient,
        contract: "item-master",
        sourceAsOf: "2026-08-13",
        actorId,
        writeEvidence: evidence(envelopes),
      });

      expect(first).toMatchObject({
        contract: "item-master",
        sourceRows: 1,
        stagedRows: 1,
        unresolvedAliases: 1,
        releaseBlocked: true,
        replayed: false,
      });
      expect(replay).toMatchObject({ runId: first.runId, importJobId: first.importJobId, replayed: true });
      const [job] = await db.select().from(schema.importJobs)
        .where(eq(schema.importJobs.id, first.importJobId));
      expect(job.scope).toMatchObject({
        connector: "jst",
        stream: "item-master",
        authority: "observation-only",
        releaseBlocked: true,
        officialPath: "/open/sku/query",
      });
      await expect(loadStagedRows(db, "jst_item_master_observation", [first.importJobId]))
        .rejects.toThrow(/releaseBlocked，禁止进入正式放行引擎/);
      expect(await db.select().from(schema.integrationRuns)).toHaveLength(1);
      expect(envelopes).toHaveLength(2);
    } finally {
      await client.close();
    }
  });

  it("采购入库保留批次观察与身份异常，但绝不调用库存过账", async () => {
    const { db, client, actorId } = await seededDb();
    try {
      const envelopes: unknown[] = [];
      const sourceClient: JstObservationClient = {
        fetchItemsModified: vi.fn(),
        fetchInboundReceiptsModified: vi.fn(async () => [{
          receiptId: "IN-1",
          purchaseOrderId: "PO-1",
          externalOrderId: null,
          supplierId: "SUP-1",
          supplierName: "观察供应商",
          warehouseCode: "WMS-1",
          status: "Confirmed",
          receiptDate: "2026-08-13 11:00:00",
          modifiedAt: "2026-08-13 11:05:00",
          receiptType: "采购入库",
          items: [{ lineId: "L-1", skuCode: "JST-SKU-1", itemId: null, name: "观察商品", qty: "2" }],
          batches: [{
            batchNo: "LOT-1",
            lineId: "L-1",
            skuCode: "JST-SKU-1",
            qty: "2",
            productionDate: "2026-07-01",
            expirationDate: "2028-07-01",
          }],
        }]),
      };

      const summary = await syncJstGovernedObservation(db, {
        client: sourceClient,
        contract: "inbound-receipts-daily",
        sourceAsOf: "2026-08-13",
        actorId,
        writeEvidence: evidence(envelopes),
      });

      expect(summary).toMatchObject({ sourceRows: 1, stagedRows: 1, unresolvedAliases: 2 });
      const staged = await db.select().from(schema.stagingRows)
        .where(eq(schema.stagingRows.importJobId, summary.importJobId));
      expect(staged[0]).toMatchObject({ status: "pending" });
      expect(staged[0].payload).toMatchObject({
        receiptId: "IN-1",
        items: [{ skuCode: "JST-SKU-1", qty: "2" }],
        batches: [{ batchNo: "LOT-1", expirationDate: "2028-07-01" }],
      });
      expect(await db.select().from(schema.stockLedger)).toHaveLength(0);
      expect(await db.select().from(schema.stockBalances)).toHaveLength(0);
      expect(JSON.stringify(envelopes[0])).not.toContain("bankAccount");
    } finally {
      await client.close();
    }
  });

  it("无效业务日会在外呼前拒绝", async () => {
    const { db, client, actorId } = await seededDb();
    try {
      const sourceClient: JstObservationClient = {
        fetchItemsModified: vi.fn(),
        fetchInboundReceiptsModified: vi.fn(),
      };
      await expect(syncJstGovernedObservation(db, {
        client: sourceClient,
        contract: "item-master",
        sourceAsOf: "2026-02-30",
        actorId,
      })).rejects.toThrow("有效的 YYYY-MM-DD");
      expect(sourceClient.fetchItemsModified).not.toHaveBeenCalled();
    } finally {
      await client.close();
    }
  });
});
