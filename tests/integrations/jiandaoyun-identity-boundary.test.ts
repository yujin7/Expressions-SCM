import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import * as schema from "@/db/schema";
import { JiandaoyunClient } from "@/server/integrations/jiandaoyun";
import type { JiandaoyunFormContract } from "@/server/integrations/jiandaoyun-contracts";
import { syncJiandaoyunForm } from "@/server/integrations/jiandaoyun-sync";
import { createTestDb } from "../helpers/db";

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("简道云外部身份边界", () => {
  it("采购需求池的 supplier 字段会进入 JIANDAOYUN 认领队列", async () => {
    const { db } = await createTestDb();
    const [actor] = await db.insert(schema.users).values({ name: "采购身份责任人" }).returning();
    const contract: JiandaoyunFormContract = {
      key: "purchase-demand-observation",
      label: "采购供应链/采购需求池",
      appId: "a".repeat(24),
      entryId: "b".repeat(24),
      targetTable: "jdy_purchase_demand_observation",
      fields: [{ source: "_supplier", target: "supplier" }],
    };
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith("/app/entry/widget/list")) {
        return response({ widgets: [{ name: "_supplier", label: "供应商", type: "text" }] });
      }
      if (path.endsWith("/app/entry/data/list")) {
        return response({
          data: [{
            _id: "c".repeat(24),
            appId: contract.appId,
            entryId: contract.entryId,
            updateTime: "2026-08-01T03:00:00.000Z",
            _supplier: { value: "采购需求供应商" },
          }],
        });
      }
      throw new Error(`unexpected ${path}`);
    }) as unknown as typeof fetch;
    const client = new JiandaoyunClient({
      apiKey: "secret",
      baseUrl: "https://example.invalid/api/v5",
    }, { fetchImpl, retries: 0 });

    const summary = await syncJiandaoyunForm(db, {
      client,
      actorId: actor.id,
      contract,
      writeEvidence: async (_connector, _stream, envelope) => ({
        relativePath: "integration-evidence/jdy/purchase-demand/evidence.json",
        hash: "d".repeat(64),
        bytes: `${JSON.stringify(envelope)}\n`,
      }),
    });

    expect(summary).toMatchObject({ sourceRows: 1, stagedRows: 1, unresolvedAliases: 1 });
    const exceptions = await db.select().from(schema.aliasExceptions);
    expect(exceptions).toEqual([
      expect.objectContaining({
        aliasType: "supplier_oem",
        scope: "JIANDAOYUN",
        rawValue: "采购需求供应商",
        status: "open",
      }),
    ]);
  });

  it("内部主档与 GLOBAL 别名即使精确同码/同名也不自动认领", async () => {
    const { db } = await createTestDb();
    const [actor] = await db.insert(schema.users).values({ name: "简道云身份责任人" }).returning();
    const [spu] = await db
      .insert(schema.spus)
      .values({ code: "P-JDY-COLLIDE", nameCn: "身份碰撞测试" })
      .returning();
    const [sku] = await db
      .insert(schema.skus)
      .values({
        code: "JDY-COLLIDE-001",
        name: "内部同码 SKU",
        spuId: spu.id,
        baseUom: "件",
        skuType: "finished",
      })
      .returning();
    const [supplier] = await db
      .insert(schema.suppliers)
      .values({ code: "SUP-JDY-COLLIDE", name: "简道云同名供应商" })
      .returning();
    const [warehouse] = await db
      .insert(schema.warehouses)
      .values({ code: "WH-JDY-COLLIDE", name: "简道云同名仓", kind: "finished" })
      .returning();
    await db.insert(schema.aliases).values([
      {
        aliasType: "sku_code",
        scope: "GLOBAL",
        rawValue: "JDY-COLLIDE-001",
        targetId: sku.id,
      },
      {
        aliasType: "supplier_oem",
        scope: "GLOBAL",
        rawValue: "简道云同名供应商",
        targetId: supplier.id,
      },
      {
        aliasType: "warehouse",
        scope: "GLOBAL",
        rawValue: "简道云同名仓",
        targetId: warehouse.id,
      },
    ]);

    const contract: JiandaoyunFormContract = {
      key: "identity-boundary-observation",
      label: "身份边界观察",
      appId: "a".repeat(24),
      entryId: "b".repeat(24),
      targetTable: "jdy_identity_boundary_observation",
      fields: [
        { source: "_product", target: "productCode" },
        { source: "_supplier", target: "supplierName" },
        { source: "_warehouse", target: "warehouseName" },
      ],
    };
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith("/app/entry/widget/list")) {
        return response({
          widgets: [
            { name: "_product", label: "产品编码", type: "text" },
            { name: "_supplier", label: "供应商", type: "text" },
            { name: "_warehouse", label: "仓库", type: "text" },
          ],
        });
      }
      if (path.endsWith("/app/entry/data/list")) {
        return response({
          data: [{
            _id: "c".repeat(24),
            appId: contract.appId,
            entryId: contract.entryId,
            updateTime: "2026-08-01T03:00:00.000Z",
            _product: { value: "JDY-COLLIDE-001" },
            _supplier: { value: "简道云同名供应商" },
            _warehouse: { value: "简道云同名仓" },
          }],
        });
      }
      throw new Error(`unexpected ${path}`);
    }) as unknown as typeof fetch;
    const client = new JiandaoyunClient({
      apiKey: "secret",
      baseUrl: "https://example.invalid/api/v5",
    }, { fetchImpl, retries: 0 });

    const summary = await syncJiandaoyunForm(db, {
      client,
      actorId: actor.id,
      contract,
      writeEvidence: async (_connector, _stream, envelope) => ({
        relativePath: "integration-evidence/jdy/identity-boundary/evidence.json",
        hash: "d".repeat(64),
        bytes: `${JSON.stringify(envelope)}\n`,
      }),
    });

    expect(summary).toMatchObject({ sourceRows: 1, stagedRows: 1, unresolvedAliases: 3 });
    const [staged] = await db
      .select()
      .from(schema.stagingRows)
      .where(eq(schema.stagingRows.importJobId, summary.importJobId));
    expect(staged).toMatchObject({
      status: "pending",
      payload: { _identity: {} },
    });
    expect(staged.errorMsg).toContain("未解析别名");
    const exceptions = await db.select().from(schema.aliasExceptions);
    expect(exceptions.map((row) => [row.aliasType, row.scope, row.rawValue]).sort()).toEqual([
      ["sku_code", "JIANDAOYUN", "JDY-COLLIDE-001"],
      ["supplier_oem", "JIANDAOYUN", "简道云同名供应商"],
      ["warehouse", "JIANDAOYUN", "简道云同名仓"],
    ].sort());
  });
});
