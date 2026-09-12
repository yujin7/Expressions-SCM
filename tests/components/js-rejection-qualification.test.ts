import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { expect, it } from "vitest";

// Wiring guard: role behavior is tested in pc-js-actions; browser covers actual activation.
function rejectionConditions(source: string) {
  const file = ts.createSourceFile("js-client.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const conditions: string[][] = [];
  const visit = (node: ts.Node) => {
    if (ts.isJsxElement(node) && node.openingElement.tagName.getText(file) === "Button"
      && node.children.some(c => ts.isJsxText(c) && c.text.trim() === "驳回")) {
      const ancestors: string[] = [];
      for (let p = node.parent; p; p = p.parent) {
        if (ts.isConditionalExpression(p)) ancestors.push(p.condition.getText(file));
      }
      conditions.push(ancestors);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return conditions;
}
it("JS rejection uses its own eligibility, never the approval gate", () => {
  const source = fs.readFileSync(path.resolve("src/app/(app)/settlement/js/js-client.tsx"), "utf8");
  const conditions = rejectionConditions(source);
  expect(conditions).toHaveLength(1);
  expect(conditions[0]).toContain("detail.actions?.reject");
  expect(conditions[0]).not.toContain("detail.actions?.approve");
  // The regression (nesting rejection beneath approval) is detected by this guard.
  const mutant = source.replace("{detail.actions?.reject ? (", "{detail.actions?.approve ? (");
  expect(rejectionConditions(mutant)[0]).not.toContain("detail.actions?.reject");
  expect(rejectionConditions(mutant)[0]).toContain("detail.actions?.approve");
});
