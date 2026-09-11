/**
 * 安全审计 S4：只读报表路由上的 `?refresh=1` 是**重算 + 写缓存**，不是读。
 *
 * `/api/report/supplier-lead-history` 与 `/api/replenish/pilot` 原本只有 `guardRead()`，
 * 任何登录用户（含仓管/质量这类与该报表无关的角色）都能反复触发一次全量暂存扫描 / 分层重建
 * 加一次缓存写——一条自助放大器，且缓存被谁在什么时候重建过完全没有身份留痕。
 * 修法照抄仓库既有先例（/api/report/inventory-alerts、/api/report/sales-spike）：
 * refresh 升级为 guardFreshWrite() + requireAnyRole(...)，只读路径逐字不变。
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionUser } from "@/server/core/dto";

const mocks = vi.hoisted(() => ({
  guardRead: vi.fn(),
  guardFreshWrite: vi.fn(),
  loadLeadHistory: vi.fn(),
  loadPilot: vi.fn(),
}));
vi.mock("@/server/modules/master/common", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/server/modules/master/common")>();
  return { ...original, guardRead: mocks.guardRead };
});
vi.mock("@/server/modules/outsource/common", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/server/modules/outsource/common")>();
  return { ...original, guardFreshWrite: mocks.guardFreshWrite };
});
vi.mock("@/server/modules/report/supplier-lead-history", () => ({ loadSupplierLeadHistory: mocks.loadLeadHistory }));
vi.mock("@/server/modules/report/replenish-pilot", () => ({ loadReplenishPilot: mocks.loadPilot }));

const { GET: leadHistoryGet } = await import("@/app/api/report/supplier-lead-history/route");
const { GET: pilotGet } = await import("@/app/api/replenish/pilot/route");

const user = (roles: string[]): SessionUser => ({ id: 1, name: roles.join("/"), roles, isApprover: false });

const SURFACES = [
  {
    name: "/api/report/supplier-lead-history",
    get: (qs: string) => leadHistoryGet(new NextRequest(`http://localhost/api/report/supplier-lead-history${qs}`)),
    load: mocks.loadLeadHistory,
    allowed: ["pmc", "purchasing", "admin"],
    denied: ["warehouse", "quality", "ops", "finance"],
  },
  {
    name: "/api/replenish/pilot",
    get: (qs: string) => pilotGet(new NextRequest(`http://localhost/api/replenish/pilot${qs}`)),
    load: mocks.loadPilot,
    allowed: ["pmc", "admin"],
    denied: ["warehouse", "quality", "ops", "purchasing"],
  },
];

describe("S4 只读报表的 ?refresh=1 需要写权限", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadLeadHistory.mockResolvedValue({ ok: true });
    mocks.loadPilot.mockResolvedValue({ ok: true });
  });

  for (const s of SURFACES) {
    it(`${s.name}：无关角色 refresh=1 → 403，且不触发重算`, async () => {
      for (const role of s.denied) {
        mocks.guardFreshWrite.mockResolvedValue(user([role]));
        const res = await s.get("?refresh=1");
        expect(res.status, role).toBe(403);
      }
      expect(s.load).not.toHaveBeenCalled();
      expect(mocks.guardRead).not.toHaveBeenCalled(); // refresh 一律走回查新鲜身份的守卫
    });

    it(`${s.name}：有权角色 refresh=1 → 200 且带 refresh:true 重算`, async () => {
      for (const role of s.allowed) {
        s.load.mockClear();
        mocks.guardFreshWrite.mockResolvedValue(user([role]));
        const res = await s.get("?refresh=1");
        expect(res.status, role).toBe(200);
        expect(s.load, role).toHaveBeenCalledWith(undefined, { refresh: true });
      }
    });

    it(`${s.name}：不带 refresh 仍是全员可读（guardRead），且不重算`, async () => {
      mocks.guardRead.mockResolvedValue(user(["warehouse"]));
      const res = await s.get("");
      expect(res.status).toBe(200);
      expect(s.load).toHaveBeenCalledWith(undefined, { refresh: false });
      expect(mocks.guardFreshWrite).not.toHaveBeenCalled();
    });
  }
});
