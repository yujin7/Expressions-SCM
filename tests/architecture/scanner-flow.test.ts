import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf8");

describe("C175 收货/盘点扫码枪回车流架构契约", () => {
  it("收货与盘点都复用受控扫码入口，并支持条码/SKU 匹配和歧义拒绝", () => {
    const receiving = read("src/app/(app)/matflow/sh/sh-client.tsx");
    const count = read("src/app/(app)/inventory/count/count-client.tsx");
    const scanner = read("src/components/ScannerEntry.tsx");

    for (const client of [receiving, count]) {
      expect(client).toContain("ScannerEntry");
      expect(client).toContain("findUniqueScanMatch");
      expect(client).toContain("addScanQty");
      expect(client).toContain('result.kind === "ambiguous"');
    }
    expect(scanner).toContain("onPressEnter={submit}");
    expect(scanner).toContain("inputRef.current?.focus");
  });

  it("业务详情 API 暴露主数据条码，但写入仍走既有受控单据服务", () => {
    expect(read("src/server/modules/inventory/count.ts")).toContain("barcode: skus.barcode");
    expect(read("src/server/modules/outsource/po.ts")).toContain("barcode: skus.barcode");
    expect(read("src/server/modules/outsource/jg.ts")).toContain("productSkuBarcode: skus.barcode");
  });
});
