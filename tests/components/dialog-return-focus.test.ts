import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canReturnDialogFocus, useDialogReturnFocus } from "@/components/useDialogReturnFocus";

const h = vi.hoisted(() => ({ cursor: 0, slots: [] as unknown[], effects: [] as (() => void)[], cleanups: new Map<number, () => void>() }));
vi.mock("react", () => ({
  useRef: (initial: unknown) => { const i = h.cursor++; if (!(i in h.slots)) h.slots[i] = { current: initial }; return h.slots[i]; },
  useCallback: (fn: unknown) => fn,
  useEffect: (fn: () => void | (() => void), deps: unknown[]) => {
    const i = h.cursor++, old = h.slots[i] as unknown[] | undefined;
    if (old && deps.every((v, j) => Object.is(v, old[j]))) return;
    h.slots[i] = deps; h.effects.push(() => { h.cleanups.get(i)?.(); h.cleanups.delete(i); const cleanup = fn(); if (cleanup) h.cleanups.set(i, cleanup); });
  },
}));
type Fake = { isConnected: boolean; visible: boolean; disabled: boolean; hidden: boolean; visibility: string; key: string;
  ownerDocument: typeof doc; children: Fake[]; fallback: Fake | null; focus: ReturnType<typeof vi.fn>;
  closest: (s: string) => Fake | null; matches: () => boolean; getClientRects: () => number[];
  querySelectorAll: () => Fake[]; getAttribute: () => string };
const doc = { body: {} as object, activeElement: null as object | null, modals: [] as Fake[],
  defaultView: { getComputedStyle: (e: Fake) => ({ visibility: e.visibility }) }, querySelectorAll: () => doc.modals };
const dom = (e: Fake) => e as unknown as HTMLElement;
function element(key = ""): Fake {
  const e: Fake = { isConnected: true, visible: true, disabled: false, hidden: false, visibility: "visible", key,
    ownerDocument: doc, children: [], fallback: null, focus: vi.fn(() => { doc.activeElement = e; }),
    closest: s => s === "[data-dialog-fallback]" ? e.fallback : e.hidden ? e : null,
    matches: () => e.disabled, getClientRects: () => e.visible ? [1] : [], querySelectorAll: () => e.children, getAttribute: () => e.key };
  return e;
}
let scope: Fake, trigger: Fake, api: ReturnType<typeof useDialogReturnFocus>;
let serial = 0;
const frames = new Map<number, () => void>();
// eslint-disable-next-line react-hooks/rules-of-hooks -- Deterministic hook runner; real DOM behavior is verified independently in the browser.
function render(open: boolean) { h.cursor = 0; api = useDialogReturnFocus(open); api.scopeRef.current = dom(scope); h.effects.splice(0).forEach(fn => fn()); }
function frame() { const work = [...frames.values()]; frames.clear(); work.forEach(fn => fn()); }
function close() { render(false); frame(); }
beforeEach(() => {
  h.cursor = 0; h.slots = []; h.effects = []; h.cleanups.clear(); frames.clear();
  doc.activeElement = doc.body; doc.modals = []; scope = element(); trigger = element("assign:17");
  vi.stubGlobal("window", { location: { href: "http://127.0.0.1:3476/todo" } });
  vi.stubGlobal("requestAnimationFrame", (fn: () => void) => { frames.set(++serial, fn); return serial; });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  render(false); api.remember(dom(trigger), "assign:17"); render(true);
});
afterEach(() => { h.cleanups.forEach(fn => fn()); vi.unstubAllGlobals(); });

describe("parent-owned dialog return focus", () => {
  it("does not focus on initial render or open; close returns to the exact original control", () => {
    frame(); expect(trigger.focus).not.toHaveBeenCalled(); close(); expect(trigger.focus).toHaveBeenCalledOnce();
  });
  it("waits until removed dialog DOM leaves BODY focused", () => {
    render(false); expect(trigger.focus).not.toHaveBeenCalled(); frame(); expect(doc.activeElement).toBe(trigger);
  });
  it("uses the visible same-action replacement when responsive copies or refreshed rows change", () => {
    trigger.visible = false; const hidden = element("assign:17"), other = element("assign:18"), replacement = element("assign:17");
    hidden.visible = false; scope.children = [hidden, other, replacement]; close();
    expect(replacement.focus).toHaveBeenCalledOnce(); expect(other.focus).not.toHaveBeenCalled(); expect(hidden.focus).not.toHaveBeenCalled();
  });
  it("falls back to the labelled list when the original row disappears", () => {
    trigger.isConnected = false; close(); expect(scope.focus).toHaveBeenCalledOnce();
  });
  it("falls back to the workspace if a recovery banner has become empty", () => {
    trigger.isConnected = false; scope.visible = false; const workspace = element(); scope.fallback = workspace;
    close(); expect(workspace.focus).toHaveBeenCalledOnce();
  });
  it.each(["disabled", "hidden", "isConnected"] as const)("rejects an unavailable target: %s", field => {
    trigger[field] = field !== "isConnected"; close(); expect(trigger.focus).not.toHaveBeenCalled(); expect(scope.focus).toHaveBeenCalledOnce();
  });
  it("rejects CSS visibility-hidden targets", () => { trigger.visibility = "hidden"; expect(canReturnDialogFocus(dom(trigger))).toBe(false); });
  it("does not steal newer focus", () => { doc.activeElement = element(); close(); expect(trigger.focus).not.toHaveBeenCalled(); });
  it("does not steal focus from an opening replacement modal even before its autofocus", () => {
    doc.modals = [element()]; close(); expect(trigger.focus).not.toHaveBeenCalled();
  });
  it("ignores hidden modal remnants", () => { const modal = element(); modal.visible = false; doc.modals = [modal]; close(); expect(trigger.focus).toHaveBeenCalledOnce(); });
  it("cancels a queued return on reopen", () => { render(false); render(true); frame(); expect(trigger.focus).not.toHaveBeenCalled(); });
  it("cancels a queued return on owner unmount", () => { render(false); h.cleanups.forEach(fn => fn()); frame(); expect(trigger.focus).not.toHaveBeenCalled(); });
  it("does not act on a departed route or detached scope", () => {
    window.location.href = "http://127.0.0.1:3476/workbench"; close(); expect(trigger.focus).not.toHaveBeenCalled();
    render(true); scope.isConnected = false; close(); expect(scope.focus).not.toHaveBeenCalled();
  });
});
