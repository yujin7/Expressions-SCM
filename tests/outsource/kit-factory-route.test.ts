import { beforeEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "@/app/api/outsource/auto-chain/evidence/route";
import { ApiError } from "@/server/modules/master/common";

const h = vi.hoisted(() => ({ user: { id: 7, name: "合成PMC", roles: ["pmc"], isApprover: false }, fresh: vi.fn(), read: vi.fn() }));
vi.mock("@/server/core/dto", async original => ({ ...await original<typeof import("@/server/core/dto")>(), getFreshSessionUser: h.fresh }));
vi.mock("@/server/modules/outsource/kit-factory-evidence", () => ({ getKitFactoryEvidence: h.read }));
beforeEach(() => { h.fresh.mockReset().mockResolvedValue(h.user); h.read.mockReset().mockResolvedValue({ woId: 18, allocationStatus: "unverified" }); });
const request = (q: string) => new NextRequest(`http://localhost/api/outsource/auto-chain/evidence${q}`);
it("fresh PMC identity and exact WO are forwarded, response stays private", async () => {
  const response = await GET(request("?woId=18"));
  expect(h.fresh).toHaveBeenCalledTimes(1); expect(h.read).toHaveBeenCalledWith(h.user, 18);
  expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(await response.json()).toEqual({ woId: 18, allocationStatus: "unverified" });
});
it.each(["", "?woId=", "?woId=1&woId=2", "?woId=1&all=true", "?woId=-1", "?woId=1.2", "?woId=NaN"])("invalid or ambiguous query %s cannot reach facts", async q => {
  expect((await GET(request(q))).status).toBe(400); expect(h.read).not.toHaveBeenCalled();
});
it("removed identity and unsupported roles do not reach factory facts", async () => {
  h.fresh.mockRejectedValueOnce(new ApiError(401, "请重新登录"));
  expect((await GET(request("?woId=18"))).status).toBe(401);
  h.fresh.mockResolvedValueOnce({ ...h.user, roles: ["ops"] });
  expect((await GET(request("?woId=18"))).status).toBe(403); expect(h.read).not.toHaveBeenCalled();
});
