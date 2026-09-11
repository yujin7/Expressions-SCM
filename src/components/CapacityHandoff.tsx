"use client";

import { useEffect, useRef, useState } from "react";
import { Alert, Button, Input, Select, Space } from "antd";
import { serverErrorMessage } from "./fetchJson";
import { todoItemHref } from "@/lib/todo-navigation";
import type { CapacityCheck } from "@/server/modules/outsource/capacity-check";

type Payload = { skuId: number; alertId: number; supplierId: number; dueDate: string; candidateQty: string;
  workItemId: number; assigneeId: number; evidenceKey: string; requestId: string; note: string };
type Receipt = { itemId: number; eventId: number; replayed: boolean };

/** Remains mounted when scenario inputs change, so an uncertain write never loses its identity. */
export default function CapacityHandoff({ check, onBusyChange }: { check: CapacityCheck | null; onBusyChange: (busy: boolean) => void }) {
  const [itemId, setItemId] = useState<number>();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const pending = useRef<Payload | null>(null);
  const locked = useRef(false);
  const live = useRef(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const item = check?.handoff?.items.find(row => row.id === itemId);
  const save = async () => {
    if (locked.current || !live.current) return;
    if (!pending.current) {
      if (!check?.scenario || !check.handoff || !check.evidenceKey || !item || note.trim().length < 5) return;
      pending.current = { skuId: check.sku.id, alertId: check.handoff.source.id, supplierId: check.scenario.supplierId,
        dueDate: check.scenario.dueDate, candidateQty: check.scenario.candidateQty, workItemId: item.id,
        assigneeId: item.assigneeId, evidenceKey: check.evidenceKey, requestId: crypto.randomUUID(), note: note.trim() };
    }
    root.current?.focus({ preventScroll: true });
    locked.current = true; setBusy(true); onBusyChange(true); setError(null); setReceipt(null);
    try {
      const response = await fetch("/api/outsource/sourcing-aid", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(pending.current), signal: AbortSignal.timeout(30_000) });
      const body = await response.json();
      if (!response.ok) {
        // Only a received, well-formed application refusal proves that this request did not write.
        const message = serverErrorMessage(body);
        if (message && [400, 401, 403, 404, 409, 422].includes(response.status)) {
          pending.current = null;
          if (live.current) { setUncertain(false); setError(message); }
          return;
        }
        throw new Error(message ?? "保存回包未确认");
      }
      if (body.itemId !== pending.current.workItemId || !Number.isSafeInteger(body.eventId) || body.eventId < 1 || typeof body.replayed !== "boolean") throw new Error("保存回执格式未确认");
      if (!live.current) return;
      pending.current = null; setUncertain(false); setReceipt(body); setNote("");
    } catch (e) {
      if (live.current) { setUncertain(true); setError(`${e instanceof Error ? e.message : "保存结果未知"}。保留了同一提交标识；请先核对待办历史，或确认同一提交，不会自动重试。`); }
    } finally {
      if (live.current) { locked.current = false; setBusy(false); onBusyChange(false); }
    }
  };
  const hasScenario = !!check?.scenario && !!check.handoff;
  return <div ref={root} tabIndex={-1} aria-label="产能依据承接" style={{ display: "grid", gap: 10, minWidth: 0 }}>
    {hasScenario && <>
      <strong>保存依据，交给现有负责人跟进</strong>
      <span>来源告警 #{check.handoff!.source.id} · {check.handoff!.source.title}。保存核对时点的依据，不代表工厂承诺。</span>
      {check.handoff!.items.length ? <>
        <Select aria-label="承接待办及负责人" placeholder="选择该告警的待办，并确认当前负责人" value={item?.id}
          disabled={busy || uncertain} onChange={setItemId} style={{ width: "100%", minWidth: 0 }}
          options={check.handoff!.items.map(row => ({ value: row.id, label: `#${row.id} · ${row.assigneeName} · ${row.title}` }))} />
        {item && <span>确认由 {item.assigneeName} 负责；不自动改派。<a href={todoItemHref(item.id)}>查看此待办</a></span>}
        <Input.TextArea aria-label="待核实事项" value={note} onChange={e => setNote(e.target.value)} disabled={busy || uncertain}
          maxLength={1000} autoSize={{ minRows: 2, maxRows: 4 }} placeholder="写明要向工厂核实什么、期望的书面依据或下一步（至少5字）" />
      </> : <Alert type="warning" showIcon message="没有可见且负责人有效的未结承接待办" description="请在待办中核对该来源的派工或状态，再重新核对情景；这里不会猜负责人、创建重复任务或重开已关闭事项。" />}
    </>}
    {(hasScenario || uncertain) && <Space wrap>
      <Button type="primary" loading={busy} disabled={busy || (!uncertain && (!item || note.trim().length < 5))} onClick={() => void save()}>{uncertain ? "确认同一提交" : "保存到承接待办"}</Button>
      {pending.current && <Button href={todoItemHref(pending.current.workItemId)}>核对待办历史</Button>}
    </Space>}
    {error && <Alert showIcon type={uncertain ? "warning" : "error"} message={uncertain ? "保存结果未确认" : "未保存，请核对后重试"} description={error} />}
    {receipt && <Alert showIcon type="success" message={`产能依据已保存 · 记录 #${receipt.eventId}`} description={<a href={todoItemHref(receipt.itemId)}>前往待办 #{receipt.itemId} 查看依据、追加跟进与结果</a>} />}
  </div>;
}
