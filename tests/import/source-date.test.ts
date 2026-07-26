import { describe, expect, it } from "vitest";
import { monthEnd, monthFromFilename } from "@/server/import/adapters/demand";

describe("月份来源日期", () => {
  it("优先使用文件名中的四位或两位年份", () => {
    expect(monthFromFilename("/tmp/2025年6月份需求.xlsx", 2099)).toBe("2025-06");
    expect(monthFromFilename("/tmp/26年产品销量汇总（6月）.xlsx", 2099)).toBe("2026-06");
  });

  it("文件名没有年份时才使用调用方明确给出的年份", () => {
    expect(monthFromFilename("/tmp/6月份业务部需求.xlsx", 2026)).toBe("2026-06");
  });

  it("把月粒度事实的截止日固定为月末", () => {
    expect(monthEnd("2026-02")).toBe("2026-02-28");
    expect(monthEnd("2024-02")).toBe("2024-02-29");
  });
});
