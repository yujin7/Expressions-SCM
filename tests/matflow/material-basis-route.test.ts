import { beforeEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "@/app/api/outsource/jg/[id]/route";
import { ApiError } from "@/server/modules/master/common";
const h = vi.hoisted(() => ({ guard: vi.fn(), basis: vi.fn(), detail: vi.fn() }));
vi.mock("@/server/modules/outsource/common", async original => ({ ...await original<typeof import("@/server/modules/outsource/common")>(), guardFreshWrite: h.guard }));
vi.mock("@/server/modules/outsource/jg", () => ({ getJg: h.detail }));
vi.mock("@/server/modules/matflow/material-basis", () => ({ getJgMaterialBasis: h.basis }));
const actor = { id: 7, roles: ["warehouse"] };
const call = (query = "", id = "42") => GET(new NextRequest(`http://localhost/api/outsource/jg/${id}${query}`), { params: Promise.resolve({ id }) });
beforeEach(() => { vi.resetAllMocks(); h.guard.mockResolvedValue(actor); h.basis.mockResolvedValue({ jgId: 42, lines: [] }); h.detail.mockResolvedValue({ id: 42, feeRateCurrent: "123", docNo: "JG42" }); });
it("one explicit basis read is current, uncached and does not perform the full money-bearing JG query", async () => {
  const r = await call("?materialBasis=1"); expect(r.status).toBe(200);
  expect(r.headers.get("Cache-Control")).toBe("private, no-store");
  expect(h.basis).toHaveBeenCalledWith(actor, 42); expect(h.detail).not.toHaveBeenCalled();
});
it("normal JG detail preserves masking and its previous handler", async () => {
  const r = await call(); expect(r.status).toBe(200); expect(await r.json()).toEqual({ id: 42, docNo: "JG42" });
  expect(h.basis).not.toHaveBeenCalled(); expect(h.detail).toHaveBeenCalledWith(42, undefined, actor);
});
it.each(["?materialBasis=0", "?materialBasis=", "?materialBasis=yes", "?materialBasis=1&materialBasis=1"])("invalid basis switch fails instead of silently loading another shape: %s", async q => {
  expect((await call(q)).status).toBe(400); expect(h.basis).not.toHaveBeenCalled(); expect(h.detail).not.toHaveBeenCalled();
});
it("fresh identity precedes parsing and missing/forbidden data remain errors", async () => {
  h.guard.mockRejectedValueOnce(new ApiError(401, "账号已停用")); expect((await call("?materialBasis=bad")).status).toBe(401);
  for (const status of [403, 404, 500]) { h.basis.mockRejectedValueOnce(new ApiError(status, "读取失败")); expect((await call("?materialBasis=1")).status).toBe(status); }
});
