import React, { isValidElement, type ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import ApprovalBrief from "@/components/ApprovalBrief";
import ChainStrip from "@/components/ChainStrip";
import { useDocumentRead } from "@/components/useDocumentRead";

// Real hook/callback lifecycle; browser tests separately verify AntD rendering and layout.
const hooks = vi.hoisted(() => ({ cursor: 0, slots: [] as unknown[], effects: [] as (() => void)[], cleanups: new Map<number, () => void>(), changed: false }));
vi.mock("antd", () => ({ Alert: "alert", Card: "card", Space: "space", Table: "table", Tag: "tag", Tooltip: "tooltip", Button: "button", Typography: { Text: "text" } }));
vi.mock("react", async original => ({
  ...await original<typeof import("react")>(),
  useState: <T,>(initial: T | (() => T)) => {
    const i = hooks.cursor++;
    if (!(i in hooks.slots)) hooks.slots[i] = typeof initial === "function" ? (initial as () => T)() : initial;
    return [hooks.slots[i], (update: T | ((old: T) => T)) => {
      const next = typeof update === "function" ? (update as (old: T) => T)(hooks.slots[i] as T) : update;
      if (!Object.is(next, hooks.slots[i])) hooks.changed = true;
      hooks.slots[i] = next;
    }];
  },
  useCallback: (fn: unknown) => fn,
  useEffect: (effect: () => void | (() => void), deps: readonly unknown[]) => {
    const i = hooks.cursor++;
    const prev = hooks.slots[i] as readonly unknown[] | undefined;
    if (prev?.length === deps.length && prev.every((v, j) => Object.is(v, deps[j]))) return;
    hooks.slots[i] = deps;
    hooks.effects.push(() => { hooks.cleanups.get(i)?.(); hooks.cleanups.delete(i); const cleanup = effect(); if (cleanup) hooks.cleanups.set(i, cleanup); });
  },
}));
type Node = React.ReactElement<Record<string, unknown> & { children?: ReactNode }>;
const nodes = (v: ReactNode): Node[] => Array.isArray(v) ? v.flatMap(nodes) : isValidElement<Node["props"]>(v) ? [v, ...nodes(v.props.children)] : [];
const fetchMock = vi.fn<typeof fetch>();
let id = 1;
let surface: "brief" | "chain" | "resource" = "brief";
let url: string | null = "/api/outsource/bh/1";
function ResourceProbe() { return React.createElement("read", useDocumentRead<{ id: number }>(url)); }
function render(effects = true) {
  for (let n = 0; n < 10; n++) {
    hooks.cursor = 0; hooks.changed = false;
    const tree = surface === "resource" ? ResourceProbe()
      : surface === "brief" ? ApprovalBrief({ docType: "bh", docId: id }) : ChainStrip({ docType: "bh", id });
    if (!effects) return tree;
    for (const effect of hooks.effects.splice(0)) effect();
    if (!hooks.changed) return tree;
  }
  throw new Error("Read did not settle");
}
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); return render(); };
const brief = (docNo: string) => Response.json({ docNo, origin: { fromSuggestion: false, note: "人工直录" }, lines: [], summary: { lineCount: 0, flaggedLines: 0, totalQty: 0 } });
const title = (tree = render()) => nodes(tree).find(n => n.type === "card")?.props.title ?? "";
function cleanup() { for (const fn of hooks.cleanups.values()) fn(); hooks.cleanups.clear(); }
beforeEach(() => {
  hooks.cursor = 0; hooks.slots = []; hooks.effects = []; hooks.changed = false; id = 1; surface = "brief"; url = "/api/outsource/bh/1";
  fetchMock.mockReset(); vi.useFakeTimers(); vi.stubGlobal("React", React); vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it("withdraws the old brief before effects when a different document is selected", async () => {
  fetchMock.mockResolvedValueOnce(brief("OLD")); render(); await flush(); expect(title()).toContain("OLD");
  id = 2; expect(title(render(false))).not.toContain("OLD");
});
it("rejects out-of-order success and aborts obsolete requests", async () => {
  const old = Promise.withResolvers<Response>(); const next = Promise.withResolvers<Response>();
  fetchMock.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
  render(); id = 2; render();
  expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
  next.resolve(brief("CURRENT")); await flush(); old.resolve(brief("OLD")); await flush();
  expect(title()).toContain("CURRENT");
});
it("a failed previous document cannot poison the next successful brief", async () => {
  const old = Promise.withResolvers<Response>(); fetchMock.mockReturnValueOnce(old.promise).mockResolvedValueOnce(brief("CURRENT"));
  render(); id = 2; render(); await flush(); old.reject(new Error("offline")); await flush();
  expect(title()).toContain("CURRENT");
});
it("offers visible failure and retry without treating missing brief as healthy", async () => {
  fetchMock.mockRejectedValueOnce(new Error("private-network-details")); render(); await flush();
  const alert = nodes(render()).find(n => n.type === "alert")!;
  expect(alert).toBeDefined(); expect(alert.props.message).toBe("审批简报暂不可用");
  expect(JSON.stringify(alert.props)).not.toContain("private-network-details");
  fetchMock.mockResolvedValueOnce(brief("RECOVERED"));
  const retry = nodes(alert.props.action as ReactNode).find(n => n.type === "button")!;
  (retry.props.onClick as () => void)(); render(); await flush(); expect(title()).toContain("RECOVERED");
});
it("times out, allows retry and never accepts a late timed-out reply", async () => {
  const old = Promise.withResolvers<Response>(); fetchMock.mockReturnValueOnce(old.promise); render();
  await vi.advanceTimersByTimeAsync(15_000); await flush();
  const alert = nodes(render()).find(n => n.type === "alert")!;
  expect(String(alert?.props.description)).toContain("超时");
  fetchMock.mockResolvedValueOnce(brief("RETRY"));
  (nodes(alert.props.action as ReactNode).find(n => n.type === "button")!.props.onClick as () => void)(); render(); await flush();
  old.resolve(brief("OLD")); await flush(); expect(title()).toContain("RETRY");
});
it.each(["brief", "chain"] as const)("%s cancels on unmount without accepting the pending response", async target => {
  surface = target; const pending = Promise.withResolvers<Response>(); fetchMock.mockReturnValueOnce(pending.promise);
  render(); cleanup(); expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
  pending.resolve(brief("OLD")); await flush(); expect(title()).not.toContain("OLD");
});
it("a failed chain is visible and retryable rather than indistinguishable from no linkage", async () => {
  surface = "chain"; fetchMock.mockResolvedValueOnce(new Response("", { status: 503 })); render(); await flush();
  const alert = nodes(render()).find(n => n.type === "alert");
  expect(alert?.props.message).toBe("关联链路暂不可用");
  expect(nodes(alert?.props.action as ReactNode).some(n => n.type === "button")).toBe(true);
});

const resource = (effects = true) => nodes(render(effects)).find(n => n.type === "read")!.props;
it.each(["brief", "chain"] as const)("%s rejects malformed successful payloads without crashing or claiming no issues", async target => {
  surface = target; fetchMock.mockResolvedValueOnce(Response.json({})); render(); await flush();
  expect(nodes(render()).find(n => n.type === "alert")?.props.description).toContain("响应格式异常");
});
it("a closed detail cannot flash cached facts or actions when reopened with the same id", async () => {
  surface = "resource"; fetchMock.mockResolvedValueOnce(Response.json({ id: 1 })); render(); await flush();
  expect(resource().data).toEqual({ id: 1 });
  url = null; expect(resource().phase).toBe("idle"); expect(resource().data).toBeNull();
  url = "/api/outsource/bh/1"; expect(resource(false).data).toBeNull(); expect(resource(false).phase).toBe("loading");
});
it("refresh immediately withdraws current document data and retry uses the current id", async () => {
  surface = "resource"; fetchMock.mockResolvedValueOnce(Response.json({ id: 1 })); render(); await flush();
  const retry = resource().retry as () => void;
  fetchMock.mockReturnValueOnce(new Promise(() => {}));
  retry(); expect(resource(false).data).toBeNull(); render();
  url = "/api/outsource/bh/2"; fetchMock.mockResolvedValueOnce(Response.json({ id: 2 })); render(); await flush();
  expect(resource().data).toEqual({ id: 2 });
  expect(fetchMock.mock.calls.at(-1)?.[0]).toBe(url);
});
it("a null successful response is a read failure, not endless loading or an empty document", async () => {
  surface = "resource"; fetchMock.mockResolvedValueOnce(Response.json(null)); render(); await flush();
  expect(resource().phase).toBe("error"); expect(resource().error).toBe("服务器未返回单据数据");
});
it("closing aborts a pending detail and clears its timeout", async () => {
  surface = "resource"; fetchMock.mockReturnValueOnce(new Promise(() => {})); render(); url = null; render();
  expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
  await vi.advanceTimersByTimeAsync(20_000); expect(resource().phase).toBe("idle"); expect(resource().error).toBeNull();
});
