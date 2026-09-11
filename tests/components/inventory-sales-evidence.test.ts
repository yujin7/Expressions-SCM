import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { formatInventoryDaily, inventorySalesStatus, inventorySalesPeriod, inventorySalesExport, INVENTORY_SALES_EXPORT_COLUMNS } from "@/lib/inventory-sales-evidence";

describe("库存分析展示与CSV的销售证据契约", () => {
  it.each([0.0001 / 91, -0.0001 / 91, 0.01, 3, 10000])("%s 的展示不舍为零或丢符号", (value) => {
    const shown = formatInventoryDaily(value);
    expect(Number(shown.replaceAll(",", ""))).not.toBe(0);
    expect(Math.sign(Number(shown.replaceAll(",", "")))).toBe(Math.sign(value));
  });
  it("未知、非法和已登记零分别表示", () => {
    expect(formatInventoryDaily(null)).toBe("—");
    expect(formatInventoryDaily(NaN)).toBe("—");
    expect(formatInventoryDaily(0)).toBe("0");
    expect(inventorySalesStatus({ salesQty: null, salesMonths: 0, salesState: "missing" })).toBe("无月销记录");
    expect(inventorySalesStatus({ salesQty: "0", salesMonths: 2, salesState: "partial" })).toBe("缺月（2/3月已登记）");
    expect(inventorySalesStatus({ salesQty: "0", salesMonths: 3, salesState: "registered" })).toBe("3/3月已登记");
  });
  it("导出按源窗口和原始字符串保留证据，不用页面今天或格式化日销", () => {
    const row = { salesQty: "0.0001", salesMonths: 1, salesState: "partial" as const };
    const window = { months: ["2026-04", "2026-05", "2026-06"], latestMonth: "2026-06", divisorDays: 91 };
    expect(inventorySalesExport(row, window)).toEqual({ salesQty: "0.0001", salesMonths: 1,
      salesStatus: "缺月（1/3月已登记）", salesPeriod: "2026-04 ～ 2026-06", salesDivisorDays: 91 });
    expect(inventorySalesPeriod()).toBe("无正式月销窗口");
    expect(INVENTORY_SALES_EXPORT_COLUMNS).toHaveLength(5);
  });
  it("同步和异步消费者都使用同一个证据出口，未知行数据表不只取绘点", () => {
    const client = readFileSync("src/app/(app)/report/inventory-analytics/inventory-analytics-client.tsx", "utf8");
    const server = readFileSync("src/server/modules/report/export.ts", "utf8");
    expect(client).toContain("inventorySalesExport(r, d.salesWindow)");
    expect(server).toContain("inventorySalesExport(r, salesWindow)");
    expect(client).toContain("dataSource={stockedRows}");
    expect(client).not.toContain("∞（无动销）");
  });
});
