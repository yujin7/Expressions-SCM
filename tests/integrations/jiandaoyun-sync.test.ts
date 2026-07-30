import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import * as schema from "@/db/schema";
import { JiandaoyunClient } from "@/server/integrations/jiandaoyun";
import type { JiandaoyunFormContract } from "@/server/integrations/jiandaoyun-contracts";
import {
  syncJiandaoyunCatalog,
  syncJiandaoyunForm,
} from "@/server/integrations/jiandaoyun-sync";
import { createTestDb } from "../helpers/db";

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

const appId = "a".repeat(24);
const entryId = "b".repeat(24);
const recordId = "c".repeat(24);

const contract: JiandaoyunFormContract = {
  key: "test-observation",
  label: "测试观察",
  appId,
  entryId,
  targetTable: "jdy_test_observation",
  fields: [
    { source: "_widget_code", target: "productCode" },
    { source: "_widget_qty", target: "qty" },
  ],
  subforms: [{
    source: "_widget_lines",
    target: "lines",
    items: [
      { source: "_widget_line_code", target: "productCode" },
      { source: "_widget_line_qty", target: "qty" },
    ],
  }],
};

describe("简道云受控同步", () => {
  it("目录只留元数据；业务行字段最小化后停在 staging，重放不重复", async () => {
    const { db } = await createTestDb();
    const [actor] = await db.insert(schema.users).values({ name: "简道云同步责任人" }).returning();
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith("/app/list")) {
        return response({ apps: [{ app_id: appId, name: "供应中心" }] });
      }
      if (path.endsWith("/app/entry/list")) {
        return response({ forms: [{ app_id: appId, entry_id: entryId, name: "测试表单" }] });
      }
      if (path.endsWith("/app/entry/widget/list")) {
        return response({
          widgets: [
            { name: "_widget_code", label: "产品编码", type: "text" },
            { name: "_widget_qty", label: "数量", type: "number" },
            { name: "_widget_phone", label: "联系人手机", type: "text" },
            {
              name: "_widget_lines",
              label: "产品明细",
              type: "subform",
              items: [
                { name: "_widget_line_code", label: "产品编码", type: "text" },
                { name: "_widget_line_qty", label: "数量", type: "number" },
                { name: "_widget_line_image", label: "图片", type: "image" },
              ],
            },
          ],
        });
      }
      if (path.endsWith("/app/entry/data/list")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        expect(body.fields).toEqual([
          "createTime",
          "updateTime",
          "deleteTime",
          "_widget_code",
          "_widget_qty",
          "_widget_lines",
        ]);
        expect(JSON.stringify(body.fields)).not.toContain("_widget_phone");
        expect(JSON.stringify(body.fields)).not.toContain("_widget_line_image");
        return response({
          data: [{
            _id: recordId,
            appId,
            entryId,
            createTime: "2026-07-29T01:00:00.000Z",
            updateTime: "2026-07-30T02:00:00.000Z",
            _widget_code: { value: "SKU-001" },
            _widget_qty: { value: "2.5000" },
            _widget_phone: { value: "sensitive-phone" },
            _widget_lines: {
              value: [{
                _widget_line_code: { value: "SKU-001" },
                _widget_line_qty: { value: "2.5000" },
                _widget_line_image: { value: "sensitive-image" },
              }],
            },
          }],
        });
      }
      throw new Error(`unexpected ${path}`);
    }) as unknown as typeof fetch;
    const client = new JiandaoyunClient({
      apiKey: "secret",
      baseUrl: "https://example.invalid/api/v5",
    }, { fetchImpl, retries: 0 });
    const catalogEvidence = vi.fn(async (
      _connector: string,
      _stream: string,
      envelope: unknown,
    ) => ({
      relativePath: "integration-evidence/jdy/catalog/catalog.json",
      hash: "a".repeat(64),
      bytes: `${JSON.stringify(envelope)}\n`,
    }));
    const formEvidence = vi.fn(async (
      _connector: string,
      _stream: string,
      envelope: unknown,
    ) => ({
      relativePath: "integration-evidence/jdy/test-observation/form.json",
      hash: "b".repeat(64),
      bytes: `${JSON.stringify(envelope)}\n`,
    }));

    const catalog = await syncJiandaoyunCatalog(db, {
      client,
      actorId: actor.id,
      writeEvidence: catalogEvidence,
    });
    const first = await syncJiandaoyunForm(db, {
      client,
      actorId: actor.id,
      contract,
      writeEvidence: formEvidence,
    });
    const replay = await syncJiandaoyunForm(db, {
      client,
      actorId: actor.id,
      contract,
      writeEvidence: formEvidence,
    });
    const emptyClient = new JiandaoyunClient({
      apiKey: "secret",
      baseUrl: "https://example.invalid/api/v5",
    }, {
      retries: 0,
      fetchImpl: vi.fn(async (url: string | URL | Request) => {
        const path = new URL(String(url)).pathname;
        if (path.endsWith("/app/entry/widget/list")) {
          return response({
            widgets: [
              { name: "_widget_code", label: "产品编码", type: "text" },
              { name: "_widget_qty", label: "数量", type: "number" },
              {
                name: "_widget_lines",
                label: "产品明细",
                type: "subform",
                items: [
                  { name: "_widget_line_code", label: "产品编码", type: "text" },
                  { name: "_widget_line_qty", label: "数量", type: "number" },
                ],
              },
            ],
          });
        }
        return response({ data: [] });
      }) as unknown as typeof fetch,
    });
    const empty = await syncJiandaoyunForm(db, {
      client: emptyClient,
      actorId: actor.id,
      contract,
      writeEvidence: async (_connector, _stream, envelope) => ({
        relativePath: "integration-evidence/jdy/test-observation/empty.json",
        hash: "c".repeat(64),
        bytes: `${JSON.stringify(envelope)}\n`,
      }),
    });

    expect(catalog).toMatchObject({ apps: 1, forms: 1, replayed: false });
    expect(first).toMatchObject({
      contractKey: "test-observation",
      sourceRows: 1,
      stagedRows: 1,
      sourceAsOf: "2026-07-30",
      replayed: false,
    });
    expect(replay).toMatchObject({
      runId: first.runId,
      importJobId: first.importJobId,
      replayed: true,
    });
    expect(empty).toMatchObject({ sourceRows: 0, stagedRows: 0, replayed: false });
    const staged = await db
      .select()
      .from(schema.stagingRows)
      .where(eq(schema.stagingRows.importJobId, first.importJobId));
    expect(staged).toHaveLength(1);
    expect(staged[0]).toMatchObject({
      targetTable: "jdy_test_observation",
      status: "pending",
    });
    expect(staged[0].payload).toMatchObject({
      sourceRecordId: recordId,
      data: {
        productCode: "SKU-001",
        qty: "2.5000",
        lines: [{ productCode: "SKU-001", qty: "2.5000" }],
      },
      _source: {
        connector: "jdy",
        appId,
        entryId,
        contractKey: "test-observation",
      },
    });
    expect(JSON.stringify(staged[0].payload)).not.toContain("sensitive-phone");
    expect(JSON.stringify(staged[0].payload)).not.toContain("sensitive-image");
    const runs = await db.select().from(schema.integrationRuns);
    const checkpoints = await db.select().from(schema.integrationCheckpoints);
    const aliasQueue = await db.select().from(schema.aliasExceptions);
    const jobs = await db.select().from(schema.importJobs);
    expect(runs).toHaveLength(3);
    expect(runs.every((run) => run.status === "succeeded")).toBe(true);
    expect(jobs.map((job) => job.status)).toEqual(["done", "done"]);
    expect(staged[0].status).toBe("pending");
    expect(checkpoints.map((row) => row.stream).sort()).toEqual(["catalog", "test-observation"]);
    expect(aliasQueue.map((row) => [row.aliasType, row.scope, row.rawValue])).toEqual([
      ["sku_code", "JIANDAOYUN", "SKU-001"],
    ]);
    expect(JSON.stringify(aliasQueue)).not.toContain("sensitive-phone");
  });

  it("字段契约漂移时拒绝落 evidence/staging", async () => {
    const { db } = await createTestDb();
    const [actor] = await db.insert(schema.users).values({ name: "简道云同步责任人" }).returning();
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith("/app/entry/widget/list")) {
        return response({ widgets: [{ name: "_widget_code", label: "产品编码", type: "text" }] });
      }
      return response({ data: [] });
    }) as unknown as typeof fetch;
    const client = new JiandaoyunClient({
      apiKey: "secret",
      baseUrl: "https://example.invalid/api/v5",
    }, { fetchImpl, retries: 0 });

    await expect(syncJiandaoyunForm(db, {
      client,
      actorId: actor.id,
      contract,
    })).rejects.toThrow("字段契约漂移");
    expect(await db.select().from(schema.integrationRuns)).toHaveLength(0);
    expect(await db.select().from(schema.stagingRows)).toHaveLength(0);
  });

  it("已成功同步后，契约字段类型变化必须停机复核", async () => {
    const { db } = await createTestDb();
    const [actor] = await db.insert(schema.users).values({ name: "简道云同步责任人" }).returning();
    const client = (qtyType: string) => new JiandaoyunClient({
      apiKey: "secret",
      baseUrl: "https://example.invalid/api/v5",
    }, {
      retries: 0,
      fetchImpl: vi.fn(async (url: string | URL | Request) => {
        const path = new URL(String(url)).pathname;
        if (path.endsWith("/app/entry/widget/list")) {
          return response({
            widgets: [
              { name: "_widget_code", label: "产品编码", type: "text" },
              { name: "_widget_qty", label: "数量", type: qtyType },
              {
                name: "_widget_lines",
                label: "产品明细",
                type: "subform",
                items: [
                  { name: "_widget_line_code", label: "产品编码", type: "text" },
                  { name: "_widget_line_qty", label: "数量", type: "number" },
                ],
              },
            ],
          });
        }
        return response({ data: [] });
      }) as unknown as typeof fetch,
    });
    const evidence = async (_connector: string, _stream: string, envelope: unknown) => ({
      relativePath: "integration-evidence/jdy/test-observation/schema.json",
      hash: "d".repeat(64),
      bytes: `${JSON.stringify(envelope)}\n`,
    });

    await syncJiandaoyunForm(db, {
      client: client("number"),
      actorId: actor.id,
      contract,
      writeEvidence: evidence,
    });
    await expect(syncJiandaoyunForm(db, {
      client: client("text"),
      actorId: actor.id,
      contract,
      writeEvidence: evidence,
    })).rejects.toThrow("schema hash 已变化");
    expect(await db.select().from(schema.integrationRuns)).toHaveLength(1);
  });
});
