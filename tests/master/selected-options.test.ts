import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "@/db/schema";
import { ApiError, parseListQuery } from "@/server/modules/master/common";
import { SessionAuthError } from "@/server/core/dto";
import { parseSelectedValues, SELECTED_OPTIONS_LIMIT } from "@/server/core/selected-options";
import { createTestDb, type TestDb } from "../helpers/db";

const mocks = vi.hoisted(() => ({ guardRead: vi.fn(), getDbAsync: vi.fn() }));
vi.mock("@/db", async () => ({
  schema: await import("@/db/schema"),
  getDbAsync: mocks.getDbAsync,
}));
vi.mock("@/server/modules/master/common", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/server/modules/master/common")>();
  return { ...original, guardRead: mocks.guardRead };
});

import { GET as skuGet } from "@/app/api/master/sku/route";
import { GET as spuGet } from "@/app/api/master/spu/route";
import { GET as channelGet } from "@/app/api/master/channel/route";
import { GET as categoryGet } from "@/app/api/master/category/route";
import { GET as supplierGet } from "@/app/api/master/supplier/route";
import { GET as warehouseGet } from "@/app/api/master/warehouse/route";
import { GET as stockDocGet } from "@/app/api/inventory/stock-doc/route";

const selectedParams = (values: unknown) => new URLSearchParams({ selectedValues: JSON.stringify(values) });

describe("selectedValues 有界协议", () => {
  it("缺参和显式空数组不同；不改变全仓 parseListQuery 行为", () => {
    expect(parseSelectedValues(new URLSearchParams())).toBeUndefined();
    expect(parseSelectedValues(selectedParams([]))).toEqual([]);
    expect(parseListQuery("http://localhost?q=a&page=2&pageSize=7&selectedValues=bad")).toMatchObject({ q: "a", page: 2, pageSize: 7 });
  });

  it("混合 ID/code/name 保留值与类型，不猜数字字符串身份或修剪名称", () => {
    const values = [1, 2_147_483_647, "42", "EXP", "中文名称", " 名称有空格 "];
    expect(parseSelectedValues(selectedParams(values))).toEqual(values);
  });

  it("最多 50 项、字符串最多 200 字符；重复选中值不变成重复 query 参数", () => {
    expect(parseSelectedValues(selectedParams(Array(50).fill("a")))).toHaveLength(50);
    expect(parseSelectedValues(selectedParams(["a".repeat(200)]))).toEqual(["a".repeat(200)]);
  });

  it.each([
    "", "not-json", "null", "{}", '"abc"', "1", "[NaN]", "[1e999]",
    "[0]", "[-1]", "[1.5]", "[2147483648]", "[9007199254740993]", "[null]", "[true]", "[{}]", "[[]]",
    '[""]', '["   "]', '["\\u0000"]', JSON.stringify(["a".repeat(201)]), JSON.stringify(Array(51).fill(1)),
  ])("拒绝非法协议 %s", (raw) => {
    expect(() => parseSelectedValues(new URLSearchParams({ selectedValues: raw }))).toThrow(ApiError);
  });

  it.each(["[1]", "[2]"])("拒绝重复 selectedValues，即使第二份是 %s", (second) => {
    const params = new URLSearchParams({ selectedValues: "[1]" });
    params.append("selectedValues", second);
    expect(() => parseSelectedValues(params)).toThrow("不能重复");
  });
});

type OptionRow = Record<string, unknown> & { id: number };
interface OptionResponse { data?: OptionRow[]; rows?: OptionRow[]; total: number }
const readRows = (body: OptionResponse) => body.data ?? body.rows ?? [];
const actor = { id: 99, name: "选择器测试员", roles: ["admin"], isApprover: true, sessionVersion: 1 };
const routes = [
  { path: "master/sku", get: skuGet, id: 3002, exact: "SKU-Z" },
  { path: "master/spu", get: spuGet, id: 2002, exact: "PSEL-Z" },
  { path: "master/channel", get: channelGet, id: 4002, exact: "CH-Z" },
  { path: "master/category", get: categoryGet, id: 1002, exact: "分类尾" },
  { path: "master/supplier", get: supplierGet, id: 11004, exact: "SUP-1004" },
  { path: "master/warehouse", get: warehouseGet, id: 5002, exact: "WH-Z" },
  { path: "inventory/stock-doc", get: stockDocGet, id: 6002, exact: "RK-SEL-Z" },
];

describe("七类列表真实 handler + SQL 精确补取（隔离合成库）", () => {
  let db: TestDb;
  let client: { close(): Promise<void> };

  beforeAll(async () => {
    ({ db, client } = await createTestDb());
    await db.insert(schema.users).values({ id: actor.id, name: actor.name, roles: actor.roles });
    await db.insert(schema.categories).values([
      { id: 1001, name: "分类首" },
      { id: 1002, name: "分类尾", parentId: 1001, level: 2 },
      ...Array.from({ length: 205 }, (_, i) => ({ id: 20000 + i, name: "同名分类" })),
    ]);
    await db.insert(schema.spus).values([
      { id: 2001, code: "PSEL-A", nameCn: "产品首", categoryId: 1001 },
      { id: 2002, code: "PSEL-Z", nameCn: "产品尾", nameEn: "Selected Tail", categoryId: 1002 },
    ]);
    await db.insert(schema.skus).values([
      { id: 3001, code: "SKU-A", name: "成品首", spuId: 2001, baseUom: "支", skuType: "finished", commercialRole: "retail" },
      { id: 3002, code: "SKU-Z", name: "成品尾", spuId: 2002, baseUom: "支", skuType: "finished", commercialRole: "retail" },
      { id: 3003, code: "SKU-RAW", name: "原料", spuId: 2001, baseUom: "千克", skuType: "raw", commercialRole: "retail" },
      { id: 3004, code: "SKU-SAMPLE", name: "样品", spuId: 2002, baseUom: "支", skuType: "finished", commercialRole: "sample" },
      { id: 3005, code: "3002", name: "数字业务编码", spuId: 2002, baseUom: "支", skuType: "finished", commercialRole: "retail" },
    ]);
    await db.insert(schema.channels).values([
      { id: 4001, code: "CH-A", name: "平台首", kind: "platform" },
      { id: 4002, code: "CH-Z", name: "平台尾", kind: "platform", active: false },
    ]);
    await db.insert(schema.suppliers).values(Array.from({ length: 1005 }, (_, i) => ({
      id: 10000 + i, code: `SUP-${String(i).padStart(4, "0")}`, name: `供应商-${i}`,
      bankAccount: "synthetic-private-bank", phone: "synthetic-private-phone", paymentTerm: "synthetic-private-term",
    })));
    await db.insert(schema.warehouses).values([
      { id: 5001, code: "WH-A", name: "仓库首", kind: "finished" },
      { id: 5002, code: "WH-Z", name: "仓库尾", kind: "outsource", parentId: 5001, supplierId: 11004, active: false },
    ]);
    await db.insert(schema.stockDocs).values([
      { id: 6001, docNo: "RK-SEL-A", subtype: "opening", status: "approved", createdBy: actor.id },
      { id: 6002, docNo: "RK-SEL-Z", subtype: "opening", status: "approved", createdBy: actor.id },
      { id: 6003, docNo: "DB-SEL-Z", subtype: "transfer", status: "approved", createdBy: actor.id },
      { id: 6004, docNo: "RK-SEL-DRAFT", subtype: "opening", status: "draft", createdBy: actor.id },
    ]);
  });
  afterAll(async () => { await client?.close(); });
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.guardRead.mockResolvedValue(actor);
    mocks.getDbAsync.mockResolvedValue(db);
  });

  const call = async (route: (typeof routes)[number], params: URLSearchParams): Promise<OptionResponse> => {
    const response = await route.get(new NextRequest(`http://localhost/api/${route.path}?${params}`));
    expect(response.status).toBe(200);
    return response.json();
  };

  for (const route of routes) {
    describe(route.path, () => {
      it("未登录在参数解析与数据库读取前返回 401", async () => {
        mocks.guardRead.mockRejectedValue(new SessionAuthError("请先登录"));
        const response = await route.get(new NextRequest(`http://localhost/api/${route.path}?selectedValues=bad`));
        expect(response.status).toBe(401);
        expect(await response.json()).toEqual({ error: "请先登录" });
        expect(mocks.getDbAsync).not.toHaveBeenCalled();
      });

      it.each(["bad", "[0]", "[]&selectedValues=[]"])("非法选项 %s 在取列表前返回 400", async (query) => {
        const response = await route.get(new NextRequest(`http://localhost/api/${route.path}?selectedValues=${query}`));
        expect(response.status).toBe(400);
        expect(mocks.guardRead).toHaveBeenCalledOnce();
        expect(mocks.getDbAsync).not.toHaveBeenCalled();
      });

      it("精确 ID 不受当前页码/pageSize 截断", async () => {
        const params = selectedParams([route.id]);
        params.set("page", "9999");
        params.set("pageSize", "1");
        const body = await call(route, params);
        expect(body.total).toBe(1);
        expect(readRows(body).map((row) => row.id)).toEqual([route.id]);
      });

      it("业务 code/name 按精确等值匹配，不依靠模糊搜索", async () => {
        const body = await call(route, selectedParams([route.exact]));
        expect(body.total).toBe(1);
        expect(readRows(body).map((row) => row.id)).toEqual([route.id]);
      });

      it("保留固定 q，selectedValues 不能扩大既有筛选", async () => {
        const params = selectedParams([route.id]);
        params.set("q", "definitely-not-a-match");
        const body = await call(route, params);
        expect(body.total).toBe(0);
        expect(readRows(body)).toEqual([]);
      });

      it("显式空选择返回空结果，缺参仍按原分页返回", async () => {
        const empty = await call(route, selectedParams([]));
        expect(empty.total).toBe(0);
        expect(readRows(empty)).toEqual([]);
        const ordinary = await call(route, new URLSearchParams({ page: "1", pageSize: "1" }));
        expect(ordinary.total).toBeGreaterThan(1);
        expect(readRows(ordinary)).toHaveLength(1);
      });
    });
  }

  it("加工厂选仓在分页、总数、搜索及已选补取前统一裁剪，不包含停用/自有/其他厂", async () => {
    const rows = await db.insert(schema.warehouses).values([
      { code: "WH-FACTORY-A", name: "同厂一仓", kind: "outsource", supplierId: 11004 },
      { code: "WH-FACTORY-B", name: "同厂二仓", kind: "outsource", supplierId: 11004 },
      { code: "WH-FACTORY-X", name: "其他厂", kind: "outsource", supplierId: 11003 },
    ]).returning();
    const params = new URLSearchParams({ outsourceSupplierId: "11004", pageSize: "1", page: "2" });
    const body = await call(routes[5], params);
    expect(body.total).toBe(2); expect(readRows(body).map(r => r.id)).toEqual([rows[1].id]);
    params.set("selectedValues", JSON.stringify([rows[0].id, rows[2].id, 5001, 5002]));
    expect(readRows(await call(routes[5], params)).map(r => r.id)).toEqual([rows[0].id]);
    params.delete("selectedValues"); params.set("q", "二仓"); params.set("page", "1");
    expect(readRows(await call(routes[5], params)).map(r => r.id)).toEqual([rows[1].id]);
    for (const invalid of ["", "oops", "0", "1.2", "2147483648", "11004&outsourceSupplierId=11003"]) {
      expect((await warehouseGet(new NextRequest(`http://localhost/api/master/warehouse?outsourceSupplierId=${invalid}`))).status).toBe(400);
    }
  });

  it("超过第 999 个供应商可精确回显，仍使用原最小投影", async () => {
    const firstPage = await call(routes[4], new URLSearchParams({ page: "1", pageSize: "999" }));
    expect(readRows(firstPage).some((row) => row.id === 11004)).toBe(false);
    const body = await call(routes[4], selectedParams([11004]));
    expect(body.total).toBe(1);
    expect(Object.keys(readRows(body)[0]).sort()).toEqual(["code", "contact", "id", "kinds", "licenseExpiry", "name", "status"]);
    expect(JSON.stringify(body)).not.toContain("synthetic-private");
  });

  it("名称重复只返回真实候选，200 行上限不伪造 total", async () => {
    const body = await call(routes[3], selectedParams(["同名分类"]));
    expect(body.total).toBe(205);
    expect(readRows(body)).toHaveLength(SELECTED_OPTIONS_LIMIT);
    expect(new Set(readRows(body).map((row) => row.id)).size).toBe(SELECTED_OPTIONS_LIMIT);
  });

  it("50 个独立已选 ID 全部可取，不继承 pageSize=1", async () => {
    const ids = Array.from({ length: 50 }, (_, i) => 10000 + i);
    const params = selectedParams(ids);
    params.set("pageSize", "1");
    const body = await call(routes[4], params);
    expect(body.total).toBe(50);
    expect(readRows(body).map((row) => row.id)).toEqual(ids);
  });

  it("数字字符串是业务编码，不能被猜成数据库 ID", async () => {
    const byString = await call(routes[0], selectedParams(["3002"]));
    const byNumber = await call(routes[0], selectedParams([3002]));
    expect(readRows(byString).map((row) => row.id)).toEqual([3005]);
    expect(readRows(byNumber).map((row) => row.id)).toEqual([3002]);
  });

  it.each(["SUP-10%", "SUP-100", "' OR 1=1 --"])("不把 %s 作为 LIKE 或 SQL 执行", async (value) => {
    const body = await call(routes[4], selectedParams([value]));
    expect(body.total).toBe(0);
    expect(readRows(body)).toEqual([]);
  });

  it("SKU 固定类型和商业角色继续取交集", async () => {
    const params = selectedParams([3002, 3003, 3004]);
    params.set("type", "finished");
    params.set("commercialRole", "retail");
    const body = await call(routes[0], params);
    expect(body.total).toBe(1);
    expect(readRows(body).map((row) => row.id)).toEqual([3002]);
  });

  it("SKU 精确模式保留 ops 与价格可见角色各自的原列表投影，不旁路 DTO 边界", async () => {
    const snapshots: OptionRow[] = [];
    for (const role of ["ops", "purchasing"]) {
      mocks.guardRead.mockResolvedValue({ ...actor, roles: [role], isApprover: false });
      const ordinary = await call(routes[0], new URLSearchParams({ q: "SKU-Z" }));
      const exact = await call(routes[0], selectedParams([3002]));
      expect(readRows(exact)).toEqual(readRows(ordinary));
      const row = readRows(exact)[0];
      expect(row).toMatchObject({ id: 3002, code: "SKU-Z", name: "成品尾" });
      for (const key of ["price", "cost", "unitCost", "bankAccount", "paymentTerm", "attrs"]) {
        expect(row).not.toHaveProperty(key);
      }
      snapshots.push(row);
    }
    // 原 SKU 列表本就不投影价格字段；精确补取不升级为全字段详情。
    expect(snapshots[0]).toEqual(snapshots[1]);
  });

  it("库存单据固定 subtype/status 继续取交集", async () => {
    const params = selectedParams([6002, 6003, 6004]);
    params.set("subtype", "opening");
    params.set("status", "approved");
    params.set("q", "RK-SEL-Z");
    const body = await call(routes[6], params);
    expect(body.total).toBe(1);
    expect(readRows(body).map((row) => row.id)).toEqual([6002]);
  });

  it("停用渠道/仓库仍遵循原列表规则，仓库关系与英文 SPU 名保留", async () => {
    const channels = await call(routes[2], selectedParams([4002]));
    expect(readRows(channels)[0]).toMatchObject({ id: 4002, active: false });
    const warehouses = await call(routes[5], selectedParams([5002]));
    expect(readRows(warehouses)[0]).toMatchObject({ id: 5002, active: false, parentId: 5001, supplierId: 11004, supplierName: "供应商-1004" });
    const spus = await call(routes[1], selectedParams(["Selected Tail"]));
    expect(readRows(spus)[0]).toMatchObject({ id: 2002, categoryId: 1002, categoryName: "分类尾" });
  });
});
