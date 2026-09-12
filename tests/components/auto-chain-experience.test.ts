import React, { isValidElement, type ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import AutoChainClient from "@/app/(app)/outsource/auto-chain/auto-chain-client";

// Callback/lifecycle proof only; real AntD layout and keyboard proof lives in the candidate browser receipt.
const h = vi.hoisted(() => ({ cursor: 0, slots: [] as unknown[], effects: [] as (() => void)[], cleanups: new Map<number, () => void>(), changed: false, q: "" }));
vi.mock("antd", () => ({ Alert: "alert", Tag: "tag", Button: "button", Modal: "modal", Space: "space", Table: "table", Card: "card", Typography: { Title: "title", Paragraph: "paragraph", Text: "text" } }));
vi.mock("next/link", () => ({ default: "a" }));
vi.mock("@/components/ListToolbar", () => ({ default: "toolbar" }));
vi.mock("@/components/SearchInput", () => ({ default: "search" }));
vi.mock("@/components/LoadErrorAlert", () => ({ default: "read-error" }));
vi.mock("@/components/useListState", () => ({ useListState: () => ({ filters: { q: h.q }, tableSize: "small", setFilter: (patch: { q: string }) => { h.q = patch.q; h.changed = true; } }) }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(),
  useRef: (initial: unknown) => { const i = h.cursor++; if (!(i in h.slots)) h.slots[i] = { current: initial }; return h.slots[i]; },
  useState: <T,>(initial: T | (() => T)) => { const i = h.cursor++; if (!(i in h.slots)) h.slots[i] = typeof initial === "function" ? (initial as () => T)() : initial;
    return [h.slots[i], (update: T | ((old: T) => T)) => { const v = typeof update === "function" ? (update as (old: T) => T)(h.slots[i] as T) : update; if (!Object.is(v, h.slots[i])) h.changed = true; h.slots[i] = v; }]; },
  useCallback: (fn: unknown, deps: readonly unknown[]) => { const i = h.cursor++; const p = h.slots[i] as { fn: unknown; deps: readonly unknown[] } | undefined;
    if (!p || p.deps.length !== deps.length || !p.deps.every((v, j) => Object.is(v, deps[j]))) h.slots[i] = { fn, deps }; return (h.slots[i] as { fn: unknown }).fn; },
  useEffect: (fn: () => void | (() => void), deps: readonly unknown[]) => { const i = h.cursor++; const p = h.slots[i] as readonly unknown[] | undefined;
    if (p?.length === deps.length && p.every((v, j) => Object.is(v, deps[j]))) return; h.slots[i] = deps; h.effects.push(() => { h.cleanups.get(i)?.(); h.cleanups.delete(i); const cleanup = fn(); if (cleanup) h.cleanups.set(i, cleanup); }); },
}));
type Node = React.ReactElement<Record<string, unknown> & { children?: ReactNode }>;
const nodes = (v: ReactNode): Node[] => Array.isArray(v) ? v.flatMap(nodes) : isValidElement<Node["props"]>(v) ? [v, ...nodes(v.props.children)] : [];
function render() { for (let i = 0; i < 12; i++) { h.cursor = 0; h.changed = false; const tree = AutoChainClient(); for (const fn of h.effects.splice(0)) fn(); if (!h.changed) return tree; } throw Error("render did not settle"); }
const all = (type: string) => nodes(render()).filter(n => n.type === type);
const props = (type: string) => all(type)[0].props;
const fetchMock = vi.fn<typeof fetch>();
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); return render(); };
const preview = () => ({ flags: { autoWoOnBh: false, autoJgOnReady: false }, batches: [
  { woId: 18, woDocNo: "WO-18", productCode: "CP-18", productName: "合成中文长名称精华", woQty: "100", producible: "50", alreadyBatched: "0", existingBatches: 0, suggestQty: "50.0000", blockedReason: null,
    kitDate: null, kitNote: "系统供给预测说明", kitBlockers: [{ materialSkuId: 8, shortBy: "3", readyDate: null }], referenceKitDate: null, referenceKitNote: "仅旁证", referenceEvidenceCount: 1, referenceReservedQty: "2" },
], wos: [{ bhId: 9, bhDocNo: "BH-9", skuId: 7, skuCode: "CP-7", qty: "10", supplierName: "合成OEM", feeRatePlan: "1", blockedReason: null }] });
type Row = ReturnType<typeof preview>["batches"][number] | ReturnType<typeof preview>["wos"][number];
type Column = { title: string; width: number; render?: (v: unknown, row: Row) => ReactNode };
const table = (i = 0) => all("table")[i].props;
const cell = (title: string, i = 0) => { const p = table(i); const row = (p.dataSource as Row[])[0]; return ((p.columns as Column[]).find(c => c.title === title)!.render!)(null, row); };
const generate = (i = 0) => nodes(cell("操作", i))[0];
const refresh = () => (nodes(props("toolbar").primaryActions as ReactNode).find(n => n.type === "button")!.props.onClick as () => void)();
const search = () => nodes(props("toolbar").extra as ReactNode)[0].props;
const begin = async () => { fetchMock.mockImplementation(async () => Response.json(preview())); render(); await flush(); };
beforeEach(() => { h.cursor = 0; h.slots = []; h.effects = []; h.changed = false; h.q = ""; fetchMock.mockReset(); vi.useFakeTimers(); vi.stubGlobal("React", React); vi.stubGlobal("fetch", fetchMock); });
afterEach(() => { for (const fn of h.cleanups.values()) fn(); h.cleanups.clear(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it("initial and failed reads retain unknown counts and flags, not false-off or zero", async () => {
  fetchMock.mockRejectedValue(Error("offline")); render(); expect(JSON.stringify(props("alert").description)).toContain("未知"); await flush();
  expect(props("read-error").error).toBeTruthy(); expect(props("card").title).toContain("未知"); expect(table().dataSource).toEqual([]);
});
it("refresh withdraws old recommendations and retry is read-only", async () => {
  await begin(); fetchMock.mockRejectedValueOnce(Error("offline")); refresh(); render(); expect(table().dataSource).toEqual([]); await flush();
  fetchMock.mockResolvedValueOnce(Response.json(preview())); (props("read-error").onRetry as () => void)(); await flush(); await flush();
  expect(table().dataSource).toHaveLength(1); expect(fetchMock.mock.calls.every(([, init]) => !init?.method)).toBe(true);
});
it("15-second timeout is visible and an obsolete result cannot replace the retry", async () => {
  const old = Promise.withResolvers<Response>(); fetchMock.mockReturnValueOnce(old.promise); render();
  await vi.advanceTimersByTimeAsync(15_000); await flush(); expect(props("read-error").error).toContain("超时");
  fetchMock.mockResolvedValueOnce(Response.json(preview())); refresh(); await flush(); await flush();
  old.resolve(Response.json({ ...preview(), batches: [] })); await flush(); expect(table().dataSource).toHaveLength(1);
});
it("malformed successful preview is not rendered as valid suggestions", async () => {
  fetchMock.mockResolvedValueOnce(Response.json({ batches: [], wos: [] })); render(); await flush(); expect(props("read-error").error).toContain("不完整"); expect(props("card").title).toContain("未知");
});
it("product and all other columns have space, scroll stays explicitly inside each fixed table", async () => {
  await begin(); for (let i = 0; i < 2; i++) { const p = table(i); expect(p.tableLayout).toBe("fixed"); const cols = p.columns as Column[]; expect(cols.every(c => c.width >= 70)).toBe(true); expect(p.scroll).toEqual({ x: cols.reduce((n, c) => n + c.width, 0) }); }
  expect(JSON.stringify(cell("成品"))).toContain("合成中文长名称精华");
});
it("joint client filter uses code, Chinese name and OEM without refetch; history state restores visible input", async () => {
  await begin(); (search().onSearch as (q: string) => void)("精华"); render(); expect(table().dataSource).toHaveLength(1); expect(table(1).dataSource).toEqual([]);
  (search().onSearch as (q: string) => void)("oem"); render(); expect(table().dataSource).toEqual([]); expect(table(1).dataSource).toHaveLength(1);
  h.q = "cp-18"; render(); expect(search().value).toBe("cp-18"); expect(table().dataSource).toHaveLength(1);
  (search().onSearch as (q: string) => void)(""); render(); expect(table(1).dataSource).toHaveLength(1); expect(fetchMock).toHaveBeenCalledTimes(1);
});
it("evidence is a labelled button opening the exact source and can be closed", async () => {
  await begin(); const button = nodes(cell("预计齐套日"))[0]; expect(button.type).toBe("button"); expect(button.props["aria-label"]).toContain("WO-18");
  (button.props.onClick as () => void)(); expect(props("modal").open).toBe(true); expect(props("modal").title).toContain("WO-18"); expect(JSON.stringify(props("modal").children)).toContain("系统供给预测说明");
  (props("modal").onCancel as () => void)(); expect(props("modal").open).toBe(false);
});
it.each([0, 1])("generation %s guards same-tick repeats and links the exact unsubmitted draft", async i => {
  await begin(); const write = Promise.withResolvers<Response>(); fetchMock.mockReturnValueOnce(write.promise);
  const first = generate(i); (first.props.onClick as () => void)(); (first.props.onClick as () => void)(); expect(generate(1 - i).props.disabled).toBe(true);
  expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  write.resolve(Response.json({ id: 201, docNo: "DRAFT-201" })); await flush(); await flush();
  const receipt = all("alert").find(n => n.props.type === "success")!; expect(JSON.stringify(receipt.props.description)).toContain("尚未提交");
  expect(nodes(receipt.props.description as ReactNode).find(n => n.type === "a")!.props.href).toBe(`/outsource/${i === 0 ? "jg" : "wo"}?docId=201`);
});
it("unconfirmed write blocks more generation until GET refresh, preserves source-specific error", async () => {
  await begin(); fetchMock.mockRejectedValueOnce(Error("offline")); (generate().props.onClick as () => void)(); await flush();
  const error = all("alert").find(n => n.props.type === "error")!; expect(JSON.stringify(error.props.description)).toContain("WO-18"); expect(JSON.stringify(error.props.description)).toContain("勿重复提交");
  expect(generate().props.disabled).toBe(true); (generate().props.onClick as () => void)();
  refresh(); await flush(); await flush(); expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1); expect(generate().props.disabled).toBe(false);
});
it("malformed write success produces no fabricated document link", async () => {
  await begin(); fetchMock.mockResolvedValueOnce(Response.json({ docNo: "DRAFT-201" })); (generate().props.onClick as () => void)(); await flush();
  expect(all("alert").some(n => n.props.type === "success")).toBe(false); expect(generate().props.disabled).toBe(true);
});
it("successful write receipt survives a failed refresh without re-enabling stale rows", async () => {
  await begin(); fetchMock.mockResolvedValueOnce(Response.json({ id: 201, docNo: "DRAFT-201" })).mockRejectedValueOnce(Error("offline"));
  (generate().props.onClick as () => void)(); await flush(); await flush(); expect(all("alert").some(n => n.props.type === "success")).toBe(true); expect(props("read-error").error).toBeTruthy(); expect(table().dataSource).toEqual([]);
});
it("unmount aborts only the read, never the business mutation or a post-unmount refresh", async () => {
  await begin(); const write = Promise.withResolvers<Response>(); fetchMock.mockReturnValueOnce(write.promise); (generate().props.onClick as () => void)();
  for (const fn of h.cleanups.values()) fn(); h.cleanups.clear(); write.resolve(Response.json({ id: 201, docNo: "DRAFT-201" })); await flush();
  expect(fetchMock).toHaveBeenCalledTimes(2); expect(fetchMock.mock.calls[1][1]?.signal).toBeUndefined();
});
it("source deep links preserve WO and BH identity", async () => {
  await begin(); expect(nodes(cell("工单"))[0].props.href).toBe("/outsource/wo?docId=18"); expect(nodes(cell("备货申请", 1))[0].props.href).toBe("/outsource/bh?docId=9");
});

it("renders exact large capacity and decimal suggested quantities without float conversion", async () => {
  await begin();
  const columns = table().columns as Column[];
  const row = (table().dataSource as Row[])[0];
  const capacity = columns.find(c => c.title === "到料可产")!.render!("999999999999980000000000", row);
  expect(nodes(capacity)[0].props.children).toBe("999999999999980000000000");
  const suggested = columns.find(c => c.title === "建议新批")!.render!;
  expect(nodes(suggested("9.9000", row))[0].props.children).toBe("9.9");
  expect(suggested("0.0000", row)).toBe("—");
});
