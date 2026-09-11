import { beforeEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/goals/refresh/route";
import { GET } from "@/app/api/goals/route";
import { ApiError } from "@/server/modules/master/common";

const state = vi.hoisted(() => ({ anonymous: false, depts: ["purchasing"] as string[], refresh: vi.fn() }));
vi.mock("@/server/modules/master/common", async original => ({
  ...await original<typeof import("@/server/modules/master/common")>(),
  guardRead: async () => ({ id: 8, name: "QA", roles: ["purchasing"] }),
}));
vi.mock("@/server/core/dto", async original => ({
  ...await original<typeof import("@/server/core/dto")>(),
  getFreshSessionUser: async () => {
    if (state.anonymous) throw new ApiError(401, "请先登录");
    return { id: 8, name: "QA", roles: ["purchasing"] };
  },
}));
vi.mock("@/server/modules/goals/service", async original => ({
  ...await original<typeof import("@/server/modules/goals/service")>(),
  refreshableDeptKeys: () => state.depts,
  refreshAutoActuals: state.refresh,
}));
const post = (body: string) => POST(new NextRequest("http://localhost/api/goals/refresh", {
  method: "POST", headers: { "Content-Type": "application/json" }, body,
}));
beforeEach(() => {
  state.anonymous = false; state.depts = ["purchasing"];
  state.refresh.mockReset().mockResolvedValue({ scanned: 2, updated: 1, unavailable: 1 });
});
it.each([
  "{", "null", "[]", '{"period":null}', '{"period":123}',
  '{"period":"2026-13"}', '{"period":"2026-Q5"}', '{"period":""}',
  '{"period":"ALL"}', '{"period":"2026-09","deptKeys":["finance"]}',
])("拒绝非法回填请求，不扩大范围: %s", async body => {
  expect((await post(body)).status).toBe(400);
  expect(state.refresh).not.toHaveBeenCalled();
});
it("所选期间与服务器新鲜权限共同限定回填", async () => {
  const response = await post('{"period":"2026-09"}');
  expect(response.status).toBe(200);
  expect(state.refresh).toHaveBeenCalledWith(undefined, { period: "2026-09", actorId: 8, deptKeys: ["purchasing"] });
  expect(await response.json()).toEqual({ scanned: 2, updated: 1, unavailable: 1 });
});
it("显式空对象保留全部期间兼容入口，无写权限和未登录仍拒绝", async () => {
  expect((await post("{}")).status).toBe(200);
  expect(state.refresh).toHaveBeenCalledWith(undefined, { period: undefined, actorId: 8, deptKeys: ["purchasing"] });
  state.refresh.mockClear(); state.depts = [];
  expect((await post("{}")).status).toBe(403);
  state.anonymous = true;
  expect((await post("{}")).status).toBe(401);
  expect(state.refresh).not.toHaveBeenCalled();
});
it.each(["period=", "period=2026-13", "period=2026-Q5", "period=2026-09&period=2026-08"])("列表也拒绝非法或多重期间，不返回未筛选列表: %s", async query => {
  const response = await GET(new NextRequest(`http://localhost/api/goals?${query}`));
  expect(response.status).toBe(400);
  expect(await response.json()).toHaveProperty("error");
});
