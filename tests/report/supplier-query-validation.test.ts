import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  read: vi.fn(), fresh: vi.fn(), role: vi.fn(), db: vi.fn(),
  qc: vi.fn(), score: vi.fn(), price: vi.fn(), supporting: vi.fn(), readiness: vi.fn(),
}));
vi.mock("@/db", () => ({ getDbAsync: mocks.db }));
vi.mock("@/server/modules/master/common", async (original) => ({
  ...await original<typeof import("@/server/modules/master/common")>(), guardRead: mocks.read,
}));
vi.mock("@/server/modules/outsource/common", () => ({ guardFreshWrite: mocks.fresh, requireAnyRole: mocks.role }));
vi.mock("@/server/modules/report/qc-summary", () => ({ getQcSummary: mocks.qc }));
vi.mock("@/server/modules/report/supplier-scorecard", () => ({ getSupplierScorecard: mocks.score }));
vi.mock("@/server/modules/report/supplier-price-variance", () => ({ getSupplierPriceVariance: mocks.price }));
vi.mock("@/server/modules/report/jiandaoyun-supporting-observation", () => ({ loadJiandaoyunSupportingObservations: mocks.supporting }));
vi.mock("@/server/modules/report/data-source-readiness", () => ({ loadDataSourceReadiness: mocks.readiness }));
vi.mock("@/components/product-external-decision-evidence", () => ({ buildProductExternalDecisionEvidenceBrief: () => ({}) }));

import { GET as qcGet } from "@/app/api/report/qc-summary/route";
import { GET as scoreGet } from "@/app/api/report/supplier-scorecard/route";
import { GET as priceGet } from "@/app/api/report/supplier-price-variance/route";
import { ApiError } from "@/server/modules/master/common";
import { optionalIntegerQuery } from "@/server/core/query-number";

const invalidIntegers = ["", " ", "abc", "0", "-1", "1.5", "1e2", "0x10", "Infinity", "NaN", "2147483648", "9007199254740993", "1\n", "１"];
const req = (query = "") => new NextRequest(`http://localhost/api/report/test?${query}`);

beforeEach(() => {
  vi.resetAllMocks();
  mocks.read.mockResolvedValue({ id: 1, roles: ["pmc"] });
  mocks.fresh.mockResolvedValue({ id: 1, roles: ["purchasing"] });
  mocks.db.mockResolvedValue({ fixture: true });
  mocks.qc.mockResolvedValue({ rows: [], totals: { batches: 0 }, months: [] });
  mocks.score.mockResolvedValue({ rows: [], total: 0 });
  mocks.price.mockResolvedValue({ rows: [], total: 0 });
  mocks.supporting.mockResolvedValue([]);
  mocks.readiness.mockResolvedValue({});
});

describe("可选整数参数：只缺参才省略，不将坏筛选扩成全量", () => {
  it.each(invalidIntegers)("拒绝 %j", (value) => {
    expect(() => optionalIntegerQuery(new URLSearchParams({ supplierId: value }), "supplierId", { label: "供应商 ID" }))
      .toThrow(expect.objectContaining({ status: 400, message: expect.stringContaining("供应商 ID") }));
  });
  it("缺参不改变默认值；合法边界和前导零精确解析", () => {
    expect(optionalIntegerQuery(new URLSearchParams(), "id", { label: "ID" })).toBeUndefined();
    for (const [raw, expected] of [["1", 1], ["0012", 12], ["2147483647", 2147483647]] as const) {
      expect(optionalIntegerQuery(new URLSearchParams({ id: raw }), "id", { label: "ID" })).toBe(expected);
    }
  });
  it("相同或冲突的重复参数均拒绝，不能由首个值暗中决定范围", () => {
    for (const query of ["id=1&id=1", "id=1&id=2", "id=&id=2"]) {
      expect(() => optionalIntegerQuery(new URLSearchParams(query), "id", { label: "ID" })).toThrow("不能重复传入");
    }
  });
});

describe("质检 API 实际请求边界", () => {
  it.each(invalidIntegers)("非法供应商 %j 不调用报表", async (value) => {
    const response = await qcGet(req(new URLSearchParams({ supplierId: value }).toString()));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: expect.stringContaining("供应商 ID") });
    expect(mocks.qc).not.toHaveBeenCalled();
  });
  it.each(["0", "37", "6.5", "abc", "", "Infinity"])("非法月份 %j 不回落六个月", async (months) => {
    expect((await qcGet(req(new URLSearchParams({ months }).toString()))).status).toBe(400);
    expect(mocks.qc).not.toHaveBeenCalled();
  });
  it("缺参沿用服务默认；精确供应商及1/36个月原样传入", async () => {
    expect((await qcGet(req())).status).toBe(200);
    expect(mocks.qc).toHaveBeenLastCalledWith({ supplierId: undefined, months: undefined });
    for (const months of [1, 36]) {
      expect((await qcGet(req(`supplierId=19&months=${months}`))).status).toBe(200);
      expect(mocks.qc).toHaveBeenLastCalledWith({ supplierId: 19, months });
    }
  });
  it("重复筛选400；未登录优先401，不泄露查询结果", async () => {
    expect((await qcGet(req("supplierId=1&supplierId=2"))).status).toBe(400);
    mocks.read.mockRejectedValue(new ApiError(401, "未登录"));
    expect((await qcGet(req("supplierId=abc"))).status).toBe(401);
    expect(mocks.qc).not.toHaveBeenCalled();
  });
});

describe.each([
  ["记分卡", scoreGet, mocks.score], ["价格JSON", priceGet, mocks.price],
] as const)("%s：窗口与分页不能被静默改写", (_name, get, builder) => {
  it.each(["windowDays=abc", "windowDays=0", "windowDays=29", "windowDays=1096", "windowDays=90.5", "windowDays=Infinity", "windowDays=90&windowDays=180", "page=Infinity", "page=1.5", "page=0", "page=", "pageSize=501", "pageSize=-1", "pageSize=20&pageSize=20"])("%s → 400且没有昂贵读取", async (query) => {
    expect((await get(req(query))).status).toBe(400);
    expect(builder).not.toHaveBeenCalled();
    expect(mocks.db).not.toHaveBeenCalled();
  });
  it("保留默认分页、默认窗口及合法30–1095天域，不缩成UI三个选项", async () => {
    expect((await get(req())).status).toBe(200);
    expect(builder.mock.calls.at(-1)?.[0]).toEqual({ q: "", page: 1, pageSize: 20, windowDays: undefined });
    for (const windowDays of [30, 47, 1095]) {
      expect((await get(req(`q=%20A%20&page=2&pageSize=500&windowDays=${windowDays}`))).status).toBe(200);
      expect(builder.mock.calls.at(-1)?.[0]).toEqual({ q: "A", page: 2, pageSize: 500, windowDays });
    }
  });
});

describe("价格CSV保留新鲜身份/价格角色和5001行超限探测", () => {
  it("CSV与JSON采用同一窗口校验，错误不能下载成另一份数据", async () => {
    expect((await priceGet(req("format=csv&windowDays=abc"))).status).toBe(400);
    expect(mocks.price).not.toHaveBeenCalled();
  });
  it("CSV有效筛选传给服务，忽略显示页码而保留5001行探测", async () => {
    const response = await priceGet(req("format=csv&q=SUP&page=3&pageSize=20&windowDays=365"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/csv");
    expect(mocks.price).toHaveBeenCalledWith({ q: "SUP", page: 1, pageSize: 5001, windowDays: 365 });
    expect(mocks.fresh).toHaveBeenCalledOnce();
    expect(mocks.role).toHaveBeenCalledWith({ id: 1, roles: ["purchasing"] }, expect.any(String), expect.any(String), expect.any(String), expect.any(String));
  });
  it("超过5000仍拒绝同步导出，不静默截断", async () => {
    mocks.price.mockResolvedValue({ rows: [], total: 5001 });
    const response = await priceGet(req("format=csv"));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: expect.stringContaining("5001") });
  });
  it("缺身份或无价格权限不调用查询，且先于参数校验", async () => {
    mocks.fresh.mockRejectedValueOnce(new ApiError(401, "未登录"));
    expect((await priceGet(req("format=csv&windowDays=abc"))).status).toBe(401);
    mocks.role.mockImplementationOnce(() => { throw new ApiError(403, "无价格权限"); });
    expect((await priceGet(req("format=csv&windowDays=abc"))).status).toBe(403);
    expect(mocks.price).not.toHaveBeenCalled();
  });
});
