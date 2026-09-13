import React, { isValidElement, type ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import CrudTable, { type CrudTableProps } from "@/components/CrudTable";
import { WarehousePanoramaDrawer } from "@/app/(app)/master/warehouse/warehouse-client";

const hooks = vi.hoisted(() => ({ md: true, cursor: 0, slots: [] as unknown[], effects: [] as (() => void)[], cleanups: new Map<number, () => void>(), changed: false,
  form: { resetFields: vi.fn(), setFieldsValue: vi.fn() }, message: { error: vi.fn(), success: vi.fn() } }));
vi.mock("antd", () => ({ App: { useApp: () => ({ message: hooks.message }) }, Button: "button", Form: Object.assign("form", { useForm: () => [hooks.form] }), Modal: "modal", Space: "space", Table: "table",
  Grid: { useBreakpoint: () => ({ md: hooks.md }) }, Popover: "popover",
  Drawer: "drawer", Descriptions: Object.assign("descriptions", { Item: "description-item" }), Skeleton: "skeleton", Tag: "tag", Typography: { Text: "text" } }));
vi.mock("@/components/ListToolbar", () => ({ default: "list-toolbar" }));
vi.mock("@/components/SearchInput", () => ({ default: "search" }));
vi.mock("@/components/LoadErrorAlert", () => ({ default: "read-error" }));
vi.mock("@ant-design/icons", () => ({ PlusOutlined: "plus", ReloadOutlined: "reload" }));
vi.mock("react", async original => {
  function memo(fn: () => unknown, deps: readonly unknown[]) {
    const i = hooks.cursor++; const prev = hooks.slots[i] as { value: unknown; deps: readonly unknown[] } | undefined;
    if (!prev || prev.deps.length !== deps.length || !prev.deps.every((v, j) => Object.is(v, deps[j]))) hooks.slots[i] = { value: fn(), deps };
    return (hooks.slots[i] as { value: unknown }).value;
  }
  return { ...await original<typeof import("react")>(),
    useState: <T,>(initial: T | (() => T)) => { const i = hooks.cursor++; if (!(i in hooks.slots)) hooks.slots[i] = typeof initial === "function" ? (initial as () => T)() : initial;
      return [hooks.slots[i], (update: T | ((old: T) => T)) => { const value = typeof update === "function" ? (update as (old: T) => T)(hooks.slots[i] as T) : update; if (!Object.is(value, hooks.slots[i])) hooks.changed = true; hooks.slots[i] = value; }]; },
    useCallback: (fn: unknown, deps: readonly unknown[]) => memo(() => fn, deps), useMemo: memo,
    useRef: (initial: unknown) => { const i = hooks.cursor++; if (!(i in hooks.slots)) hooks.slots[i] = { current: initial }; return hooks.slots[i]; },
    useEffect: (fn: () => void | (() => void), deps: readonly unknown[]) => { const i = hooks.cursor++; const prev = hooks.slots[i] as readonly unknown[] | undefined;
      if (prev?.length === deps.length && prev.every((v, j) => Object.is(v, deps[j]))) return; hooks.slots[i] = deps;
      hooks.effects.push(() => { hooks.cleanups.get(i)?.(); const cleanup = fn(); if (cleanup) hooks.cleanups.set(i, cleanup); else hooks.cleanups.delete(i); }); },
  };
});
type Node = React.ReactElement<Record<string, unknown> & { children?: ReactNode }>;
const nodes = (v: ReactNode): Node[] => Array.isArray(v) ? v.flatMap(nodes) : isValidElement<Node["props"]>(v) ? [v, ...nodes(v.props.children)] : [];
const fetchMock = vi.fn<typeof fetch>();
let detailMode = false;
let panelMode = false;
let panelId: number | null = 1;
let extraProps: Partial<CrudTableProps<{ id: number }>> = {};
function render() { for (let i = 0; i < 10; i++) { hooks.cursor = 0; hooks.changed = false;
  const tree = panelMode ? WarehousePanoramaDrawer({ id: panelId, onClose: () => {} }) : CrudTable({ entityName: "SKU", apiPath: "/api/master/sku", columns: [], formItems: () => null, loadDetailOnEdit: detailMode, ...extraProps });
  for (const effect of hooks.effects.splice(0)) effect(); if (!hooks.changed) return tree;
} throw new Error("render did not settle"); }
const props = (type: string) => nodes(render()).find(n => n.type === type)!.props;
const search = (q: string) => { (props("search").onSearch as (v: string) => void)(q); render(); };
const rows = () => props("table").dataSource;
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); render(); };
beforeEach(() => { hooks.md = true; extraProps = {}; hooks.cursor = 0; hooks.slots = []; hooks.effects = []; hooks.changed = false; detailMode = false; panelMode = false; panelId = 1; vi.clearAllMocks(); fetchMock.mockReset(); vi.useFakeTimers(); vi.stubGlobal("React", React); vi.stubGlobal("fetch", fetchMock); });
afterEach(() => { for (const cleanup of hooks.cleanups.values()) cleanup(); hooks.cleanups.clear(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it("bounds the search control to its toolbar instead of overflowing a narrow padded surface", () => {
  fetchMock.mockReturnValue(new Promise(() => {}));
  expect(props("search").style).toMatchObject({ maxWidth: "100%", minWidth: 0 });
});

it("keeps long shared edit forms inside the viewport with a separately scrolling body", () => {
  fetchMock.mockReturnValue(new Promise(() => {}));
  extraProps = { modalWidth: 900 };
  const modal = props("modal");
  expect(modal.width).toBe(900);
  expect(modal.centered).toBe(true);
  expect(modal.style).toMatchObject({ maxWidth: "calc(100vw - 32px)", paddingBottom: 0 });
  expect(modal.styles).toMatchObject({
    content: { maxHeight: "calc(100dvh - 32px)", display: "flex", flexDirection: "column" },
    body: { minHeight: 0, overflowY: "auto", overscrollBehavior: "contain" },
    header: { flexShrink: 0, paddingInlineEnd: 32, overflowWrap: "anywhere" },
    footer: { flexShrink: 0 },
  });
});

it("does not reserve an empty fixed action column for a read-only role", async () => {
  extraProps = { canEdit: () => false, columns: [{ title: "编码", dataIndex: "id" }] };
  fetchMock.mockResolvedValue(Response.json({ data: [{ id: 1 }], total: 1 })); render(); await flush();
  expect(props("table").columns).toEqual(extraProps.columns);
});
it("limits narrow-screen actions and restores wrapped desktop actions without changing rows", async () => {
  extraProps = { rowActions: () => React.createElement("button", null, "360") };
  fetchMock.mockResolvedValue(Response.json({ data: [{ id: 1 }], total: 1 })); render(); await flush();
  hooks.md = false;
  const narrow = props("table").columns as { width: number; render: (_: unknown, row: { id: number }) => ReactNode }[];
  expect(narrow.at(-1)!.width).toBe(76);
  expect(typeof nodes(narrow.at(-1)!.render(undefined, { id: 1 }))[0].type).toBe("function");
  hooks.md = true;
  const wide = props("table").columns as typeof narrow;
  expect(wide.at(-1)!.width).toBe(220);
  expect(nodes(wide.at(-1)!.render(undefined, { id: 1 }))[0].props.style).toMatchObject({ flexWrap: "wrap" });
  expect(rows()).toEqual([{ id: 1 }]);
});

it("cancels an old list request and refuses its late success", async () => {
  const old = Promise.withResolvers<Response>(); fetchMock.mockReturnValueOnce(old.promise).mockResolvedValueOnce(Response.json({ data: [{ id: 2 }], total: 1 }));
  render(); search("NEW"); await flush(); expect(rows()).toEqual([{ id: 2 }]);
  expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
  old.resolve(Response.json({ data: [{ id: 1 }], total: 1 })); await flush(); expect(rows()).toEqual([{ id: 2 }]);
});
it("withdraws previous facts while the next query is loading, and exposes persistent failure with retry", async () => {
  fetchMock.mockResolvedValueOnce(Response.json({ data: [{ id: 1 }], total: 1 })).mockRejectedValueOnce(new Error("offline"));
  render(); await flush(); search("FAIL"); expect(rows()).toEqual([]); await flush();
  expect(props("read-error").error).toBeTruthy(); expect(props("table").pagination).toBe(false);
  fetchMock.mockResolvedValueOnce(Response.json({ data: [{ id: 3 }], total: 1 })); (props("read-error").onRetry as () => void)(); render(); await flush(); expect(rows()).toEqual([{ id: 3 }]);
});
it("does not pass malformed list payloads into AntD or invent a zero-count success", async () => {
  fetchMock.mockResolvedValueOnce(Response.json({ data: "bad", total: 0 })); render(); await flush();
  expect(rows()).toEqual([]); expect(props("read-error").error).toBeTruthy(); expect(props("table").pagination).toBe(false);
});
it("a late detail response cannot overwrite the next record's edit form", async () => {
  detailMode = true;
  const old = Promise.withResolvers<Response>();
  fetchMock.mockResolvedValueOnce(Response.json({ data: [{ id: 1 }, { id: 2 }], total: 2 }))
    .mockReturnValueOnce(old.promise)
    .mockResolvedValueOnce(Response.json({ id: 2, name: "NEW", bankAccount: "synthetic-new" }));
  render(); await flush();
  const columns = props("table").columns as { render?: (_: unknown, row: { id: number }) => ReactNode }[];
  const edit = (id: number) => {
    const action = nodes(columns.at(-1)!.render!(undefined, { id })).find(n => n.type === "button")!;
    return (action.props.onClick as () => Promise<void>)();
  };
  const pending = edit(1);
  await edit(2); await flush();
  expect(fetchMock.mock.calls[1][1]?.signal?.aborted).toBe(true);
  expect(hooks.form.setFieldsValue).toHaveBeenCalledExactlyOnceWith({ id: 2, name: "NEW", bankAccount: "synthetic-new" });
  old.resolve(Response.json({ id: 1, name: "OLD", bankAccount: "synthetic-old" }));
  await pending; await flush();
  expect(hooks.form.setFieldsValue).toHaveBeenCalledOnce();
  expect(hooks.message.error).not.toHaveBeenCalled();
});

const panorama = (id: number) => ({ warehouse: { id, code: `WH-${id}`, name: "合成仓", accountingMode: "realtime", kind: "finished", regionCode: "CN" }, totals: { total: "0", skuCount: 0 }, topStock: [], recentLedger: [], batches: [], snapDates: [] });
it("warehouse panorama withdraws the previous identity, refuses late success and aborts on close", async () => {
  panelMode = true;
  const old = Promise.withResolvers<Response>();
  fetchMock.mockReturnValueOnce(old.promise).mockResolvedValueOnce(Response.json(panorama(2)));
  render(); panelId = 2; render(); await flush();
  expect(props("drawer").title).toBe("仓库 360 — WH-2 合成仓");
  old.resolve(Response.json(panorama(1))); await flush();
  expect(props("drawer").title).toBe("仓库 360 — WH-2 合成仓");
  panelId = null; render(); expect(props("drawer").title).toBe("仓库 360"); expect(props("drawer").open).toBe(false);
  expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
});
it("warehouse failure is not an endless skeleton; retry reads the same warehouse", async () => {
  panelMode = true;
  fetchMock.mockRejectedValueOnce(new Error("offline")); render(); await flush();
  expect(props("read-error").error).toBe("网络连接异常，未能获取服务器响应"); expect(nodes(render()).some(n => n.type === "skeleton")).toBe(false);
  fetchMock.mockResolvedValueOnce(Response.json(panorama(1))); (props("read-error").onRetry as () => void)(); render(); await flush();
  expect(props("read-error").error).toBeNull(); expect(props("drawer").title).toBe("仓库 360 — WH-1 合成仓");
  expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["/api/master/warehouse/1/panorama", "/api/master/warehouse/1/panorama"]);
});
it("warehouse timeout and malformed or mismatched identity are explicit errors, not empty stock", async () => {
  panelMode = true; fetchMock.mockReturnValueOnce(new Promise(() => {})); render();
  await vi.advanceTimersByTimeAsync(15_000); await flush(); expect(props("read-error").error).toContain("超时");
  fetchMock.mockResolvedValueOnce(Response.json(panorama(9))); (props("read-error").onRetry as () => void)(); render(); await flush();
  expect(props("read-error").error).toContain("不一致"); expect(props("drawer").title).toBe("仓库 360");
});
it("shared edit detail timeout unlocks editing and rejects a late response", async () => {
  detailMode = true;
  const held = Promise.withResolvers<Response>();
  fetchMock.mockResolvedValueOnce(Response.json({ data: [{ id: 1 }], total: 1 })).mockReturnValueOnce(held.promise);
  render(); await flush();
  const columns = props("table").columns as { render?: (_: unknown, row: { id: number }) => ReactNode }[];
  const action = nodes(columns.at(-1)!.render!(undefined, { id: 1 })).find(n => n.type === "button")!;
  const pending = (action.props.onClick as () => Promise<void>)();
  await vi.advanceTimersByTimeAsync(15_000); await flush();
  expect(hooks.message.error).toHaveBeenCalledWith("读取详情超时，请重新点击编辑");
  held.resolve(Response.json({ id: 1, name: "late" })); await pending; await flush();
  expect(hooks.form.setFieldsValue).not.toHaveBeenCalled();
});
