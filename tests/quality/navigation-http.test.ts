import { NextRequest } from "next/server";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import * as s from "@/db/schema";
import type { SessionUser } from "@/server/core/dto";
import { GET } from "@/app/api/quality/cases/[id]/route";
import { GET as listGET } from "@/app/api/quality/cases/route";
import { getQualityCase, listQualityCases } from "@/server/modules/quality/service";
import { createTestDb, type TestDb } from "../helpers/db";

let db: TestDb, close: () => Promise<void>, actor: SessionUser | null, first: number, second: number;
vi.mock("@/db", async original => ({ ...await original<typeof import("@/db")>(), getDbAsync: async () => db }));
vi.mock("@/server/core/dto", async original => ({ ...await original<typeof import("@/server/core/dto")>(), getFreshSessionUser: async () => {
  if (!actor) throw Error("No session"); return actor;
} }));
const get = (id: string) => GET(new NextRequest(`http://localhost/api/quality/cases/${id}`), { params: Promise.resolve({ id }) });
beforeAll(async () => {
  const fixture = await createTestDb(); db = fixture.db; close = () => fixture.client.close();
  const [user] = await db.insert(s.users).values({ name: "质量核验", roles: ["quality"] }).returning();
  actor = { id: user.id, name: user.name, roles: ["quality"], isApprover: true };
  const base = { ownerId: user.id, createdBy: user.id, kind: "complaint", title: "受限标题", summary: "受限事实摘要", marketCode: "CN", sourceChannel: "consumer" };
  const rows = await db.insert(s.qualityCases).values([
    { ...base, idempotencyKey: "ff66b4ae-351a-492d-8694-f18ecc86871c", caseNo: "QI-NAV-A", severity: "critical", receivedDate: "2026-09-07", externalRef: "受控证据-A", reportDueDate: "2026-09-05" },
    { ...base, idempotencyKey: "37d60b64-c4a6-495f-9a5d-27c6dbb32e2f", caseNo: "QI-NAV-B", severity: "low", receivedDate: "2026-08-01" },
  ]).returning(); first = rows[0].id; second = rows[1].id;
});
afterAll(async () => close());

it("exact detail is independent of the first list page and preserves the list DTO", async () => {
  const page = await listQualityCases(actor!, { pageSize: 1 }, db);
  expect(page.rows[0].id).toBe(first);
  expect((await getQualityCase(actor!, second, db)).id).toBe(second);
  const response = await get(String(first));
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toContain("no-store");
  expect(await response.json()).toMatchObject({ id: first, title: "受限标题", externalRef: "受控证据-A", version: 1 });
});

it("detail rechecks current roles and uses the same restricted-evidence masking as the list", async () => {
  const original = actor!;
  try {
    actor = { ...original, roles: ["ops"] };
    const response = await get(String(first)); expect(response.status).toBe(200);
    const detail = await response.json();
    expect(detail).toMatchObject({ title: "受限投诉/不良事件案件", externalRef: null, assessmentBasis: null, rootCause: null });
    expect(JSON.stringify(detail)).not.toContain("受控证据-A");
    const list = await listQualityCases(actor, { q: "QI-NAV-A" }, db);
    expect(JSON.parse(JSON.stringify(list.rows[0]))).toEqual(detail);
    actor = { ...original, roles: ["finance"] };
    expect((await get(String(first))).status).toBe(403);
    actor = null;
    expect((await get(String(first))).status).toBe(401);
  } finally { actor = original; }
});

it("missing or malformed identity refuses instead of silently selecting another case", async () => {
  expect((await get("2147483647")).status).toBe(404);
  for (const id of ["0", "-1", "bad", "1.2"]) expect((await get(id)).status).toBe(400);
});

it("sorting happens before pagination and unknown dates remain last in both directions", async () => {
  const read = async (sort: string, direction: string) => {
    const response = await listGET(new NextRequest(`http://localhost/api/quality/cases?pageSize=1&sort=${sort}&direction=${direction}`));
    expect(response.status).toBe(200); return response.json();
  };
  expect((await read("receivedDate", "asc")).rows[0].id).toBe(second);
  expect((await read("receivedDate", "desc")).rows[0].id).toBe(first);
  expect((await read("caseNo", "desc")).rows[0].id).toBe(second);
  expect((await read("reportDueDate", "asc")).rows[0].id).toBe(first);
  expect((await read("reportDueDate", "desc")).rows[0].id).toBe(first);
});

it("unsupported filter/sort parameters return 400 rather than an unfiltered or misleading answer", async () => {
  for (const query of ["sort=constructor", "sort=unknown", "sort=caseNo&direction=sideways", "direction=asc", "kind=typo", "status=typo"]) {
    expect((await listGET(new NextRequest(`http://localhost/api/quality/cases?${query}`))).status).toBe(400);
  }
});
