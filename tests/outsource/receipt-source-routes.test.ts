import { beforeEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET as poGet } from "@/app/api/outsource/po/route";
import { GET as jgGet } from "@/app/api/outsource/jg/route";
const mocks = vi.hoisted(() => ({ guard: vi.fn(), listPo: vi.fn(), listJg: vi.fn() }));
vi.mock("@/server/modules/master/common", async original => ({ ...await original<typeof import("@/server/modules/master/common")>(), guardRead: mocks.guard }));
vi.mock("@/server/modules/outsource/po", () => ({ listPos: mocks.listPo }));
vi.mock("@/server/modules/outsource/jg", () => ({ listJgs: mocks.listJg }));
beforeEach(() => { vi.clearAllMocks(); mocks.guard.mockResolvedValue({ id: 1 }); mocks.listPo.mockResolvedValue({ rows: [], total: 0 }); mocks.listJg.mockResolvedValue({ rows: [], total: 0 }); });
it.each([poGet, jgGet])("source route validates receipt flag and exact selected identity instead of ignoring bad filters", async get => {
  for (const query of ["receiptEligible=0", "receiptEligible=1&receiptEligible=1", "selectedValues=oops"]) {
    expect((await get(new NextRequest(`http://localhost/api?${query}`))).status).toBe(400);
  }
  expect(mocks.listPo).not.toHaveBeenCalled(); expect(mocks.listJg).not.toHaveBeenCalled();
  const response = await get(new NextRequest("http://localhost/api?receiptEligible=1&selectedValues=%5B7%5D&q=SKU&page=2&pageSize=50"));
  expect(response.status).toBe(200);
  expect(get === poGet ? mocks.listPo : mocks.listJg).toHaveBeenCalledWith("SKU", expect.objectContaining({ receiptEligible: true, selectedValues: [7], page: 2, pageSize: 50 }));
  expect(mocks.guard).toHaveBeenCalledTimes(4);
});
