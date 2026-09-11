import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { expect, it } from "vitest";
const source = readFileSync("src/app/(app)/outsource/po/[id]/print/page.tsx", "utf8");
const ast = ts.createSourceFile("print.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const fn = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === "mulDec")!;
const multiply = runInNewContext(ts.transpileModule(`(${fn.getText(ast)})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText) as (a: string, b: string) => string;
it.each([
  ["1", "1.2449", "1.24"], ["1", "1.2450", "1.25"], ["-1", "1.2449", "-1.24"],
  ["-1", "1.2450", "-1.25"], ["0.0001", "9999.9999", "1.00"],
  ["9999999999.9999", "9999999999.99", "99999999999899000000.00"],
])("print quantity %s times price %s rounds only once to %s", (qty, price, expected) => expect(multiply(qty, price)).toBe(expected));
