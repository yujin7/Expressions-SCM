import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useJgMaterialLines, type JgMaterialLine } from "@/components/useJgMaterialLines";

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
const line: JgMaterialLine = { materialSkuId: 72, skuCode: "MAT-B", skuName: "当前物料", baseUom: "件", grossReq: "15.0000",
  issuedQty: "5", returnedQty: "2", draftIssueQty: "0", pendingIssueQty: "0", draftReturnQty: "0", pendingReturnQty: "0", suggestedIssueQty: "10" };
const basis = (id = 7) => ({ jgId: id, woId: 9, supplierId: id + 100, lines: [line], openDocuments: [], observedAt: "2026-09-13" });
function MaterialReadHarness() { h.cursor = 0; return useJgMaterialLines(onLoaded); }
beforeEach(() => { h.cursor = 0; h.slots = []; h.cleanups = []; h.fetchJson.mockReset(); onLoaded.mockReset(); });
afterEach(() => { h.cleanups.forEach(fn => fn()); });

describe("JG material snapshot read isolation", () => {
  it("clears prior evidence and reads one uncached source snapshot instead of JG → WO waterfall", async () => {
    h.fetchJson.mockResolvedValueOnce(basis());
    const pending = MaterialReadHarness().load(7);
    expect(onLoaded).toHaveBeenLastCalledWith([]);
    expect(MaterialReadHarness()).toMatchObject({ loading: true, error: null, basis: null, supplierId: null });
    await pending;
    expect(h.fetchJson).toHaveBeenCalledTimes(1);
    expect(h.fetchJson).toHaveBeenCalledWith("/api/outsource/jg/7?materialBasis=1", { signal: expect.any(AbortSignal), cache: "no-store" });
    expect(onLoaded).toHaveBeenLastCalledWith([line]);
    expect(MaterialReadHarness()).toMatchObject({ loading: false, error: null, supplierId: 107, basis: basis() });
  });
  it.each(["success", "failure"])("ignores old source %s after another JG loads", async outcome => {
    const old = Promise.withResolvers<ReturnType<typeof basis>>();
    h.fetchJson.mockReturnValueOnce(old.promise).mockResolvedValueOnce(basis(2));
    const first = MaterialReadHarness().load(1); await MaterialReadHarness().load(2);
    if (outcome === "success") old.resolve(basis(1)); else old.reject(Error("旧数据失败"));
    await first;
    expect(onLoaded.mock.calls).toEqual([[[]], [[]], [[line]]]);
    expect(MaterialReadHarness()).toMatchObject({ supplierId: 102, error: null, basis: basis(2) });
  });
  it("refuses wrong JG identity rather than forwarding apparently valid material rows", async () => {
    h.fetchJson.mockResolvedValueOnce(basis(8)); await MaterialReadHarness().load(7);
    expect(MaterialReadHarness()).toMatchObject({ loading: false, basis: null, supplierId: null, error: expect.stringContaining("不符") });
    expect(onLoaded.mock.calls).toEqual([[[]]]);
  });
  it("failure after a successful load removes evidence and retry supplies new facts", async () => {
    h.fetchJson.mockResolvedValueOnce(basis()).mockRejectedValueOnce(Error("读取失败")).mockResolvedValueOnce(basis());
    await MaterialReadHarness().load(7); await MaterialReadHarness().load(7);
    expect(MaterialReadHarness()).toMatchObject({ loading: false, error: "读取失败", basis: null, supplierId: null });
    expect(onLoaded).toHaveBeenLastCalledWith([]);
    await MaterialReadHarness().load(7); expect(MaterialReadHarness()).toMatchObject({ error: null, basis: basis() });
  });
  it.each(["cancel", "unmount"])("%s prevents late evidence from repopulating a closed form", async mode => {
    const old = Promise.withResolvers<ReturnType<typeof basis>>(); h.fetchJson.mockReturnValueOnce(old.promise);
    const hook = MaterialReadHarness(), pending = hook.load(7);
    if (mode === "cancel") hook.cancel(); else h.cleanups.forEach(fn => fn());
    old.resolve(basis()); await pending;
    expect(onLoaded.mock.calls).toEqual([[[]]]);
    expect(h.fetchJson.mock.calls[0][1].signal.aborted).toBe(true);
    expect(MaterialReadHarness().basis).toBeNull();
  });
});
