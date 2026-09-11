import { NextRequest } from "next/server";
import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ guard: vi.fn(), db: vi.fn(), promise: vi.fn() }));
vi.mock("@/db", async original => ({ ...await original<typeof import("@/db")>(), getDbAsync: () => mocks.db() }));
vi.mock("@/server/modules/master/common", async original => ({ ...await original<typeof import("@/server/modules/master/common")>(), guardRead: () => mocks.guard() }));
vi.mock("@/server/modules/report/supply-commitment", () => ({ loadPromiseReliability: (...args: unknown[]) => mocks.promise(...args) }));
vi.mock("@/server/modules/report/inbound-calendar", () => ({ getInboundCalendar: async () => ({ days: [] }) }));
vi.mock("@/server/modules/report/jiandaoyun-supporting-observation", () => ({ loadJiandaoyunSupportingObservations: async () => [] }));
vi.mock("@/server/modules/report/data-source-readiness", () => ({ loadDataSourceReadiness: async () => [] }));
vi.mock("@/components/product-external-decision-evidence", () => ({ buildProductExternalDecisionEvidenceBrief: () => ({}) }));
import { GET } from "@/app/api/report/inbound-calendar/route";
import { ApiError } from "@/server/modules/master/common";
const request = (q: string) => GET(new NextRequest(`http://localhost/api/report/inbound-calendar?${q}`));
beforeEach(() => { vi.clearAllMocks(); mocks.guard.mockResolvedValue({ id: 1 }); mocks.db.mockResolvedValue({}); mocks.promise.mockResolvedValue({ exceptions: [] }); });
it.each(["page=0", "pageSize=201", "sort=bad", "order=bad", "q=a&q=b", "from=2026-08-01&from=2026-09-01", "to=x&to=y", "warehouseId=1"])("HTTP非法参数在读库前拒绝 %s", async q => {
  expect((await request(q)).status).toBe(400); expect(mocks.db).not.toHaveBeenCalled();
});
it("HTTP将完整筛选和分页传给唯一加载器，不在路由裁切", async () => {
  expect((await request("q=SKU&basis=current&status=overdue_short&sort=lineId&order=asc&page=3&pageSize=50")).status).toBe(200);
  expect(mocks.promise).toHaveBeenCalledWith({ exceptionQuery: { q: "SKU", basis: "current", status: "overdue_short", sort: "lineId", order: "asc", page: 3, pageSize: 50 } }, {});
});
it("匿名请求仍拒绝，不因查询新增而绕过读取权限", async () => {
  mocks.guard.mockRejectedValue(new ApiError(401, "未登录")); expect((await request("")).status).toBe(401);
  expect(mocks.db).not.toHaveBeenCalled();
});
