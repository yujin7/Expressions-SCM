import { beforeEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/matflow/sh/[id]/batch-check/route";
import { GET } from "@/app/api/matflow/sh/route";
import { ApiError } from "@/server/modules/master/common";
const mocks = vi.hoisted(() => ({ guard: vi.fn(), check: vi.fn(), list: vi.fn() }));
vi.mock("@/server/modules/master/common", async original => ({ ...await original<typeof import("@/server/modules/master/common")>(), guardRead: mocks.guard }));
vi.mock("@/server/modules/matflow/sh-read", () => ({ listShs: mocks.list }));
vi.mock("@/server/modules/outsource/common", async original => ({ ...await original<typeof import("@/server/modules/outsource/common")>(), guardFreshWrite: mocks.guard }));
vi.mock("@/server/modules/outsource/auto-chain", () => ({ checkBatchAfterPoReceipt: mocks.check }));
const post = (id: string) => POST(new NextRequest(`http://localhost/api/matflow/sh/${id}/batch-check`, { method: "POST" }), { params: Promise.resolve({ id }) });
beforeEach(() => { vi.resetAllMocks(); mocks.guard.mockResolvedValue({ id: 7, roles: ["pmc"] }); mocks.check.mockResolvedValue({ state: "pending" }); });
it("fresh authorization precedes exact receipt parsing", async () => {
  expect((await post("181")).status).toBe(200);
  expect(mocks.check).toHaveBeenCalledWith({ id: 7, roles: ["pmc"] }, 181);
  for (const id of ["oops", "-1", "0", "2147483648", "1.5"]) expect((await post(id)).status).toBe(400);
  expect(mocks.check).toHaveBeenCalledTimes(1);
});
it("preserves authentication, permission and incompatible-source errors", async () => {
  mocks.guard.mockRejectedValueOnce(new ApiError(401, "未登录"));
  expect((await post("181")).status).toBe(401); expect(mocks.check).not.toHaveBeenCalled();
  for (const status of [403, 409]) {
    mocks.check.mockRejectedValueOnce(new ApiError(status, "核对拒绝"));
    expect((await post("181")).status).toBe(status);
  }
});
it("queue filter is forwarded before pagination and malformed input cannot broaden results", async () => {
  mocks.list.mockResolvedValue({ rows: [], total: 0 });
  expect((await GET(new NextRequest("http://localhost/api/matflow/sh?batchCheckPending=1&page=2"))).status).toBe(200);
  expect(mocks.list).toHaveBeenCalledWith("", expect.objectContaining({ batchCheckPending: true, page: 2 }));
  for (const query of ["batchCheckPending=0", "batchCheckPending=oops", "batchCheckPending=1&batchCheckPending=1"]) {
    expect((await GET(new NextRequest(`http://localhost/api/matflow/sh?${query}`))).status).toBe(400);
  }
  expect(mocks.list).toHaveBeenCalledTimes(1);
});
