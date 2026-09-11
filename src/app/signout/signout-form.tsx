"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";

const FAILURE = "退出结果未确认，请重试。若问题持续，请刷新页面后再试。";
const TIMEOUT_MS = 15_000;

function checkActive(signal: AbortSignal) {
  if (signal.aborted) throw new Error("Sign-out request cancelled");
}

async function readAuthJson(path: string, signal: AbortSignal, init?: RequestInit): Promise<unknown> {
  const response = await fetch(path, {
    ...init, credentials: "same-origin", cache: "no-store", redirect: "error", signal,
  });
  checkActive(signal);
  if (!response.ok || !response.headers.get("content-type")?.toLowerCase().includes("application/json")) {
    throw new Error("Sign-out response unavailable");
  }
  const body: unknown = await response.json();
  checkActive(signal);
  return body;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Existing Auth.js protocol, with observable failures and no client-side Cookie manipulation. */
export async function signOutCurrentOrigin(signal: AbortSignal): Promise<void> {
  checkActive(signal);
  // This same-origin browser GET can receive a fresh HttpOnly CSRF Cookie. An RSC
  // auth() call cannot bootstrap it for the browser; the POST still validates the cookie/token pair.
  const csrf = await readAuthJson("/api/auth/csrf", signal);
  if (!record(csrf) || typeof csrf.csrfToken !== "string" || !/^[A-Za-z0-9_-]{32,256}$/.test(csrf.csrfToken)) {
    throw new Error("Sign-out CSRF unavailable");
  }
  const result = await readAuthJson("/api/auth/signout", signal, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Auth-Return-Redirect": "1" },
    body: new URLSearchParams({ csrfToken: csrf.csrfToken, callbackUrl: "/login" }),
  });
  // Auth.js also returns HTTP 200 + an error redirect when CSRF is rejected.
  // Never navigate to its returned URL: AUTH_URL can describe the other supported
  // origin. Only a clean login destination plus this origin's anonymous session is success.
  if (!record(result) || typeof result.url !== "string") throw new Error("Invalid sign-out response");
  const destination = new URL(result.url, window.location.origin);
  if (destination.pathname !== "/login" || destination.search || destination.hash) throw new Error("Sign-out rejected");
  const session = await readAuthJson("/api/auth/session", signal);
  if (session !== null && (!record(session) || Object.keys(session).length !== 0)) throw new Error("Sign-out session not cleared");
}

type Attempt = { controller: AbortController; timer?: ReturnType<typeof setTimeout> };

export default function SignOutForm() {
  const [ready, setReady] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current = useRef<Attempt | null>(null);

  useEffect(() => {
    setReady(true);
    return () => {
      const attempt = current.current;
      current.current = null;
      if (attempt) { clearTimeout(attempt.timer); attempt.controller.abort(); }
    };
  }, []);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!ready || current.current) return;
    const attempt: Attempt = { controller: new AbortController() };
    current.current = attempt; // Synchronous gate; two clicks before a render still submit once.
    setPending(true);
    setError(null);
    attempt.timer = setTimeout(() => {
      if (current.current !== attempt) return;
      current.current = null;
      attempt.controller.abort();
      setPending(false);
      setError(FAILURE);
    }, TIMEOUT_MS);
    let navigating = false;
    try {
      await signOutCurrentOrigin(attempt.controller.signal);
      if (current.current !== attempt || attempt.controller.signal.aborted) return;
      window.location.assign("/login"); // Full same-origin navigation also discards authenticated UI state.
      navigating = true;
    } catch {
      if (current.current === attempt) setError(FAILURE);
    } finally {
      clearTimeout(attempt.timer);
      if (current.current === attempt && !navigating) {
        current.current = null;
        setPending(false);
      }
    }
  }

  return (
    <main style={{ display: "flex", justifyContent: "center", padding: "clamp(48px, 12vh, 120px) 16px 24px" }}>
      <form onSubmit={onSubmit} aria-busy={pending} style={{ width: "100%", maxWidth: 400, background: "#fff", padding: 28, borderRadius: 12, textAlign: "center", boxShadow: "0 2px 12px rgba(0,0,0,.08)" }}>
        <h1 style={{ fontSize: 20, margin: "0 0 12px" }}>退出登录</h1>
        <p style={{ fontSize: 14, marginBottom: 8 }}>确定要退出登录吗？</p>
        <p style={{ color: "#667085", fontSize: 13, margin: "0 0 20px" }}>仅退出当前浏览器的此入口，不影响其他设备。</p>
        {error ? <p role="alert" style={{ color: "#b42318", fontSize: 14, marginBottom: 16 }}>{error}</p> : null}
        <button type="submit" disabled={!ready || pending} style={{ background: "#3157d5", color: "#fff", border: 0, borderRadius: 8, padding: "10px 28px", fontSize: 14, cursor: pending ? "wait" : "pointer", opacity: ready && !pending ? 1 : 0.65 }}>
          {!ready ? "正在准备…" : pending ? "正在退出…" : error ? "重试退出" : "退出登录"}
        </button>
        <noscript><p>请启用 JavaScript 并刷新页面后退出登录。</p></noscript>
      </form>
    </main>
  );
}
