import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("发退料窄屏表格契约（像素与操作仍需浏览器验收）", () => {
  for (const [domain, rowType, detailWidth, createWidth] of [
    ["fl", "FlLine", 750, 540], ["tl", "TlLine", 660, 580],
  ] as const) {
    const source = readFileSync(`src/app/(app)/matflow/${domain}/${domain}-client.tsx`, "utf8");
    it(`${domain} 明细与录入表保留可滚动列宽`, () => {
      for (const [type, width] of [[rowType, detailWidth], ["CreateLine", createWidth]]) {
        const table = source.match(new RegExp(`<Table<${type}>[\\s\\S]*?/>`))?.[0];
        expect(table).toContain(`scroll={{ x: ${width} }}`);
        expect(table).toContain('tableLayout="fixed"');
        expect(table).toContain("pagination={false}");
      }
    });
    it(`${domain} 完整物料身份及中文标签不退化为逐字竖排`, () => {
      for (const name of ["lineColumns", "createLineColumns"]) {
        const columns = source.slice(source.indexOf(`const ${name}:`)).split("\n  ];")[0];
        const identity = columns.slice(0, columns.indexOf('title: "单位"'));
        expect(identity).toContain("width: 200");
        expect(identity).not.toContain("ellipsis");
      }
      expect(source).toContain('label: { width: 104, whiteSpace: "nowrap" }');
      expect(source).toContain('content: { overflowWrap: "anywhere" }');
    });
  }
});
