"use client";

import { useEffect, useRef, useState } from "react";
import { clearSopCycleRequest, loadSopCycleRequest, lookupSopCycleRequest, prepareSopCycleRequest,
  sopCycleStorageKey, submitSopCycleRequest, withSopCycleLock,
  type SopCyclePayload, type SopCycleRequest, type SopCycleResult } from "./sop-cycle-request";

/** The workspace remounts per account/roles; pending writes never cross account UI state. */
export function useSopCycleRequest(actorId: number | null, allowed: boolean) {
  const [request, setRequest] = useState<SopCycleRequest | null>(null);
  const [result, setResult] = useState<SopCycleResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false), [busy, setBusy] = useState(false);
  const pending = useRef(false), alive = useRef(true), permission = useRef(allowed);
  permission.current = allowed;
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const active = () => alive.current && permission.current;
  const show = (value: SopCycleRequest | null) => { setRequest(value); setResult(null); };
  useEffect(() => {
    if (actorId === null || !allowed) return;
    const restore = () => {
      if (pending.current) return;
      try { show(loadSopCycleRequest(localStorage, actorId)); setError(null); setReady(true); }
      catch (e) { setError((e as Error).message); setReady(false); }
    };
    restore();
    const onStorage = (event: StorageEvent) => {
      if (event.storageArea === localStorage && (event.key === null || event.key === sopCycleStorageKey(actorId))) restore();
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [actorId, allowed]);

  const run = async (action: (id: number) => Promise<void>) => {
    if (actorId === null || !allowed || !ready || pending.current) return;
    pending.current = true; setBusy(true); setError(null);
    try { await withSopCycleLock(actorId, async () => { if (active()) await action(actorId); }); }
    catch (e) { if (active()) setError((e as Error).message); }
    finally { pending.current = false; if (alive.current) setBusy(false); }
  };
  const confirm = (found: SopCycleResult) => { if (active()) setResult(found); };
  const lookup = () => run(async id => {
    const current = loadSopCycleRequest(localStorage, id); show(current);
    if (current) confirm(await lookupSopCycleRequest(current.requestKey));
  });
  const submit = (payload?: SopCyclePayload, edit = false) => run(async id => {
    let current = loadSopCycleRequest(localStorage, id);
    if (edit) {
      if (!current || current.requestKey !== request?.requestKey || !payload) throw Error("原请求已变化，请重新核对");
      const found = await lookupSopCycleRequest(current.requestKey);
      if (!active()) return;
      if (found.cycle) { show(current); confirm(found); return; }
      current = prepareSopCycleRequest(localStorage, id, payload, current.requestKey);
    } else if (!current && payload) current = prepareSopCycleRequest(localStorage, id, payload);
    else if (payload && current) { show(current); throw Error("发现未核对的原周期请求，未发送新的创建请求"); }
    if (!current) throw Error("没有可重试的原周期请求");
    if (!active()) return;
    show(current); confirm(await submitSopCycleRequest(current));
  });
  const acknowledge = () => run(async id => {
    if (!request || !result?.cycle || result.requestKey !== request.requestKey) return;
    const found = await lookupSopCycleRequest(request.requestKey);
    if (!found.cycle) throw Error("尚未确认原周期，请继续核对");
    if (active()) show(clearSopCycleRequest(localStorage, id, request.requestKey));
  });
  return { request, result, error, ready, busy, lookup, submit, acknowledge };
}
