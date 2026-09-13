import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useJgMaterialLines, type JgMaterialLine } from "@/components/useJgMaterialLines";

// Execute the real hook and async callbacks; browser interaction is a separate acceptance step.
const h = vi.hoisted(() => ({ cursor: 0, slots: [] as unknown[], cleanups: [] as (() => void)[], fetchJson: vi.fn() }));
vi.mock("react", () => ({
  useState(initial: unknown) {
    const index = h.cursor++;
    if (!(index in h.slots)) h.slots[index] = typeof initial === "function" ? initial() : initial;
    return [h.slots[index], (value: unknown) => { h.slots[index] = value; }];
  },
  useCallback: (fn: unknown) => fn,
  useEffect(effect: () => (() => void)) {
    const index = h.cursor++;
    if (!(index in h.slots)) { h.slots[index] = true; h.cleanups.push(effect()); }
  },
}));
vi.mock("@/components/fetchJson", () => ({ fetchJson: h.fetchJson }));
const onLoaded = vi.fn<(lines: JgMaterialLine[]) => void>();
const line = { materialSkuId: 72, skuCode: "MAT-B", skuName: "当前物料", baseUom: "件", grossReq: "15.0000" };
function MaterialReadHarness() { h.cursor = 0; return useJgMaterialLines(onLoaded); }
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
beforeEach(() => { h.cursor = 0; h.slots = []; h.cleanups = []; h.fetchJson.mockReset(); onLoaded.mockReset(); });
afterEach(() => { h.cleanups.forEach(fn => fn()); });

describe("JG → WO material read isolation", () => {
  it("clears old editable lines, reads the selected JG's WO and forwards one abort signal", async () => {
    h.fetchJson.mockResolvedValueOnce({ woId: 9, supplierId: 19 }).mockResolvedValueOnce({ lines: [line] });
    const pending = MaterialReadHarness().load(7);
    expect(onLoaded).toHaveBeenLastCalledWith([]);
    expect(MaterialReadHarness()).toMatchObject({ loading: true, error: null });
    await pending;
    expect(h.fetchJson.mock.calls.map(c => c[0])).toEqual(["/api/outsource/jg/7", "/api/outsource/wo/9"]);
    expect(h.fetchJson.mock.calls[0][1].signal).toBe(h.fetchJson.mock.calls[1][1].signal);
    expect(onLoaded).toHaveBeenLastCalledWith([line]);
    expect(MaterialReadHarness()).toMatchObject({ loading: false, error: null, supplierId: 19 });
    MaterialReadHarness().cancel();
    expect(MaterialReadHarness().supplierId).toBeNull();
  });

  it("does not even start the stale WO request if an old JG detail arrives late", async () => {
    const old = Promise.withResolvers<{ woId: number }>();
    h.fetchJson.mockReturnValueOnce(old.promise).mockResolvedValueOnce({ woId: 22 }).mockResolvedValueOnce({ lines: [line] });
    const hook = MaterialReadHarness(), first = hook.load(1);
    await hook.load(2);
    old.resolve({ woId: 11 }); await first;
    expect(h.fetchJson.mock.calls.map(c => c[0])).toEqual(["/api/outsource/jg/1", "/api/outsource/jg/2", "/api/outsource/wo/22"]);
    expect(onLoaded.mock.calls).toEqual([[[]], [[]], [[line]]]);
  });

  it.each(["success", "failure"])("ignores an old WO %s after another JG has loaded", async outcome => {
    const old = Promise.withResolvers<{ lines: JgMaterialLine[] }>();
    h.fetchJson.mockResolvedValueOnce({ woId: 11, supplierId: 111 }).mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce({ woId: 22, supplierId: 222 }).mockResolvedValueOnce({ lines: [line] });
    const hook = MaterialReadHarness(), first = hook.load(1);
    await flush();
    expect(MaterialReadHarness().supplierId).toBeNull();
    await hook.load(2);
    if (outcome === "success") old.resolve({ lines: [{ ...line, skuCode: "OLD" }] });
    else old.reject(Error("旧工单故障"));
    await first;
    expect(onLoaded).toHaveBeenLastCalledWith([line]);
    expect(onLoaded).toHaveBeenCalledTimes(3);
    expect(MaterialReadHarness()).toMatchObject({ loading: false, error: null, supplierId: 222 });
  });

  it("shows a material failure and retries the same source without hidden stale rows", async () => {
    h.fetchJson.mockResolvedValueOnce({ woId: 9 }).mockRejectedValueOnce(Error("读取物料失败"));
    await MaterialReadHarness().load(7);
    expect(MaterialReadHarness()).toMatchObject({ loading: false, error: "读取物料失败" });
    expect(onLoaded).toHaveBeenLastCalledWith([]);
    h.fetchJson.mockResolvedValueOnce({ woId: 9 }).mockResolvedValueOnce({ lines: [line] });
    await MaterialReadHarness().load(7);
    expect(MaterialReadHarness()).toMatchObject({ loading: false, error: null });
    expect(onLoaded).toHaveBeenLastCalledWith([line]);
  });

  it.each(["cancel", "unmount"])("%s invalidates an in-flight WO and prevents late edits", async mode => {
    const old = Promise.withResolvers<{ lines: JgMaterialLine[] }>();
    h.fetchJson.mockResolvedValueOnce({ woId: 9 }).mockReturnValueOnce(old.promise);
    const hook = MaterialReadHarness(), pending = hook.load(7);
    await flush();
    if (mode === "cancel") hook.cancel(); else h.cleanups.forEach(fn => fn());
    old.resolve({ lines: [line] }); await pending;
    expect(onLoaded.mock.calls).toEqual([[[]]]);
    expect(h.fetchJson.mock.calls[1][1].signal.aborted).toBe(true);
  });
});
