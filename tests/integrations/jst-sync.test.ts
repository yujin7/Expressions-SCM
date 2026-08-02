import { describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { createTestDb } from "../helpers/db";
import { JstClient } from "@/server/integrations/jst";
import { syncJstDailySales } from "@/server/integrations/jst-sync";

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("聚水潭日出库受控同步", () => {
  it("源信封 → staging → run/checkpoint，重放不重复写", async () => {
    const { db } = await createTestDb();
    const [actor] = await db.insert(schema.users).values({ name: "JST 同步责任人" }).returning();
    const [spu] = await db.insert(schema.spus).values({
      code: "P-JST-1",
      nameCn: "JST 测试",
    }).returning();
    const [sku] = await db.insert(schema.skus).values({
      code: "SKU-A",
      name: "JST SKU",
      spuId: spu.id,
      baseUom: "个",
      skuType: "finished",
    }).returning();
    const [warehouse] = await db.insert(schema.warehouses).values({
      code: "WH-1",
      name: "JST 仓",
      kind: "finished",
    }).returning();
    await db.insert(schema.aliases).values([
      { aliasType: "sku_code", scope: "JST", rawValue: "JST-SKU-A", targetId: sku.id, createdBy: actor.id },
      { aliasType: "warehouse", scope: "JST", rawValue: "10", targetId: warehouse.id, createdBy: actor.id },
    ]);

    let fetchCount = 0;
    const fetchImpl = vi.fn(async () => {
      const payload = fetchCount++ % 2 === 0 ? {
        code: 0,
        data: {
          has_next: false,
          datas: [
          {
            io_id: "IO-1",
            status: "Confirmed",
            io_date: "2026-07-28 10:00:00",
            wms_co_id: "10",
            ts: 101,
            items: [{ sku_id: "JST-SKU-A", qty: "2.1250", ioi_id: "L1" }],
            batchs: [{
              batch_no: "LOT-A",
              ioi_id: "L1",
              sku_id: "JST-SKU-A",
              qty: "2.1250",
              product_date: "2026-06-01",
              expiration_date: "2028-06-01",
            }],
          },
          {
            io_id: "IO-2",
            status: "Archive",
            io_date: "2026-07-28 11:00:00",
            wms_co_id: "10",
            ts: 102,
            items: [{ sku_id: "JST-SKU-A", qty: "3.3750", ioi_id: "L2" }],
          },
          ],
        },
      } : { code: 0, data: { has_next: false, datas: [] } };
      return response(payload);
    }) as unknown as typeof fetch;
    const client = new JstClient({
      appKey: "app",
      appSecret: "secret",
      accessToken: "token",
      baseUrl: "https://example.invalid",
    }, { fetchImpl, retries: 0 });
    const writeEvidence = vi.fn(async (_connector: string, _stream: string, envelope: unknown) => ({
      relativePath: "integration-evidence/jst/outbound-sales-daily/evidence.json",
      hash: "a".repeat(64),
      bytes: `${JSON.stringify(envelope)}\n`,
    }));
    await db.insert(schema.integrationRuns).values({
      connector: "jst",
      stream: "outbound-sales-daily",
      idempotencyKey: `jst:outbound-sales-daily:2026-07-28:${"a".repeat(64)}`,
      status: "failed",
      cursorStart: "1",
      requestScope: { bizDate: "2026-07-28" },
      error: "simulated prior failure",
      finishedAt: new Date(),
    });

    const first = await syncJstDailySales(db, {
      client,
      bizDate: "2026-07-28",
      actorId: actor.id,
      writeEvidence,
    });
    const replay = await syncJstDailySales(db, {
      client,
      bizDate: "2026-07-28",
      actorId: actor.id,
      writeEvidence,
    });

    expect(first).toMatchObject({
      sourceOrders: 2,
      sourceItems: 2,
      sourceBatchAllocations: 1,
      stagedRows: 1,
      rejectedRows: 0,
      unresolvedAliases: 0,
      cursorEnd: "102",
      replayed: false,
    });
    expect(replay).toMatchObject({
      runId: first.runId,
      importJobId: first.importJobId,
      replayed: true,
    });
    const staged = await db.select().from(schema.stagingRows)
      .where(eq(schema.stagingRows.importJobId, first.importJobId));
    expect(staged).toHaveLength(1);
    expect(staged[0]).toMatchObject({ status: "validated", targetTable: "jst_daily_sales" });
    expect(staged[0].payload).toMatchObject({
      bizDate: "2026-07-28",
      skuCode: "JST-SKU-A",
      warehouseRaw: "10",
      qty: "5.5000",
      sourceOrderCount: 2,
    });
    expect(writeEvidence).toHaveBeenCalled();
    const envelope = writeEvidence.mock.calls[0]?.[2] as {
      orders: Array<{ ioId: string; batches: unknown[] }>;
    };
    expect(envelope.orders.find((order) => order.ioId === "IO-1")).toMatchObject({
      batches: [{ batchNo: "LOT-A", lineId: "L1", skuCode: "JST-SKU-A" }],
    });
    const runs = await db.select().from(schema.integrationRuns);
    const checkpoints = await db.select().from(schema.integrationCheckpoints);
    expect(runs).toHaveLength(2);
    expect(runs.some((run) => run.status === "failed")).toBe(true);
    expect(runs.find((run) => run.id === first.runId))
      .toMatchObject({ status: "succeeded", importJobId: first.importJobId });
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0]).toMatchObject({ cursor: "102", lastRunId: first.runId });
  });
});
