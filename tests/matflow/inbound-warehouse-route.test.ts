import { beforeEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/matflow/sh/[id]/inbound/route";
import { ApiError } from "@/server/modules/master/common";
import { confirmInboundSchema } from "@/server/modules/matflow/schemas";
const mocks = vi.hoisted(() => ({ guard: vi.fn(), inbound: vi.fn() }));
vi.mock("@/server/modules/outsource/common", async original => ({ ...await original<typeof import("@/server/modules/outsource/common")>(), guardFreshWrite: mocks.guard }));
vi.mock("@/server/modules/matflow/sh", () => ({ confirmInbound: mocks.inbound }));
const actor = { id: 7, roles: ["warehouse"] };
const call = (body?: string) => POST(new NextRequest("http://localhost/api/matflow/sh/42/inbound", { method: "POST", body }), { params: Promise.resolve({ id: "42" }) });
beforeEach(() => { vi.resetAllMocks(); mocks.guard.mockResolvedValue(actor); mocks.inbound.mockImplementation(async (_u, _id, _db, input) => { confirmInboundSchema.parse(input); return { status: "completed" }; }); });
it.each([undefined, "{}", '{"outsourceWarehouseId":19}'])("accepts optional old body or exact selected warehouse: %s", async body => {
  expect((await call(body)).status).toBe(200);
  expect(mocks.inbound).toHaveBeenCalledWith(actor, 42, undefined, body ? JSON.parse(body) : {});
});
it.each(["{broken", "null", '{"outsourceWarehouseId":0}', '{"outsourceWarehouseId":"19"}', '{"unrelated":19}'])("bad selection cannot silently become default warehouse: %s", async body => {
  expect((await call(body)).status).toBe(400);
});
it("fresh identity precedes request parsing and preserves warehouse conflict", async () => {
  mocks.guard.mockRejectedValueOnce(new ApiError(401, "请先登录"));
  expect((await call("{broken")).status).toBe(401); expect(mocks.inbound).not.toHaveBeenCalled();
  mocks.inbound.mockRejectedValueOnce(new ApiError(409, "多个委外仓，请选择"));
  const response = await call("{}"); expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ error: "多个委外仓，请选择" });
});
