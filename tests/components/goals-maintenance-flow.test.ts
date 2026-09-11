import React, { isValidElement, type ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import GoalsClient from "@/app/(app)/goals/goals-client";

// Exercise real page callbacks and useDocumentRead. Browser evidence remains separate.
const hooks = vi.hoisted(() => ({ cursor: 0, slots: [] as unknown[], effects: [] as (() => void)[], cleanups: new Map<number, () => void>(), changed: false }));
const ui = vi.hoisted(() => ({ wide: true, filters: { period: "2026-09", dept: "purchasing" }, message: { success: vi.fn(), error: vi.fn(), info: vi.fn() }, form: { validateFields: vi.fn(), resetFields: vi.fn(), setFieldsValue: vi.fn(), setFieldValue: vi.fn() } }));
vi.mock("@/components/useListState", () => ({ useListState: () => ({ filters: ui.filters, tableSize: "small", setFilter: (v: object) => { ui.filters = { ...ui.filters, ...v }; } }) }));
vi.mock("@/components/ListToolbar", () => ({ default: "toolbar" }));
vi.mock("@/components/LoadErrorAlert", () => ({ default: "load-error" }));
vi.mock("@/components/CaliberNote", () => ({ default: "caliber" }));
vi.mock("@/app/(app)/goals/GoalProgressCard", () => ({ default: "summary" }));
vi.mock("antd", () => ({
  Alert: "alert", App: { useApp: () => ({ message: ui.message }) }, Grid: { useBreakpoint: () => ({ md: ui.wide }) }, Button: "button", Col: "col", DatePicker: "date-picker", Drawer: "drawer",
  Form: Object.assign("form", { useForm: () => [ui.form], Item: "form-item" }), InputNumber: "number", Input: { TextArea: "textarea" },
  Popconfirm: "confirm", Row: "row", Segmented: "segmented", Select: "select", Space: "space", Table: "table", Tabs: "tabs", Tag: "tag", Tooltip: "tooltip", Typography: { Title: "h4", Text: "text", Paragraph: "p" },
}));
vi.mock("react", async original => ({
  ...await original<typeof import("react")>(),
  useRef: <T,>(initial: T) => { const i = hooks.cursor++; if (!(i in hooks.slots)) hooks.slots[i] = { current: initial }; return hooks.slots[i]; },
  useState: <T,>(initial: T | (() => T)) => {
    const i = hooks.cursor++;
    if (!(i in hooks.slots)) hooks.slots[i] = typeof initial === "function" ? (initial as () => T)() : initial;
    return [hooks.slots[i], (update: T | ((old: T) => T)) => { const next = typeof update === "function" ? (update as (old: T) => T)(hooks.slots[i] as T) : update; if (!Object.is(next, hooks.slots[i])) hooks.changed = true; hooks.slots[i] = next; }];
  },
  useMemo: (compute: () => unknown) => compute(), useCallback: (fn: unknown) => fn,
  useEffect: (effect: () => void | (() => void), deps: readonly unknown[]) => {
    const i = hooks.cursor++, prev = hooks.slots[i] as readonly unknown[] | undefined;
    if (prev?.length === deps.length && prev.every((v, j) => Object.is(v, deps[j]))) return;
    hooks.slots[i] = deps; hooks.effects.push(() => { hooks.cleanups.get(i)?.(); hooks.cleanups.delete(i); const cleanup = effect(); if (cleanup) hooks.cleanups.set(i, cleanup); });
  },
}));
type Node = React.ReactElement<Record<string, unknown> & { children?: ReactNode }>;
const nodes = (v: ReactNode): Node[] => Array.isArray(v) ? v.flatMap(nodes) : isValidElement<Node["props"]>(v) ? [v, ...nodes(v.props.children)] : [];
const words = (v: ReactNode): string => typeof v === "string" || typeof v === "number" ? String(v) : Array.isArray(v) ? v.map(words).join(" ") : isValidElement<Node["props"]>(v) ? words(v.props.children) : "";
const fetchMock = vi.fn<typeof fetch>();
const data = (period = "2026-09", editable = true) => ({ rows: [{ id: 1, deptKey: "purchasing", period, metricKey: "onTimeRate", metricLabel: "准时率", unit: "pct", targetValue: "90", actualValue: "80", actualSource: "auto", autoStatus: "ok", direction: "up", attained: false, attainment: "88.9", note: null, editable, updatedAt: "2026-09-10" }], deptKeys: ["purchasing"], editableDepts: editable ? ["purchasing"] : [], autoMetrics: [{ metricKey: "onTimeRate", label: "准时率", defaultDirection: "up" }] });
function render(effects = true): Node {
  for (let n = 0; n < 10; n++) {
    hooks.cursor = 0; hooks.changed = false;
    const tree = GoalsClient() as Node;
    if (!effects) return tree;
    for (const effect of hooks.effects.splice(0)) effect();
    if (!hooks.changed) return tree;
  }
  throw Error("Read did not settle");
}
const flush = async () => { render(); for (let i = 0; i < 25; i++) await Promise.resolve(); return render(); };
const find = (type: string, tree = render()) => nodes(tree).find(n => n.type === type)!;
const button = (label: string) => nodes(render()).find(n => n.type === "button" && words(n.props.children) === label)!;
const confirm = () => {
  const popup = nodes(render()).find(n => n.type === "confirm");
  return popup ? (popup.props.onConfirm as () => Promise<void>)() : (button("回填自动实际值").props.onClick as () => Promise<void>)();
};
const requests = (method: string) => fetchMock.mock.calls.filter(([, init]) => (init?.method ?? "GET") === method);
const cleanup = () => { for (const fn of hooks.cleanups.values()) fn(); hooks.cleanups.clear(); };
beforeEach(() => {
  cleanup(); hooks.slots = []; hooks.effects = []; hooks.changed = false; ui.wide = true; ui.filters = { period: "2026-09", dept: "purchasing" };
  ui.message.error.mockReset(); ui.message.success.mockReset(); ui.form.validateFields.mockReset(); ui.form.setFieldsValue.mockReset(); fetchMock.mockReset();
  vi.useFakeTimers(); vi.stubGlobal("React", React); vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it("期间切换立即撤旧行、导出与编辑入口，不等副作用", async () => {
  fetchMock.mockResolvedValueOnce(Response.json(data())); await flush();
  expect(find("table").props.dataSource).toHaveLength(1);
  ui.filters.period = "2026-08";
  const tree = render(false);
  expect(find("table", tree).props.dataSource).toEqual([]);
  expect(find("toolbar", tree).props.onExport).toBeUndefined();
});
it("过期期间的迟到成功不能覆盖当前期间", async () => {
  const late = Promise.withResolvers<Response>(); fetchMock.mockReturnValueOnce(late.promise); render();
  ui.filters.period = "2026-08"; fetchMock.mockResolvedValueOnce(Response.json(data("2026-08"))); await flush();
  late.resolve(Response.json(data("2026-09"))); await flush();
  expect(find("table").props.dataSource).toMatchObject([{ period: "2026-08" }]);
});
it("回填明确期间且同步防双击，成功后的读取失败只重读，不重复写", async () => {
  fetchMock.mockResolvedValueOnce(Response.json(data())); await flush();
  const pending = Promise.withResolvers<Response>(); fetchMock.mockReturnValueOnce(pending.promise);
  const first = confirm(); const second = confirm();
  expect(requests("POST")).toHaveLength(1);
  expect(JSON.parse(requests("POST")[0][1]!.body as string)).toEqual({ period: "2026-09" });
  fetchMock.mockResolvedValueOnce(Response.json({ error: "回填后读取失败" }, { status: 503 }));
  pending.resolve(Response.json({ scanned: 2, updated: 1, unavailable: 1 })); await first; await second; await flush();
  expect(find("alert").props.message).toContain("回填已完成");
  expect(find("load-error").props.error).toContain("回填后读取失败");
  expect(find("table").props.dataSource).toEqual([]);
  fetchMock.mockResolvedValueOnce(Response.json(data())); (find("load-error").props.onRetry as () => void)(); await flush();
  expect(requests("POST")).toHaveLength(1); expect(find("table").props.dataSource).toHaveLength(1);
});
it("全部期间须在确认说明中明确，不把当前部门页签伪装成写权限范围", async () => {
  ui.filters.period = ""; fetchMock.mockResolvedValueOnce(Response.json(data())); await flush();
  const popup = find("confirm");
  expect(words(popup.props.description as ReactNode)).toContain("全部期间");
  expect(words(popup.props.description as ReactNode)).toContain("所有可编辑部门");
});
it("无可编辑部门时不能回填", async () => {
  fetchMock.mockResolvedValueOnce(Response.json(data("2026-09", false))); await flush();
  expect(button("回填自动实际值").props.disabled).toBe(true);
});
it("读取超时撤旧，重新读取不会发写请求", async () => {
  fetchMock.mockReturnValueOnce(new Promise(() => {})); render(); await vi.advanceTimersByTimeAsync(15000);
  expect(find("load-error").props.error).toContain("超时");
  expect(find("table").props.dataSource).toEqual([]); expect(requests("POST")).toHaveLength(0);
});
it("保存同步防双击，表单校验失败不提交且可继续修正", async () => {
  fetchMock.mockResolvedValueOnce(Response.json(data())); await flush();
  (button("设置目标").props.onClick as () => void)(); render();
  const save = () => ((find("drawer").props.extra as Node).props.onClick as () => Promise<void>)();
  const validation = Promise.withResolvers<Record<string, unknown>>(); ui.form.validateFields.mockReturnValueOnce(validation.promise);
  const first = save(); const second = save();
  expect(ui.form.validateFields).toHaveBeenCalledTimes(1);
  validation.reject({ errorFields: [{ name: ["targetValue"], errors: ["必填"] }] });
  await first; await second;
  expect(requests("POST")).toHaveLength(0); expect(ui.message.error).not.toHaveBeenCalled();
  expect(find("drawer").props.open).toBe(true);
  expect((find("drawer").props.extra as Node).props.loading).toBe(false);
});
it("回填回包丢失保留核对提示并撤旧，不自动再次提交", async () => {
  fetchMock.mockResolvedValueOnce(Response.json(data())); await flush();
  fetchMock.mockRejectedValueOnce(new Error("connection lost"));
  fetchMock.mockResolvedValueOnce(Response.json(data())); await confirm(); await flush();
  expect(find("alert").props.type).toBe("warning");
  expect(find("alert").props.message).toContain("勿直接再次回填");
  expect(requests("POST")).toHaveLength(1);
});

type Column = { key?: string; title?: string; dataIndex?: string; fixed?: string; width?: number; render?: (v: unknown, r: unknown) => ReactNode };
it("手机将期间、指标与编辑放在同一固定身份列，不让操作列遮挡指标", async () => {
  ui.wide = false; fetchMock.mockResolvedValueOnce(Response.json(data())); await flush();
  const columns = find("table").props.columns as Column[];
  expect(columns.some(c => c.fixed === "right")).toBe(false);
  expect(columns[0].dataIndex).toBe("metricLabel");
  expect(columns[0].width).toBeLessThanOrEqual(170);
  const cell = columns[0].render!("准时率", data().rows[0]);
  expect(words(cell)).toContain("2026-09"); expect(words(cell)).toContain("准时率");
  expect(nodes(cell).some(n => n.type === "button")).toBe(true);
});
it("新建目标继承当前期间，不要求重新选择", async () => {
  fetchMock.mockResolvedValueOnce(Response.json(data())); await flush();
  (button("设置目标").props.onClick as () => void)();
  const values = ui.form.setFieldsValue.mock.calls.at(-1)![0];
  expect(values.periodKind).toBe("month"); expect(values.periodDate?.format("YYYY-MM")).toBe("2026-09");
});
it("编辑携带所见版本，只提交变化字段，清空备注发送null", async () => {
  const payload = data(); payload.rows[0].note = "旧备注" as never;
  fetchMock.mockResolvedValueOnce(Response.json(payload)); await flush();
  const columns = find("table").props.columns as Column[];
  const edit = nodes(columns.find(c => c.key === "ops")!.render!(null, payload.rows[0])).find(n => n.type === "button")!;
  (edit.props.onClick as () => void)(); render();
  ui.form.validateFields.mockResolvedValueOnce({ targetValue: "95", direction: "up", note: "", actualValue: undefined, evidence: "" });
  fetchMock.mockResolvedValueOnce(Response.json(payload.rows[0])); fetchMock.mockResolvedValueOnce(Response.json(payload));
  await ((find("drawer").props.extra as Node).props.onClick as () => Promise<void>)(); await flush();
  const sent = JSON.parse(requests("PATCH")[0][1]!.body as string);
  expect(sent).toEqual({ targetValue: "95", note: null, expectedUpdatedAt: payload.rows[0].updatedAt });
});
