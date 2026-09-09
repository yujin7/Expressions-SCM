import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import type { SessionUser } from "@/server/core/dto";
import { confirmSkuSourceStatus, getSkuSourceStatus } from "@/server/modules/master/sku-source-status";
import { createTestDb, type TestDb } from "../helpers/db";

const deps = vi.hoisted(() => ({ fail: false }));
vi.mock("@/server/core/audit", async original => {
  const actual = await original<typeof import("@/server/core/audit")>();
  return { ...actual, writeAudit: async (...args: Parameters<typeof actual.writeAudit>) => {
    await actual.writeAudit(...args); if (deps.fail) throw new Error("synthetic status audit failure");
  } };
});
let db: TestDb, client: Awaited<ReturnType<typeof createTestDb>>["client"], actor: SessionUser;
let tick = 0;
beforeAll(async () => {
  ({ db, client } = await createTestDb());
  const [u] = await db.insert(schema.users).values({ name: "合成状态计划员", roles: ["pmc"] }).returning();
  actor = { id: u.id, name: u.name, roles: ["pmc"], isApprover: false };
});
afterAll(async () => client?.close());
async function sku() {
  const code = `QA-${randomUUID()}`;
  const [spu] = await db.insert(schema.spus).values({ code, nameCn: "合成状态族" }).returning();
  const [row] = await db.insert(schema.skus).values({ code, name: "合成状态商品", spuId: spu.id, skuType: "finished", baseUom: "支",
    lifecycle: "halted", active: false, commercialRole: "sample", nearExpiryDays: 180 }).returning();
  return row;
}
async function feed(skuRow: Awaited<ReturnType<typeof sku>>, opts: { source?: "jst" | "jdy"; raw?: unknown; code?: string; duplicate?: boolean; qualityBlocked?: boolean; failed?: boolean; asOf?: string; deleted?: boolean; recorded?: number; } = {}) {
  const source = opts.source ?? "jdy", code = opts.code ?? skuRow.code;
  const key = randomUUID(), startedAt = new Date(Date.UTC(2026, 8, 1, 0, 0, ++tick));
  const [job] = await db.insert(schema.importJobs).values({ template: "synthetic", filename: key, createdBy: actor.id, status: "done", sourceAsOf: opts.asOf ?? "2026-09-01" }).returning();
  const [run] = await db.insert(schema.integrationRuns).values({ connector: source, stream: source === "jdy" ? "jst-item-master-mirror-observation" : "item-master",
    idempotencyKey: key, status: opts.failed ? "failed" : "succeeded", importJobId: opts.failed ? null : job.id,
    startedAt, finishedAt: new Date(startedAt.getTime() + 100), sourceRows: opts.duplicate ? 2 : 1, stagedRows: opts.duplicate ? 2 : 1,
    requestScope: { qualityBlocked: opts.qualityBlocked ?? false } }).returning();
  const raw = Object.prototype.hasOwnProperty.call(opts, "raw") ? opts.raw : source === "jdy" ? "启用" : "1";
  const payload = source === "jdy" ? { data: { skuCode: code, itemStatus: raw }, _identity: opts.recorded ? { skuId: opts.recorded } : {}, sourceDeletedAt: opts.deleted ? "2026-09-01" : null }
    : { skuCode: code, enabled: raw, _resolved: opts.recorded ? { skuId: opts.recorded } : {} };
  const rows = await db.insert(schema.stagingRows).values(Array.from({ length: opts.duplicate ? 2 : 1 }, (_, i) => ({ importJobId: job.id, rowNo: i + 1, payload,
    targetTable: source === "jdy" ? "jdy_jst_item_master_mirror_observation" : "jst_item_master_observation", status: "pending" as const }))).returning();
  return { job, run, row: rows[0] };
}
async function claim(id: number, code: string, scope = "JIANDAOYUN") {
  await db.insert(schema.aliases).values({ aliasType: "sku_code", scope, rawValue: code, targetId: id, createdBy: actor.id });
}
function input(view: Awaited<ReturnType<typeof getSkuSourceStatus>>, source: "jst" | "jdy" = "jdy") {
  return { requestId: randomUUID(), fingerprint: view.fingerprint, source, rowId: view.sources.find(s => s.key === source)!.rows[0].id,
    lifecycle: "trial", reason: "已与产品负责人核实为试销", independentlyVerified: true };
}
it("same code remains an unclaimed clue; scoped identity enables explicit confirmation without touching other master fields", async () => {
  const row = await sku(); await feed(row);
  const unclaimed = await getSkuSourceStatus(row.id, actor, db);
  expect(unclaimed.sources[1].rows[0]).toMatchObject({ rawStatus: "启用", confirmable: false });
  await expect(confirmSkuSourceStatus(row.id, input(unclaimed), actor, db)).rejects.toThrow("不具备确认资格");
  await claim(row.id, row.code);
  const view = await getSkuSourceStatus(row.id, actor, db);
  expect(view.sources[1].rows[0].ageDays).toBeGreaterThanOrEqual(0);
  const body = input(view);
  const result = await confirmSkuSourceStatus(row.id, body, actor, db);
  expect(result.replayed).toBe(false);
  expect(await confirmSkuSourceStatus(row.id, body, actor, db)).toEqual({ ...result, replayed: true });
  const [saved] = await db.select().from(schema.skus).where(eq(schema.skus.id, row.id));
  expect(saved).toMatchObject({ lifecycle: "trial", active: false, commercialRole: "sample", nearExpiryDays: 180 });
  const history = (await getSkuSourceStatus(row.id, actor, db)).history;
  expect(history).toHaveLength(1);
  expect(history[0]).toMatchObject({ from: "halted", to: "trial", rawStatus: "启用", reason: body.reason });
  await expect(confirmSkuSourceStatus(row.id, { ...body, lifecycle: "retired" }, actor, db)).rejects.toThrow("不同确认");
});
it("latest failure is visible next to old success and blocks confirmation; a new full snapshot does not fall back to old rows", async () => {
  const row = await sku(); await claim(row.id, row.code); const old = await feed(row); await feed(row, { failed: true });
  const failed = await getSkuSourceStatus(row.id, actor, db);
  expect(failed.sources[1].latestAttempt?.status).toBe("failed");
  expect(failed.sources[1].latestSuccess?.jobId).toBe(old.job.id);
  expect(failed.sources[1].rows[0].confirmable).toBe(false);
  await feed(await sku());
  expect((await getSkuSourceStatus(row.id, actor, db)).sources[1].rows).toHaveLength(0);
});
it("JST change feeds retain prior SKU observations across newer other-SKU batches; 0 is reserve, never disabled", async () => {
  const row = await sku(); await claim(row.id, row.code, "JST"); await feed(row, { source: "jst", raw: 0 });
  await feed(await sku(), { source: "jst" });
  expect((await getSkuSourceStatus(row.id, actor, db)).sources[0].rows[0]).toMatchObject({ meaning: "备用", confirmable: true });
  await feed(row, { source: "jst", raw: -1, asOf: "2026-09-02" });
  expect((await getSkuSourceStatus(row.id, actor, db)).sources[0].rows[0].meaning).toBe("禁用");
});
it("duplicate, unknown, deletion, quality review and conflicting ownership cannot be confirmed", async () => {
  for (const opts of [{ duplicate: true }, { raw: "禁用" }, { raw: null }, { deleted: true }, { qualityBlocked: true }]) {
    const row = await sku(); await claim(row.id, row.code); await feed(row, opts);
    expect((await getSkuSourceStatus(row.id, actor, db)).sources[1].rows[0].confirmable).toBe(false);
  }
  const row = await sku(), other = await sku(); await claim(row.id, row.code); await feed(row, { recorded: other.id });
  expect((await getSkuSourceStatus(row.id, actor, db)).sources[1].rows[0].reasons.join()).toContain("归属冲突");
  await db.insert(schema.skuIdentifiers).values({ skuId: other.id, value: row.code, kind: "external", scope: "JIANDAOYUN", active: true });
  expect((await getSkuSourceStatus(row.id, actor, db)).sources[1].rows[0].confirmable).toBe(false);
});
it("stale evidence and changed SKU refuse; audit failure rolls back lifecycle and receipt", async () => {
  const row = await sku(); await claim(row.id, row.code); await feed(row);
  const prior = await getSkuSourceStatus(row.id, actor, db);
  await db.update(schema.skus).set({ name: "已变化" }).where(eq(schema.skus.id, row.id));
  await expect(confirmSkuSourceStatus(row.id, input(prior), actor, db)).rejects.toThrow("已变化");
  const current = await getSkuSourceStatus(row.id, actor, db);
  deps.fail = true;
  try { await expect(confirmSkuSourceStatus(row.id, input(current), actor, db)).rejects.toThrow("synthetic status audit failure"); } finally { deps.fail = false; }
  expect((await getSkuSourceStatus(row.id, actor, db)).history).toHaveLength(0);
  expect((await db.select().from(schema.skus).where(eq(schema.skus.id, row.id)))[0].lifecycle).toBe("halted");
  await feed(row, { qualityBlocked: true });
  await expect(confirmSkuSourceStatus(row.id, input(current), actor, db)).rejects.toThrow("已变化");
});
it("superseded batches are never resurrected and future/missing source dates remain ineligible", async () => {
  const row = await sku(); await claim(row.id, row.code); const old = await feed(row);
  await db.update(schema.importJobs).set({ status: "superseded" }).where(eq(schema.importJobs.id, old.job.id));
  expect((await getSkuSourceStatus(row.id, actor, db)).sources[1].rows).toHaveLength(0);
  await feed(row, { asOf: "2099-01-01" });
  expect((await getSkuSourceStatus(row.id, actor, db)).sources[1].rows[0].confirmable).toBe(false);
});
it("observations with zero or mismatched batch control totals cannot support a status decision", async () => {
  const row = await sku(); await claim(row.id, row.code); const observed = await feed(row);
  for (const values of [{ sourceRows: 0, stagedRows: 0 }, { sourceRows: 2, stagedRows: 1 }, { sourceRows: 1, stagedRows: 1, rejectedRows: 1 }]) {
    await db.update(schema.integrationRuns).set(values).where(eq(schema.integrationRuns.id, observed.run.id));
    expect((await getSkuSourceStatus(row.id, actor, db)).sources[1].rows[0].confirmable).toBe(false);
  }
});
it("history cursors retrieve all confirmations without repeating the first page or changing evidence", async () => {
  const row = await sku(); await claim(row.id, row.code); await feed(row);
  for (let i = 0; i < 22; i++) {
    const view = await getSkuSourceStatus(row.id, actor, db);
    await confirmSkuSourceStatus(row.id, { ...input(view), reason: `人工核实历史分页第${i}次` }, actor, db);
  }
  const first = await getSkuSourceStatus(row.id, actor, db);
  expect(first.history).toHaveLength(20); expect(first.historyHasMore).toBe(true);
  const last = await getSkuSourceStatus(row.id, actor, db, first.history.at(-1)!.id);
  expect(last.history).toHaveLength(2); expect(last.historyHasMore).toBe(false);
  expect(new Set([...first.history, ...last.history].map(item => item.id)).size).toBe(22);
  expect(last.fingerprint).toBe(first.fingerprint);
  await expect(getSkuSourceStatus(row.id, actor, db, 0)).rejects.toThrow("历史游标");
});
it("fresh role/activation and channel restrictions apply to reads, writes and replay", async () => {
  const row = await sku(); await claim(row.id, row.code); await feed(row);
  const view = await getSkuSourceStatus(row.id, actor, db), body = input(view);
  await confirmSkuSourceStatus(row.id, body, actor, db);
  await db.update(schema.users).set({ roles: ["warehouse"] }).where(eq(schema.users.id, actor.id));
  expect((await getSkuSourceStatus(row.id, actor, db)).canWrite).toBe(false);
  await expect(confirmSkuSourceStatus(row.id, body, actor, db)).rejects.toThrow("计划或管理员");
  await db.insert(schema.userDataScopes).values({ userId: actor.id, scopeKind: "channel", targetId: 1, createdBy: actor.id });
  await expect(getSkuSourceStatus(row.id, actor, db)).rejects.toThrow("跨店铺身份治理");
  await db.update(schema.users).set({ active: false }).where(eq(schema.users.id, actor.id));
  await expect(getSkuSourceStatus(row.id, actor, db)).rejects.toThrow("停用");
});
