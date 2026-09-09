import { beforeEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { ApiError } from "@/server/modules/master/common";

const mocks = vi.hoisted(() => ({ fresh: vi.fn(), read: vi.fn(), confirm: vi.fn() }));
vi.mock("@/server/modules/outsource/common", async original => ({
  ...await original<typeof import("@/server/modules/outsource/common")>(), guardFreshWrite: mocks.fresh,
}));
vi.mock("@/server/modules/master/sku-source-status", () => ({ getSkuSourceStatus: mocks.read, confirmSkuSourceStatus: mocks.confirm }));
import { GET, POST } from "@/app/api/master/sku/[id]/source-status/route";
const actor = { id: 7, name: "合成计划", roles: ["pmc"] };
const ctx = { params: Promise.resolve({ id: "42" }) };
const request = (query = "") => new NextRequest(`http://localhost/api/master/sku/42/source-status${query}`);
beforeEach(() => { vi.clearAllMocks(); mocks.fresh.mockResolvedValue(actor); mocks.read.mockResolvedValue({ history: [] }); });

it("passes a validated history cursor and fresh actor, with private no-store response", async () => {
  const response = await GET(request("?before=123"), ctx);
  expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(mocks.read).toHaveBeenCalledExactlyOnceWith(42, actor, undefined, 123);
});
it.each(["?before=0", "?before=-1", "?before=1.5", "?before=nan", "?before=12&before=13"])("rejects invalid or ambiguous history %s", async query => {
  expect((await GET(request(query), ctx)).status).toBe(400); expect(mocks.read).not.toHaveBeenCalled();
});
it("revoked sessions never invoke read or write service", async () => {
  mocks.fresh.mockRejectedValue(new ApiError(401, "会话已失效"));
  expect((await GET(request(), ctx)).status).toBe(401); expect((await POST(request(), ctx)).status).toBe(401);
  expect(mocks.read).not.toHaveBeenCalled(); expect(mocks.confirm).not.toHaveBeenCalled();
});
it.each([false, true])("preserves first-write versus replay receipt (replayed=%s)", async replayed => {
  const body = { requestId: "synthetic" };
  mocks.confirm.mockResolvedValue({ auditId: 81, lifecycle: "trial", replayed });
  const response = await POST(new NextRequest(request().url, { method: "POST", body: JSON.stringify(body) }), ctx);
  expect(response.status).toBe(replayed ? 200 : 201);
  expect(await response.json()).toEqual({ auditId: 81, lifecycle: "trial", replayed });
  expect(mocks.confirm).toHaveBeenCalledExactlyOnceWith(42, body, actor);
});
it("preserves conflict explanations and does not claim a successful receipt", async () => {
  mocks.confirm.mockRejectedValue(new ApiError(409, "来源已变化，请重新核对"));
  const response = await POST(new NextRequest(request().url, { method: "POST", body: "{}" }), ctx);
  expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ error: "来源已变化，请重新核对" });
});
