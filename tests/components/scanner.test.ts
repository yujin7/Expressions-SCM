import { describe, expect, it } from "vitest";

import { addScanQty, findUniqueScanMatch, normalizeScanCode } from "@/components/scanner";

describe("扫码枪回车流纯函数", () => {
  const rows = [
    { id: 1, skuCode: "RA-001", barcode: "6900000000001" },
    { id: 2, skuCode: "PK-002", barcode: "6900000000002" },
  ];

  it("条码与 SKU 编码均可匹配，且忽略首尾空格和编码大小写", () => {
    expect(normalizeScanCode("  ra-001 ")).toBe("RA-001");
    expect(findUniqueScanMatch(rows, "6900000000002", (row) => [row.barcode, row.skuCode])).toEqual({
      kind: "match",
      item: rows[1],
    });
    expect(findUniqueScanMatch(rows, " ra-001 ", (row) => [row.barcode, row.skuCode])).toEqual({
      kind: "match",
      item: rows[0],
    });
  });

  it("拒绝未命中和重复条码，避免把数量写到错误行", () => {
    expect(findUniqueScanMatch(rows, "UNKNOWN", (row) => [row.barcode, row.skuCode])).toEqual({
      kind: "missing",
    });
    const duplicate = [...rows, { id: 3, skuCode: "RA-003", barcode: "6900000000001" }];
    expect(findUniqueScanMatch(duplicate, "6900000000001", (row) => [row.barcode, row.skuCode])).toEqual({
      kind: "ambiguous",
      count: 2,
    });
  });

  it("用精确十进制累加扫码数量，不引入浮点误差", () => {
    expect(addScanQty("0.1", "0.2")).toBe("0.3");
    expect(addScanQty("12.3400", "0.66")).toBe("13");
    expect(addScanQty("9999999999999999.9999", "0.0001")).toBe("10000000000000000");
    expect(() => addScanQty("-1", "1")).toThrow("非负十进制");
  });
});
