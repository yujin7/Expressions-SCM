import { NextRequest } from "next/server";
import { beforeEach, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ guard: vi.fn(), progress: vi.fn(), cycles: vi.fn() }));
vi.mock("@/server/modules/master/common", async original => ({ ...await original<typeof import("@/server/modules/master/common")>(), guardRead: m.guard }));
vi.mock("@/server/modules/report/wip", () => ({ listWip: m.progress }));
vi.mock("@/server/modules/report/processing-cycle", () => ({ listProcessingCycles: m.cycles }));
import { GET } from "@/app/api/report/wip/route";
import { SessionAuthError } from "@/server/core/dto";
const call = (query: string) => GET(new NextRequest(`http://localhost/api/report/wip?${query}`));
beforeEach(() => { vi.resetAllMocks(); m.guard.mockResolvedValue({ id: 1, roles: ["warehouse"] }); m.progress.mockResolvedValue({ rows: [] }); m.cycles.mockResolvedValue({ rows: [] }); });
it.each(["mode=bad", "mode=", "mode=cycles&mode=progress", "overdueOnly=bad", "overdueOnly=", "overdueOnly=1&overdueOnly=0", "mode=cycles&overdueOnly=1", "mode=cycles&supplierId=bad"])("rejects malformed/mismatched filter %s without running a report", async query => {
  expect((await call(query)).status).toBe(400); expect(m.progress).not.toHaveBeenCalled(); expect(m.cycles).not.toHaveBeenCalled();
});
it("cycles uses the authorized selected supplier; progress preserves legacy default", async () => {
  expect((await call("mode=cycles&supplierId=42")).status).toBe(200); expect(m.cycles).toHaveBeenCalledWith({ supplierId: 42 });
  expect((await call("overdueOnly=1")).status).toBe(200); expect(m.progress).toHaveBeenCalledWith({ supplierId: undefined, overdueOnly: true });
});
it("unauthenticated callers cannot read either view", async () => {
  m.guard.mockRejectedValue(new SessionAuthError("未登录"));
  expect((await call("mode=cycles")).status).toBe(401); expect(m.cycles).not.toHaveBeenCalled();
});
