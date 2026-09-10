import React, { isValidElement, type ReactNode } from "react";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import LoginForm from "@/app/login/login-form";

const mocks = vi.hoisted(() => ({ signIn: vi.fn(), replace: vi.fn(), refresh: vi.fn(), navigate: vi.fn(), error: vi.fn() }));
vi.mock("next-auth/react", () => ({ signIn: mocks.signIn }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: mocks.replace, refresh: mocks.refresh }) }));
vi.mock("antd", () => ({ App: Object.assign("app", { useApp: () => ({ message: { error: mocks.error } }) }), Button: "button", Card: "card", Divider: "divider", Form: Object.assign("form", { Item: "item" }), Input: Object.assign("input", { Password: "password" }), Tooltip: "tooltip", Typography: { Title: "title", Paragraph: "p", Link: "a" } }));
vi.mock("@ant-design/icons", () => ({ LockOutlined: "lock", UserOutlined: "user" }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(), useState: (v: unknown) => [v, vi.fn()], useRef: (v: unknown) => ({ current: v }) }));
type Node = React.ReactElement<{ children?: ReactNode; onFinish?: (v: unknown) => Promise<void> }>;
const nodes = (v: ReactNode): Node[] => Array.isArray(v) ? v.flatMap(nodes) : isValidElement<Node["props"]>(v) ? [v, ...nodes(v.props.children)] : [];
const form = () => {
  const child = LoginForm({ feishuEnabled: false }).props.children;
  const inner = child.type as (p: { feishuEnabled: boolean }) => ReactNode;
  return nodes(inner(child.props)).find(n => n.props.onFinish)!.props.onFinish!;
};
beforeEach(() => { vi.clearAllMocks(); vi.stubGlobal("React", React); vi.stubGlobal("window", { location: { search: "", replace: mocks.navigate } }); });
afterEach(() => vi.unstubAllGlobals());
it("confirmed login performs one fresh document navigation, without racing router refresh", async () => {
  mocks.signIn.mockResolvedValue({ ok: true, status: 200, error: null });
  await form()({ username: "qa", password: "synthetic" });
  expect(mocks.navigate).toHaveBeenCalledExactlyOnceWith("/");
  expect(mocks.replace).not.toHaveBeenCalled(); expect(mocks.refresh).not.toHaveBeenCalled();
});
it("allows only one login attempt until document navigation finishes", async () => {
  const result = Promise.withResolvers<unknown>();
  mocks.signIn.mockReturnValue(result.promise);
  const submit = form();
  const pending = submit({ username: "qa", password: "synthetic" });
  await submit({ username: "qa", password: "synthetic" });
  expect(mocks.signIn).toHaveBeenCalledOnce();
  result.resolve({ ok: true, status: 200, error: null });
  await pending;
  await submit({ username: "qa", password: "synthetic" });
  expect(mocks.signIn).toHaveBeenCalledOnce();
  expect(mocks.navigate).toHaveBeenCalledOnce();
});
it("unlocks a failed attempt so the user can retry explicitly", async () => {
  mocks.signIn.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce({ ok: true, error: null });
  const submit = form();
  await submit({ username: "qa", password: "synthetic" });
  expect(mocks.navigate).not.toHaveBeenCalled();
  await submit({ username: "qa", password: "synthetic" });
  expect(mocks.signIn).toHaveBeenCalledTimes(2);
  expect(mocks.error).toHaveBeenCalledOnce();
  expect(mocks.navigate).toHaveBeenCalledOnce();
});
it.each([undefined, { ok: false }, { ok: false, error: "CredentialsSignin", code: "invalid" }])("does not navigate for an unconfirmed auth result %j", async result => {
  mocks.signIn.mockResolvedValue(result); await form()({ username: "qa", password: "synthetic" });
  expect(mocks.navigate).not.toHaveBeenCalled(); expect(mocks.replace).not.toHaveBeenCalled(); expect(mocks.error).toHaveBeenCalledOnce();
});
it.each([
  ["/master/sku?name=%E7%B2%BE%E5%8D%8E#details", "/master/sku?name=%E7%B2%BE%E5%8D%8E#details"],
  ["//evil.example", "/"], ["/\\evil.example", "/"], ["https://evil.example", "/"],
])("preserves only safe callback %s", async (callback, expected) => {
  window.location.search = `?callbackUrl=${encodeURIComponent(callback)}`;
  mocks.signIn.mockResolvedValue({ ok: true, status: 200, error: null });
  await form()({ username: "qa", password: "synthetic" }); expect(mocks.navigate).toHaveBeenCalledExactlyOnceWith(expected);
});
