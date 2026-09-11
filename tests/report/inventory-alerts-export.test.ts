import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { exportJobs } from "@/db/schema";
import { createTestDb, type TestDb } from "../helpers/db";
import { seedTierWorld } from "../helpers/tier-seed";
import type { InventoryAlertsReadModel } from "@/server/modules/report/inventory-alerts";

const mocks = vi.hoisted(() => ({ db: null as unknown, guard: vi.fn(), load: vi.fn(), start: vi.fn() }));
vi.mock("@/db", () => ({ getDbAsync: async () => mocks.db }));
vi.mock("@/server/modules/master/common", async original => ({ ...await original<typeof import("@/server/modules/master/common")>(), guardRead: () => mocks.guard() }));
vi.mock("@/server/modules/report/inventory-alerts", async original => ({ ...await original<typeof import("@/server/modules/report/inventory-alerts")>(), loadInventoryAlerts: (...args: unknown[]) => mocks.load(...args) }));
vi.mock("@/jobs/export-worker", async original => ({ ...await original<typeof import("@/jobs/export-worker")>(), ensureExportWorkerStarted: () => mocks.start() }));
import { computeInventoryAlerts } from "@/server/modules/report/inventory-alerts";
import { EXPORT_KINDS } from "@/server/modules/report/export";
import { runExportWorkerOnce } from "@/jobs/export-worker";
import { GET } from "@/app/api/export/inventory-alerts/route";

let db: TestDb, close: () => Promise<void>, model: InventoryAlertsReadModel;
const def = EXPORT_KINDS["inventory-alerts"];
const request = (params: Record<string, string> = {}) => GET(new NextRequest(`http://localhost/api/export/inventory-alerts?${new URLSearchParams({ onlyAlert: "0", showC: "1", ...params })}`));
beforeAll(async () => {
  const fixture = await createTestDb(); db = fixture.db; close = () => fixture.client.close(); mocks.db = db;
  const w = await seedTierWorld(db); mocks.guard.mockResolvedValue(w.pmc);
  model = await computeInventoryAlerts(db);
  expect(model.rows.length).toBeGreaterThan(0);
});
beforeEach(() => { mocks.load.mockReset().mockResolvedValue(model); mocks.start.mockReset(); });
afterAll(async () => close());

it("uses the same 44 columns and keeps unknown windows distinct from observed zero", async () => {
  const row = { ...model.rows[0], code: "ZERO", name: "=UNTRUSTED()", net7External: "0", net15External: null, net30External: "-1", externalDemand: { anchorDate: null, current: false, windows: null }, amount: "PRIVATE_AMOUNT" };
  mocks.load.mockResolvedValue({ ...model, rows: [row] });
  const response = await request();
  expect(response.status).toBe(200); expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  const csv = await response.text();
  expect(csv).toContain("'=UNTRUSTED()"); expect(csv).not.toContain("PRIVATE_AMOUNT");
  const result = await def.produce(await mocks.guard(), { onlyAlert: "0", showC: "1" }, 50000, db);
  expect(result.columns).toHaveLength(44);
  expect(result.rows[0]).toMatchObject({ c28: "0", c29: null, c10: "-1", c35: "未知" });
  expect(mocks.start).not.toHaveBeenCalled();
});

it("over 5000 rows queues once per request; the real worker exports beyond the page cap in global order", async () => {
  mocks.load.mockResolvedValue({ ...model, rows: Array.from({ length: 5002 }, (_, i) => ({ ...model.rows[0], skuId: i + 1, code: `EXPORT-${i + 1}`, name: `条目 ${i + 1}` })) });
  const response = await request({ sort: "code", order: "desc", page: "2", pageSize: "2" });
  expect(response.status).toBe(202); const result = await response.json();
  const [job] = await db.select().from(exportJobs).where(eq(exportJobs.id, result.jobId));
  expect(job.params).toEqual({ onlyAlert: "0", showC: "1", sort: "code", order: "desc" });
  expect(mocks.start).toHaveBeenCalledOnce();
  const dir = mkdtempSync(path.join(tmpdir(), "inventory-alert-export-"));
  expect(await runExportWorkerOnce(db, dir)).toMatchObject({ id: job.id, status: "done", rowCount: 5002 });
  const [done] = await db.select().from(exportJobs).where(eq(exportJobs.id, job.id));
  const csv = readFileSync(done.filePath!, "utf8").trimEnd().split("\r\n");
  expect(csv).toHaveLength(5003);
  expect(csv[1]).toContain("EXPORT-5002,"); expect(csv.at(-1)).toContain("EXPORT-1,");
});

it("filters before sorting/capping and does not recompute from an export refresh parameter", async () => {
  mocks.load.mockResolvedValue({ ...model, rows: [
    { ...model.rows[0], code: "KEEP-2", brand: "筛选品牌", onHand: "9007199254740993.0001" },
    { ...model.rows[0], code: "DROP", brand: "另一个品牌", onHand: "9999999999999999" },
    { ...model.rows[0], code: "KEEP-1", brand: "筛选品牌", onHand: "9007199254740993.0000" },
  ] });
  const params = def.paramsFromSearch(new URLSearchParams({ q: "筛选品牌", onlyAlert: "0", showC: "1", sort: "onHand", order: "asc", refresh: "1" }));
  expect(params).not.toHaveProperty("refresh");
  const result = await def.produce(await mocks.guard(), params, 1, db);
  expect(result.total).toBe(2); expect(result.rows[0].c2).toBe("KEEP-1");
});

it("invalid sort and malformed task filter are rejected before loading the model", async () => {
  expect((await request({ sort: "price" })).status).toBe(400);
  await expect(def.produce(await mocks.guard(), { q: ["bad"] }, 5000, db)).rejects.toMatchObject({ status: 400 });
  expect(mocks.load).not.toHaveBeenCalled(); expect(mocks.start).not.toHaveBeenCalled();
});
