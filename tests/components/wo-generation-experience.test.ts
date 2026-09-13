import React, { isValidElement, type ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import WoClient, { WoActions } from "@/app/(app)/outsource/wo/wo-client";
import type { WoTaskActions } from "@/server/modules/outsource/wo-task-actions";

// Lifecycle/callback proof, not AntD rendering. Layout is checked in the isolated browser.
const h = vi.hoisted(() => ({ cursor: 0, slots: [] as unknown[], effects: [] as (() => void)[], cleanups: new Map<number, () => void>(), changed: false, id: 18, permitted: true,
  formIndex: 0, values: {} as Record<string, unknown>, setField: vi.fn(), validate: vi.fn(), post: vi.fn(), retry: vi.fn(), success: vi.fn(), error: vi.fn(), destroy: vi.fn(),
  generated: { phase: "success", data: { rows: [] as { docNo: string }[] } },
}));
vi.mock("antd", () => ({ App: { useApp: () => ({ message: { error: h.error, success: vi.fn() }, modal: { success: h.success } }) },
  Alert: "alert", Button: "button", Modal: "modal", Space: "space", Table: "table", Tabs: "tabs", Tag: "tag", Tooltip: "tooltip", Divider: "divider", Popconfirm: "popconfirm", Select: "select", DatePicker: "date", InputNumber: "number",
  Input: Object.assign("input", { TextArea: "textarea" }), Descriptions: Object.assign("descriptions", { Item: "description" }), Typography: { Title: "title", Paragraph: "paragraph", Text: "text", Link: "link" },
  Form: Object.assign(() => null, { Item: "form-item", List: "form-list", useForm: () => [{ resetFields: vi.fn(), setFieldValue: h.setField, setFieldsValue: (v: Record<string, unknown>) => { h.values = v; }, validateFields: h.validate }] }),
}));
vi.mock("next/link", () => ({ default: "a" }));
vi.mock("@/components/useMe", () => ({ useMe: () => ({}), hasAnyRole: () => h.permitted }));
vi.mock("@/components/DocumentDrawer", () => ({ default: "drawer" }));
vi.mock("@/components/ListToolbar", () => ({ default: "toolbar" }));
vi.mock("@/components/SearchInput", () => ({ default: "search" }));
vi.mock("@/components/RemoteSelect", () => ({ default: "remote" }));
vi.mock("@/components/ChainStrip", () => ({ default: "chain" }));
vi.mock("@/components/DocStatusTag", () => ({ default: "status" }));
vi.mock("@/components/DocTransitionActions", () => ({ default: "transitions" }));
vi.mock("@/components/DocWindowFilterTag", () => ({ default: "window" }));
vi.mock("@/components/ApprovalTimeline", () => ({ default: "approvals" }));
vi.mock("@/app/(app)/outsource/wo/sourcing-aid-panel", () => ({ default: "sourcing" }));
vi.mock("@/components/fetchJson", () => ({ fetchJson: async () => ({ rows: [], total: 0 }), postJson: h.post }));
vi.mock("@/components/useLatestRead", () => ({ useLatestRead: () => () => ({ signal: undefined, isCurrent: () => true }) }));
vi.mock("@/components/useDocumentTarget", () => ({ useDocumentTarget: () => ({ id: h.id, present: true, setId: (id: number) => { h.id = id; } }) }));
vi.mock("@/components/useDocumentRead", () => ({ useDocumentRead: (url: string) => url?.includes("/jg?") ? { ...h.generated, retry: h.retry } : ({ phase: "success", retry: h.retry, data: {
  id: h.id, docNo: `WO-${h.id}`, status: "approved", qty: "100.0000", supplierId: 7, taskActions: { generate: h.permitted, reason: "核对后生成" }, approvals: [], lines: [{ id: 1, materialSkuId: 9, skuCode: "MAT9", skuName: "物料", suggestedQty: "0.0000", grossReq: "100.0000" }],
} }) }));
vi.mock("@/components/useListState", () => ({ useListState: () => ({ filters: { q: "", status: "", from: "", to: "" }, page: 1, pageSize: 20, tableSize: "small", paginationProps: () => ({}) }) }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(),
  useRef: (initial: unknown) => { const i = h.cursor++; if (!(i in h.slots)) h.slots[i] = { current: initial }; return h.slots[i]; },
  useState: <T,>(initial: T | (() => T)) => { const i = h.cursor++; if (!(i in h.slots)) h.slots[i] = typeof initial === "function" ? (initial as () => T)() : initial;
    return [h.slots[i], (update: T | ((old: T) => T)) => { const v = typeof update === "function" ? (update as (old: T) => T)(h.slots[i] as T) : update; if (!Object.is(v, h.slots[i])) h.changed = true; h.slots[i] = v; }]; },
  useCallback: (fn: unknown) => fn,
  useEffect: (fn: () => void | (() => void), deps: readonly unknown[]) => { const i = h.cursor++; const p = h.slots[i] as readonly unknown[] | undefined;
    // The list fetch is irrelevant here; run stable document/lifecycle effects only.
    if (deps.some(v => typeof v === "function")) return;
    if (p?.length === deps.length && p.every((v, j) => Object.is(v, deps[j]))) return; h.slots[i] = deps; h.effects.push(() => { h.cleanups.get(i)?.(); const cleanup = fn(); if (cleanup) h.cleanups.set(i, cleanup); }); },
}));
type Node = React.ReactElement<Record<string, unknown> & { children?: ReactNode }>;
const nodes = (v: ReactNode): Node[] => Array.isArray(v) ? v.flatMap(nodes) : isValidElement<Node["props"]>(v) ? [v, ...nodes(v.props.children)] : [];
function render(): ReactNode {
  for (let i = 0; i < 10; i++) {
    h.cursor = 0; h.changed = false;
    const outer = WoClient() as React.ReactElement<{ children: React.ReactElement }>;
    const tree = (outer.props.children.type as () => ReactNode)();
    for (const fn of h.effects.splice(0)) fn();
    if (!h.changed) return tree;
  }
  throw Error("render did not settle");
}
const drawer = () => nodes(render()).find(n => n.type === "drawer")!;
const generateButton = () => nodes(drawer().props.extra as ReactNode).find(n => n.props.children === "生成单据");
const dialog = () => nodes(render()).find(n => n.type === "modal" && String(n.props.title).startsWith("生成采购"))!;
const open = () => { (generateButton()!.props.onClick as () => void)(); render(); };
const submit = () => (dialog().props.onOk as () => void)();
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); render(); };
beforeEach(() => { h.slots = []; h.effects = []; h.id = 18; h.permitted = true; h.generated = { phase: "success", data: { rows: [] } }; h.post.mockReset(); h.validate.mockReset().mockImplementation(async () => h.values); h.success.mockReset().mockReturnValue({ destroy: h.destroy }); h.destroy.mockClear(); h.error.mockClear(); h.retry.mockClear(); vi.stubGlobal("React", React); });
afterEach(() => { for (const fn of h.cleanups.values()) fn(); h.cleanups.clear(); vi.unstubAllGlobals(); });

it("role and existing-generation checks gate the button; zero suggestion opens without PO", () => {
  h.permitted = false; expect(generateButton()).toBeUndefined(); h.permitted = true;
  h.generated.phase = "loading"; expect(generateButton()).toBeUndefined(); h.generated.phase = "success";
  h.generated.data.rows = [{ docNo: "JG-1" }]; expect(generateButton()).toBeUndefined(); h.generated.data.rows = [];
  open(); expect(h.values.poGroups).toEqual([]); expect(h.values.jgQty).toBe("100.0000");
  expect(dialog().props.zIndex).toBe(1100); // sibling drawer defaults to 1000, so portal creation order cannot cover the form
});
it("BH source uses bounded shared remote selection and clears stale manual type for authoritative inheritance", () => {
  const source = nodes(render()).find(n => n.type === "remote" && n.props.api === "/api/outsource/bh?status=approved")!;
  expect(source).toBeDefined();
  expect((source.props.getLabel as (r: Record<string, unknown>) => string)({ docNo: "BH-001", orderType: null })).toBe("BH-001");
  (source.props.onChange as () => void)();
  expect(h.setField).toHaveBeenLastCalledWith("orderType", undefined);
});
it("same-tick double submit is blocked before asynchronous form validation", async () => {
  open(); const validation = Promise.withResolvers<Record<string, unknown>>(), write = Promise.withResolvers<unknown>(); h.validate.mockReturnValue(validation.promise); h.post.mockReturnValue(write.promise);
  submit(); submit(); expect(h.validate).toHaveBeenCalledTimes(1); expect(dialog().props.closable).toBe(false);
  (drawer().props.onClose as () => void)(); expect(h.id).toBe(18);
  validation.resolve(h.values); await flush(); expect(h.post).toHaveBeenCalledTimes(1);
  write.resolve({ pos: [{ id: 41, docNo: "PO-41" }], jg: { id: 42, docNo: "JG-42" } }); await flush();
  expect(h.success.mock.calls[0][0].title).toContain("尚未提交审批");
  expect(h.success.mock.calls[0][0].zIndex).toBe(1200);
  expect(nodes(h.success.mock.calls[0][0].content).filter(n => n.type === "a").map(n => n.props.href)).toEqual(["/outsource/po?docId=41", "/outsource/jg?docId=42"]);
  (nodes(h.success.mock.calls[0][0].content).find(n => n.type === "a")!.props.onClick as () => void)(); expect(h.destroy).toHaveBeenCalledTimes(1);
});
it("switching source during validation never submits to the old or the new WO", async () => {
  open(); const validation = Promise.withResolvers<Record<string, unknown>>(); h.validate.mockReturnValue(validation.promise); submit(); h.id = 19; render(); validation.resolve(h.values); await flush(); expect(h.post).not.toHaveBeenCalled();
});
it("empty groups stay editable and cannot be silently discarded", async () => {
  open(); h.values.poGroups = [{ supplierId: 7, lines: [] }]; submit(); await flush(); expect(h.post).not.toHaveBeenCalled(); expect(h.error).toHaveBeenCalled(); expect(dialog().props.confirmLoading).toBe(false);
});
it.each(["network", "malformed"])("%s failure persists and refuses another write until source refresh", async mode => {
  open(); if (mode === "network") h.post.mockRejectedValue(Error("offline")); else h.post.mockResolvedValue({ pos: [], jg: {} });
  submit(); await flush(); expect(h.success).not.toHaveBeenCalled();
  const error = nodes(dialog()).find(n => n.type === "alert" && n.props.type === "error")!;
  expect(String(error.props.description)).toContain("WO-18"); expect(String(error.props.description)).toContain("勿重复提交");
  submit(); await flush(); expect(h.post).toHaveBeenCalledTimes(1);
  (nodes(error.props.action as ReactNode)[0].props.onClick as () => void)(); expect(h.retry).toHaveBeenCalledTimes(2); expect(dialog().props.open).toBe(false);
});
it("unmount during write cannot publish a receipt or refresh another screen", async () => {
  open(); const write = Promise.withResolvers<unknown>(); h.post.mockReturnValue(write.promise); submit(); await flush();
  for (const fn of h.cleanups.values()) fn(); h.cleanups.clear();
  write.resolve({ pos: [], jg: { id: 42, docNo: "JG-42" } }); await flush(); expect(h.success).not.toHaveBeenCalled(); expect(h.retry).not.toHaveBeenCalled();
});

const hints: WoTaskActions = { submit: false, approve: false, reject: false, withdraw: false, generate: false, manage: false, reason: "测试资格" };
function actions(taskActions: WoTaskActions | null, opts: { status?: string; blocked?: boolean; onError?: (s: string) => void; onChanged?: () => void } = {}) {
  h.cursor = 0;
  const tree = WoActions({ doc: { id: 18, version: 2, status: opts.status ?? "pending", taskActions }, blocked: opts.blocked ?? false, onError: opts.onError ?? h.error, onChanged: opts.onChanged ?? h.retry });
  for (const fn of h.effects.splice(0)) fn();
  return nodes(tree);
}
it("WO actions follow server hints: maker only withdraws, checker can independently reject, unknown/read-only shows no write", () => {
  expect(actions(null)).toEqual([]);
  expect(actions({ ...hints, withdraw: true }).filter(n => n.type === "button").map(n => n.props.children)).toEqual(["撤回"]);
  const checker = actions({ ...hints, reject: true });
  expect(checker.filter(n => n.type === "button").map(n => n.props.children)).toEqual(["驳回"]);
  expect(checker.find(n => n.type === "modal")?.props.zIndex).toBe(1100);
  expect(actions({ ...hints, submit: true }, { status: "draft", blocked: true })).toEqual([]);
  expect(actions({ ...hints }, { status: "approved" })).toEqual([]);
});
it("WO action guards same-tick repeated confirms and keeps unconfirmed results blocked pending GET", async () => {
  const wait = Promise.withResolvers<unknown>(); h.post.mockReturnValue(wait.promise);
  const confirm = actions({ ...hints, submit: true }, { status: "draft" }).find(n => n.type === "popconfirm")!.props.onConfirm as () => void;
  confirm(); confirm(); expect(h.post).toHaveBeenCalledTimes(1);
  wait.reject(Error("connection interrupted")); for (let i = 0; i < 15; i++) await Promise.resolve();
  expect(h.error).toHaveBeenCalledWith(expect.stringContaining("先刷新核对"));
  confirm(); expect(h.post).toHaveBeenCalledTimes(1); expect(h.retry).not.toHaveBeenCalled();
});
it("WO action completion after unmount cannot refresh or report against another document", async () => {
  const wait = Promise.withResolvers<unknown>(); h.post.mockReturnValue(wait.promise);
  const confirm = actions({ ...hints, withdraw: true }).find(n => n.type === "popconfirm")!.props.onConfirm as () => void;
  confirm(); for (const fn of h.cleanups.values()) fn(); h.cleanups.clear();
  wait.resolve({ status: "draft" }); for (let i = 0; i < 15; i++) await Promise.resolve();
  expect(h.retry).not.toHaveBeenCalled(); expect(h.error).not.toHaveBeenCalled();
});
