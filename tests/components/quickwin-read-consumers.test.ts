import { readdirSync, readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { expect, it, vi } from "vitest";
import { createLatestReadScope } from "@/components/useLatestRead";

// Executes each real, trusted source callback with deferred reads; this is not browser/layout proof.
const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
  entry.isDirectory() ? files(`${dir}/${entry.name}`) : entry.name.endsWith(".tsx") ? [`${dir}/${entry.name}`] : []);
const consumers: { label: string; source: string; names: Set<string> }[] = [];
for (const file of files("src/app/(app)")) {
  const source = readFileSync(file, "utf8");
  if (!source.includes("useLatestRead")) continue;
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isCallExpression(node.initializer)
      && node.initializer.expression.getText(ast) === "useCallback") {
      const callback = node.initializer.arguments[0];
      if (callback && ts.isArrowFunction(callback) && callback.getText(ast).includes("const readRequest = begin")) {
        const names = new Set<string>();
        const collect = (child: ts.Node) => { if (ts.isIdentifier(child)) names.add(child.text); ts.forEachChild(child, collect); };
        collect(callback);
        consumers.push({ label: `${file}:${ast.getLineAndCharacterOfPosition(node.pos).line + 1}`,
          source: callback.getText(ast), names });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
}

function fixture(consumer: typeof consumers[number]) {
  const scope = createLatestReadScope();
  const writes: unknown[] = [];
  const pending: ReturnType<typeof Promise.withResolvers<unknown>>[] = [];
  const fetch = vi.fn((_url: string, init?: RequestInit) => {
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    const deferred = Promise.withResolvers<unknown>(); pending.push(deferred); return deferred.promise;
  });
  const env: Record<string, unknown> = {};
  for (const name of consumer.names) {
    if (name.startsWith("set")) env[name] = (...args: unknown[]) => writes.push([name, ...args]);
    else if (/^begin.*Read$/.test(name)) env[name] = scope.begin;
    else env[name] = "";
  }
  const filters = new Proxy({}, { get: () => "" });
  const state = { page: 1, pageSize: 20, filters };
  Object.assign(env, { fetchJson: fetch, message: { error: (e: unknown) => writes.push(["error", e]) },
    URLSearchParams, String, Number, Boolean, Math, Error, Object, Array, Date, Set, Map, JSON, encodeURIComponent,
    filters, reviewState: state, moState: state, bfState: state,
    month: { format: () => "2026-09" }, buildParams: () => new URLSearchParams(),
    page: 1, pageSize: 20, skuId: 1,
    loadSequence: { current: 0 }, publishKey: { current: "" },
  });
  const code = ts.transpileModule(`(${consumer.source})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const callback = runInNewContext(code, env) as (value?: unknown) => Promise<void>;
  const run = () => callback(consumer.source.includes("sku: string") ? "QA-SKU"
    : consumer.source.includes("query:") ? { versionId: 1 } : 1);
  return { scope, writes, pending, run, fetch };
}
const payload = { rows: [], data: [], total: 2, items: [], cycles: [{ id: 1 }], versions: [{ id: 1 }],
  summary: null, sections: [], exceptions: [], nextActions: [], queues: [], bySupplier: [], docs: [],
  assignableRoles: [], importedAt: "2026-09-11", marker: "current" };
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

it("keeps the audited read migration covered, not an empty source scan", () => { expect(consumers.length).toBeGreaterThanOrEqual(60); });
it.each(consumers)("$label ignores stale success/error/finally and cancels on unmount", async consumer => {
  for (const failure of [false, true]) {
    const f = fixture(consumer);
    const oldRun = f.run(), oldCount = f.pending.length;
    expect(oldCount).toBeGreaterThan(0);
    const newRun = f.run();
    for (const call of f.fetch.mock.calls.slice(0, oldCount)) expect(call[1]?.signal?.aborted).toBe(true);
    for (const p of f.pending.slice(oldCount)) p.resolve(payload);
    await newRun; await flush();
    expect(f.writes.filter(w => Array.isArray(w) && w[0] === "error")).toEqual([]);
    const count = f.writes.length;
    for (const p of f.pending.slice(0, oldCount)) {
      if (failure) p.reject(Error("obsolete")); else p.resolve({ ...payload, marker: "obsolete" });
    }
    await oldRun; await flush();
    expect(f.writes).toHaveLength(count);
    const unmountRun = f.run(), beforeUnmount = f.writes.length;
    f.scope.cancel();
    for (const p of f.pending) p.resolve(payload);
    await unmountRun; await flush();
    expect(f.writes).toHaveLength(beforeUnmount);
  }
});
