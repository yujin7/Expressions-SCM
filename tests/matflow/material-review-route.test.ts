import { beforeEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/matflow/sh/[id]/material-review/route";
import { GET as listGet } from "@/app/api/matflow/sh/route";
import { ApiError } from "@/server/modules/master/common";
const mocks = vi.hoisted(() => ({ guard: vi.fn(), refresh: vi.fn(), list: vi.fn() }));
vi.mock("@/server/modules/master/common", async original => ({ ...await original<typeof import("@/server/modules/master/common")>(), guardRead: mocks.guard }));
vi.mock("@/server/modules/matflow/sh-read", () => ({ listShs: mocks.list }));
vi.mock("@/server/modules/outsource/common", async original => ({ ...await original<typeof import("@/server/modules/outsource/common")>(), guardFreshWrite: mocks.guard }));
vi.mock("@/server/modules/outsource/leftover", () => ({ refreshInboundMaterialReview: mocks.refresh }));
const post = (id: string) => POST(new NextRequest(`http://localhost/api/matflow/sh/${id}/material-review`, { method: "POST" }), { params: Promise.resolve({ id }) });
beforeEach(() => { vi.resetAllMocks(); mocks.guard.mockResolvedValue({ id: 7, roles: ["warehouse"] }); mocks.refresh.mockResolvedValue(undefined); });
it("authenticates and parses the exact receipt ID, then invokes estimate recovery only", async () => {
  expect((await post("181")).status).toBe(200);
  expect(mocks.refresh).toHaveBeenCalledWith({ id: 7, roles: ["warehouse"] }, 181);
  for (const id of ["oops", "-1", "0", "2147483648"]) expect((await post(id)).status).toBe(400);
  expect(mocks.refresh).toHaveBeenCalledTimes(1);
});
it("preserves unauthenticated, forbidden and incompatible-source errors", async () => {
  mocks.guard.mockRejectedValueOnce(new ApiError(401, "未登录"));
  expect((await post("181")).status).toBe(401); expect(mocks.refresh).not.toHaveBeenCalled();
  for (const status of [403, 409]) {
    mocks.refresh.mockRejectedValueOnce(new ApiError(status, "核对拒绝"));
    expect((await post("181")).status).toBe(status);
  }
});
it("pending filter is forwarded before pagination and invalid values never silently broaden results", async () => {
  mocks.list.mockResolvedValue({ rows: [], total: 0 });
  expect((await listGet(new NextRequest("http://localhost/api/matflow/sh?materialReviewPending=1&page=2"))).status).toBe(200);
  expect(mocks.list).toHaveBeenCalledWith("", expect.objectContaining({ materialReviewPending: true, page: 2 }));
  for (const query of ["materialReviewPending=0", "materialReviewPending=oops", "materialReviewPending=1&materialReviewPending=1"]) {
    expect((await listGet(new NextRequest(`http://localhost/api/matflow/sh?${query}`))).status).toBe(400);
  }
  expect(mocks.list).toHaveBeenCalledTimes(1);
});
