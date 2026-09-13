import React, { isValidElement, type ReactNode } from "react";
import dayjs from "dayjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import TodoCreateDrawer, { type TodoCreateDrawerProps } from "@/app/(app)/todo/TodoCreateDrawer";
import { loadTodoCreate, todoCreateKey } from "@/components/todo-create-request";

// Invoke the actual component and its callbacks with instance-local hook storage.
// This proves request/lifecycle behavior and AntD control props, not DOM/visual QA.
interface Instance {
  cursor: number;
  slots: unknown[];
  effects: (() => void)[];
  cleanups: Map<number, () => void>;
  changed: boolean;
  unmounted: boolean;
  writesAfterUnmount: number;
  form: { validateFields: ReturnType<typeof vi.fn>; resetFields: ReturnType<typeof vi.fn>; setFieldsValue: ReturnType<typeof vi.fn> };
}
const hooks = vi.hoisted(() => ({ current: null as Instance | null }));
const mocks = vi.hoisted(() => ({
  post: vi.fn(),
  message: { success: vi.fn(), warning: vi.fn() },
}));

vi.mock("react", async (importOriginal) => ({
  ...await importOriginal<typeof import("react")>(),
  useState: <T,>(initial: T | (() => T)) => {
    const instance = hooks.current!;
    const index = instance.cursor++;
    if (!(index in instance.slots)) instance.slots[index] = typeof initial === "function" ? (initial as () => T)() : initial;
    return [instance.slots[index], (next: T | ((previous: T) => T)) => {
      if (instance.unmounted) instance.writesAfterUnmount += 1;
      const value = typeof next === "function" ? (next as (previous: T) => T)(instance.slots[index] as T) : next;
      if (!Object.is(instance.slots[index], value)) instance.changed = true;
      instance.slots[index] = value;
    }];
  },
  useRef: <T,>(initial: T) => {
    const instance = hooks.current!;
    const index = instance.cursor++;
    if (!(index in instance.slots)) instance.slots[index] = { current: initial };
    return instance.slots[index];
  },
  useLayoutEffect: (effect: () => void | (() => void), deps: readonly unknown[]) => {
    const instance = hooks.current!;
    const index = instance.cursor++;
    const previous = instance.slots[index] as readonly unknown[] | undefined;
    if (previous && previous.length === deps.length && previous.every((value, i) => Object.is(value, deps[i]))) return;
    instance.slots[index] = deps;
    instance.effects.push(() => {
      instance.cleanups.get(index)?.();
      instance.cleanups.delete(index);
      const cleanup = effect();
      if (cleanup) instance.cleanups.set(index, cleanup);
    });
  },
}));
vi.mock("antd", () => ({
  App: { useApp: () => ({ message: mocks.message }) },
  Drawer: "mock-drawer",
  Alert: "mock-alert",
  Button: "mock-button",
  DatePicker: "mock-datepicker",
  Select: "mock-select",
  Space: "mock-space",
  Input: Object.assign(() => null, { TextArea: "mock-textarea" }),
  Form: Object.assign(() => null, { useForm: () => [hooks.current!.form], Item: "mock-form-item" }),
}));
vi.mock("@/components/fetchJson", () => ({ fetchJson: mocks.post }));

interface DrawerProps {
  open: boolean;
  onClose: () => void;
  closable: boolean;
  maskClosable: boolean;
  keyboard: boolean;
  extra: ReactNode;
  children: ReactNode;
}
interface ElementProps {
  children?: ReactNode;
  description?: ReactNode;
  tabIndex?: number;
  ref?: { current: Pick<HTMLDivElement, "focus" | "scrollIntoView"> | null };
  form?: Instance["form"];
  disabled?: boolean;
  initialValues?: unknown;
  message?: string;
  onClick?: () => void;
  loading?: boolean;
}

const instances: Instance[] = [];
function instance(): Instance {
  const created: Instance = {
    cursor: 0, slots: [], effects: [], cleanups: new Map(), changed: false, unmounted: false, writesAfterUnmount: 0,
    form: { validateFields: vi.fn().mockResolvedValue(values), resetFields: vi.fn(), setFieldsValue: vi.fn() },
  };
  instances.push(created);
  return created;
}
function render(target: Instance, props: TodoCreateDrawerProps): DrawerProps {
  hooks.current = target;
  for (let pass = 0; pass < 5; pass += 1) {
    target.cursor = 0;
    target.changed = false;
    const element = TodoCreateDrawer(props);
    for (const effect of target.effects.splice(0)) effect();
    if (!target.changed) return element.props as DrawerProps;
  }
  throw new Error("Component did not settle");
}
function find(node: ReactNode, predicate: (props: ElementProps) => boolean): ElementProps | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = find(child, predicate);
      if (found) return found;
    }
  } else if (isValidElement<ElementProps>(node)) {
    if (predicate(node.props)) return node.props;
    return find(node.props.children, predicate) ?? find(node.props.description, predicate);
  }
}
function save(drawer: DrawerProps): ElementProps & { onClick: () => void } {
  const button = find(drawer.extra, (props) => typeof props.onClick === "function") ?? find(drawer.children, p => p.children === "确认同一创建");
  if (!button?.onClick) throw new Error("Save button not found");
  return { ...button, onClick: button.onClick };
}
function unmount(target: Instance) {
  for (const cleanup of target.cleanups.values()) cleanup();
  target.cleanups.clear();
  target.unmounted = true;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
const values = { title: "合成 QA 待办", detail: "保留填写内容", assigneeId: 42, ownerRole: "ops", priority: "normal", sourceRef: "QA-PO-001" };
const key = "ec264aa1-38a0-4803-9643-f9371545d3b8";
const created = { requestId: key, itemId: 17, created: true };
let props: TodoCreateDrawerProps;

beforeEach(() => {
  // Vitest uses the classic JSX transform; do not depend on another suite's globals.
  vi.stubGlobal("React", React);
  const data = new Map<string, string>(); vi.stubGlobal("localStorage", { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => data.set(k, v), removeItem: (k: string) => data.delete(k) });
  vi.stubGlobal("window", new EventTarget()); vi.stubGlobal("navigator", { locks: { request: (_key: string, action: () => unknown) => action() } });
  vi.stubGlobal("crypto", { randomUUID: () => key });
  vi.clearAllMocks();
  mocks.post.mockReset();
  instances.length = 0;
  props = {
    actorId: 1,
    defaultAssigneeId: 42,
    roleOptions: [{ value: "ops", label: "运营" }],
    priorityOptions: [{ value: "normal", label: "中" }],
    onCancel: vi.fn(), onCreated: vi.fn(),
  };
});
afterEach(() => {
  for (const target of instances) unmount(target);
  hooks.current = null;
  vi.unstubAllGlobals();
});

describe("TodoCreateDrawer submission lifecycle", () => {
  it("brings an uncertain result into view after the form was submitted from its bottom fields", async () => {
    const target = instance(); const initial = render(target, props);
    const focus = vi.fn(), scrollIntoView = vi.fn();
    find(initial.children, p => p.tabIndex === -1)!.ref!.current = { focus, scrollIntoView };
    mocks.post.mockRejectedValueOnce(Error("原请求结果未确认"));
    save(initial).onClick(); await flush(); render(target, props);
    expect(scrollIntoView).toHaveBeenCalledExactlyOnceWith({ block: "start" });
    expect(focus).toHaveBeenLastCalledWith({ preventScroll: true }); expect(loadTodoCreate(localStorage, 1)).not.toBeNull();
  });
  it("locks before async validation, ignores rapid clicks and blocks closing synchronously", async () => {
    const target = instance();
    const validation = deferred<typeof values>();
    const request = deferred<typeof created>();
    target.form.validateFields.mockReturnValue(validation.promise);
    mocks.post.mockReturnValue(request.promise);
    const initial = render(target, props);
    save(initial).onClick();
    save(initial).onClick();
    initial.onClose();
    expect(target.form.validateFields).toHaveBeenCalledOnce();
    expect(mocks.post).not.toHaveBeenCalled();
    expect(props.onCancel).not.toHaveBeenCalled();
    const validating = render(target, props);
    expect([validating.closable, validating.maskClosable, validating.keyboard]).toEqual([false, false, false]);
    expect(save(validating)).toMatchObject({ loading: true, disabled: true });
    expect(find(validating.children, (p) => p.form === target.form)?.disabled).toBe(true);
    validation.resolve(values);
    await flush();
    const submitting = render(target, props);
    save(submitting).onClick();
    submitting.onClose();
    expect(target.form.validateFields).toHaveBeenCalledOnce();
    expect(mocks.post).toHaveBeenCalledOnce(); expect(JSON.parse(mocks.post.mock.calls[0][1].body)).toEqual({ ...values, dueDate: null, requestId: key });
    expect(props.onCancel).not.toHaveBeenCalled();
    request.resolve(created);
    await flush();
    expect(props.onCreated).toHaveBeenCalledOnce();
    // Still mounted until the parent commits removal: success must not unlock a second POST.
    save(render(target, props)).onClick();
    expect(mocks.post).toHaveBeenCalledOnce();
    expect(mocks.message.success).toHaveBeenCalledExactlyOnceWith("已确认待办 #17，可从页面提示打开准确任务");
  });

  it.each([{ errorFields: [{ name: ["title"], errors: ["标题必填"] }] }, new Error("validator unavailable")])(
    "handles rejected validation without POST, preserves fields and permits a deliberate retry: %j", async (validationError) => {
      const target = instance();
      target.form.validateFields.mockRejectedValueOnce(validationError).mockResolvedValueOnce(values);
      mocks.post.mockResolvedValue(created);
      save(render(target, props)).onClick();
      await flush();
      expect(mocks.post).not.toHaveBeenCalled();
      expect(mocks.message.warning).toHaveBeenCalledExactlyOnceWith("请检查必填项及输入内容");
      expect(target.form.resetFields).not.toHaveBeenCalled();
      const retry = render(target, props);
      expect(save(retry)).toMatchObject({ loading: false, disabled: false });
      expect(find(retry.children, (p) => p.form === target.form)?.disabled).toBe(false);
      save(retry).onClick();
      await flush();
      expect(mocks.post).toHaveBeenCalledOnce();
      expect(props.onCreated).toHaveBeenCalledOnce();
    },
  );

  it("preserves fields after API failure and retries only on a fresh user click", async () => {
    const target = instance();
    mocks.post.mockRejectedValueOnce(new Error("责任人已停用")).mockResolvedValueOnce(created);
    save(render(target, props)).onClick();
    await flush();
    const failed = render(target, props);
    expect(find(failed.children, (p) => Boolean(p.message))?.message).toBe("责任人已停用");
    expect([failed.closable, failed.maskClosable, failed.keyboard]).toEqual([true, true, true]);
    expect(save(failed).loading).toBe(false);
    expect(props.onCreated).not.toHaveBeenCalled();
    expect(props.onCancel).not.toHaveBeenCalled();
    expect(target.form.resetFields).not.toHaveBeenCalled();
    await flush();
    expect(mocks.post).toHaveBeenCalledOnce();
    save(failed).onClick();
    expect(find(render(target, props).children, (p) => p.message === "责任人已停用")).toBeUndefined();
    await flush();
    expect(mocks.post).toHaveBeenCalledTimes(2);
    expect(props.onCreated).toHaveBeenCalledOnce();
  });

  it("retains the helper's uncertain-write warning and never schedules a retry", async () => {
    const target = instance();
    const warning = "网络连接异常，未能获取服务器响应。操作可能已在服务端完成，请先核对结果，勿重复提交";
    mocks.post.mockRejectedValueOnce(new Error(warning));
    save(render(target, props)).onClick();
    await flush();
    expect(find(render(target, props).children, (p) => Boolean(p.message))?.message).toBe(warning);
    await flush();
    expect(mocks.post).toHaveBeenCalledOnce();
    expect(props.onCreated).not.toHaveBeenCalled();
  });

  it.each([null, {}, { created: true }, { created: true, reopened: true }])("does not claim success for an unconfirmed JSON result %j", async (result) => {
    const target = instance();
    mocks.post.mockResolvedValueOnce(result);
    save(render(target, props)).onClick();
    await flush();
    expect(find(render(target, props).children, (p) => Boolean(p.message))?.message).toContain("请先核对待办列表，勿重复提交");
    expect(mocks.message.success).not.toHaveBeenCalled();
    expect(props.onCreated).not.toHaveBeenCalled();
    expect(mocks.post).toHaveBeenCalledOnce();
  });

  it("does not start a write when unmounted during validation", async () => {
    const target = instance();
    const validation = deferred<typeof values>();
    target.form.validateFields.mockReturnValue(validation.promise);
    const initial = render(target, props);
    save(initial).onClick();
    unmount(target);
    validation.resolve(values);
    await flush();
    save(initial).onClick();
    initial.onClose();
    expect(mocks.post).not.toHaveBeenCalled();
    expect(props.onCreated).not.toHaveBeenCalled();
    expect(props.onCancel).not.toHaveBeenCalled();
    expect(target.writesAfterUnmount).toBe(0);
  });

  it("ignores a validation failure after unmount without a toast or state write", async () => {
    const target = instance();
    const validation = deferred<typeof values>();
    target.form.validateFields.mockReturnValue(validation.promise);
    save(render(target, props)).onClick();
    unmount(target);
    validation.reject(new Error("old validation"));
    await flush();
    expect(mocks.message.warning).not.toHaveBeenCalled();
    expect(mocks.post).not.toHaveBeenCalled();
    expect(target.writesAfterUnmount).toBe(0);
  });

  it.each(["success", "failure"] as const)("a late %s cannot close, report against or unlock a reopened drawer", async (outcome) => {
    const old = instance();
    const oldRequest = deferred<typeof created>();
    const currentRequest = deferred<typeof created>();
    mocks.post.mockReturnValueOnce(oldRequest.promise).mockReturnValueOnce(currentRequest.promise);
    save(render(old, props)).onClick();
    await flush();
    unmount(old);
    const current = instance();
    const nextProps = { ...props, onCancel: vi.fn(), onCreated: vi.fn() };
    const reopened = render(current, nextProps);
    expect(save(reopened).loading).toBe(false);
    expect(loadTodoCreate(localStorage, 1)?.requestId).toBe(key);
    expect(current.form.setFieldsValue).toHaveBeenCalled();
    save(reopened).onClick();
    await flush();
    if (outcome === "success") oldRequest.resolve(created);
    else oldRequest.reject(new Error("old request failed"));
    await flush();
    const stillPending = render(current, nextProps);
    expect(save(stillPending).loading).toBe(true);
    expect(find(stillPending.children, (p) => p.message === "old request failed")).toBeUndefined();
    expect(mocks.message.success).not.toHaveBeenCalled();
    expect(props.onCreated).not.toHaveBeenCalled();
    expect(nextProps.onCreated).not.toHaveBeenCalled();
    save(stillPending).onClick();
    stillPending.onClose();
    expect(nextProps.onCancel).not.toHaveBeenCalled();
    expect(mocks.post).toHaveBeenCalledTimes(2);
    expect(old.writesAfterUnmount).toBe(0);
    currentRequest.resolve(created);
    await flush();
    expect(nextProps.onCreated).toHaveBeenCalledOnce();
  });

  it("can close an idle or failed drawer without creating a task", async () => {
    const target = instance();
    render(target, props).onClose();
    expect(props.onCancel).toHaveBeenCalledOnce();
    expect(mocks.post).not.toHaveBeenCalled();
    mocks.post.mockRejectedValueOnce(new Error("权限不足"));
    save(render(target, props)).onClick();
    await flush();
    render(target, props).onClose();
    expect(props.onCancel).toHaveBeenCalledTimes(2);
  });

  it("preserves validated role, reference and date while adding a stable request key", async () => {
    const target = instance();
    target.form.validateFields.mockResolvedValueOnce({ ...values, dueDate: dayjs("2026-09-19") });
    mocks.post.mockResolvedValueOnce(created);
    save(render(target, props)).onClick();
    await flush();
    expect(mocks.post).toHaveBeenCalledOnce(); expect(JSON.parse(mocks.post.mock.calls[0][1].body)).toEqual({ ...values, dueDate: "2026-09-19", requestId: key });
    expect(target.form.resetFields).not.toHaveBeenCalled();
  });

  it.each([true, false])("new and replayed manual creation both return the exact task %j", async (isNew) => {
    const target = instance();
    mocks.post.mockResolvedValueOnce({ ...created, created: isNew });
    save(render(target, props)).onClick();
    await flush();
    expect(mocks.message.success).toHaveBeenCalledExactlyOnceWith("已确认待办 #17，可从页面提示打开准确任务");
    expect(props.onCreated).toHaveBeenCalledExactlyOnceWith(17);
  });

  it("restores after remount, GETs original intent, and requires explicit acknowledgement without POST", async () => {
    localStorage.setItem(todoCreateKey(1), JSON.stringify({ ...values, dueDate: null, requestId: key }));
    const target = instance();
    const initial = render(target, props);
    expect(mocks.post).not.toHaveBeenCalled();
    mocks.post.mockResolvedValueOnce({ requestId: key, itemId: 17, originalIntent: { ...values, title: "原始而非后来本机的标题", dueDate: null } });
    find(initial.children, p => p.children === "核对原创建结果")!.onClick!(); await flush();
    expect(mocks.post.mock.calls[0][0]).toContain("mode=create-result"); expect(mocks.post.mock.calls[0][1].method).toBeUndefined();
    expect(loadTodoCreate(localStorage, 1)).not.toBeNull(); expect(props.onCreated).not.toHaveBeenCalled();
    const checked = render(target, props);
    expect(find(checked.children, p => p.message === "原请求已创建待办 #17")).toBeDefined();
    find(checked.children, p => p.children === "已核对原任务")!.onClick!(); await flush();
    expect(mocks.post).toHaveBeenCalledOnce(); expect(loadTodoCreate(localStorage, 1)).toBeNull(); expect(props.onCreated).toHaveBeenCalledExactlyOnceWith(17);
  });

  it("missing result only enables deliberate correction, which preserves the request key", async () => {
    localStorage.setItem(todoCreateKey(1), JSON.stringify({ ...values, dueDate: null, requestId: key }));
    const target = instance();
    mocks.post.mockResolvedValueOnce({ requestId: key, itemId: null, originalIntent: null });
    find(render(target, props).children, p => p.children === "核对后修改原请求")!.onClick!(); await flush();
    const editing = render(target, props);
    expect(find(editing.children, p => p.form === target.form)?.disabled).toBe(false); expect(props.onCreated).not.toHaveBeenCalled();
    target.form.validateFields.mockResolvedValueOnce({ ...values, title: "修改后的合成标题" }); mocks.post.mockResolvedValueOnce(created);
    save(editing).onClick(); await flush();
    expect(JSON.parse(mocks.post.mock.calls[1][1].body)).toMatchObject({ requestId: key, title: "修改后的合成标题" });
    expect(props.onCreated).toHaveBeenCalledExactlyOnceWith(17);
  });

  it("does not use a stale drawer to replace another tab's request", async () => {
    localStorage.setItem(todoCreateKey(1), JSON.stringify({ ...values, dueDate: null, requestId: key }));
    const target = instance(); const initial = render(target, props);
    localStorage.setItem(todoCreateKey(1), JSON.stringify({ ...values, dueDate: null, requestId: "ec264aa1-38a0-4803-9643-f9371545d3b9" }));
    save(initial).onClick(); await flush(); expect(mocks.post).not.toHaveBeenCalled();
    expect(find(render(target, props).children, p => p.message === "原请求已变化，请关闭后重新核对")).toBeDefined();
    expect(loadTodoCreate(localStorage, 1)?.requestId.endsWith("b9")).toBe(true);
  });
});
