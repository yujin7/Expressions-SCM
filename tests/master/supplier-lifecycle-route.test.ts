import { NextRequest } from "next/server";
import { beforeEach, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn(), list: vi.fn(), detail: vi.fn(), open: vi.fn(), close: vi.fn(), follow: vi.fn() }));
vi.mock("@/server/modules/master/common", async original => ({ ...await original<typeof import("@/server/modules/master/common")>(), guardRead: m.read, guardWrite: m.write }));
vi.mock("@/server/modules/master/supplier-lifecycle", () => ({ listSupplierLifecycleCases: m.list, getSupplierLifecycleDetail: m.detail, openSupplierLifecycleCase: m.open, closeSupplierLifecycleCase: m.close, followUpSupplierLifecycleCase: m.follow }));
import { GET as listGet, POST } from "@/app/api/master/supplier/lifecycle/route";
import { GET as detailGet, PATCH } from "@/app/api/master/supplier/lifecycle/[id]/route";
import { ApiError } from "@/server/modules/master/common";
import { SessionAuthError } from "@/server/core/dto";
const actor = { id: 3, name: "采购", roles: ["purchasing"], isApprover: false };
const ctx = { params: Promise.resolve({ id: "5" }) };
const req = (query = "") => new NextRequest(`http://localhost/api/master/supplier/lifecycle?${query}`);
beforeEach(() => { vi.resetAllMocks(); m.read.mockResolvedValue(actor); m.write.mockResolvedValue(actor); m.list.mockResolvedValue({ rows: [] }); m.detail.mockResolvedValue({ row: { id: 5 }, history: [] }); m.follow.mockResolvedValue({ id: 5 }); m.close.mockResolvedValue({ id: 5, status: "closed" }); });
it.each(["warehouse", "ops", "rd", "qc"])("%s不能读取谈判列表或工作项审计", async role => {
  m.read.mockResolvedValue({ ...actor, roles: [role] });
  expect((await listGet(req())).status).toBe(403); expect((await detailGet(req(), ctx)).status).toBe(403);
  expect(m.list).not.toHaveBeenCalled(); expect(m.detail).not.toHaveBeenCalled();
});
it.each(["admin", "purchasing", "pmc", "finance"])("%s按工作项入口读取", async role => {
  m.read.mockResolvedValue({ ...actor, roles: [role] });
  expect((await detailGet(req("beforeAuditId=12"), ctx)).status).toBe(200); expect(m.detail).toHaveBeenCalledWith(5, 12);
});
it.each(["supplierId=", "caseId=abc", "ownerId=1e2", "supplierId=4&supplierId=5", "caseId=2147483648", "page=", "pageSize=1&pageSize=2"])("非法筛选%s拒绝，不悄悄扩大或更改范围", async query => {
  expect((await listGet(req(query))).status).toBe(400); expect(m.list).not.toHaveBeenCalled();
});
it("空或重复历史游标拒绝，不悄悄回到第一页", async () => {
  for (const query of ["beforeAuditId=", "beforeAuditId=1&beforeAuditId=2"]) expect((await detailGet(req(query), ctx)).status).toBe(400);
  expect(m.detail).not.toHaveBeenCalled();
});
it("未登录优先401；写路径必须先经过fresh guard", async () => {
  m.read.mockRejectedValue(new SessionAuthError("请先登录")); expect((await listGet(req("caseId=bad"))).status).toBe(401);
  m.write.mockRejectedValue(new ApiError(403, "无写权限")); expect((await POST(req())).status).toBe(403); expect((await PATCH(req(), ctx)).status).toBe(403);
  expect(m.write).toHaveBeenCalledWith("supplier"); expect(m.open).not.toHaveBeenCalled(); expect(m.close).not.toHaveBeenCalled();
});
it("跟进准确分发版本与证据；未知操作不能意外落入关案", async () => {
  const patch = (body: unknown) => new NextRequest("http://localhost/api/master/supplier/lifecycle/5", { method: "PATCH", body: JSON.stringify(body) });
  const body = { operation: "follow_up", expectedVersion: 3, note: "需要留痕的进展" };
  expect((await PATCH(patch(body), ctx)).status).toBe(200); expect(m.follow).toHaveBeenCalledWith(actor, 5, body);
  expect((await PATCH(patch({ operation: "typo", outcome: "resolved", closureNote: "不能静默关案" }), ctx)).status).toBe(400);
  expect(m.close).not.toHaveBeenCalled();
});
