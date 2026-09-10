import { beforeEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const h = vi.hoisted(() => ({ fresh: vi.fn(), detail: vi.fn(), list: vi.fn(), canCreate: vi.fn() }));
vi.mock("@/server/modules/outsource/common", () => ({ guardFreshWrite: h.fresh }));
vi.mock("@/server/modules/master/common", () => ({
  errorResponse: () => Response.json({ error: "未登录或账号已停用" }, { status: 401 }),
  parseId: Number,
  parseListQuery: (url: string) => ({ q: "", page: 1, pageSize: 20, searchParams: new URL(url).searchParams }),
}));
vi.mock("@/server/modules/inventory/stock-doc", () => ({ guardWarehouseWrite: vi.fn() }));
vi.mock("@/server/modules/inventory/count", () => ({ getCountTask: h.detail, listCountTasks: h.list, canCreateCountTask: h.canCreate }));
import { GET as getDetail } from "@/app/api/inventory/count/[id]/route";
import { GET as getList } from "@/app/api/inventory/count/route";
const current = { id: 4, roles: ["finance"], isApprover: false, name: "合成账号" };
beforeEach(() => { vi.clearAllMocks(); h.fresh.mockResolvedValue(current); h.detail.mockResolvedValue({ id: 2, actions: { approve: false } }); h.list.mockResolvedValue({ rows: [], total: 0 }); h.canCreate.mockReturnValue(false); });
it("detail passes fresh identity to the action projection", async () => {
  const result = await getDetail(new NextRequest("http://localhost/api/inventory/count/2"), { params: Promise.resolve({ id: "2" }) });
  expect(result.status).toBe(200); expect(h.detail).toHaveBeenCalledWith(2, undefined, current); expect(h.fresh).toHaveBeenCalledTimes(1);
});
it("list includes creation eligibility from current identity without changing row contract", async () => {
  const result = await getList(new NextRequest("http://localhost/api/inventory/count"));
  expect(await result.json()).toEqual({ rows: [], total: 0, canCreate: false }); expect(h.canCreate).toHaveBeenCalledWith(current);
});
it("inactive or revoked session cannot receive old action hints", async () => {
  h.fresh.mockRejectedValue(Error("revoked"));
  expect((await getDetail(new NextRequest("http://localhost/api/inventory/count/2"), { params: Promise.resolve({ id: "2" }) })).status).toBe(401);
  expect((await getList(new NextRequest("http://localhost/api/inventory/count"))).status).toBe(401);
  expect(h.detail).not.toHaveBeenCalled(); expect(h.list).not.toHaveBeenCalled();
});
