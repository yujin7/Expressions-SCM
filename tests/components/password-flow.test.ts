import React, { isValidElement, type ReactNode } from "react";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import PasswordClient from "@/app/(app)/account/password/password-client";

const state = vi.hoisted(() => ({ cursor: 0, slots: [] as unknown[], cleanup: undefined as (() => void) | undefined }));
const ui = vi.hoisted(() => ({ navigate: vi.fn(), error: vi.fn(), success: vi.fn(), resetFields: vi.fn(), signOut: vi.fn(), post: vi.fn() }));
vi.mock("next-auth/react", () => ({ signOut: ui.signOut }));
vi.mock("@/components/fetchJson", () => ({ postJson: ui.post, fetchJson: ui.post }));
vi.mock("antd", () => ({ App: { useApp: () => ({ message: ui }) }, Alert: "alert", Button: "button", Card: "card", Form: Object.assign("form", { useForm: () => [{ resetFields: ui.resetFields }], Item: "item" }), Input: { Password: "password" }, Typography: { Title: "h4", Paragraph: "p", Link: "a" } }));
vi.mock("@ant-design/icons", () => ({ LockOutlined: "lock" }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(),
  useEffect: (fn: () => () => void) => { state.cleanup = fn(); },
  useState: (initial: unknown) => { const i = state.cursor++; if (!(i in state.slots)) state.slots[i] = initial; return [state.slots[i], (v: unknown) => { state.slots[i] = v; }]; },
  useRef: (initial: unknown) => { const i = state.cursor++; if (!(i in state.slots)) state.slots[i] = { current: initial }; return state.slots[i]; },
}));
type Node = React.ReactElement<Record<string, unknown> & { children?: ReactNode }>;
const nodes = (v: ReactNode): Node[] => Array.isArray(v) ? v.flatMap(nodes) : isValidElement<Node["props"]>(v) ? [v, ...nodes(v.props.children), ...nodes(v.props.description as ReactNode)] : [];
const render = () => { state.cursor = 0; return nodes(PasswordClient()); };
const submit = () => {
  const send = render().find(n => n.props.onFinish)!.props.onFinish as (v: unknown) => Promise<void> | void;
  return async (v: unknown) => { await send(v); for (let i = 0; i < 20; i++) await Promise.resolve(); };
};
const values = { oldPassword: "synthetic-old", newPassword: "synthetic-new", confirmPassword: "synthetic-new" };
beforeEach(() => { state.cursor = 0; state.slots = []; vi.resetAllMocks(); vi.useFakeTimers(); vi.stubGlobal("React", React); vi.stubGlobal("window", { location: { replace: ui.navigate } }); });
afterEach(() => { state.cleanup?.(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it("two submissions before a render perform one password write", async () => {
  const pending = Promise.withResolvers<unknown>(); ui.post.mockReturnValue(pending.promise);
  const send = submit(); const first = send(values); const second = send(values);
  expect(ui.post).toHaveBeenCalledOnce(); pending.resolve({ ok: true }); await first; await second;
});
it("confirmed write goes straight to a fresh login without a second logout network dependency", async () => {
  ui.post.mockResolvedValue({ ok: true }); await submit()(values);
  expect(ui.signOut).not.toHaveBeenCalled();
  expect(ui.navigate).toHaveBeenCalledExactlyOnceWith("/login?passwordChanged=1");
  expect(ui.resetFields).toHaveBeenCalledOnce();
});
it("a navigation exception cannot turn a saved password into failure or unlock a second write", async () => {
  ui.post.mockResolvedValue({ ok: true }); ui.navigate.mockImplementationOnce(() => { throw Error("navigation blocked"); });
  const send = submit(); await send(values); await send(values);
  expect(ui.post).toHaveBeenCalledOnce();
  expect(render().find(n => n.type === "alert")?.props.type).toBe("success");
  expect(render().find(n => n.type === "a")?.props.href).toBe("/login?passwordChanged=1");
});
it("a malformed success response is not confirmation and does not navigate", async () => {
  ui.post.mockResolvedValue({}); await submit()(values);
  expect(ui.navigate).not.toHaveBeenCalled(); expect(render().find(n => n.type === "alert")?.props.type).toBe("error");
});
it("a refused write remains visible and can be retried explicitly", async () => {
  ui.post.mockRejectedValueOnce(Error("原密码不正确")).mockResolvedValueOnce({ ok: true });
  const send = submit(); await send(values);
  expect(render().find(n => n.type === "alert")?.props.message).toContain("原密码不正确");
  await send(values); expect(ui.post).toHaveBeenCalledTimes(2);
});
it("timeout is an unknown result, and a late success cannot navigate or replace its warning", async () => {
  const pending = Promise.withResolvers<unknown>(); ui.post.mockReturnValue(pending.promise);
  const first = submit()(values); await vi.advanceTimersByTimeAsync(15_000);
  expect(render().find(n => n.type === "alert")?.props.message).toContain("可能已修改");
  expect(ui.post).toHaveBeenCalledOnce();
  expect(ui.post.mock.calls[0][1].signal.aborted).toBe(true);
  pending.resolve({ ok: true }); await first;
  expect(ui.navigate).not.toHaveBeenCalled(); expect(ui.resetFields).not.toHaveBeenCalled();
});
it("leaving the page cancels the owned request and suppresses a late navigation", async () => {
  const pending = Promise.withResolvers<unknown>(); ui.post.mockReturnValue(pending.promise);
  const first = submit()(values); state.cleanup?.(); pending.resolve({ ok: true }); await first;
  expect(ui.navigate).not.toHaveBeenCalled(); expect(ui.post.mock.calls[0][1].signal.aborted).toBe(true);
});
