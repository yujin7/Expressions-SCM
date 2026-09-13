"use client";

import { useEffect, useRef, useState } from "react";
import { Alert, Button, Input, Select, Space } from "antd";
import { todoItemHref } from "@/lib/todo-navigation";
import { hasAnyRole, useMe } from "./useMe";
import { capacityStorageKey, clearCapacityRequest, loadCapacityRequest, lookupCapacityRequest, prepareCapacityRequest,
  submitCapacityRequest, withCapacityLock, type CapacityPayload, type CapacityRequest, type CapacityResult } from "./capacity-handoff-request";
import type { CapacityCheck } from "@/server/modules/outsource/capacity-check";

/** Account-keyed child prevents old asynchronous work from displaying in another session. */
export default function CapacityHandoff(props: { check: CapacityCheck | null; onBusyChange: (busy: boolean) => void }) {
  const me = useMe();
  if (!me || !hasAnyRole(me, "purchasing", "pmc", "ops")) return null;
  return <CapacityHandoffForm key={`${me.id}:${me.roles.join(",")}`} {...props} actorId={me.id} />;
}

export function CapacityHandoffForm({ check, onBusyChange, actorId }: {
  check: CapacityCheck | null; onBusyChange: (busy: boolean) => void; actorId: number;
}) {
  const [itemId, setItemId] = useState<number>();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false), [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [request, setRequest] = useState<CapacityRequest | null>(null);
  const [result, setResult] = useState<CapacityResult | null>(null);
  const locked = useRef(false), live = useRef(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  useEffect(() => {
    const restore = () => {
      if (locked.current) return;
      try { setRequest(loadCapacityRequest(localStorage, actorId)); setResult(null); setError(null); setReady(true); }
      catch (e) { setReady(false); setError((e as Error).message); }
    };
    restore();
    const changed = (e: StorageEvent) => { if (e.storageArea === localStorage && (e.key == null || e.key === capacityStorageKey(actorId))) restore(); };
    window.addEventListener("storage", changed);
    return () => window.removeEventListener("storage", changed);
  }, [actorId]);
  const item = check?.handoff?.items.find(row => row.id === itemId);
  const payload: CapacityPayload | null = check?.scenario && check.handoff && check.evidenceKey && item && note.trim().length >= 5 ? {
    skuId: check.sku.id, alertId: check.handoff.source.id, supplierId: check.scenario.supplierId,
    dueDate: check.scenario.dueDate, candidateQty: check.scenario.candidateQty, workItemId: item.id,
    assigneeId: item.assigneeId, evidenceKey: check.evidenceKey, note: note.trim(),
  } : null;
  const run = async (action: () => Promise<void>) => {
    if (locked.current || !live.current || !ready) return;
    root.current?.focus({ preventScroll: true });
    locked.current = true; setBusy(true); onBusyChange(true); setError(null);
    try { await withCapacityLock(actorId, async () => { if (live.current) await action(); }); }
    catch (e) { if (live.current) setError(`${e instanceof Error ? e.message : "结果未确认"}。原请求未清除；请先核对，不会自动重发。`); }
    finally { locked.current = false; if (live.current) { setBusy(false); onBusyChange(false); } }
  };
  const show = (current: CapacityRequest | null) => { if (live.current) { setRequest(current); setResult(null); } };
  const lookup = () => run(async () => {
    const current = loadCapacityRequest(localStorage, actorId); show(current);
    if (current) { const found = await lookupCapacityRequest(current); if (live.current) setResult(found); }
  });
  const save = (edit = false) => run(async () => {
    let current = loadCapacityRequest(localStorage, actorId);
    if (request && current?.requestId !== request.requestId) { show(current); throw Error("原请求已被另一标签页处理，请重新核对"); }
    if (edit) {
      if (!current || current.requestId !== request?.requestId || !payload) throw Error("请重新核对原来源情景并选择原待办");
      const found = await lookupCapacityRequest(current);
      if (!live.current) return;
      if (found.eventId) { show(current); setResult(found); return; }
      current = prepareCapacityRequest(localStorage, actorId, payload, current.requestId);
    } else if (!current && payload && !request) current = prepareCapacityRequest(localStorage, actorId, payload);
    else if (!request && current) { show(current); throw Error("另一标签页已有待核对请求，未发送新请求"); }
    if (!current) throw Error("没有可重试的原请求，请重新核对");
    show(current);
    if (!live.current) return;
    const found = await submitCapacityRequest(current);
    if (live.current) { setResult(found); setNote(""); }
  });
  const acknowledge = () => run(async () => {
    const current = loadCapacityRequest(localStorage, actorId);
    if (!current || current.requestId !== request?.requestId || !result?.eventId) throw Error("原请求已变化，请重新核对");
    const found = await lookupCapacityRequest(current);
    if (!found.eventId) throw Error("尚未确认已保存的原记录");
    if (live.current) show(clearCapacityRequest(localStorage, actorId, current.requestId));
  });
  const canCorrect = !!request && !!payload && payload.workItemId === request.workItemId && payload.alertId === request.alertId && payload.skuId === request.skuId;
  return <div ref={root} tabIndex={-1} aria-label="产能依据承接" style={{ display: "grid", gap: 10, minWidth: 0, overflowWrap: "anywhere" }}>
    {request && <Alert showIcon type={result?.eventId ? "success" : "warning"}
      message={result?.eventId ? `产能依据已保存 · 记录 #${result.eventId}` : "有一笔产能保存请求待核对"}
      description={<Space direction="vertical" style={{ width: "100%" }}>
        <span>原待办 #{request.workItemId} · SKU #{request.skuId}。同账号、同浏览器站点保留原请求；刷新或关页不会自动重发。</span>
        <details><summary>查看原提交的情景与备注</summary><p>来源告警 #{request.alertId}；加工厂 #{request.supplierId}；拟新增 {request.candidateQty}；拟交付 {request.dueDate}；负责人 #{request.assigneeId}。</p><p>{request.note}</p><p>请求编号：{request.requestId}</p></details>
        {result && !result.eventId && <span>服务器暂未找到原记录。可重试同一请求；如依据已变化，重新核对原SKU情景、选择原待办后修正原请求，不另换编号。</span>}
        <Space wrap>
          <Button disabled={busy} onClick={() => void lookup()}>核对原保存结果</Button>
          {!result?.eventId && <Button disabled={busy} onClick={() => void save()}>重试原产能请求</Button>}
          {result?.eventId && <Button disabled={busy} onClick={() => void acknowledge()}>确认记录，准备下一笔</Button>}
          <Button href={todoItemHref(request.workItemId)}>查看原待办历史</Button>
        </Space>
      </Space>} />}
    {check?.scenario && check.handoff && <>
      <strong>保存依据，交给现有负责人跟进</strong>
      <span>来源告警 #{check.handoff.source.id} · {check.handoff.source.title}。保存核对时点的依据，不代表工厂承诺。</span>
      {check.handoff.items.length ? <>
        <Select aria-label="承接待办及负责人" placeholder="选择该告警的待办，并确认当前负责人" value={item?.id}
          disabled={busy} onChange={setItemId} style={{ width: "100%", minWidth: 0 }}
          options={check.handoff.items.map(row => ({ value: row.id, label: `#${row.id} · ${row.assigneeName} · ${row.title}` }))} />
        {item && <span>确认由 {item.assigneeName} 负责；不自动改派。<a href={todoItemHref(item.id)}>查看此待办</a></span>}
        <Input.TextArea aria-label="待核实事项" value={note} onChange={e => setNote(e.target.value)} disabled={busy}
          maxLength={1000} autoSize={{ minRows: 2, maxRows: 4 }} placeholder="写明需核实事项（至少5字）" />
        {!request && <Button type="primary" loading={busy} disabled={busy || !ready || !payload} onClick={() => void save()}>保存到承接待办</Button>}
        {request && result?.eventId === null && <Button disabled={busy || !canCorrect} onClick={() => void save(true)}>核对后用当前情景修正原请求</Button>}
      </> : <Alert type="warning" showIcon message="没有可见且负责人有效的未结承接待办" description="请在待办中核对该来源的派工或状态；这里不会猜负责人、重复建任务或重开已关闭事项。" />}
    </>}
    {error && <Alert showIcon type="error" message="请核对产能保存结果" description={error} />}
  </div>;
}
