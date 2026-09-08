import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import type { SessionUser } from "@/server/core/dto";
import { createExportJob, runExportWorkerOnce } from "@/jobs/export-worker";
import { EXPORT_KINDS } from "@/server/modules/report/export";
import { createTestDb, type TestDb } from "../helpers/db";

const state = vi.hoisted(() => ({ db: null as unknown, user: null as unknown }));
vi.mock("@/db", () => ({ getDbAsync: async () => state.db }));
vi.mock("@/server/modules/master/common", async importOriginal => ({
  ...await importOriginal<typeof import("@/server/modules/master/common")>(), guardRead: async () => state.user,
}));
vi.mock("@/server/core/dto", async importOriginal => ({
  ...await importOriginal<typeof import("@/server/core/dto")>(), getFreshSessionUser: async () => state.user,
}));
import { GET } from "@/app/api/export/jobs/[id]/download/route";

let db: TestDb, close: () => Promise<void>, user: SessionUser, jobId: number;
const download = () => GET(new NextRequest(`http://localhost/api/export/jobs/${jobId}/download`), { params: Promise.resolve({ id: String(jobId) }) });
beforeEach(async () => {
  const fixture = await createTestDb(); db = fixture.db; state.db = db; close = () => fixture.client.close();
  const [row] = await db.insert(schema.users).values({ username: "export-owner", name: "合成财务", roles: ["finance"] }).returning();
  user = { id: row.id, name: row.name, roles: row.roles, sessionVersion: row.sessionVersion, isApprover: false };
  state.user = user;
  const job = await createExportJob(user, "balance", { __generatedAccess: "forged-client-binding" }, db); jobId = job.id;
  vi.spyOn(EXPORT_KINDS.balance, "produce").mockResolvedValue({ rows: [{ marker: "SYNTH_PRIVATE_AMOUNT" }], columns: [{ key: "marker", title: "授权时文件" }], total: 1 });
  expect(await runExportWorkerOnce(db, mkdtempSync(path.join(tmpdir(), "export-access-")))).toMatchObject({ status: "done" });
});
afterEach(async () => { vi.restoreAllMocks(); await close(); });

it("unchanged owner downloads the real generated file privately; client binding cannot override worker evidence", async () => {
  const response = await download(); expect(response.status).toBe(200);
  expect(await response.text()).toContain("SYNTH_PRIVATE_AMOUNT");
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  const [job] = await db.select().from(schema.exportJobs).where(eq(schema.exportJobs.id, jobId));
  expect((job.params as Record<string, unknown>).__generatedAccess).not.toBe("forged-client-binding");
});

it("role downgrade after generation rejects the old file even after a fresh login", async () => {
  await db.update(schema.users).set({ roles: ["warehouse"] }).where(eq(schema.users.id, user.id));
  state.user = { ...user, roles: ["warehouse"] };
  const response = await download(); expect(response.status).toBe(409);
  expect(await response.text()).not.toContain("SYNTH_PRIVATE_AMOUNT");
});

it("channel scope narrowing after generation rejects the old wider file", async () => {
  const [channel] = await db.insert(schema.channels).values({ code: "EXPORT-SCOPE", name: "合成渠道", kind: "platform" }).returning();
  await db.insert(schema.userDataScopes).values({ userId: user.id, scopeKind: "channel", targetId: channel.id, createdBy: user.id });
  const response = await download(); expect(response.status).toBe(409);
  expect(await response.text()).not.toContain("SYNTH_PRIVATE_AMOUNT");
});

it("disabled owner cannot read an already completed file", async () => {
  await db.update(schema.users).set({ active: false }).where(eq(schema.users.id, user.id));
  const response = await download(); expect(response.status).toBe(403);
  expect(await response.text()).not.toContain("SYNTH_PRIVATE_AMOUNT");
});

it("legacy file without worker-generated access evidence requests regeneration, not silent release", async () => {
  await db.update(schema.exportJobs).set({ params: {} }).where(eq(schema.exportJobs.id, jobId));
  const response = await download(); expect(response.status).toBe(409);
  expect(await response.text()).toContain("重新");
});

it("changed or corrupted file contents are refused instead of downloaded as trusted output", async () => {
  const [job] = await db.select().from(schema.exportJobs).where(eq(schema.exportJobs.id, jobId));
  writeFileSync(job.filePath!, "CORRUPTED_SYNTHETIC_FILE", "utf8");
  const response = await download(); expect(response.status).toBe(409);
  expect(await response.text()).toContain("校验失败");
});

it("other account cannot enumerate the file; current admin can read only a still-valid owner snapshot", async () => {
  const [other] = await db.insert(schema.users).values({ username: "export-other", name: "合成其他", roles: ["warehouse"] }).returning();
  state.user = { ...user, id: other.id, roles: other.roles };
  expect((await download()).status).toBe(404);
  await db.update(schema.users).set({ roles: ["admin"] }).where(eq(schema.users.id, other.id));
  state.user = { ...user, id: other.id, roles: ["admin"] };
  expect((await download()).status).toBe(200);
  await db.update(schema.users).set({ sessionVersion: user.sessionVersion! + 1 }).where(eq(schema.users.id, user.id));
  expect((await download()).status).toBe(409);
});
