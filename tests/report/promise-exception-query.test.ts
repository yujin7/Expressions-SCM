import { expect, it } from "vitest";
import { buildPromiseReliability, type PromiseLineFact } from "@/server/modules/report/supply-commitment";
import { parsePromiseExceptionSearch } from "@/server/modules/report/promise-exception-query";

const lines: PromiseLineFact[] = Array.from({ length: 251 }, (_, i) => ({
  lineId: i + 1, poId: 1, docNo: "PO-SAME", supplierCode: "SUP-A", supplierName: "供应商甲",
  skuId: 1, skuCode: "SAME-SKU", skuName: i === 250 ? "尾部专属物料" : "普通物料",
  baseUom: "件", orderQty: "1", uomFactor: "1", currentReceivedQty: "0",
  promisedDate: "2026-08-05", originalPromisedDate: null, promiseHistoryState: "missing", revisionCount: 0,
}));

it("全量搜索能找到前30/200条之外的记录，分母不随异常筛选改变", () => {
  const data = buildPromiseReliability(lines, [], [], { asOf: "2026-08-10", exceptionQuery: { q: "尾部专属" } });
  expect(data.exceptions.map(r => r.lineId)).toEqual([251]);
  expect(data.exceptionTotal).toBe(251);
  expect(data.exceptionView.total).toBe(1);
  expect(data.totals.eligibleLines).toBe(251);
});
it("全量排序后分页，翻到末页不重叠，反转输入保持稳定", () => {
  const options = { asOf: "2026-08-10", exceptionQuery: { sort: "lineId" as const, order: "desc" as const, page: 9, pageSize: 30 } };
  const a = buildPromiseReliability(lines, [], [], options);
  const b = buildPromiseReliability([...lines].reverse(), [], [], options);
  expect(a.exceptions.map(r => r.lineId)).toEqual([11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
  expect(b.exceptions).toEqual(a.exceptions);
  expect(a.exceptionView).toMatchObject({ page: 9, pageSize: 30, total: 251 });
});
it("没有匹配是筛选空态而不是整个窗口无异常", () => {
  const data = buildPromiseReliability(lines, [], [], { asOf: "2026-08-10", exceptionQuery: { basis: "original" } });
  expect(data.exceptions).toEqual([]); expect(data.exceptionTotal).toBe(251);
  expect(data.exceptionView.total).toBe(0); expect(data.state).toBe("ready");
});
it.each(["page=0", "page=-1", "page=1.1", "page=1e2", "pageSize=201", "page=1&page=2", "sort=unknown", "basis=trusted", "status=on_time_in_full", "q=a&q=b", "extra=x"])("非法列表条件不静默扩大范围 %s", query => {
  expect(() => parsePromiseExceptionSearch(new URLSearchParams(query), "list")).toThrow();
});
it("空页保留真实匹配总数，不自动冒充第一页", () => {
  const data = buildPromiseReliability(lines, [], [], { asOf: "2026-08-10", exceptionQuery: { page: 20 } });
  expect(data.exceptions).toHaveLength(0); expect(data.exceptionView.total).toBe(251); expect(data.exceptionView.page).toBe(20);
});
it("所有白名单排序字段可用，相同值有稳定行身份次序", () => {
  for (const sort of ["docNo", "lineId", "supplierName", "skuCode", "promisedDate", "revisionCount", "daysLate", "shortQty"] as const) {
    const options = { asOf: "2026-08-10", exceptionQuery: { sort, order: "asc" as const, pageSize: 200 } };
    expect(buildPromiseReliability(lines, [], [], options).exceptions)
      .toEqual(buildPromiseReliability([...lines].reverse(), [], [], options).exceptions);
  }
});
