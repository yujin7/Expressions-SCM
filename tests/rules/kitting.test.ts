import { describe, expect, it } from "vitest";
import { batchAllowed, producibleQty, suggestBatchQty } from "@/server/rules/kitting";

describe("R18 齐套引擎（D33）", () => {
  it("可产量=各料净发÷单耗的最小下整", () => {
    // WO 1000 件：料A 毛需 2000（单耗2，净发 900→450 件）；料B 毛需 1000（单耗1，净发 800→800 件）
    expect(producibleQty("1000", [
      { materialSkuId: 1, grossReq: "2000", netIssued: "900" },
      { materialSkuId: 2, grossReq: "1000", netIssued: "800" },
    ])).toBe("450");
  });
  it("零需求行不约束；空行/零单=0", () => {
    expect(producibleQty("100", [{ materialSkuId: 1, grossReq: "0", netIssued: "0" }])).toBe("0");
    expect(producibleQty("0", [])).toBe("0");
  });
  it("建议批量：扣已批、按倍数下整、不超 WO 余量", () => {
    expect(suggestBatchQty({ producible: "450", alreadyBatched: "100", woQty: "1000", orderMultiple: "50" })).toBe("350.0000");
    expect(suggestBatchQty({ producible: "450", alreadyBatched: "100", woQty: "400", orderMultiple: "50" })).toBe("300.0000");
    expect(suggestBatchQty({ producible: "30", alreadyBatched: "0", woQty: "1000", orderMultiple: "50" })).toBe("0.0000");
    expect(suggestBatchQty({ producible: "80", alreadyBatched: "80", woQty: "1000" })).toBe("0.0000");
  });
  it("批次护栏", () => {
    expect(batchAllowed(7)).toBe(true);
    expect(batchAllowed(8)).toBe(false);
  });
});
