import React, { isValidElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import PlatformSkuGapCard from "@/app/(app)/report/decision-studio/platform-sku-gap-card";
import { emptyPlatformSkuIdentityGap } from "@/server/modules/report/platform-sku-identity-gap";
import { platformSkuIdentityView } from "@/server/modules/report/platform-sku-identity-view";
const hooks = vi.hoisted(() => ({ cursor: 0, slots: [] as unknown[], effects: [] as (() => void)[], cleanups: new Map<number, () => void>(), changed: false, writes: 0 }));
const network = vi.hoisted(() => ({ fetch: vi.fn(), post: vi.fn() }));
const messages = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn(), warning: vi.fn() }));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState: <T,>(initial: T) => {
    const index = hooks.cursor++;
    if (!(index in hooks.slots)) hooks.slots[index] = initial;
    return [hooks.slots[index], (next: T | ((previous: T) => T)) => {
      const value = typeof next === "function" ? (next as (previous: T) => T)(hooks.slots[index] as T) : next;
      hooks.writes += 1;
      if (!Object.is(hooks.slots[index], value)) hooks.changed = true;
      hooks.slots[index] = value;
    }];
  },
  useRef: <T,>(initial: T) => {
    const index = hooks.cursor++;
    if (!(index in hooks.slots)) hooks.slots[index] = { current: initial };
    return hooks.slots[index];
  },
  useCallback: (callback: unknown, deps: readonly unknown[]) => {
    const index = hooks.cursor++;
    const previous = hooks.slots[index] as { value: unknown; deps: readonly unknown[] } | undefined;
    if (!previous || previous.deps.length !== deps.length || deps.some((value, i) => !Object.is(value, previous.deps[i]))) hooks.slots[index] = { value: callback, deps };
    return (hooks.slots[index] as { value: unknown }).value;
  },
  useMemo: (create: () => unknown, deps: readonly unknown[]) => {
    const index = hooks.cursor++;
    const previous = hooks.slots[index] as { value: unknown; deps: readonly unknown[] } | undefined;
    if (!previous || previous.deps.length !== deps.length || deps.some((value, i) => !Object.is(value, previous.deps[i]))) hooks.slots[index] = { value: create(), deps };
    return (hooks.slots[index] as { value: unknown }).value;
  },
  useEffect: (effect: () => void | (() => void), deps: readonly unknown[]) => {
    const index = hooks.cursor++;
    const previous = hooks.slots[index] as readonly unknown[] | undefined;
    if (previous && previous.length === deps.length && previous.every((value, i) => Object.is(value, deps[i]))) return;
    hooks.slots[index] = deps;
    hooks.effects.push(() => {
      hooks.cleanups.get(index)?.();
      hooks.cleanups.delete(index);
      const cleanup = effect();
      if (cleanup) hooks.cleanups.set(index, cleanup);
    });
  },
  useLayoutEffect: (effect: () => void | (() => void), deps: readonly unknown[]) => {
    const index = hooks.cursor++;
    const previous = hooks.slots[index] as readonly unknown[] | undefined;
    if (previous && previous.length === deps.length && previous.every((value, i) => Object.is(value, deps[i]))) return;
    hooks.slots[index] = deps;
    hooks.effects.push(() => {
      hooks.cleanups.get(index)?.();
      hooks.cleanups.delete(index);
      const cleanup = effect();
      if (cleanup) hooks.cleanups.set(index, cleanup);
    });
  },
}));

vi.mock("antd", () => ({ App: { useApp: () => ({ message: messages }) }, Alert: "alert", Button: "button", Card: "card", Col: "col", Modal: "modal", Progress: "progress", Row: "row", Space: "space", Statistic: "statistic", Table: "table", Tag: "tag", Typography: { Text: "text", Paragraph: "paragraph" } }));
vi.mock("@/components/fetchJson", () => ({ fetchJson: network.fetch, postJson: network.post }));
vi.mock("@/components/RemoteSelect", () => ({ default: "remote-select" }));
vi.mock("@/components/decision-visuals", () => ({ VISUAL_COLOR: { positive: "green", warning: "orange" } }));
type Props = Record<string, unknown> & { children?: ReactNode };
type Element = React.ReactElement<Props>;
function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Props>(node)) return [];
  return [node, ...elements(node.props.children), ...elements(node.props.extra as ReactNode), ...elements(node.props.footer as ReactNode), ...elements(node.props.action as ReactNode)];
}
function text(node: ReactNode): string {
  if (Array.isArray(node)) return node.map(text).join("");
  if (isValidElement<Props>(node)) return text(node.props.children);
  return typeof node === "string" || typeof node === "number" ? String(node) : "";
}
function render() {
  for (let i = 0; i < 8; i++) {
    hooks.cursor = 0; hooks.changed = false;
    const tree = PlatformSkuGapCard({ active: true });
    for (const effect of hooks.effects.splice(0)) effect();
    if (!hooks.changed) return tree;
  }
  throw new Error("did not settle");
}
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const button = (tree: ReactNode, label: string) => elements(tree).find(e => e.type === "button" && text(e).includes(label));
const click = (e: Element) => (e.props.onClick as () => void)();
const modal = (tree: ReactNode) => elements(tree).find(e => e.type === "modal" && e.props.open)!;
function data(role: string, id = 42) {
  const result = emptyPlatformSkuIdentityGap("QA observation");
  result.state = "ready";
  result.window = { from: "2026-06-01", to: "2026-08-31" };
  result.exactHits = [{ shopName: "QA", platformSkuId: "platform-" + id, skuId: id, skuCode: "SKU-" + id, paidAmount: "9000.12", source: "crosswalk" }];
  return platformSkuIdentityView(result, [role]);
}
async function loaded(role: string) {
  network.fetch.mockResolvedValueOnce(data(role)); render(); await flush(); return render();
}
beforeEach(() => {
  vi.stubGlobal("React", React);
  hooks.cursor = 0; hooks.slots = []; hooks.effects = []; hooks.cleanups.clear(); hooks.changed = false; hooks.writes = 0;
  vi.clearAllMocks(); network.fetch.mockReset(); network.post.mockReset();
  network.fetch.mockReturnValue(new Promise(() => {}));
});
afterEach(() => { for (const cleanup of hooks.cleanups.values()) cleanup(); vi.unstubAllGlobals(); });

describe("platform identity UI contract (real callbacks, mocked hook scheduler; not browser proof)", () => {
  it("keeps the outcome and next action visible on mobile without a horizontal results table", async () => {
    const tree = await loaded("pmc");
    const table = elements(tree).find(e => e.props["data-testid"] === "identity-bulk-results")!;
    expect(table.props.scroll).toBeUndefined();
    const columns = table.props.columns as { title: string; responsive?: string[]; render?: (value: unknown, row: unknown) => ReactNode }[];
    const mobile = columns.filter(column => !column.responsive || column.responsive.includes("xs"));
    expect(mobile.map(column => column.title)).toEqual(["项目 / 下一步", "结果"]);
    const item = { item: { skuId: 42, skuCode: "QA-42", shopName: "QA店", platformSkuId: "外部42" }, status: "rejected", detail: "归属冲突，请核对" };
    const detail = text(mobile[0].render!(null, item));
    expect(detail).toContain("QA-42");
    expect(detail).toContain("外部42");
    expect(detail).toContain("归属冲突，请核对");
    expect(text(mobile[1].render!(null, item))).toContain("被拒绝");
  });
  it.each(["ops", "quality", "finance", "unknown"])("%s cannot see or submit claim controls", async role => {
    const tree = await loaded(role);
    expect(button(tree, "一键认领")).toBeUndefined();
    expect(button(tree, "补齐条码")).toBeUndefined();
    const table = elements(tree).find(e => e.type === "table")!;
    expect((table.props.columns as { key: string }[]).some(c => c.key === "action")).toBe(false);
    expect(network.post).not.toHaveBeenCalled();
  });
  it.each(["warehouse", "pmc", "purchasing", "admin"])("%s retains claim workflow independently of monetary access", async role => {
    const tree = await loaded(role);
    expect(button(tree, "一键认领")).toBeDefined();
    const table = elements(tree).find(e => e.type === "table")!;
    expect((table.props.columns as { key: string }[]).some(c => c.key === "paidAmount")).toBe(role !== "warehouse");
  });
  it("double confirmation posts once, prevents cancel, and keeps reviewed items across refresh", async () => {
    let tree = await loaded("pmc");
    click(button(tree, "一键认领")!); tree = render();
    network.fetch.mockResolvedValueOnce(data("pmc", 99));
    click(button(tree, "刷新")!); await flush(); tree = render();
    const preview = elements(modal(tree)).find(e => e.type === "table")!;
    expect((preview.props.dataSource as { skuId: number }[])[0].skuId).toBe(42);
    network.post.mockReturnValue(new Promise(() => {}));
    const confirm = modal(tree).props.onOk as () => void;
    confirm(); confirm();
    expect(network.post).toHaveBeenCalledTimes(1);
    expect(network.post.mock.calls[0][1].items[0].skuId).toBe(42);
    tree = render();
    expect(modal(tree).props.closable).toBe(false);
    expect(modal(tree).props.keyboard).toBe(false);
    (modal(tree).props.onCancel as () => void)();
    expect(modal(render())).toBeDefined();
  });
  it("a failed refresh cannot be used to open a new claim review", async () => {
    let tree = await loaded("pmc");
    network.fetch.mockRejectedValueOnce(new Error("offline"));
    click(button(tree, "刷新")!); await flush(); tree = render();
    expect(button(tree, "一键认领")!.props.disabled).toBe(true);
    click(button(tree, "一键认领")!);
    expect(modal(render())).toBeUndefined();
  });
  it("keeps partial failures visible and retries only reviewed unsuccessful rows", async () => {
    const fixture = data("pmc");
    fixture.exactHits.push(data("pmc", 99).exactHits[0]);
    network.fetch.mockResolvedValue(fixture);
    render(); await flush(); let tree = render();
    click(button(tree, "一键认领")!); tree = render();
    network.post.mockResolvedValueOnce({ total: 2, claimed: 1, alreadyClaimed: 0, failed: 1, readModels: "refreshed", results: [
      { shopName: "QA", platformSkuId: "platform-42", skuId: 42, ok: true, created: true },
      { shopName: "QA", platformSkuId: "platform-99", skuId: 99, ok: false, errorKind: "business", error: "归属冲突，请先人工裁决" },
    ] });
    await (modal(tree).props.onOk as () => Promise<void>)(); await flush(); tree = render();
    expect(messages.success).not.toHaveBeenCalled();
    expect(messages.warning).toHaveBeenCalled();
    expect(modal(tree).props.title).toContain("处理结果");
    const resultTable = elements(modal(tree)).find(e => e.props["data-testid"] === "identity-bulk-results")!;
    expect((resultTable.props.dataSource as { detail: string }[]).some(row => row.detail.includes("归属冲突"))).toBe(true);
    click(button(tree, "复核未完成项")!); tree = render();
    expect(network.post).toHaveBeenCalledTimes(1);
    network.post.mockReturnValue(new Promise(() => {}));
    click(button(tree, "确认重试 1 项")!);
    expect(network.post.mock.calls[1][1].items).toEqual([{ shopName: "QA", platformSkuId: "platform-99", skuId: 99 }]);
  });
  it("keeps uncertain network outcomes distinct and offers no blind retry", async () => {
    let tree = await loaded("pmc");
    network.fetch.mockResolvedValue(data("pmc"));
    click(button(tree, "一键认领")!); tree = render();
    network.post.mockRejectedValueOnce(new Error("网络断开；操作可能已完成"));
    await (modal(tree).props.onOk as () => Promise<void>)(); await flush(); tree = render();
    expect(modal(tree).props.title).toContain("处理结果");
    expect(elements(modal(tree)).some(e => String(e.props.message).includes("结果未确认"))).toBe(true);
    expect(button(tree, "复核未完成项")).toBeUndefined();
    expect(network.post).toHaveBeenCalledTimes(1);
  });
});
