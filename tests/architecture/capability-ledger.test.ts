import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ledger = readFileSync(
  path.resolve(__dirname, "../../docs/spec/15-194项能力审计台账.md"),
  "utf8",
);

describe("194 项能力审计台账", () => {
  const rows = [...ledger.matchAll(/^\| C(\d{3}) \| ([^|]+) \| (✅|◐|☐|⛔) \| ([^|]+) \|$/gm)];

  it("恰好包含 C001–C194，连续且无重复", () => {
    expect(rows).toHaveLength(194);
    expect(rows.map((match) => match[1])).toEqual(
      Array.from({ length: 194 }, (_, index) => String(index + 1).padStart(3, "0")),
    );
  });

  it("每行都有独立能力名称与证据/出口，不以空占位冒充完成", () => {
    const names = rows.map((match) => match[2].trim());
    expect(new Set(names).size).toBe(194);
    for (const row of rows) {
      expect(row[2].trim().length).toBeGreaterThanOrEqual(4);
      expect(row[4].trim().length).toBeGreaterThanOrEqual(4);
    }
  });

  it("台账明确规定只有 ✅ 计入完成，防止 partial 被虚报", () => {
    expect(ledger).toContain("只有 ✅ 才计入已执行数");
    expect(ledger).toContain("◐ 不得算完成");
  });
});
