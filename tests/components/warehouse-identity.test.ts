import React, { isValidElement, type ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import WarehouseClient from "@/app/(app)/master/warehouse/warehouse-client";

vi.mock("react", async original => ({ ...await original<typeof import("react")>(), useState: (v: unknown) => [v, vi.fn()], useRef: (v: unknown) => ({ current: v }) }));
vi.mock("antd", () => ({ Alert: "alert", Button: "button", Descriptions: "descriptions", Drawer: "drawer", Form: { Item: "form-item" }, Input: "input", Select: "select", Skeleton: "skeleton", Space: "space", Switch: "switch", Table: "table", Tag: "tag", Typography: { Title: "title", Text: "text" } }));
vi.mock("@/components/CrudTable", () => ({ default: "crud" }));
vi.mock("@/components/RemoteSelect", () => ({ default: "remote" }));
vi.mock("@/components/useListState", () => ({ useListState: () => ({ filters: {} }) }));
vi.mock("@/components/useMe", () => ({ useMe: () => ({ id: 1, roles: ["admin"] }), hasAnyRole: () => true }));
type Node = React.ReactElement<Record<string, unknown> & { children?: ReactNode }>;
const nodes = (v: ReactNode): Node[] => Array.isArray(v) ? v.flatMap(nodes) : isValidElement<Node["props"]>(v) ? [v, ...nodes(v.props.children)] : [];
function fields(usage: string[] | undefined | null) {
  const crud = nodes(WarehouseClient()).find(n => n.type === "crud")!;
  expect(crud.props.loadDetailOnEdit).toBe(true);
  const form = (crud.props.formItems as (editing: unknown) => ReactNode)(usage === null ? null : { id: 1, identityUsage: usage });
  const rendered = nodes(form);
  const supplier = rendered.find(n => n.props.noStyle)?.props.children as unknown as (form: { getFieldValue: () => string }) => ReactNode;
  return [...rendered, ...nodes(supplier({ getFieldValue: () => "outsource" }))];
}
beforeEach(() => vi.stubGlobal("React", React));
afterEach(() => vi.unstubAllGlobals());
it.each([["库存余额"], ["发料单", "收货单"], undefined])("used or unknown identity stays locked, but ordinary edits remain available: %j", usage => {
  const tree = fields(usage);
  expect(tree.find(n => n.type === "select")?.props.disabled).toBe(true);
  expect(tree.find(n => n.type === "remote" && n.props.placeholder === "选择加工厂")?.props.disabled).toBe(true);
  expect(tree.find(n => n.type === "alert")?.props.description).toBeTruthy();
  expect(tree.filter(n => n.type === "input" || n.type === "switch").every(n => n.props.disabled !== true)).toBe(true);
});
it.each([[], null])("empty detail and new warehouse allow choosing identity: %j", usage => {
  const tree = fields(usage);
  expect(tree.find(n => n.type === "select")?.props.disabled).toBe(false);
  expect(tree.find(n => n.type === "remote" && n.props.placeholder === "选择加工厂")?.props.disabled).toBe(false);
  expect(tree.some(n => n.type === "alert")).toBe(false);
});
