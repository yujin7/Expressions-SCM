import { beforeEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET as flGet } from "@/app/api/matflow/fl/route";
import { GET as tlGet } from "@/app/api/matflow/tl/route";
const mocks = vi.hoisted(() => ({ guard: vi.fn(), fl: vi.fn(), tl: vi.fn() }));
vi.mock("@/server/modules/outsource/common", () => ({ guardFreshWrite: mocks.guard }));
vi.mock("@/server/modules/matflow/fl", () => ({ listFls: mocks.fl }));
vi.mock("@/server/modules/matflow/tl", () => ({ listTls: mocks.tl }));
beforeEach(() => { vi.clearAllMocks(); mocks.guard.mockResolvedValue({ id: 1, roles: ["warehouse"] }); mocks.fl.mockResolvedValue({ rows: [], total: 0 }); mocks.tl.mockResolvedValue({ rows: [], total: 0 }); });
for (const get of [flGet, tlGet]) {
  it.each(["", "bad", "0", "-1", "1.5", "Infinity", "9007199254740992"])("invalid JG filter %s returns 400, never an unfiltered material list", async raw => {
    const response = await get(new NextRequest(`http://localhost/api?jgId=${encodeURIComponent(raw)}`));
    expect(response.status).toBe(400); expect(mocks.fl).not.toHaveBeenCalled(); expect(mocks.tl).not.toHaveBeenCalled();
  });
  it("valid source identity and omitted filter keep their distinct meanings", async () => {
    expect((await get(new NextRequest("http://localhost/api?jgId=7&q=物料&page=2&pageSize=10"))).status).toBe(200);
    const list = get === flGet ? mocks.fl : mocks.tl;
    expect(list).toHaveBeenLastCalledWith("物料", expect.objectContaining({ jgId: 7, page: 2, pageSize: 10 }));
    await get(new NextRequest("http://localhost/api"));
    expect(list).toHaveBeenLastCalledWith("", expect.objectContaining({ jgId: undefined }));
  });
}
