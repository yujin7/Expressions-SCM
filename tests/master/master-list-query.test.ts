import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import * as schema from "@/db/schema";
import { createTestDb, type TestDb } from "../helpers/db";
import { GET as suppliersGET } from "@/app/api/master/supplier/route";
import { GET as warehousesGET } from "@/app/api/master/warehouse/route";
import { GET as binsGET } from "@/app/api/master/bin/route";

let db: TestDb;
let close: () => Promise<void>;
let signedIn = true;
vi.mock("@/db", async () => ({ schema: await import("@/db/schema"), getDbAsync: async () => db }));
vi.mock("@/server/core/dto", async original => ({
  ...await original<typeof import("@/server/core/dto")>(),
  getSessionUser: async () => { if (!signedIn) throw new Error("not signed in"); return { id: 1, roles: ["purchasing"], name: "合成采购" }; },
}));
const get = async (kind: "supplier" | "warehouse" | "bin", query: string) => {
  const response = await ({ supplier: suppliersGET, warehouse: warehousesGET, bin: binsGET }[kind])(new NextRequest(`http://localhost/api/master/${kind}?${query}`));
  return { status: response.status, body: await response.json() };
};
beforeAll(async () => {
  const test = await createTestDb(); db = test.db; close = () => test.client.close();
  await db.insert(schema.suppliers).values(Array.from({ length: 65 }, (_, i) => ({
    code: `SUP-${String(i).padStart(3, "0")}`, name: `同名-${String(64 - i).padStart(3, "0")}`,
    kinds: ["raw"], status: i >= 40 ? "paused" as const : "qualified" as const,
    licenseExpiry: i % 4 === 0 ? null : `2027-01-${String(i % 20 + 1).padStart(2, "0")}`,
    bankAccount: "不得出现在列表的合成账号",
  })));
  const warehouses = await db.insert(schema.warehouses).values(Array.from({ length: 65 }, (_, i) => ({
    code: `WH-${String(i).padStart(3, "0")}`, name: `合成仓${i}`, kind: "finished" as const,
    accountingMode: "realtime" as const, regionCode: i >= 40 ? "US" : "CN",
  }))).returning();
  await db.insert(schema.bins).values(Array.from({ length: 65 }, (_, i) => ({ warehouseId: warehouses[i >= 40 ? 64 : 0].id,
    code: `BIN-${String(i).padStart(3, "0")}`, name: `合成库位${i}`, kind: i >= 40 ? "quarantine" : "normal", active: i % 2 === 0 })));
});
afterAll(async () => { await close?.(); });

it("sorts the full supplier population before pagination and never exposes bank fields", async () => {
  const a = await get("supplier", "sort=code&order=desc&pageSize=20&page=1");
  const b = await get("supplier", "sort=code&order=desc&pageSize=20&page=2");
  expect(a.status).toBe(200); expect(a.body.total).toBe(65);
  expect(a.body.data[0].code).toBe("SUP-064"); expect(b.body.data[0].code).toBe("SUP-044");
  expect(a.body.data.every((r: object) => !("bankAccount" in r))).toBe(true);
});
it("intersects status with search before count and pagination, and preserves exact option lookup", async () => {
  const { body } = await get("supplier", "status=paused&q=SUP-0&sort=name&order=asc&pageSize=20&page=2");
  expect(body.total).toBe(25); expect(body.data).toHaveLength(5);
  expect(body.data[0].code).toBe("SUP-044");
  const selected = await get("supplier", `selectedValues=${encodeURIComponent(JSON.stringify(["SUP-041", "SUP-001"]))}&status=paused`);
  expect(selected.body.total).toBe(1); expect(selected.body.data.map((r: { code: string }) => r.code)).toEqual(["SUP-041"]);
  expect((await get("supplier", "status=blacklisted")).body).toEqual({ data: [], total: 0 });
});
it("keeps unknown expiry dates last in either direction and gives ties stable code order", async () => {
  for (const order of ["asc", "desc"]) {
    const { body } = await get("supplier", `sort=licenseExpiry&order=${order}&pageSize=100`);
    const dates = body.data.map((r: { licenseExpiry: string | null }) => r.licenseExpiry);
    const firstNull = dates.indexOf(null);
    expect(firstNull).toBe(48); expect(dates.slice(firstNull).every((d: unknown) => d === null)).toBe(true);
    for (let i = 1; i < 48; i++) {
      const previous = body.data[i - 1], current = body.data[i];
      if (previous.licenseExpiry === current.licenseExpiry) expect(previous.code < current.code).toBe(true);
      else expect(order === "asc" ? previous.licenseExpiry < current.licenseExpiry : previous.licenseExpiry > current.licenseExpiry).toBe(true);
    }
  }
});
it("sorts warehouse regions across pages rather than only the first twenty rows", async () => {
  const { body } = await get("warehouse", "sort=regionCode&order=desc&pageSize=20&page=2");
  expect(body.total).toBe(65); expect(body.data[0].code).toBe("WH-060");
  expect(body.data[4].regionCode).toBe("US"); expect(body.data[5].regionCode).toBe("CN");
});
it.each(["sort=bankAccount", "order=SIDEWAYS", "sort=code&sort=name", "status=all", "status=paused&status=qualified", "page=1.5", "pageSize=20.5"])("refuses invalid or ambiguous supplier query %s", async query => {
  expect((await get("supplier", query)).status).toBe(400);
});
it("retains the signed-in boundary", async () => {
  signedIn = false;
  try { expect((await get("supplier", "sort=code&order=desc")).status).toBe(401); }
  finally { signedIn = true; }
});
it("sorts and filters all bins before paging, including explicit inactive values", async () => {
  const { body } = await get("bin", "sort=warehouseCode&order=desc&pageSize=20&page=2");
  expect(body.total).toBe(65); expect(body.data[0].code).toBe("BIN-060");
  const filtered = await get("bin", "sort=code&order=desc&kind=quarantine&active=false&q=BIN-0");
  expect(filtered.body.total).toBe(12); expect(filtered.body.data[0].code).toBe("BIN-063");
  expect(filtered.body.data.every((r: { active: boolean; kind: string }) => !r.active && r.kind === "quarantine")).toBe(true);
});
it.each(["active=no", "kind=unknown", "warehouseId=-1", "kind=normal&kind=staging"])("does not silently discard invalid bin filter %s", async query => {
  expect((await get("bin", query)).status).toBe(400);
});
