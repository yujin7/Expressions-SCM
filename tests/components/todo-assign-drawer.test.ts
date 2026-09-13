import React, { isValidElement, type ReactNode } from "react";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import TodoAssignDrawer from "@/app/(app)/todo/TodoAssignDrawer";
import TodoAssigneeSelect, { todoAssigneeLabel } from "@/components/TodoAssigneeSelect";
import type { WorkItemRow } from "@/app/(app)/todo/todo-client";

const h = vi.hoisted(() => ({ cursor: 0, slots: [] as unknown[], effects: [] as (() => void)[] }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(),
  useState: (initial: unknown) => { const i = h.cursor++; if (!(i in h.slots)) h.slots[i] = initial; return [h.slots[i], (next: unknown) => { h.slots[i] = next; }]; },
  useRef: (initial: unknown) => { const i = h.cursor++; if (!(i in h.slots)) h.slots[i] = { current: initial }; return h.slots[i]; },
  useLayoutEffect: (fn: () => void, deps: unknown[]) => { const i = h.cursor++, old = h.slots[i] as unknown[] | undefined; if (!old || deps.some((d, j) => d !== old[j])) { h.slots[i] = deps; h.effects.push(fn); } },
}));
vi.mock("antd", () => ({ Alert: "alert", Button: "button", Drawer: "drawer" }));
vi.mock("@/components/RemoteSelect", () => ({ default: "remote-select" }));
type Props = { children?: ReactNode; message?: string; description?: ReactNode; disabled?: boolean; onClick?: () => void; onChange?: (value: unknown, option: unknown) => void; ref?: { current: unknown }; tabIndex?: number; "aria-label"?: string };
function elements(node: ReactNode): React.ReactElement<Props>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Props>(node)) return [];
  return [node, ...elements(node.props.children), ...elements(node.props.description)];
}
const row = { id: 17, version: 4, title: "合成待办", assigneeId: 42, assigneeName: "同名" } as WorkItemRow;
let props: Parameters<typeof TodoAssignDrawer>[0];
function render() { h.cursor = 0; const tree = TodoAssignDrawer(props); h.effects.splice(0).forEach(fn => fn()); return tree; }
function select(value: unknown) { elements(render()).find(e => e.type === TodoAssigneeSelect)!.props.onChange!(value, { label: `#${value} 同名 · 生产计划` }); }
function confirm() { return elements(render()).find(e => e.type === "button" && e.props.children === "确认改派")!.props; }
beforeEach(() => { vi.stubGlobal("React", React); h.cursor = 0; h.slots = []; h.effects = [];
  props = { row, busy: false, onClose: vi.fn(), onConfirm: vi.fn(), onRecover: vi.fn() }; });
afterEach(() => vi.unstubAllGlobals());

describe("shared assignee picker and explicit reassignment", () => {
  it("labels same names with stable IDs and roles, retaining readable unknown roles", () => {
    expect(todoAssigneeLabel({ id: 42, name: "同名", roles: ["pmc"] })).toBe("#42 同名 · 生产计划");
    expect(todoAssigneeLabel({ id: 43, name: "同名", roles: ["custom"] })).toBe("#43 同名 · custom");
    const picker = TodoAssigneeSelect({ excludeId: 42 });
    expect(picker.props).toMatchObject({ api: "/api/todo/assignees?excludeId=42", showSearch: true, virtual: false, listHeight: 240 });
  });
  it.each([undefined, 42, "43", 0, -1, 1.1, 2147483648])("never submits invalid/current candidate %s", value => {
    select(value); expect(confirm().disabled).toBe(true); confirm().onClick!(); expect(props.onConfirm).not.toHaveBeenCalled();
  });
  it("selection alone does not write; explicit confirmation passes the exact selected ID", () => {
    select(43); expect(props.onConfirm).not.toHaveBeenCalled(); expect(confirm().disabled).toBe(false);
    confirm().onClick!(); expect(props.onConfirm).toHaveBeenCalledExactlyOnceWith(43);
    expect(render().props.width).toBe("min(480px, 100vw)");
  });
  it("busy and uncertain results block a new assignment; errors are brought into view", () => {
    select(43); const focus = vi.fn(), scrollIntoView = vi.fn();
    elements(render()).find(e => e.props.tabIndex === -1)!.props.ref!.current = { focus, scrollIntoView };
    props = { ...props, busy: true }; expect(render().props).toMatchObject({ closable: false, maskClosable: false, keyboard: false });
    confirm().onClick!(); expect(props.onConfirm).not.toHaveBeenCalled();
    props = { ...props, busy: false, recoverable: true, error: "原操作待核对" };
    expect(confirm().disabled).toBe(true); expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "start" });
    elements(render()).find(e => e.props.children === "核对原改派结果")!.props.onClick!(); expect(props.onRecover).toHaveBeenCalledOnce();
  });
});
