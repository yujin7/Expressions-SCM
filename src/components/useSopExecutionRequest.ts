"use client";

import { useEffect, useRef, useState } from "react";
import { clearSopExecutionRequest, loadSopExecutionRequest, lookupSopExecutionRequest, prepareSopExecutionRequest,
  sopRequestStorageKey, submitSopExecutionRequest, withSopExecutionLock,
  type SopExecutionPayload, type SopExecutionRequest, type SopExecutionResult } from "./sop-execution-request";

/** Consumer is keyed by actor; no recovery state or late response crosses account boundaries. */
export function useSopExecutionRequest(actorId: number | null, allowed: boolean, onConfirmed: () => void) {
  const [request, setRequest] = useState<SopExecutionRequest | null>(null);
  const [result, setResult] = useState<SopExecutionResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false), alive = useRef(true);
  const permission = useRef(allowed); permission.current = allowed;
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const active = () => alive.current && permission.current;
  const show = (value: SopExecutionRequest | null) => { setRequest(value); setResult(null); };
  useEffect(() => {
    if (actorId == null || !allowed) return;
    const restore = () => {
      if (pending.current) return;
      try { show(loadSopExecutionRequest(localStorage, actorId)); setError(null); setReady(true); }
      catch (e) { setError((e as Error).message); setReady(false); }
    };
    restore();
    const onStorage = (event: StorageEvent) => {
      if (event.storageArea === localStorage && (event.key === null || event.key === sopRequestStorageKey(actorId))) restore();
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [actorId, allowed]);

  const run = async (action: (id: number) => Promise<void>) => {
    if (actorId == null || !allowed || !ready || pending.current) return;
    pending.current = true; setBusy(true); setError(null);
    try { await withSopExecutionLock(actorId, async () => { if (active()) await action(actorId); }); }
    catch (e) { if (active()) setError((e as Error).message); }
    finally { pending.current = false; if (alive.current) setBusy(false); }
  };
  const confirm = (found: SopExecutionResult) => {
    if (!active()) return;
    setResult(found);
    if (found.document) onConfirmed();
  };
  const lookup = () => run(async id => {
    const current = loadSopExecutionRequest(localStorage, id); show(current);
    if (current) confirm(await lookupSopExecutionRequest(current.requestKey));
  });
  const submit = (payload?: SopExecutionPayload, edit = false) => run(async id => {
    let current = loadSopExecutionRequest(localStorage, id);
    if (edit) {
      if (!current || current.requestKey !== request?.requestKey || !payload) throw Error("原请求已变化，请重新核对");
      const found = await lookupSopExecutionRequest(current.requestKey);
      if (!active()) return;
      if (found.document) { show(current); confirm(found); return; }
      current = prepareSopExecutionRequest(localStorage, id, payload, current.requestKey);
    } else if (!current && payload) current = prepareSopExecutionRequest(localStorage, id, payload);
    else if (payload && current) { show(current); throw Error("发现尚未确认的原请求，请先核对；未发送新的开单请求"); }
    if (!current) throw Error("没有可重试的原请求");
    if (!active()) return;
    show(current);
    confirm(await submitSopExecutionRequest(current));
  });
  const acknowledge = () => run(async id => {
    if (!request || !result?.document || result.requestKey !== request.requestKey) return;
    const found = await lookupSopExecutionRequest(request.requestKey);
    if (!found.document) throw Error("尚未确认原单，请继续核对");
    if (active()) show(clearSopExecutionRequest(localStorage, id, request.requestKey));
  });
  return { request, result, error, ready, busy, lookup, submit, acknowledge };
}
