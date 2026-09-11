import React, { isValidElement, type FormEvent, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SignOutForm, { signOutCurrentOrigin } from "@/app/signout/signout-form";
import SignOutPage from "@/app/signout/page";

// Drive real component callbacks without a DOM dependency. Cookie acceptance and
// browser navigation still require the separate same-origin browser acceptance.
const hooks = vi.hoisted(() => ({
  cursor: 0, slots: [] as unknown[], effects: [] as (() => void)[],
  cleanups: new Map<number, () => void>(), changed: false, writes: 0,
}));
const mocks = vi.hoisted(() => ({ fetch: vi.fn(), navigate: vi.fn(), auth: vi.fn(), redirect: vi.fn() }));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState: <T,>(initial: T) => {
    const index = hooks.cursor++;
    if (!(index in hooks.slots)) hooks.slots[index] = initial;
    return [hooks.slots[index], (value: T) => {
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
  useEffect: (callback: () => void | (() => void), deps: readonly unknown[]) => {
    const index = hooks.cursor++;
    const previous = hooks.slots[index] as readonly unknown[] | undefined;
    if (previous && previous.length === deps.length && previous.every((value, i) => Object.is(value, deps[i]))) return;
    hooks.slots[index] = deps;
    hooks.effects.push(() => {
      hooks.cleanups.get(index)?.();
      hooks.cleanups.delete(index);
      const cleanup = callback();
      if (cleanup) hooks.cleanups.set(index, cleanup);
    });
  },
}));
vi.mock("@/server/auth", () => ({ auth: mocks.auth }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));

type Props = { children?: ReactNode; role?: string; disabled?: boolean; onSubmit?: (event: FormEvent<HTMLFormElement>) => Promise<void>; "aria-busy"?: boolean };
type Element = React.ReactElement<Props>;
function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Props>(node)) return [];
  return [node, ...elements(node.props.children)];
}
function render(commit = true): Element {
  for (let pass = 0; pass < 5; pass += 1) {
    hooks.cursor = 0; hooks.changed = false;
    const tree = SignOutForm();
    if (!commit) return tree;
    for (const effect of hooks.effects.splice(0)) effect();
    if (!hooks.changed) return tree;
  }
  throw new Error("Component did not settle");
}
const form = (tree = render()) => elements(tree).find((node) => node.type === "form")!;
const button = (tree = render()) => elements(tree).find((node) => node.type === "button")!;
const errorText = () => elements(render()).find((node) => node.props.role === "alert")?.props.children;
function unmount() {
  for (const cleanup of hooks.cleanups.values()) cleanup();
  hooks.cleanups.clear();
}
function deferred<T = unknown>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}
function response(body: unknown, options: { status?: number; type?: string } = {}) {
  return {
    ok: (options.status ?? 200) < 400,
    headers: new Headers({ "content-type": options.type ?? "application/json; charset=utf-8" }),
    json: vi.fn().mockResolvedValue(body),
  };
}
const TOKEN = "a".repeat(64);
function successfulResponses(session: unknown = null, destination = "/login") {
  mocks.fetch.mockResolvedValueOnce(response({ csrfToken: TOKEN }))
    .mockResolvedValueOnce(response({ url: destination }))
    .mockResolvedValueOnce(response(session));
}
const event = () => ({ preventDefault: vi.fn() }) as unknown as FormEvent<HTMLFormElement>;
const flush = async () => { for (let i = 0; i < 12; i += 1) await Promise.resolve(); };

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("React", React); // This repository uses the classic JSX transform in Vitest.
  vi.stubGlobal("fetch", mocks.fetch);
  vi.stubGlobal("window", { location: { origin: "http://127.0.0.1:3100", assign: mocks.navigate } });
  hooks.cursor = 0; hooks.slots = []; hooks.effects = []; hooks.cleanups.clear(); hooks.changed = false; hooks.writes = 0;
  mocks.fetch.mockReset(); mocks.navigate.mockReset(); mocks.auth.mockReset(); mocks.redirect.mockReset();
  mocks.redirect.mockImplementation(() => { throw new Error("NEXT_REDIRECT"); });
});
afterEach(() => {
  unmount();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("same-origin sign-out protocol", () => {
  it.each(["http://127.0.0.1:3100", "https://scm.example.test"])("gets fresh CSRF before POST and verifies the anonymous session on %s", async (origin) => {
    vi.stubGlobal("window", { location: { origin, assign: mocks.navigate } });
    successfulResponses(null, `${origin}/login`);
    const controller = new AbortController();
    await signOutCurrentOrigin(controller.signal);
    expect(mocks.fetch.mock.calls.map((call) => call[0])).toEqual(["/api/auth/csrf", "/api/auth/signout", "/api/auth/session"]);
    for (const [, options] of mocks.fetch.mock.calls) {
      expect(options).toMatchObject({ credentials: "same-origin", cache: "no-store", redirect: "error", signal: controller.signal });
    }
    const posted = mocks.fetch.mock.calls[1][1];
    expect(posted.method).toBe("POST");
    expect(posted.headers).toEqual({ "Content-Type": "application/x-www-form-urlencoded", "X-Auth-Return-Redirect": "1" });
    expect([...posted.body.entries()]).toEqual([["csrfToken", TOKEN], ["callbackUrl", "/login"]]);
  });

  it.each([undefined, "", " ".repeat(64), "x", 42, "a".repeat(257)])("rejects malformed CSRF %j without posting", async (token) => {
    mocks.fetch.mockResolvedValueOnce(response({ csrfToken: token }));
    await expect(signOutCurrentOrigin(new AbortController().signal)).rejects.toThrow();
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it.each([{ status: 503 }, { type: "text/html" }])("rejects failed/non-JSON CSRF response %j", async (options) => {
    mocks.fetch.mockResolvedValueOnce(response({ csrfToken: TOKEN }, options));
    await expect(signOutCurrentOrigin(new AbortController().signal)).rejects.toThrow();
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it.each([403, 500])("does not treat a failed sign-out POST (%i) as logout", async (status) => {
    mocks.fetch.mockResolvedValueOnce(response({ csrfToken: TOKEN })).mockResolvedValueOnce(response({ url: "/login" }, { status }));
    await expect(signOutCurrentOrigin(new AbortController().signal)).rejects.toThrow();
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
  });

  it("rejects an unreadable POST JSON body before session verification", async () => {
    mocks.fetch.mockResolvedValueOnce(response({ csrfToken: TOKEN }))
      .mockResolvedValueOnce({ ...response(null), json: vi.fn().mockRejectedValue(new SyntaxError("Malformed body")) });
    await expect(signOutCurrentOrigin(new AbortController().signal)).rejects.toThrow();
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
  });

  it.each(["/api/auth/signout?csrf=true", "/api/auth/error?error=MissingCSRF", "/login?error=Configuration", "/other", "javascript:alert(1)"])("rejects Auth.js error/unexpected destination %s even with HTTP 200", async (url) => {
    mocks.fetch.mockResolvedValueOnce(response({ csrfToken: TOKEN })).mockResolvedValueOnce(response({ url }));
    await expect(signOutCurrentOrigin(new AbortController().signal)).rejects.toThrow();
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
  });

  it.each([{ user: { id: "1" } }, { error: "unavailable" }, [], "", false])("does not claim logout for a non-anonymous session response %j", async (session) => {
    successfulResponses(session);
    await expect(signOutCurrentOrigin(new AbortController().signal)).rejects.toThrow();
  });

  it("accepts the empty-object anonymous response, but never a non-OK session response", async () => {
    successfulResponses({});
    await signOutCurrentOrigin(new AbortController().signal);
    mocks.fetch.mockResolvedValueOnce(response({ csrfToken: TOKEN }))
      .mockResolvedValueOnce(response({ url: "/login" }))
      .mockResolvedValueOnce(response(null, { status: 500 }));
    await expect(signOutCurrentOrigin(new AbortController().signal)).rejects.toThrow();
  });

  it("checks cancellation after a deferred CSRF body before posting", async () => {
    const body = deferred();
    mocks.fetch.mockResolvedValueOnce({ ...response(null), json: () => body.promise });
    const controller = new AbortController();
    const request = signOutCurrentOrigin(controller.signal);
    await flush();
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    controller.abort(); body.resolve({ csrfToken: TOKEN });
    await expect(request).rejects.toThrow();
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it("checks cancellation after a deferred POST body before session verification", async () => {
    const body = deferred();
    mocks.fetch.mockResolvedValueOnce(response({ csrfToken: TOKEN }))
      .mockResolvedValueOnce({ ...response(null), json: () => body.promise });
    const controller = new AbortController();
    const request = signOutCurrentOrigin(controller.signal);
    await flush();
    controller.abort(); body.resolve({ url: "/login" });
    await expect(request).rejects.toThrow();
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
  });
});

describe("sign-out confirmation lifecycle", () => {
  it("keeps the confirmation page independent of identity DB availability or stale sessions", () => {
    mocks.auth.mockImplementation(() => { throw new Error("Identity database unavailable"); });
    expect(SignOutPage().type).toBe(SignOutForm);
    expect(mocks.auth).not.toHaveBeenCalled();
    expect(mocks.redirect).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled(); // GET/render never logs the browser out.
  });

  it("disables the control before hydration, then submits once even on immediate double submit", async () => {
    expect(button(render(false)).props.disabled).toBe(true);
    const pending = deferred();
    mocks.fetch.mockReturnValueOnce(pending.promise);
    const submit = form().props.onSubmit!;
    const first = submit(event());
    await submit(event());
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(button().props.disabled).toBe(true);
    pending.resolve(response(null, { status: 503 }));
    await first;
    expect(button().props.disabled).toBe(false);
  });

  it("shows a safe retry after failure, obtains fresh CSRF on retry, and navigates only after session verification", async () => {
    mocks.fetch.mockRejectedValueOnce(new Error("RAW_TOKEN_OR_EXTERNAL_ERROR_MUST_NOT_APPEAR"));
    await form().props.onSubmit!(event());
    expect(errorText()).toContain("退出结果未确认");
    expect(errorText()).not.toContain("RAW_TOKEN");
    expect(button().props.children).toBe("重试退出");
    expect(mocks.navigate).not.toHaveBeenCalled();
    const verification = deferred();
    mocks.fetch.mockResolvedValueOnce(response({ csrfToken: TOKEN }))
      .mockResolvedValueOnce(response({ url: "https://other-supported-origin.example/login" }))
      .mockReturnValueOnce(verification.promise);
    const retry = form().props.onSubmit!(event());
    await flush();
    expect(mocks.navigate).not.toHaveBeenCalled();
    verification.resolve(response(null));
    await retry;
    // Returned URLs are not followed, even if AUTH_URL belongs to the other origin.
    expect(mocks.navigate).toHaveBeenCalledExactlyOnceWith("/login");
    expect(button().props.disabled).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("times out safely; a late old response cannot post, navigate or unlock a retry", async () => {
    const oldBody = deferred();
    mocks.fetch.mockResolvedValueOnce({ ...response(null), json: () => oldBody.promise });
    const old = form().props.onSubmit!(event());
    await flush();
    vi.advanceTimersByTime(15_000);
    expect((mocks.fetch.mock.calls[0][1].signal as AbortSignal).aborted).toBe(true);
    expect(errorText()).toContain("退出结果未确认");
    const newResponse = deferred();
    mocks.fetch.mockReturnValueOnce(newResponse.promise);
    const retry = form().props.onSubmit!(event());
    oldBody.resolve({ csrfToken: TOKEN });
    await old;
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    expect(button().props.disabled).toBe(true);
    expect(mocks.navigate).not.toHaveBeenCalled();
    newResponse.resolve(response(null, { status: 503 }));
    await retry;
    expect(button().props.disabled).toBe(false);
  });

  it("unmount cancels a late session result with no UI writes or navigation", async () => {
    const body = deferred();
    mocks.fetch.mockResolvedValueOnce(response({ csrfToken: TOKEN }))
      .mockResolvedValueOnce(response({ url: "/login" }))
      .mockResolvedValueOnce({ ...response(null), json: () => body.promise });
    const request = form().props.onSubmit!(event());
    await flush();
    unmount();
    const writes = hooks.writes;
    body.resolve(null);
    await request;
    expect(hooks.writes).toBe(writes);
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
