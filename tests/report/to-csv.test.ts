import { describe, expect, it } from "vitest";
import {
  buildCsv, csvDisposition, stripMoneyColumns, toCsv, TRUNCATION_ROW_TEXT,
} from "@/server/modules/report/export";

describe("W5 导出基础设施：toCsv/buildCsv/stripMoneyColumns", () => {
  const cols = [
    { key: "skuCode", title: "SKU编码" },
    { key: "qty", title: "数量" },
  ];

  it("BOM + CRLF + 标题行；decimal 字符串逐字输出（不重格式化）", () => {
    const csv = toCsv(
      [
        { skuCode: "CP00001", qty: "1000.0000" },
        { skuCode: "YL00001", qty: "-0.5000" },
      ],
      cols,
    );
    expect(csv.charCodeAt(0)).toBe(0xfeff); // Excel BOM
    const body = csv.slice(1);
    expect(body).toBe("SKU编码,数量\r\nCP00001,1000.0000\r\nYL00001,-0.5000\r\n");
    expect(body).toContain("1000.0000"); // 尾零保留——禁 float 重格式化
  });

  it("引号转义（RFC4180）：逗号/引号/换行包裹，内部引号加倍；null/undefined → 空", () => {
    const csv = toCsv(
      [{ skuCode: 'A,B"C\nD', qty: null }],
      cols,
    );
    // 整格包裹引号，内部引号加倍，内嵌 \n 原样保留（在引号内不破行）
    expect(csv).toContain('"A,B""C\nD",');
    // 行分隔为 CRLF：数据行内嵌的是裸 \n，不会被当作行结束
    const lines = csv.slice(1).split("\r\n");
    expect(lines[0]).toBe("SKU编码,数量");
    expect(lines[1]).toBe('"A,B""C\nD",'); // null → 空单元格
    expect(csv.endsWith("\r\n")).toBe(true);
  });

  it("buildCsv 截断：truncated=true 追加提示行（占第一列）", () => {
    const csv = buildCsv([{ skuCode: "X", qty: "1" }], cols, { truncated: true });
    const lines = csv.slice(1).split("\r\n").filter((l) => l !== "");
    expect(lines).toHaveLength(3); // 标题 + 1 数据 + 截断行
    expect(lines[2].startsWith(TRUNCATION_ROW_TEXT)).toBe(true);
    // 未截断不追加
    const csv2 = buildCsv([{ skuCode: "X", qty: "1" }], cols);
    expect(csv2).not.toContain(TRUNCATION_ROW_TEXT);
  });

  it("stripMoneyColumns：非价格可见角色整列剔除金额（列缺失而非置空）；可见角色原样", () => {
    const withMoney = [
      { key: "jsNo", title: "结算单号" },
      { key: "feePayable", title: "应付加工费" },
      { key: "settleAmount", title: "结算金额" },
      { key: "deductionTotal", title: "扣款合计" },
      { key: "price", title: "单价" },
    ];
    const opsCols = stripMoneyColumns(withMoney, ["ops"]);
    expect(opsCols.map((c) => c.key)).toEqual(["jsNo"]);
    const whCols = stripMoneyColumns(withMoney, ["warehouse"]);
    expect(whCols.map((c) => c.key)).toEqual(["jsNo"]);
    const finCols = stripMoneyColumns(withMoney, ["finance"]);
    expect(finCols).toHaveLength(5);
    const adminCols = stripMoneyColumns(withMoney, ["admin"]);
    expect(adminCols).toHaveLength(5);

    // 剥列后 CSV 不含敏感标题与值（R9 含导出）
    const csv = toCsv(
      [{ jsNo: "JS-1", feePayable: "88.00", settleAmount: "80.00", deductionTotal: "8.00", price: "1.00" }],
      opsCols,
    );
    expect(csv).not.toContain("88.00");
    expect(csv).not.toContain("应付加工费");
  });

  it("csvDisposition：RFC5987 中文文件名编码", () => {
    const d = csvDisposition("库存余额_2026-07-24");
    expect(d).toContain("attachment;");
    expect(d).toContain(`filename*=UTF-8''${encodeURIComponent("库存余额_2026-07-24")}.csv`);
  });
});
