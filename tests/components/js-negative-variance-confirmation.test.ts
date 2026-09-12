import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { expect, it, vi } from "vitest";
import { JsonRequestError } from "@/components/fetchJson";

const source = readFileSync("src/app/(app)/settlement/js/js-client.tsx", "utf8");
const file = ts.createSourceFile("js-client.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let callback = "";
function visit(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(file) === "doApprove") callback = node.initializer!.getText(file);
  ts.forEachChild(node, visit);
}
visit(file);
// Execute the actual client callback. Browser evidence covers AntD state/rendering separately.
function harness(error?: Error, target: { id: number; version: number } | null = null, allowed = true) {
  const context = { detail: { id: 7, version: 3, actions: { approve: allowed } }, surplusTarget: target,
    post: error ? vi.fn().mockRejectedValue(error) : vi.fn().mockResolvedValue(true),
    setSurplusTarget: vi.fn(), setSurplusAck: vi.fn(), setSurplusNote: vi.fn(), setSurplusMsg: vi.fn(),
    message: { error: vi.fn() }, JsonRequestError };
  const script = ts.transpileModule(`const callback = ${callback}; callback;`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const run = vm.runInNewContext(script, context) as (extra?: { acknowledgeSurplus: boolean; surplusNote: string }) => Promise<void>;
  return { ...context, run };
}
it.each([
  new Error("结余 acknowledgeSurplus 网络异常"), new JsonRequestError("negative", 403, "SURPLUS_UNACKED"),
  new JsonRequestError("negative", 409, "VERSION_CONFLICT"), new JsonRequestError("negative", 500, "SURPLUS_UNACKED"),
])("ordinary/unauthorized/uncertain failures cannot trigger a special approval confirmation", async error => {
  const h = harness(error); await h.run();
  expect(h.setSurplusTarget).not.toHaveBeenCalled(); expect(h.message.error).toHaveBeenCalledWith(error.message);
});
it("only exact conflict code binds a fresh confirmation to this document version and clears prior consent", async () => {
  const h = harness(new JsonRequestError("核对差异", 409, "SURPLUS_UNACKED")); await h.run();
  expect(h.setSurplusTarget).toHaveBeenCalledWith({ id: 7, version: 3 });
  expect(h.setSurplusAck).toHaveBeenCalledWith(false); expect(h.setSurplusNote).toHaveBeenCalledWith("");
});
it.each([null, { id: 8, version: 3 }, { id: 7, version: 2 }])("missing/obsolete challenge %j cannot acknowledge the current document", async target => {
  const h = harness(undefined, target); await h.run({ acknowledgeSurplus: true, surplusNote: "已核对" });
  expect(h.post).not.toHaveBeenCalled(); expect(h.message.error).toHaveBeenCalled();
});
it("current challenge still needs current approval eligibility", async () => {
  const h = harness(undefined, { id: 7, version: 3 }, false); await h.run({ acknowledgeSurplus: true, surplusNote: "已核对" });
  expect(h.post).not.toHaveBeenCalled();
});
it("current confirmed action carries its version and preserves existing wire fields", async () => {
  const h = harness(undefined, { id: 7, version: 3 }); await h.run({ acknowledgeSurplus: true, surplusNote: "已核对" });
  expect(h.post).toHaveBeenCalledWith("approve", { action: "approve", version: 3, acknowledgeSurplus: true, surplusNote: "已核对" }, expect.any(String));
  expect(h.setSurplusTarget).toHaveBeenCalledWith(null);
});
it("an already busy write does not discard the pending confirmation", async () => {
  const h = harness(undefined, { id: 7, version: 3 }); h.post.mockResolvedValue(false);
  await h.run({ acknowledgeSurplus: true, surplusNote: "已核对" }); expect(h.setSurplusTarget).not.toHaveBeenCalled();
});
