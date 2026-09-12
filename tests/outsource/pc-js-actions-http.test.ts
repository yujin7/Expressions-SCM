import { NextRequest } from "next/server";
import { beforeEach, expect, it, vi } from "vitest";
import { ApiError } from "@/server/modules/master/common";
import { GET as pcDetail } from "@/app/api/outsource/pc/[id]/route";
import { GET as jsDetail } from "@/app/api/settlement/js/[id]/route";
import { GET as pcList } from "@/app/api/outsource/pc/route";
const h = vi.hoisted(() => ({ fresh: vi.fn(), pc: vi.fn(), js: vi.fn(), list: vi.fn() }));
vi.mock("@/server/modules/outsource/common", () => ({ guardFreshWrite: h.fresh }));
vi.mock("@/server/modules/outsource/pc-detail", () => ({ getPc: h.pc }));
vi.mock("@/server/modules/settlement/js", () => ({ getJs: h.js }));
vi.mock("@/server/modules/outsource/po", () => ({ listPcs: h.list }));
vi.mock("@/server/modules/outsource/jg", () => ({ createPcForJgFee: vi.fn() }));
const actor = { id: 7, name: "合成当前身份", roles: ["warehouse"], isApprover: false };
const req = new NextRequest("http://localhost/api/outsource/pc?page=1&pageSize=20");
const ctx = { params: Promise.resolve({ id: "19" }) };
beforeEach(() => {
  vi.clearAllMocks(); h.fresh.mockResolvedValue(actor);
  h.pc.mockResolvedValue({ id: 19, newPrice: "3", oldPrice: "2", actions: { approve: false, reject: false, reason: "需要采购审批角色" } });
  h.js.mockResolvedValue({ id: 19, feePayable: "30", settleAmount: "20", actions: { approve: false, reject: false } });
  h.list.mockResolvedValue({ rows: [], total: 0 });
});
it.each([pcDetail, jsDetail, pcList])("rejects invalid current identity before loading data", async handler => {
  h.fresh.mockRejectedValue(new ApiError(401, "登录状态已失效"));
  expect((await handler(req, ctx)).status).toBe(401);
  expect(h.pc).not.toHaveBeenCalled(); expect(h.js).not.toHaveBeenCalled(); expect(h.list).not.toHaveBeenCalled();
});
it("PC detail passes the current user and masks financial fields", async () => {
  const res = await pcDetail(req, ctx), body = await res.json();
  expect(res.status).toBe(200); expect(h.pc).toHaveBeenCalledWith(19, actor);
  expect(body).not.toHaveProperty("newPrice"); expect(body).not.toHaveProperty("oldPrice");
  expect(body.actions).toMatchObject({ approve: false, reject: false });
});
it("JS detail passes the current user and masks financial fields", async () => {
  const res = await jsDetail(req, ctx), body = await res.json();
  expect(res.status).toBe(200); expect(h.js).toHaveBeenCalledWith(19, undefined, actor);
  expect(body).not.toHaveProperty("feePayable"); expect(body).not.toHaveProperty("settleAmount");
});
it.each([["warehouse", false], ["finance", false], ["pmc", false], ["purchasing", true], ["admin", true]])(
  "PC creation hint uses current %s role", async (role, allowed) => {
    h.fresh.mockResolvedValue({ ...actor, roles: [role] });
    expect((await (await pcList(req)).json()).actions).toEqual({ createFee: allowed });
  });
