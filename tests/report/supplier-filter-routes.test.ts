/** Real route handlers/parser/error mapping; only authentication and report services are stubbed. */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  guardRead: vi.fn(),
  guardFreshWrite: vi.fn(),
  getSettlementSummary: vi.fn(),
  listWip: vi.fn(),
}));

vi.mock("@/server/modules/master/common", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/server/modules/master/common")>();
  return { ...original, guardRead: mocks.guardRead };
});
vi.mock("@/server/modules/outsource/common", () => ({ guardFreshWrite: mocks.guardFreshWrite }));
vi.mock("@/server/modules/report/settlement-summary", () => ({ getSettlementSummary: mocks.getSettlementSummary }));
vi.mock("@/server/modules/report/wip", () => ({ listWip: mocks.listWip }));

import { GET as settlementGet } from "@/app/api/report/settlement-summary/route";
import { GET as wipGet } from "@/app/api/report/wip/route";
import { SessionAuthError } from "@/server/core/dto";
import { ApiError } from "@/server/modules/master/common";

const actor = { id: 42, name: "采购测试员", roles: ["purchasing"], isApprover: false, sessionVersion: 1 };
const result = { rows: [], source: "synthetic-report" };

const routes = [
  { name: "结算汇总", path: "settlement-summary", get: settlementGet, guard: mocks.guardFreshWrite, report: mocks.getSettlementSummary },
  { name: "委外在制", path: "wip", get: wipGet, guard: mocks.guardRead, report: mocks.listWip },
];

const invalidIds = [
  ["空字符串", ""],
  ["纯空白", " "],
  ["前后空白", " 42 "],
  ["非数字", "abc"],
  ["NaN", "NaN"],
  ["Infinity", "Infinity"],
  ["零", "0"],
  ["负数", "-1"],
  ["正号", "+1"],
  ["小数", "1.5"],
  ["指数", "1e2"],
  ["十六进制", "0x10"],
  ["非安全整数", "9007199254740993"],
  ["超出数据库整数范围", "2147483648"],
  ["非 ASCII 数字", "１２"],
];

for (const route of routes) {
  describe(`${route.name}供应商筛选边界`, () => {
    beforeEach(() => {
      vi.resetAllMocks();
      mocks.guardRead.mockResolvedValue(actor);
      mocks.guardFreshWrite.mockResolvedValue(actor);
      route.report.mockResolvedValue(result);
    });

    const call = (params = new URLSearchParams()) => route.get(
      new NextRequest(`http://localhost/api/report/${route.path}?${params}`),
    );
    const options = () => route.report.mock.calls[0].at(-1);

    it("缺参才按全供应商读取，并保留原鉴权入口", async () => {
      const response = await call();
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(result);
      expect(route.guard).toHaveBeenCalledTimes(1);
      expect(route.report).toHaveBeenCalledTimes(1);
      expect(options()).toHaveProperty("supplierId", undefined);
      const otherGuard = route.path === "settlement-summary" ? mocks.guardRead : mocks.guardFreshWrite;
      expect(otherGuard).not.toHaveBeenCalled();
      if (route.path === "settlement-summary") expect(route.report.mock.calls[0][0]).toBe(actor);
    });

    it.each([
      ["1", 1],
      ["42", 42],
      ["2147483647", 2_147_483_647],
      ["00042", 42],
    ])("有效十进制 ID %s 精确传递为 %s", async (raw, expected) => {
      const response = await call(new URLSearchParams({ supplierId: String(raw) }));
      expect(response.status).toBe(200);
      expect(route.report).toHaveBeenCalledTimes(1);
      expect(options()).toHaveProperty("supplierId", expected);
    });

    it.each(invalidIds)("拒绝%s，不把筛选扩大为全量", async (_label, value) => {
      const response = await call(new URLSearchParams({ supplierId: value }));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: expect.stringContaining("供应商 ID") });
      expect(route.guard).toHaveBeenCalledTimes(1);
      expect(route.report).not.toHaveBeenCalled();
    });

    it.each(["42", "43"])("拒绝重复 supplierId（42、%s），不静默取第一项", async (second) => {
      const params = new URLSearchParams({ supplierId: "42" });
      params.append("supplierId", second);
      const response = await call(params);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: expect.stringContaining("不能重复") });
      expect(route.report).not.toHaveBeenCalled();
    });

    it.each(["", "supplierId=abc", "supplierId=", "supplierId=42&supplierId=43"])(
      "未登录优先返回 401，不因参数 %s 改成 400",
      async (query) => {
        route.guard.mockRejectedValue(new SessionAuthError("请先登录"));
        const response = await call(new URLSearchParams(query));
        expect(response.status).toBe(401);
        expect(await response.json()).toEqual({ error: "请先登录" });
        expect(route.report).not.toHaveBeenCalled();
      },
    );

    it("保留报表服务自身的角色/业务拒绝，不把 403 转为成功", async () => {
      route.report.mockRejectedValue(new ApiError(403, "无权查看此报表"));
      const response = await call(new URLSearchParams({ supplierId: "42" }));
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "无权查看此报表" });
    });
  });
}

describe("其他既有筛选不受供应商 ID 收口影响", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.guardRead.mockResolvedValue(actor);
    mocks.guardFreshWrite.mockResolvedValue(actor);
    mocks.getSettlementSummary.mockResolvedValue(result);
    mocks.listWip.mockResolvedValue(result);
  });

  it("结算仍将日期、状态和新鲜会话交给原服务", async () => {
    const response = await settlementGet(new NextRequest(
      "http://localhost/api/report/settlement-summary?supplierId=42&from=2026-08-01&to=2026-08-31&status=approved",
    ));
    expect(response.status).toBe(200);
    expect(mocks.getSettlementSummary).toHaveBeenCalledExactlyOnceWith(actor, {
      supplierId: 42, from: "2026-08-01", to: "2026-08-31", status: "approved",
    });
  });

  it.each([["1", true], ["0", false]])("在制 overdueOnly=%s 保持 %s", async (value, expected) => {
    const response = await wipGet(new NextRequest(
      `http://localhost/api/report/wip?supplierId=42&overdueOnly=${value}`,
    ));
    expect(response.status).toBe(200);
    expect(mocks.listWip).toHaveBeenCalledExactlyOnceWith({ supplierId: 42, overdueOnly: expected });
  });
});
