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

interface TestObservationRow {
  id: string;
  code: string;
  updatedAt: string;
}

function observationClient(readRows: () => readonly TestObservationRow[]): JiandaoyunClient {
  return new JiandaoyunClient({
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
      return response({
        data: readRows().map((row) => ({
          _id: row.id,
          appId,
          entryId,
          updateTime: row.updatedAt,
          _widget_code: { value: row.code },
          _widget_qty: { value: "1.0000" },
          _widget_lines: { value: [] },
        })),
      });
    }) as unknown as typeof fetch,
  });
}

function observationEvidence(hashPart: string) {
  return async (_connector: string, _stream: string, envelope: unknown) => ({
    relativePath: `integration-evidence/jdy/test-observation/${hashPart}.json`,
    hash: hashPart.repeat(64),
    bytes: `${JSON.stringify(envelope)}\n`,
  });
}

async function expectMissingPriorObservationRejected(
  replacement: readonly TestObservationRow[],
  replacementHashPart: string,
): Promise<void> {
  const { db } = await createTestDb();
  const [actor] = await db.insert(schema.users).values({ name: "简道云记录连续性责任人" }).returning();
  const original = [
    { id: "1".repeat(24), code: "SKU-1", updatedAt: "2026-07-30T02:00:00.000Z" },
    { id: "2".repeat(24), code: "SKU-2", updatedAt: "2026-07-30T02:00:00.000Z" },
  ];
  let rows: readonly TestObservationRow[] = original;
  const client = observationClient(() => rows);
  const first = await syncJiandaoyunForm(db, {
    client,
    actorId: actor.id,
    contract,
    writeEvidence: observationEvidence("7"),
  });
  rows = replacement;
  await expect(syncJiandaoyunForm(db, {
    client,
    actorId: actor.id,
    contract,
    writeEvidence: observationEvidence(replacementHashPart),
  })).rejects.toThrow("缺少旧记录 1 条");

  const jobs = await db.select().from(schema.importJobs);
  expect(jobs).toHaveLength(1);
  expect(jobs[0]).toMatchObject({ id: first.importJobId, status: "done", controlRows: 2 });
  const activeRows = await db
    .select()
    .from(schema.stagingRows)
    .where(eq(schema.stagingRows.importJobId, first.importJobId));
  expect(activeRows.map((row) => (
    row.payload as { sourceRecordId: string }
  ).sourceRecordId).sort()).toEqual(original.map((row) => row.id));
  expect(activeRows.every((row) => row.status === "pending")).toBe(true);
  const [checkpoint] = await db.select().from(schema.integrationCheckpoints);
  expect(checkpoint).toMatchObject({
    stream: contract.key,
    version: 1,
    lastRunId: first.runId,
    cursor: "7".repeat(64),
  });
  expect((await db.select().from(schema.integrationRuns)).map((run) => run.status)).toEqual([
    "succeeded",
    "failed",
  ]);
}

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
    expect(formEvidence.mock.calls[0]?.[2]).toMatchObject({
      contract: "jiandaoyun-observation-v4",
      scope: {
        controlSummary: {
          version: "jdy-control-v1",
          status: "pass",
          activeRows: 1,
          duplicateRows: 0,
          invalidNumericValues: 0,
          reconciliationMismatchedRows: 0,
        },
      },
    });
    const runs = await db.select().from(schema.integrationRuns);
    const checkpoints = await db.select().from(schema.integrationCheckpoints);
    const aliasQueue = await db.select().from(schema.aliasExceptions);
    const jobs = await db.select().from(schema.importJobs);
    expect(runs).toHaveLength(3);
    expect(runs.every((run) => run.status === "succeeded")).toBe(true);
    expect(runs.find((run) => run.id === first.runId)?.requestScope).toMatchObject({
      qualityBlocked: false,
      controlSummary: { version: "jdy-control-v1", status: "pass" },
    });
    expect(jobs.map((job) => job.status)).toEqual(["done", "done"]);
    expect(jobs.find((job) => job.id === first.importJobId)?.scope).toMatchObject({
      qualityBlocked: false,
      controlSummary: { version: "jdy-control-v1", status: "pass" },
    });
    expect(staged[0].status).toBe("pending");
    expect(checkpoints.map((row) => row.stream).sort()).toEqual(["catalog", "test-observation"]);
    expect(checkpoints.find((row) => row.stream === "test-observation")?.lastRunId).toBe(first.runId);
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

  it("把业务键重复固化为不含原始值的质量门禁摘要", async () => {
    const { db } = await createTestDb();
    const [actor] = await db.insert(schema.users).values({ name: "简道云质量责任人" }).returning();
    const controlled = { ...contract, businessKey: ["productCode"] } satisfies JiandaoyunFormContract;
    const client = observationClient(() => [
      { id: "1".repeat(24), code: "DUPLICATE-SKU", updatedAt: "2026-07-30T02:00:00.000Z" },
      { id: "2".repeat(24), code: "duplicate-sku", updatedAt: "2026-07-30T02:00:00.000Z" },
    ]);
    const writeEvidence = vi.fn(observationEvidence("d"));

    const result = await syncJiandaoyunForm(db, {
      client,
      actorId: actor.id,
      contract: controlled,
      writeEvidence,
    });
    const [run] = await db
      .select({ requestScope: schema.integrationRuns.requestScope })
      .from(schema.integrationRuns)
      .where(eq(schema.integrationRuns.id, result.runId));

    expect(run.requestScope).toMatchObject({
      qualityBlocked: true,
      controlSummary: {
        version: "jdy-control-v1",
        status: "review",
        duplicateKeyGroups: 1,
        duplicateRows: 2,
      },
    });
    expect(JSON.stringify(run.requestScope)).not.toContain("DUPLICATE-SKU");
    expect(writeEvidence.mock.calls[0]?.[2]).toMatchObject({
      scope: { controlSummary: { status: "review", duplicateRows: 2 } },
    });
  });

  it("新的非空全量观察替代旧待复核批次，但保留追溯记录", async () => {
    const { db } = await createTestDb();
    const [actor] = await db.insert(schema.users).values({ name: "简道云全量责任人" }).returning();
    let currentCode = "OLD-SKU";
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
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
      return response({
        data: [{
          _id: recordId,
          appId,
          entryId,
          updateTime: "2026-07-30T02:00:00.000Z",
          _widget_code: { value: currentCode },
          _widget_qty: { value: "1.0000" },
          _widget_lines: { value: [] },
        }],
      });
    }) as unknown as typeof fetch;
    const client = new JiandaoyunClient({
      apiKey: "secret",
      baseUrl: "https://example.invalid/api/v5",
    }, { fetchImpl, retries: 0 });
    const evidence = (hash: string) => async (
      _connector: string,
      _stream: string,
      envelope: unknown,
    ) => ({
      relativePath: `integration-evidence/jdy/test-observation/${hash}.json`,
      hash: hash.repeat(64),
      bytes: `${JSON.stringify(envelope)}\n`,
    });

    const first = await syncJiandaoyunForm(db, {
      client,
      actorId: actor.id,
      contract,
      writeEvidence: evidence("1"),
    });
    currentCode = "NEW-SKU";
    const second = await syncJiandaoyunForm(db, {
      client,
      actorId: actor.id,
      contract,
      writeEvidence: evidence("2"),
    });

    const jobs = await db.select().from(schema.importJobs);
    expect(jobs.map((job) => [job.id, job.status])).toEqual([
      [first.importJobId, "superseded"],
      [second.importJobId, "done"],
    ]);
    const oldRows = await db
      .select()
      .from(schema.stagingRows)
      .where(eq(schema.stagingRows.importJobId, first.importJobId));
    const currentRows = await db
      .select()
      .from(schema.stagingRows)
      .where(eq(schema.stagingRows.importJobId, second.importJobId));
    expect(oldRows).toHaveLength(1);
    expect(oldRows[0]).toMatchObject({ status: "error" });
    expect(oldRows[0].errorMsg).toContain(`新全量观察批次 #${second.importJobId}`);
    expect(currentRows).toHaveLength(1);
    expect(currentRows[0]).toMatchObject({ status: "pending" });
    expect(currentRows[0].payload).toMatchObject({ data: { productCode: "NEW-SKU" } });
    expect(await db.select().from(schema.integrationRuns)).toHaveLength(2);
  });

  it("滚动窗口观察保留旧批次，供 30/90 天读模型跨批去重累加", async () => {
    const { db } = await createTestDb();
    const [actor] = await db.insert(schema.users).values({ name: "简道云窗口责任人" }).returning();
    let rows: readonly TestObservationRow[] = [{
      id: "1".repeat(24), code: "OLDER-SKU", updatedAt: "2026-08-30T02:00:00.000Z",
    }];
    const windowedContract: JiandaoyunFormContract = {
      ...contract,
      key: "windowed-test-observation",
      window: { field: "statistical_date", days: 3 },
    };
    const client = observationClient(() => rows);
    const envelopes: unknown[] = [];
    const captureEvidence = (hashPart: string) => async (
      _connector: string,
      _stream: string,
      envelope: unknown,
    ) => {
      envelopes.push(envelope);
      return {
        relativePath: `integration-evidence/jdy/test-observation/${hashPart}.json`,
        hash: hashPart.repeat(64),
        bytes: `${JSON.stringify(envelope)}\n`,
      };
    };
    const first = await syncJiandaoyunForm(db, {
      client,
      actorId: actor.id,
      contract: windowedContract,
      writeEvidence: captureEvidence("3"),
    });
    rows = [{ id: "2".repeat(24), code: "NEWER-SKU", updatedAt: "2026-09-02T02:00:00.000Z" }];
    const second = await syncJiandaoyunForm(db, {
      client,
      actorId: actor.id,
      contract: windowedContract,
      writeEvidence: captureEvidence("4"),
    });

    const jobs = await db.select().from(schema.importJobs);
    expect(jobs.map((job) => [job.id, job.status])).toEqual([
      [first.importJobId, "done"],
      [second.importJobId, "done"],
    ]);
    const staged = await db.select().from(schema.stagingRows);
    expect(staged).toHaveLength(2);
    expect(staged.every((row) => row.status === "pending")).toBe(true);
    expect(staged.map((row) => (row.payload as { data: { productCode: string } }).data.productCode).sort())
      .toEqual(["NEWER-SKU", "OLDER-SKU"]);
    expect(envelopes).toHaveLength(2);
    expect(envelopes[0]).toMatchObject({
      scope: { window: { field: "statistical_date", days: 3 } },
    });
    const runs = await db.select().from(schema.integrationRuns);
    expect(runs.map((run) => run.requestScope)).toEqual([
      expect.objectContaining({ window: { field: "statistical_date", days: 3 } }),
      expect.objectContaining({ window: { field: "statistical_date", days: 3 } }),
    ]);
  });

  it("全量行数下降时失败并保留旧批次，不把权限缩减当删除", async () => {
    const { db } = await createTestDb();
    const [actor] = await db.insert(schema.users).values({ name: "简道云完整性责任人" }).returning();
    let sourceRows = 2;
    const client = new JiandaoyunClient({
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
        return response({
          data: Array.from({ length: sourceRows }, (_, index) => ({
            _id: String(index + 1).padStart(24, "c"),
            appId,
            entryId,
            updateTime: "2026-07-30T02:00:00.000Z",
            _widget_code: { value: `SKU-${index + 1}` },
            _widget_qty: { value: "1.0000" },
            _widget_lines: { value: [] },
          })),
        });
      }) as unknown as typeof fetch,
    });
    const evidence = (hash: string) => async (_connector: string, _stream: string, envelope: unknown) => ({
      relativePath: `integration-evidence/jdy/test-observation/${hash}.json`,
      hash: hash.repeat(64),
      bytes: `${JSON.stringify(envelope)}\n`,
    });
    const first = await syncJiandaoyunForm(db, {
      client,
      actorId: actor.id,
      contract,
      writeEvidence: evidence("3"),
    });
    sourceRows = 1;
    /* 拒绝口径不变（旧批次原封不动保留），但报文必须说清楚**少了哪一条、像什么形状**：
       2026-09-04 生产上只报了「6447 < 6448，需人工复核」，运维无从下手，
       唯一在跑通的连接器就此停摆。 */
    await expect(syncJiandaoyunForm(db, {
      client,
      actorId: actor.id,
      contract,
      writeEvidence: evidence("4"),
      /* 一次调用同时验三件事：仍然拒绝、说得出少了哪一条、说得出形状。
         「尾部整段消失」= 分页/权限截断，指向查分页与授权，而不是当成删除放行。 */
    })).rejects.toThrow(/缺少旧记录 1 条[\s\S]*ccc[\s\S]*尾部/u);

    const jobs = await db.select().from(schema.importJobs);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ id: first.importJobId, status: "done", controlRows: 2 });
    const active = await db
      .select()
      .from(schema.stagingRows)
      .where(eq(schema.stagingRows.importJobId, first.importJobId));
    expect(active).toHaveLength(2);
    expect(active.every((row) => row.status === "pending")).toBe(true);
    expect((await db.select().from(schema.integrationRuns)).map((run) => run.status)).toEqual([
      "succeeded",
      "failed",
    ]);
  });

  it("同数量观察替换旧记录 ID 时失败，不把权限漂移当删除和新增", async () => {
    await expectMissingPriorObservationRejected([
      { id: "2".repeat(24), code: "SKU-2", updatedAt: "2026-07-30T03:00:00.000Z" },
      { id: "3".repeat(24), code: "SKU-3", updatedAt: "2026-07-30T03:00:00.000Z" },
    ], "8");
  });

  it("行数增加但仍缺少旧记录 ID 时失败，不用新增行掩盖缺失行", async () => {
    await expectMissingPriorObservationRejected([
      { id: "2".repeat(24), code: "SKU-2", updatedAt: "2026-07-30T03:00:00.000Z" },
      { id: "3".repeat(24), code: "SKU-3", updatedAt: "2026-07-30T03:00:00.000Z" },
      { id: "4".repeat(24), code: "SKU-4", updatedAt: "2026-07-30T03:00:00.000Z" },
    ], "9");
  });

  it("不同信封并发时每个 stream 只保留一个可复核全量批次", async () => {
    const { db } = await createTestDb();
    const [actor] = await db.insert(schema.users).values({ name: "简道云并发责任人" }).returning();
    const makeClient = (code: string) => new JiandaoyunClient({
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
        return response({
          data: [{
            _id: recordId,
            appId,
            entryId,
            updateTime: "2026-07-30T02:00:00.000Z",
            _widget_code: { value: code },
            _widget_qty: { value: "1.0000" },
            _widget_lines: { value: [] },
          }],
        });
      }) as unknown as typeof fetch,
    });
    const attempt = (code: string, hash: string) => syncJiandaoyunForm(db, {
      client: makeClient(code),
      actorId: actor.id,
      contract,
      writeEvidence: async (_connector, _stream, envelope) => ({
        relativePath: `integration-evidence/jdy/test-observation/${hash}.json`,
        hash: hash.repeat(64),
        bytes: `${JSON.stringify(envelope)}\n`,
      }),
    });

    const results = await Promise.allSettled([attempt("CONCURRENT-A", "5"), attempt("CONCURRENT-B", "6")]);
    expect(results.some((result) => result.status === "fulfilled")).toBe(true);
    const runs = (await db.select().from(schema.integrationRuns)).sort((left, right) => left.id - right.id);
    const succeededRuns = runs.filter((run) => run.status === "succeeded");
    const newestRun = runs.at(-1)!;
    expect(newestRun.status).toBe("succeeded");
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(succeededRuns.length);
    const [checkpoint] = await db.select().from(schema.integrationCheckpoints);
    expect(checkpoint).toMatchObject({
      stream: contract.key,
      version: succeededRuns.length,
      lastRunId: newestRun.id,
      cursor: newestRun.evidenceHash,
    });
    const jobs = await db.select().from(schema.importJobs);
    expect(jobs.filter((job) => job.status === "done")).toHaveLength(1);
    const activeJob = jobs.find((job) => job.status === "done")!;
    expect(activeJob.id).toBe(newestRun.importJobId);
    const activeRows = await db
      .select()
      .from(schema.stagingRows)
      .where(eq(schema.stagingRows.importJobId, activeJob.id));
    expect(activeRows).toHaveLength(1);
    expect(activeRows[0].status).toBe("pending");
    const expectedCode = newestRun.evidenceHash === "5".repeat(64) ? "CONCURRENT-A" : "CONCURRENT-B";
    expect(activeRows[0].payload).toMatchObject({ data: { productCode: expectedCode } });
    const allRows = await db.select().from(schema.stagingRows);
    expect(allRows.filter((row) => row.status === "pending")).toHaveLength(1);
  });

  it("目录不同信封并发完成时由较新运行持有单调 checkpoint", async () => {
    const { db } = await createTestDb();
    const [actor] = await db.insert(schema.users).values({ name: "简道云目录并发责任人" }).returning();
    const makeClient = (label: string) => new JiandaoyunClient({
      apiKey: "secret",
      baseUrl: "https://example.invalid/api/v5",
    }, {
      retries: 0,
      fetchImpl: vi.fn(async (url: string | URL | Request) => {
        const path = new URL(String(url)).pathname;
        if (path.endsWith("/app/list")) {
          return response({ apps: [{ app_id: appId, name: `应用-${label}` }] });
        }
        if (path.endsWith("/app/entry/list")) {
          return response({ forms: [{ app_id: appId, entry_id: entryId, name: `表单-${label}` }] });
        }
        throw new Error(`unexpected ${path}`);
      }) as unknown as typeof fetch,
    });
    const attempt = (label: string, hashPart: string) => syncJiandaoyunCatalog(db, {
      client: makeClient(label),
      actorId: actor.id,
      writeEvidence: async (_connector, _stream, envelope) => ({
        relativePath: `integration-evidence/jdy/catalog/${hashPart}.json`,
        hash: hashPart.repeat(64),
        bytes: `${JSON.stringify(envelope)}\n`,
      }),
    });

    const results = await Promise.allSettled([attempt("A", "a"), attempt("B", "b")]);
    const fulfilled = results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
    const runs = (await db.select().from(schema.integrationRuns)).sort((left, right) => left.id - right.id);
    const succeededRuns = runs.filter((run) => run.status === "succeeded");
    const newestRun = runs.at(-1)!;
    expect(fulfilled).toHaveLength(succeededRuns.length);
    expect(newestRun.status).toBe("succeeded");
    expect(fulfilled.map((summary) => summary.runId)).toContain(newestRun.id);
    const [checkpoint] = await db.select().from(schema.integrationCheckpoints);
    expect(checkpoint).toMatchObject({
      stream: "catalog",
      version: succeededRuns.length,
      lastRunId: newestRun.id,
      cursor: newestRun.evidenceHash,
    });
    expect(await db.select().from(schema.importJobs)).toHaveLength(0);
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

  it("checkpoint 失败时整批回滚；同一信封可从 failed 原子重试", async () => {
    const { db, client: pg } = await createTestDb();
    const [actor] = await db.insert(schema.users).values({ name: "简道云恢复责任人" }).returning();
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
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
      return response({
        data: [{
          _id: recordId,
          appId,
          entryId,
          updateTime: "2026-07-30T02:00:00.000Z",
          _widget_code: { value: "RECOVERY-SKU" },
          _widget_qty: { value: "1.0000" },
          _widget_lines: { value: [] },
        }],
      });
    }) as unknown as typeof fetch;
    const client = new JiandaoyunClient({
      apiKey: "secret",
      baseUrl: "https://example.invalid/api/v5",
    }, { fetchImpl, retries: 0 });
    const evidence = async (_connector: string, _stream: string, envelope: unknown) => ({
      relativePath: "integration-evidence/jdy/test-observation/recovery.json",
      hash: "e".repeat(64),
      bytes: `${JSON.stringify(envelope)}\n`,
    });

    await pg.exec(`
      CREATE FUNCTION fail_jdy_checkpoint() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'injected checkpoint failure';
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER fail_jdy_checkpoint_trigger
      BEFORE INSERT OR UPDATE ON integration_checkpoints
      FOR EACH ROW EXECUTE FUNCTION fail_jdy_checkpoint();
    `);

    await expect(syncJiandaoyunForm(db, {
      client,
      actorId: actor.id,
      contract,
      writeEvidence: evidence,
    })).rejects.toThrow("Failed query");

    const [failed] = await db.select().from(schema.integrationRuns);
    expect(failed).toMatchObject({ status: "failed", importJobId: null });
    expect(await db.select().from(schema.importJobs)).toHaveLength(0);
    expect(await db.select().from(schema.stagingRows)).toHaveLength(0);
    expect(await db.select().from(schema.aliasExceptions)).toHaveLength(0);
    expect(await db.select().from(schema.integrationCheckpoints)).toHaveLength(0);

    await pg.exec(`
      DROP TRIGGER fail_jdy_checkpoint_trigger ON integration_checkpoints;
      DROP FUNCTION fail_jdy_checkpoint();
    `);
    const retried = await syncJiandaoyunForm(db, {
      client,
      actorId: actor.id,
      contract,
      writeEvidence: evidence,
    });
    expect(retried).toMatchObject({ runId: failed.id, sourceRows: 1, stagedRows: 1 });
    const [recovered] = await db.select().from(schema.integrationRuns);
    expect(recovered).toMatchObject({ id: failed.id, status: "succeeded" });
    expect(await db.select().from(schema.importJobs)).toHaveLength(1);
    expect(await db.select().from(schema.stagingRows)).toHaveLength(1);
    expect(await db.select().from(schema.aliasExceptions)).toHaveLength(1);
    expect(await db.select().from(schema.integrationCheckpoints)).toHaveLength(1);
  });

  it("分页重复记录必须在 evidence 和运行史之前停机", async () => {
    const { db } = await createTestDb();
    const [actor] = await db.insert(schema.users).values({ name: "简道云控制责任人" }).returning();
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
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
      return response({
        data: [
          { _id: recordId, appId, entryId, _widget_code: { value: "A" }, _widget_lines: { value: [] } },
          { _id: recordId, appId, entryId, _widget_code: { value: "A" }, _widget_lines: { value: [] } },
        ],
      });
    }) as unknown as typeof fetch;
    const client = new JiandaoyunClient({
      apiKey: "secret",
      baseUrl: "https://example.invalid/api/v5",
    }, { fetchImpl, retries: 0 });
    const writeEvidence = vi.fn();

    await expect(syncJiandaoyunForm(db, {
      client,
      actorId: actor.id,
      contract,
      writeEvidence,
    })).rejects.toThrow("分页返回重复记录");
    expect(writeEvidence).not.toHaveBeenCalled();
    expect(await db.select().from(schema.integrationRuns)).toHaveLength(0);
    expect(await db.select().from(schema.importJobs)).toHaveLength(0);
  });

  it("超出租约的 running 运行可恢复，未过期运行仍受并发保护", async () => {
    const { db } = await createTestDb();
    const [actor] = await db.insert(schema.users).values({ name: "简道云租约责任人" }).returning();
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith("/app/list")) {
        return response({ apps: [{ app_id: appId, name: "供应中心" }] });
      }
      if (path.endsWith("/app/entry/list")) {
        return response({ forms: [{ app_id: appId, entry_id: entryId, name: "测试表单" }] });
      }
      throw new Error(`unexpected ${path}`);
    }) as unknown as typeof fetch;
    const client = new JiandaoyunClient({
      apiKey: "secret",
      baseUrl: "https://example.invalid/api/v5",
    }, { fetchImpl, retries: 0 });
    const staleHash = "f".repeat(64);
    const evidence = async (_connector: string, _stream: string, envelope: unknown) => ({
      relativePath: "integration-evidence/jdy/catalog/lease.json",
      hash: staleHash,
      bytes: `${JSON.stringify(envelope)}\n`,
    });
    const [abandoned] = await db.insert(schema.integrationRuns).values({
      connector: "jdy",
      stream: "catalog",
      idempotencyKey: `jdy:catalog:${staleHash}`,
      evidencePath: "integration-evidence/jdy/catalog/lease.json",
      evidenceHash: staleHash,
      startedAt: new Date(Date.now() - 3 * 60 * 60 * 1_000),
    }).returning();

    const recovered = await syncJiandaoyunCatalog(db, {
      client,
      actorId: actor.id,
      writeEvidence: evidence,
    });
    expect(recovered).toMatchObject({ runId: abandoned.id, replayed: false, apps: 1, forms: 1 });
    const [run] = await db.select().from(schema.integrationRuns);
    expect(run.status).toBe("succeeded");

    const freshHash = "9".repeat(64);
    await db.insert(schema.integrationRuns).values({
      connector: "jdy",
      stream: "catalog",
      idempotencyKey: `jdy:catalog:${freshHash}`,
      evidencePath: "integration-evidence/jdy/catalog/fresh.json",
      evidenceHash: freshHash,
    });
    await expect(syncJiandaoyunCatalog(db, {
      client,
      actorId: actor.id,
      writeEvidence: async (_connector, _stream, envelope) => ({
        relativePath: "integration-evidence/jdy/catalog/fresh.json",
        hash: freshHash,
        bytes: `${JSON.stringify(envelope)}\n`,
      }),
    })).rejects.toThrow("正在处理");
  });
});
