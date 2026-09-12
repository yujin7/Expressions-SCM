import React, { isValidElement, type ReactNode } from "react";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
let SourcingAidPanel: typeof import("@/app/(app)/outsource/wo/sourcing-aid-panel").default;
beforeAll(async () => { vi.stubGlobal("React", React); SourcingAidPanel = (await import("@/app/(app)/outsource/wo/sourcing-aid-panel")).default; });
afterAll(() => vi.unstubAllGlobals());
const h = vi.hoisted(() => ({ selected: undefined as number | undefined, phase: "success", url: null as string | null, retry: vi.fn() }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(), useState: (initial: number | undefined) => [h.selected ?? initial, (value: number) => { h.selected = value; }] }));
vi.mock("antd", () => ({ Card: "card", Select: "select", Table: "table", Button: "button", Alert: "alert", Empty: Object.assign("empty", { PRESENTED_IMAGE_SIMPLE: "empty" }), Space: "space", Tag: "tag", Tooltip: "tooltip", Typography: { Text: "text" } }));
vi.mock("@/components/useDocumentRead", () => ({ useDocumentRead: (url: string | null) => {
  h.url = url; return { phase: h.phase, data: h.phase === "success" ? { rows: [{ supplierId: 1 }], limitations: [] } : null, error: h.phase === "error" ? "offline" : null, retry: h.retry };
} }));
type Node = React.ReactElement<Record<string, unknown> & { children?: ReactNode }>;
const nodes = (v: ReactNode): Node[] => Array.isArray(v) ? v.flatMap(nodes) : isValidElement<Node["props"]>(v) ? [v, ...nodes(v.props.children)] : [];
const render = (ids = [1, 2]) => nodes(SourcingAidPanel({ skuOptions: ids.map(value => ({ value, label: `物料${value}` })) }));
beforeEach(() => { h.selected = undefined; h.phase = "success"; h.retry.mockClear(); vi.stubGlobal("React", React); });
it("selecting another material or changing source immediately switches the identity-bound GET", () => {
  let tree = render(); expect(h.url).toBe("/api/outsource/sourcing-aid?skuId=1");
  (tree.find(n => n.type === "select")!.props.onChange as (id: number) => void)(2);
  tree = render(); expect(h.url).toBe("/api/outsource/sourcing-aid?skuId=2");
  render([3]); expect(h.url).toBe("/api/outsource/sourcing-aid?skuId=3");
  render([]); expect(h.url).toBeNull();
});
it("failed reads are unknown, clear previous facts and expose a read-only retry", () => {
  h.phase = "error"; const tree = render(), table = tree.find(n => n.type === "table")!;
  expect(table.props.dataSource).toEqual([]); expect((table.props.locale as { emptyText: string }).emptyText).toContain("不代表没有");
  const alert = tree.find(n => n.type === "alert")!;
  (nodes(alert.props.action as ReactNode)[0].props.onClick as () => void)(); expect(h.retry).toHaveBeenCalledTimes(1);
});
