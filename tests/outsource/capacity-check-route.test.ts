import { NextRequest } from "next/server";
import { beforeEach, expect, it, vi } from "vitest";
import { ApiError } from "@/server/modules/master/common";

const mocks = vi.hoisted(() => ({ guard: vi.fn(), capacity: vi.fn(), sourcing: vi.fn() }));
vi.mock("@/server/modules/outsource/common", () => ({ guardFreshWrite: () => mocks.guard() }));
vi.mock("@/server/modules/outsource/capacity-check", () => ({ getCapacityCheck: (...args: unknown[]) => mocks.capacity(...args) }));
vi.mock("@/server/modules/outsource/sourcing-aid", () => ({ getSourcingAid: (...args: unknown[]) => mocks.sourcing(...args) }));
import { GET } from "@/app/api/outsource/sourcing-aid/route";

const user = { id: 1, name: "计划", roles: ["pmc"], isApprover: false };
const call = (query: string) => GET(new NextRequest(`http://localhost/api/outsource/sourcing-aid?${query}`));
beforeEach(() => {
  vi.clearAllMocks(); mocks.guard.mockResolvedValue(user);
  mocks.capacity.mockResolvedValue({ sku: { id: 1 }, factories: [], scenario: null });
  mocks.sourcing.mockResolvedValue({ sku: { id: 1 }, candidates: [] });
});
it("capacity reads require fresh identity and are private and uncached", async () => {
  const response = await call("mode=capacity&skuId=1&supplierId=2&dueDate=2026-09-30&candidateQty=0.0001");
  expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(mocks.guard).toHaveBeenCalledOnce();
  expect(mocks.capacity).toHaveBeenCalledWith(user, { skuId: "1", supplierId: "2", dueDate: "2026-09-30", candidateQty: "0.0001" });
  expect(mocks.sourcing).not.toHaveBeenCalled();
});
it("the original purchase sourcing mode keeps its service", async () => {
  expect((await call("skuId=1&supplierIds=2,3")).status).toBe(200);
  expect(mocks.sourcing).toHaveBeenCalledWith(user, { skuId: 1, supplierIds: [2, 3] });
  expect(mocks.capacity).not.toHaveBeenCalled();
});
it.each([
  "mode=capacity&mode=capacity&skuId=1", "mode=capacity&skuId=1&skuId=2",
  "mode=capacity&skuId=1&supplierId=2&supplierId=3", "mode=capacity&skuId=1&dueDate=a&dueDate=b",
  "mode=capacity&skuId=1&candidateQty=1&candidateQty=2", "mode=capacity&skuId=1&supplierIds=2", "mode=unknown&skuId=1",
])("rejects ambiguous or unknown input before selecting a service: %s", async query => {
  expect((await call(query)).status).toBe(400); expect(mocks.capacity).not.toHaveBeenCalled(); expect(mocks.sourcing).not.toHaveBeenCalled();
});
it("expired identity cannot reach either service", async () => {
  mocks.guard.mockRejectedValueOnce(new ApiError(401, "未登录或账号已停用"));
  expect((await call("mode=capacity&skuId=1")).status).toBe(401); expect(mocks.capacity).not.toHaveBeenCalled();
});
