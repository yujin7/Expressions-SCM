import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const read = (relative: string): string => readFileSync(path.join(process.cwd(), relative), "utf8");

describe("import exception scoped-clearance UI", () => {
  it("lets operators isolate external-system queues and explains the zero-open gate", () => {
    const client = read("src/app/(app)/import/exceptions/exceptions-client.tsx");
    expect(client).toContain('defaults: { status: "open", aliasType: "", scope: "" }');
    expect(client).toContain('params.set("scope", scope)');
    expect(client).toContain('placeholder="全部来源"');
    expect(client).toContain("外部系统作用域的待认领项必须清零");
  });
});
