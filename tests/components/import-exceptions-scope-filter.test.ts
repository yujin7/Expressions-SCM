import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const read = (relative: string): string => readFileSync(path.join(process.cwd(), relative), "utf8");

describe("import exception scoped-clearance UI", () => {
  it("lets operators isolate external-system queues and explains the zero-open gate", () => {
    const client = read("src/app/(app)/import/exceptions/exceptions-client.tsx");
    /* 逐键断言而不是钉整行字面量：2026-09-04 新增身份认领页签时给 useListState 加了 `view` 缺省，
       整行字面量比对随即变红——但被测行为（作用域/原始值筛选可用）并没有变。钉键不钉排版。 */
    for (const key of ['status: "open"', 'aliasType: ""', 'scope: ""', 'rawValue: ""']) {
      expect(client, `useListState 缺省应包含 ${key}`).toContain(key);
    }
    expect(client).toContain('params.set("scope", scope)');
    expect(client).toContain('params.set("rawValue", rawValue)');
    expect(client).toContain('placeholder="精确查找原始值"');
    expect(client).toContain('placeholder="全部来源"');
    expect(client).toContain("外部系统作用域的待认领项必须清零");
  });
});
