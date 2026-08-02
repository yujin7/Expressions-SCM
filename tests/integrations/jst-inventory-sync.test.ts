import { describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { createTestDb } from "../helpers/db";
import { JstClient } from "@/server/integrations/jst";
import { syncJstInventoryObservations } from "@/server/integrations/jst-inventory-sync";

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("聚水潭库存增量观察受控同步", () => {
  it("最大游标 → 最小化证据 → staging/checkpoint；未知 SKU 不作零也不直写库存", async () => {
    const { db } = await createTestDb();
    const [actor] = await db.insert(schema.users).values({ name: "JST 库存同步责任人" }).returning();
    const [spu] = await db.insert(schema.spus).values({
      code: "P-JST-INV",
      nameCn: "JST 库存测试",
    }).returning();
    const [sku] = await db.insert(schema.skus).values({
      code: "SKU-A",
      name: "JST 库存 SKU",
      spuId: spu.id,
      baseUom: "个",
      skuType: "finished",
    }).returning();
    await db.insert(schema.aliases).values({
      aliasType: "sku_code",
      scope: "JST",
      rawValue: "JST-SKU-A",
      targetId: sku.id,
      createdBy: actor.id,
    });

    const payloads = [
      {
        code: 0,
        data: {
          has_next: false,
          inventorys: [
            {
              sku_id: "JST-SKU-A",
              i_id: "ITEM-A",
              name: "已映射商品",
              qty: "12.5000",
              order_lock: "2",
              lock_qty: "3",
              purchase_qty: "5",
              modified: "2026-07-30 07:00:00",
              ts: 501,
            },
            {
              sku_id: "JST-SKU-UNKNOWN",
              name: "待认领商品",
              qty: "7",
              modified: "2026-07-30 07:01:00",
              ts: 502,
            },
          ],
        },
      },
      { code: 0, data: { has_next: false, inventorys: [] } },
      { code: 0, data: { has_next: false, inventorys: [] } },
    ];
    const fetchImpl = vi.fn(async () => response(payloads.shift())) as unknown as typeof fetch;
    const client = new JstClient({
      appKey: "app",
      appSecret: "secret",
      accessToken: "token",
      baseUrl: "https://example.invalid",
    }, { fetchImpl, retries: 0 });
    let evidenceNo = 0;
    const writeEvidence = vi.fn(async (_connector: string, _stream: string, envelope: unknown) => {
      const hash = (evidenceNo++ === 0 ? "a" : "b").repeat(64);
      return {
        relativePath: `integration-evidence/jst/inventory-total-delta/${hash}.json`,
        hash,
        bytes: `${JSON.stringify(envelope)}\n`,
      };
    });

    const first = await syncJstInventoryObservations(db, {
      client,
      actorId: actor.id,
      observedAt: new Date("2026-07-30T00:00:00Z"),
      writeEvidence,
    });
    const noChange = await syncJstInventoryObservations(db, {
      client,
      actorId: actor.id,
      observedAt: new Date("2026-07-30T01:00:00Z"),
      writeEvidence,
    });

    expect(first).toMatchObject({
      sourceRows: 2,
      stagedRows: 2,
      unresolvedAliases: 1,
      cursorStart: "1",
      cursorEnd: "502",
      replayed: false,
    });
    expect(noChange).toMatchObject({
      sourceRows: 0,
      stagedRows: 0,
      unresolvedAliases: 0,
      cursorStart: "502",
      cursorEnd: "502",
      replayed: false,
    });
    const staged = await db.select().from(schema.stagingRows)
      .where(eq(schema.stagingRows.importJobId, first.importJobId));
    expect(staged).toHaveLength(2);
    expect(staged.find((row) => row.status === "validated")?.payload).toMatchObject({
      grain: "sku-all-jst-warehouses",
      skuCode: "JST-SKU-A",
      qty: "12.5000",
      orderLockQty: "2",
      inventoryLockQty: "3",
      purchaseQty: "5",
      _resolved: { skuId: sku.id },
    });
    expect(staged.find((row) => row.status === "pending")).toMatchObject({
      errorMsg: "未解析别名: sku=JST-SKU-UNKNOWN",
    });
    const [unknownAlias] = await db.select().from(schema.aliasExceptions)
      .where(eq(schema.aliasExceptions.rawValue, "JST-SKU-UNKNOWN"));
    expect(unknownAlias).toMatchObject({
      aliasType: "sku_code",
      scope: "JST",
      status: "open",
    });

    const runs = await db.select().from(schema.integrationRuns);
    const checkpoints = await db.select().from(schema.integrationCheckpoints);
    expect(runs).toHaveLength(2);
    expect(runs.every((run) => run.status === "succeeded")).toBe(true);
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0]).toMatchObject({
      connector: "jst",
      stream: "inventory-total-delta",
      cursor: "502",
      lastRunId: noChange.runId,
    });
    expect(await db.select().from(schema.stockSnapshots)).toHaveLength(0);
  });
});
