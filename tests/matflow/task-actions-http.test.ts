import { NextRequest } from "next/server";
import { beforeEach, expect, it, vi } from "vitest";
import { ApiError } from "@/server/modules/master/common";
import { GET as flDetail } from "@/app/api/matflow/fl/[id]/route";
import { GET as tlDetail } from "@/app/api/matflow/tl/[id]/route";
import { GET as flList } from "@/app/api/matflow/fl/route";
import { GET as tlList } from "@/app/api/matflow/tl/route";
const h = vi.hoisted(() => ({ fresh: vi.fn(), fl: vi.fn(), tl: vi.fn(), list: vi.fn() }));
vi.mock("@/server/modules/outsource/common", () => ({ guardFreshWrite: h.fresh }));
vi.mock("@/server/modules/matflow/fl", () => ({ getFl: h.fl, listFls: h.list }));
vi.mock("@/server/modules/matflow/tl", () => ({ getTl: h.tl, listTls: h.list }));
const actor = { id: 7, name: "当前仓管", roles: ["warehouse"], isApprover: false };
const req = new NextRequest("http://localhost/api/matflow/fl");
const ctx = { params: Promise.resolve({ id: "19" }) };
beforeEach(() => {
  vi.clearAllMocks(); h.fresh.mockResolvedValue(actor);
  h.fl.mockResolvedValue({ id: 19, price: "30", actions: { approve: false, reject: true, reason: "结算已冻结" } });
  h.tl.mockImplementation(h.fl); h.list.mockResolvedValue({ rows: [], total: 0 });
});
it.each([flDetail, tlDetail, flList, tlList])("invalid current session fails before loading material facts", async handler => {
  h.fresh.mockRejectedValue(new ApiError(401, "会话已失效"));
  expect((await handler(req, ctx)).status).toBe(401);
  expect(h.fl).not.toHaveBeenCalled(); expect(h.tl).not.toHaveBeenCalled(); expect(h.list).not.toHaveBeenCalled();
});
it.each([flDetail, tlDetail])("detail forwards current identity and preserves masking", async handler => {
  const response = await handler(req, ctx), body = await response.json();
  expect(response.status).toBe(200);
  expect(handler === flDetail ? h.fl : h.tl).toHaveBeenCalledWith(19, undefined, actor);
  expect(body).not.toHaveProperty("price");
  expect(body.actions).toMatchObject({ approve: false, reject: true, reason: "结算已冻结" });
});
it.each(["warehouse", "admin", "ops", "finance"])("both lists return current %s creation permission", async role => {
  h.fresh.mockResolvedValue({ ...actor, roles: [role] });
  for (const handler of [flList, tlList]) {
    expect((await (await handler(req)).json()).actions).toEqual({ create: ["warehouse", "admin"].includes(role) });
  }
});
