import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync("src/app/(app)/matflow/sh/sh-client.tsx", "utf8");

describe("收货详情宽表布局契约（实际窄屏另验）", () => {
  it.each([
    ["ShLine", 840], ["QcLine", 720], ["QcEditRow", 890],
  ])("%s 将宽字段留在表内滚动，不压缩为竖排", (rowType, width) => {
    const table = source.match(new RegExp(`<Table<${rowType}>[\\s\\S]*?/>`))?.[0];
    expect(table).toBeDefined();
    expect(table).toContain(`scroll={{ x: ${width} }}`);
    expect(table).toContain('tableLayout="fixed"');
    expect(table).toContain("pagination={false}");
  });

  it("三张表保留可换行的物料身份列，不用省略号隐藏名称", () => {
    for (const columnName of ["lineColumns", "qcResultColumns", "qcEditColumns"]) {
      const columns = source.slice(source.indexOf(`const ${columnName}:`)).split("\n  ];")[0];
      const material = columns.slice(0, columns.indexOf('title: "行类型"'));
      expect(material).toContain("width: 160");
      expect(material).not.toContain("ellipsis");
    }
  });
});
