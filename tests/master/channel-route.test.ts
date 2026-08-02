import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  guardRead: vi.fn(),
  listChannels: vi.fn(),
}));

vi.mock("@/server/modules/master/common", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/server/modules/master/common")>();
  return { ...original, guardRead: mocks.guardRead };
});

vi.mock("@/server/modules/master/channel", () => ({
  listChannels: mocks.listChannels,
}));

import { GET } from "@/app/api/master/channel/route";

describe("GET /api/master/channel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.guardRead.mockResolvedValue({ id: 1, name: "管理员", roles: ["admin"], isApprover: true });
  });

  it("经过读权限守卫并透传搜索、分页参数", async () => {
    mocks.listChannels.mockResolvedValue({
      data: [{ id: 7, code: "tmall", name: "天猫", kind: "platform", active: true }],
      total: 1,
    });

    const response = await GET(new NextRequest("http://localhost/api/master/channel?q=tm&page=2&pageSize=3"));

    expect(mocks.guardRead).toHaveBeenCalledOnce();
    expect(mocks.listChannels).toHaveBeenCalledWith("tm", 2, 3);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      data: [{ id: 7, code: "tmall", name: "天猫", kind: "platform", active: true }],
      total: 1,
    });
  });
});
