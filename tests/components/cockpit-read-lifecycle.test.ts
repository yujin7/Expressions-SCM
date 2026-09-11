import React, { isValidElement, type ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import CockpitClient from "@/app/(app)/cockpit/cockpit-client";
import { useTrends } from "@/app/(app)/cockpit/trends/shared";
import GoalProgressCard from "@/app/(app)/goals/GoalProgressCard";

// Production callbacks and read hook, not a replacement for browser/scheduler evidence.
const hooks = vi.hoisted(() => ({ cursor: 0, slots: [] as unknown[], effects: [] as (() => void)[], cleanups: new Map<number, () => void>(), changed: false }));
const navigation = vi.hoisted(() => ({ query: "", replace: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: navigation.replace }), useSearchParams: () => new URLSearchParams(navigation.query) }));
vi.mock("next/link", () => ({ default: "a" }));
vi.mock("@/app/(app)/cockpit/trends/CockpitTrends", () => ({ default: "trends" }));
vi.mock("@/components/DecisionVisual", () => ({ default: "visual" }));
vi.mock("@/components/LoadErrorAlert", () => ({ default: "load-error" }));
vi.mock("antd", () => ({ Alert: "alert", Button: "button", Card: "card", Col: "col", Collapse: "collapse", Empty: Object.assign("empty", { PRESENTED_IMAGE_SIMPLE: "empty" }), Row: "row", Skeleton: "skeleton", Space: "space", Statistic: "statistic", Table: "table", Tabs: "tabs", Tag: "tag", Tooltip: "tooltip", Typography: { Text: "text", Paragraph: "p" }, theme: { useToken: () => ({ token: {} }) } }));
vi.mock("react", async original => ({
  ...await original<typeof import("react")>(),
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
let surface: "cockpit" | "trends" | "goals" = "cockpit";
let summaryRevision = 0;
const empty = { state: "insufficient", data: null, source: { tier: "fact", source: "QA", asOf: null }, note: "暂无事实" };
const mainData = (roleLabel: string) => ({ topbar: { roleLabel }, screens: { sources: { position: empty, ratio: empty, dataSources: empty, monthlySalesBlock: empty }, alerts: { redline: [] } }, limitations: [] });
const trendData = (calibreVersion: string) => ({ calibreVersion });
function TrendsProbe() { return React.createElement("probe", useTrends()); }
function render(effects = true): Node {
  for (let n = 0; n < 10; n++) {
    hooks.cursor = 0; hooks.changed = false;
    const tree = (surface === "cockpit" ? CockpitClient() : surface === "goals" ? GoalProgressCard({ refreshKey: summaryRevision }) : TrendsProbe()) as Node;
    if (!effects) return tree;
    for (const effect of hooks.effects.splice(0)) effect();
    if (!hooks.changed) return tree;
  }
  throw Error("Read did not settle");
}
const flush = async () => { render(); for (let i = 0; i < 20; i++) await Promise.resolve(); return render(); };
const cleanup = () => { for (const fn of hooks.cleanups.values()) fn(); hooks.cleanups.clear(); };
function resetHooks() { cleanup(); hooks.slots = []; hooks.effects = []; hooks.changed = false; }
const reloadMain = () => (nodes(render()).find(n => n.type === "button" && words(n.props.children) === "刷新")!.props.onClick as () => void)();
beforeEach(() => { resetHooks(); surface = "cockpit"; summaryRevision = 0; navigation.query = ""; navigation.replace.mockReset(); fetchMock.mockReset(); vi.useFakeTimers(); vi.stubGlobal("React", React); vi.stubGlobal("fetch", fetchMock); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it("mounts the independent trends reader even while the summary is pending", () => {
  fetchMock.mockReturnValue(new Promise(() => {}));
  expect(nodes(render()).filter(n => n.type === "trends")).toHaveLength(1);
});
it("summary refresh immediately withdraws old facts; failure stays explicit without zero substitution", async () => {
  fetchMock.mockResolvedValueOnce(Response.json(mainData("旧角色范围"))); render(); await flush();
  expect(words(render())).toContain("旧角色范围");
  fetchMock.mockResolvedValueOnce(Response.json({ error: "QA失败" }, { status: 503 })); reloadMain();
  expect(words(render(false))).not.toContain("旧角色范围");
  const tree = await flush(); expect(words(tree)).not.toContain("旧角色范围");
  expect(nodes(tree).find(n => n.type === "load-error")?.props.error).toBe("QA失败");
  expect(fetchMock).toHaveBeenCalledTimes(2);
});
it("summary times out and ignores its late success until explicit retry", async () => {
  const late = Promise.withResolvers<Response>(); fetchMock.mockReturnValueOnce(late.promise); render();
  await vi.advanceTimersByTimeAsync(15000); expect(nodes(render()).find(n => n.type === "load-error")?.props.error).toContain("超时");
  late.resolve(Response.json(mainData("迟到"))); await flush(); expect(words(render())).not.toContain("迟到");
  fetchMock.mockResolvedValueOnce(Response.json(mainData("新范围"))); reloadMain(); await flush(); expect(words(render())).toContain("新范围");
});
it("trends refresh removes old data and cancels an obsolete response", async () => {
  surface = "trends"; fetchMock.mockResolvedValueOnce(Response.json(trendData("OLD"))); render(); await flush();
  const late = Promise.withResolvers<Response>(); fetchMock.mockReturnValueOnce(late.promise);
  (render().props.reload as () => void)(); expect(render(false).props.data).toBeNull(); render();
  fetchMock.mockResolvedValueOnce(Response.json(trendData("CURRENT"))); (render().props.reload as () => void)(); render(); await flush();
  late.resolve(Response.json(trendData("LATE"))); await flush(); expect(render().props.data).toEqual(trendData("CURRENT"));
});
it("trends failure is not hidden behind a previous success and cannot auto-retry", async () => {
  surface = "trends"; fetchMock.mockResolvedValueOnce(Response.json(trendData("CURRENT"))); render(); await flush();
  fetchMock.mockResolvedValueOnce(Response.json({ error: "趋势失败" }, { status: 503 })); (render().props.reload as () => void)(); render(); await flush();
  expect(render().props).toMatchObject({ data: null, error: "趋势失败", loading: false });
  await vi.advanceTimersByTimeAsync(20000); expect(fetchMock).toHaveBeenCalledTimes(2);
});
it("unmount and revisit cannot reuse a previous session's module cache", async () => {
  surface = "trends"; fetchMock.mockResolvedValueOnce(Response.json(trendData("USER-A"))); render(); await flush();
  resetHooks(); fetchMock.mockReturnValueOnce(new Promise(() => {}));
  expect(render().props.data).toBeNull(); expect(fetchMock).toHaveBeenCalledTimes(2);
});

const goalSummary = (attained = 0, withActual = 0) => ({ generatedAt: "2026-09-10T12:00:00Z", periods: { month: "2026-09", quarter: "2026-Q3" }, byDept: [{ deptKey: "purchasing", total: 2, attained, withActual, attainmentRate: withActual ? "0" : null, editable: true }], caliber: "真实分母", href: "/goals" });
it("目标摘要加载时不谎称未设置，成功后无可评估值不显示0/0", async () => {
  surface = "goals"; const pending = Promise.withResolvers<Response>(); fetchMock.mockReturnValueOnce(pending.promise);
  expect(words(render())).not.toContain("尚未设置"); expect(nodes(render()).some(n => n.type === "skeleton")).toBe(true);
  pending.resolve(Response.json(goalSummary())); await flush();
  const stat = nodes(render()).find(n => n.type === "statistic")!;
  expect(stat.props.title).toContain("无可评估目标"); expect(stat.props.title).not.toContain("0/0");
});
it("目标摘要刷新失败撤旧并提供重试，重试成功不残留错误", async () => {
  surface = "goals"; fetchMock.mockResolvedValueOnce(Response.json(goalSummary(0, 2))); render(); await flush();
  fetchMock.mockResolvedValueOnce(Response.json({ error: "摘要失败" }, { status: 503 })); summaryRevision++;
  expect(nodes(render(false)).some(n => n.type === "statistic")).toBe(false);
  await flush(); const alert = nodes(render()).find(n => n.type === "load-error")!;
  expect(alert.props.error).toBe("摘要失败"); expect(nodes(render()).some(n => n.type === "statistic")).toBe(false);
  fetchMock.mockResolvedValueOnce(Response.json(goalSummary(0, 2))); (alert.props.onRetry as () => void)(); await flush();
  expect(nodes(render()).find(n => n.type === "load-error")?.props.error).toBeFalsy();
  expect(nodes(render()).find(n => n.type === "statistic")?.props.title).toContain("0/2 达成");
});
it("目标摘要忽略旧刷新迟到的结果，并在15秒超时后保留未知态", async () => {
  surface = "goals"; const old = Promise.withResolvers<Response>(); fetchMock.mockReturnValueOnce(old.promise); render();
  summaryRevision++; fetchMock.mockResolvedValueOnce(Response.json(goalSummary(0, 2))); render(); await flush();
  old.resolve(Response.json(goalSummary())); await flush();
  expect(nodes(render()).find(n => n.type === "statistic")?.props.title).toContain("0/2 达成");
  summaryRevision++; fetchMock.mockReturnValueOnce(new Promise(() => {})); render(); await vi.advanceTimersByTimeAsync(15000);
  expect(nodes(render()).find(n => n.type === "load-error")?.props.error).toContain("超时");
  expect(nodes(render()).some(n => n.type === "statistic")).toBe(false);
});
