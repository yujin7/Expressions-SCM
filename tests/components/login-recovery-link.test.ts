import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import LoginForm from "@/app/login/login-form";

const mocks = vi.hoisted(() => ({ signIn: vi.fn(), replace: vi.fn(), refresh: vi.fn() }));
vi.mock("next-auth/react", () => ({ signIn: mocks.signIn }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: mocks.replace, refresh: mocks.refresh }) }));
afterEach(() => vi.unstubAllGlobals());

describe("login session recovery entry", () => {
  it.each([false, true])("offers a same-origin confirmation link with Feishu enabled=%s, not a password reset", (feishuEnabled) => {
    vi.stubGlobal("React", React);
    const html = renderToStaticMarkup(createElement(LoginForm, { feishuEnabled }));
    expect(html).toMatch(/<a[^>]*href="\/signout"[^>]*>清除当前登录状态<\/a>/);
    expect(html).toContain("仅清理此入口的会话，不会重置密码");
    expect(mocks.signIn).not.toHaveBeenCalled();
    expect(mocks.replace).not.toHaveBeenCalled();
  });
});
