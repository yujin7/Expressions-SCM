"use client";

import { useEffect, useState } from "react";

/** One independent read lane. Cancellation never applies to business writes. */
export function createLatestReadScope() {
  let current: AbortController | null = null;
  const cancel = () => { current?.abort(); current = null; };
  const begin = () => {
    cancel();
    const request = new AbortController();
    current = request;
    return { signal: request.signal, isCurrent: () => current === request && !request.signal.aborted };
  };
  return { begin, cancel };
}

/** Stable start callback; each page/tab owns a lane and aborts it on unmount. */
export function useLatestRead() {
  const [scope] = useState(createLatestReadScope);
  useEffect(() => scope.cancel, [scope]);
  return scope.begin;
}
