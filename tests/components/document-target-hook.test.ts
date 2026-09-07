import { afterEach, expect, it, vi } from "vitest";
import { useDocumentTarget } from "@/components/useDocumentTarget";

const state = vi.hoisted(() => ({ url: new URL("http://localhost/outsource/bh?q=kept&page=4#table") }));
vi.mock("next/navigation", () => ({ useSearchParams: () => state.url.searchParams }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(), useCallback: (fn: unknown) => fn }));
afterEach(() => vi.unstubAllGlobals());
it("history selection uses the latest address and closing replaces only selection", () => {
  state.url = new URL("http://localhost/outsource/bh?q=kept&page=4#table");
  const pushState = vi.fn((_data, _unused, path) => { state.url = new URL(path, state.url); });
  const replaceState = vi.fn((_data, _unused, path) => { state.url = new URL(path, state.url); });
  vi.stubGlobal("window", { get location() { return state.url; }, history: { pushState, replaceState } });
  const initial = useDocumentTarget();
  expect(initial.present).toBe(false);
  initial.setId(10);
  expect(pushState).toHaveBeenLastCalledWith(null, "", "/outsource/bh?q=kept&page=4&docId=10#table");
  expect(useDocumentTarget().id).toBe(10);
  // Simulated back/forward state supplied by Next; no stale local selection.
  state.url = new URL("http://localhost/outsource/bh?q=changed&page=8&docId=11#table");
  expect(useDocumentTarget().id).toBe(11);
  initial.setId(null);
  expect(replaceState).toHaveBeenLastCalledWith(null, "", "/outsource/bh?q=changed&page=8#table");
  expect(useDocumentTarget().present).toBe(false);
  initial.setId(null);
  expect(replaceState).toHaveBeenCalledTimes(1);
});
