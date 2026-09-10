import React, { isValidElement, type ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import CrudTable from "@/components/CrudTable";

const hooks = vi.hoisted(() => ({ cursor: 0, slots: [] as unknown[], effects: [] as (() => void)[], cleanups: new Map<number, () => void>(), changed: false,
  form: { resetFields: vi.fn(), setFieldsValue: vi.fn() }, message: { error: vi.fn(), success: vi.fn() } }));
vi.mock("antd", () => ({ App: { useApp: () => ({ message: hooks.message }) }, Button: "button", Form: Object.assign("form", { useForm: () => [hooks.form] }), Modal: "modal", Space: "space", Table: "table" }));
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
function render() { for (let i = 0; i < 10; i++) { hooks.cursor = 0; hooks.changed = false;
  const tree = CrudTable({ entityName: "SKU", apiPath: "/api/master/sku", columns: [], formItems: () => null, loadDetailOnEdit: detailMode });
  for (const effect of hooks.effects.splice(0)) effect(); if (!hooks.changed) return tree;
} throw new Error("render did not settle"); }
const props = (type: string) => nodes(render()).find(n => n.type === type)!.props;
const search = (q: string) => { (props("search").onSearch as (v: string) => void)(q); render(); };
const rows = () => props("table").dataSource;
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); render(); };
beforeEach(() => { hooks.cursor = 0; hooks.slots = []; hooks.effects = []; hooks.changed = false; detailMode = false; vi.clearAllMocks(); fetchMock.mockReset(); vi.useFakeTimers(); vi.stubGlobal("React", React); vi.stubGlobal("fetch", fetchMock); });
afterEach(() => { for (const cleanup of hooks.cleanups.values()) cleanup(); hooks.cleanups.clear(); vi.useRealTimers(); vi.unstubAllGlobals(); });

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
