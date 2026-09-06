import React, { isValidElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AlertCloseModal, { type AlertCloseModalProps, type AlertCloseResult } from "@/components/AlertCloseModal";

// Drive the actual component's callbacks without a DOM dependency. These tests cover
// request/lifecycle behavior and control props, not browser rendering or visual QA.
const hooks = vi.hoisted(() => ({
  cursor: 0,
  slots: [] as unknown[],
  effects: [] as (() => void)[],
  cleanups: new Map<number, () => void>(),
  changed: false,
}));
const mocks = vi.hoisted(() => ({
  post: vi.fn(),
  message: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

vi.mock("react", async (importOriginal) => ({
  ...await importOriginal<typeof import("react")>(),
  useState: <T,>(initial: T | (() => T)) => {
    const index = hooks.cursor++;
    if (!(index in hooks.slots)) hooks.slots[index] = typeof initial === "function" ? (initial as () => T)() : initial;
    return [hooks.slots[index], (next: T | ((previous: T) => T)) => {
      const value = typeof next === "function" ? (next as (previous: T) => T)(hooks.slots[index] as T) : next;
      if (!Object.is(hooks.slots[index], value)) hooks.changed = true;
      hooks.slots[index] = value;
    }];
  },
  useRef: <T,>(initial: T) => {
    const index = hooks.cursor++;
    if (!(index in hooks.slots)) hooks.slots[index] = { current: initial };
    return hooks.slots[index];
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
vi.mock("antd", () => ({
  App: { useApp: () => ({ message: mocks.message }) },
  Modal: "mock-modal",
  Select: "mock-select",
  Alert: "mock-alert",
  Space: "mock-space",
  Input: { TextArea: "mock-textarea" },
  Typography: { Paragraph: "p", Text: "span" },
}));
vi.mock("@/components/fetchJson", () => ({ postJson: mocks.post }));

type ModalProps = {
  open: boolean;
  onOk: () => void;
  onCancel: () => void;
  confirmLoading: boolean;
  closable: boolean;
  maskClosable: boolean;
  keyboard: boolean;
  okButtonProps: { disabled: boolean };
  cancelButtonProps: { disabled: boolean };
  children: ReactNode;
};
type ControlProps = {
  "aria-label"?: string;
  children?: ReactNode;
  disabled?: boolean;
  value?: unknown;
  onChange: (value: unknown) => void;
};

function render(props: AlertCloseModalProps): ModalProps {
  for (let pass = 0; pass < 5; pass += 1) {
    hooks.cursor = 0;
    hooks.changed = false;
    const element = AlertCloseModal(props);
    for (const effect of hooks.effects.splice(0)) effect();
    if (!hooks.changed) return element.props as ModalProps;
  }
  throw new Error("Component did not settle");
}

function control(node: ReactNode, label: string): ControlProps | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = control(child, label);
      if (found) return found;
    }
  } else if (isValidElement<ControlProps>(node)) {
    if (node.props["aria-label"] === label) return node.props;
    return control(node.props.children, label);
  }
}

function unmount() {
  for (const cleanup of hooks.cleanups.values()) cleanup();
  hooks.cleanups.clear();
}

function deferred() {
  let resolve!: (result: AlertCloseResult) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<AlertCloseResult>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const result = (id: number): AlertCloseResult => ({ id, resolvedAt: "2026-09-06T00:00:00Z", reasonCode: "fixed" });
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
let props: AlertCloseModalProps;

beforeEach(() => {
  // This repository's Vitest JSX transform is classic (Next uses automatic JSX).
  // Supply its runtime explicitly per case and restore it below; no ambient globals.
  vi.stubGlobal("React", React);
  hooks.cursor = 0;
  hooks.slots = [];
  hooks.effects = [];
  hooks.changed = false;
  hooks.cleanups.clear();
  vi.clearAllMocks();
  mocks.post.mockReset();
  props = { open: true, alertId: 11, onCancel: vi.fn(), onClosed: vi.fn() };
});
afterEach(() => {
  unmount();
  vi.unstubAllGlobals();
});

describe("AlertCloseModal submission lifecycle", () => {
  it("blocks duplicate submits and cancellation synchronously, and locks all controls while pending", async () => {
    const pending = deferred();
    mocks.post.mockReturnValue(pending.promise);
    const initial = render(props);
    initial.onOk();
    initial.onOk();
    initial.onCancel();
    expect(mocks.post).toHaveBeenCalledExactlyOnceWith("/api/alerts/11/close", { reasonCode: "fixed", note: undefined });
    expect(props.onCancel).not.toHaveBeenCalled();
    const busy = render(props);
    expect(busy.confirmLoading).toBe(true);
    expect([busy.closable, busy.maskClosable, busy.keyboard]).toEqual([false, false, false]);
    expect(busy.okButtonProps.disabled).toBe(true);
    expect(busy.cancelButtonProps.disabled).toBe(true);
    expect(control(busy.children, "关闭原因")?.disabled).toBe(true);
    expect(control(busy.children, "关闭备注")?.disabled).toBe(true);
    pending.resolve(result(11));
    await flush();
    expect(props.onClosed).toHaveBeenCalledExactlyOnceWith(result(11));
    expect(render(props).confirmLoading).toBe(false);
  });

  it("a late success cannot close another target or unlock its pending request", async () => {
    const old = deferred();
    const current = deferred();
    mocks.post.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    render(props).onOk();
    props = { ...props, alertId: 22 };
    render(props).onOk();
    old.resolve(result(11));
    await flush();
    expect(props.onClosed).not.toHaveBeenCalled();
    expect(mocks.message.success).not.toHaveBeenCalled();
    const stillBusy = render(props);
    expect(stillBusy.confirmLoading).toBe(true);
    stillBusy.onOk();
    expect(mocks.post).toHaveBeenCalledTimes(2);
    current.resolve(result(22));
    await flush();
    expect(props.onClosed).toHaveBeenCalledExactlyOnceWith(result(22));
  });

  it("a late error from another target does not report against or unlock the new dialog", async () => {
    const old = deferred();
    const current = deferred();
    mocks.post.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    render(props).onOk();
    props = { ...props, alertId: 22 };
    render(props).onOk();
    old.reject(new Error("old target failed"));
    await flush();
    expect(mocks.message.error).not.toHaveBeenCalled();
    expect(render(props).confirmLoading).toBe(true);
    current.resolve(result(22));
    await flush();
    expect(props.onClosed).toHaveBeenCalledExactlyOnceWith(result(22));
  });

  it("closing and reopening the same ID invalidates its previous dialog session", async () => {
    const pending = deferred();
    mocks.post.mockReturnValueOnce(pending.promise);
    render(props).onOk();
    render({ ...props, open: false });
    const reopened = render(props);
    expect(reopened.confirmLoading).toBe(false);
    pending.resolve(result(11));
    await flush();
    expect(props.onClosed).not.toHaveBeenCalled();
    expect(mocks.message.success).not.toHaveBeenCalled();
  });

  it("does not call back or emit success after unmount", async () => {
    const pending = deferred();
    mocks.post.mockReturnValueOnce(pending.promise);
    render(props).onOk();
    unmount();
    pending.resolve(result(11));
    await flush();
    expect(props.onClosed).not.toHaveBeenCalled();
    expect(mocks.message.success).not.toHaveBeenCalled();
  });

  it("an active failure releases the lock, reports the error, and allows retry", async () => {
    const pending = deferred();
    mocks.post.mockReturnValueOnce(pending.promise).mockResolvedValueOnce(result(11));
    render(props).onOk();
    pending.reject(new Error("permission changed"));
    await flush();
    expect(mocks.message.error).toHaveBeenCalledExactlyOnceWith("permission changed");
    expect(props.onClosed).not.toHaveBeenCalled();
    const retry = render(props);
    expect(retry.confirmLoading).toBe(false);
    expect(retry.cancelButtonProps.disabled).toBe(false);
    retry.onOk();
    await flush();
    expect(mocks.post).toHaveBeenCalledTimes(2);
    expect(props.onClosed).toHaveBeenCalledExactlyOnceWith(result(11));
  });

  it("preserves the manual-reason requirement and submits the trimmed explanation", async () => {
    props = { ...props, defaultReasonCode: "manual" };
    render(props).onOk();
    expect(mocks.message.warning).toHaveBeenCalledOnce();
    expect(mocks.post).not.toHaveBeenCalled();
    expect(render(props).confirmLoading).toBe(false);
    control(render(props).children, "关闭备注")!.onChange({ target: { value: "  业务负责人已核实  " } });
    mocks.post.mockResolvedValueOnce({ ...result(11), reasonCode: "manual" });
    render(props).onOk();
    await flush();
    expect(mocks.post).toHaveBeenCalledExactlyOnceWith("/api/alerts/11/close", { reasonCode: "manual", note: "业务负责人已核实" });
    expect(props.onClosed).toHaveBeenCalledOnce();
  });

  it("does not submit hidden or targetless dialogs; idle cancellation still works", () => {
    render({ ...props, open: false }).onOk();
    render({ ...props, alertId: null }).onOk();
    render(props).onCancel();
    expect(mocks.post).not.toHaveBeenCalled();
    expect(props.onCancel).toHaveBeenCalledOnce();
  });
});
