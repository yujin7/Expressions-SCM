"use client";

import { useEffect, useRef, useState } from "react";
import { Alert, Button, DatePicker, Drawer, InputNumber, Select, Space, Spin, Typography } from "antd";
import dayjs from "dayjs";
import { useDocumentRead } from "./useDocumentRead";
import LoadErrorAlert from "./LoadErrorAlert";
import SupplierDeclaredCapacity from "./SupplierDeclaredCapacity";
import { formatQty } from "./format";
import CapacityHandoff from "./CapacityHandoff";
import { capacityStorageKey, loadCapacityRequest } from "./capacity-handoff-request";
import { hasAnyRole, useMe } from "./useMe";
import type { CapacityCheck } from "@/server/modules/outsource/capacity-check";

export interface CapacityTarget { skuId: number; code: string; name: string; replenishHref: string; alertId?: number }

/** Parent owns the drawer so responsive table/card switches cannot discard a scenario. */
export default function CapacityCheckDrawer({ target, onClose }: { target: CapacityTarget | null; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [recoveryOpen, setRecoveryOpen] = useState(false), [hasRecovery, setHasRecovery] = useState(false);
  const me = useMe(), actorId = me?.id;
  const allowed = hasAnyRole(me, "purchasing", "pmc", "ops");
  useEffect(() => {
    if (!actorId || !allowed) { setHasRecovery(false); return; }
    const restore = () => {
      try { setHasRecovery(loadCapacityRequest(localStorage, actorId) !== null); }
      catch { setHasRecovery(true); } // Corruption needs a visible recovery/error entry too.
    };
    restore();
    const changed = (e: StorageEvent) => { if (e.storageArea === localStorage && (e.key == null || e.key === capacityStorageKey(actorId))) restore(); };
    window.addEventListener("storage", changed);
    return () => window.removeEventListener("storage", changed);
  }, [actorId, allowed, target, recoveryOpen]);
  return <>
    {hasRecovery && allowed && <Button style={{ marginBlock: 12 }} onClick={() => setRecoveryOpen(true)}>核对待保存产能依据</Button>}
    <Drawer title="核对加工产能" open={target !== null || recoveryOpen} onClose={() => { setRecoveryOpen(false); onClose(); }} width={680} destroyOnHidden closable={!busy} maskClosable={!busy} keyboard={!busy}>
      {target ? <CapacityCheckForm key={`${target.skuId}:${target.alertId ?? "none"}`} target={target} onBusyChange={setBusy} />
        : recoveryOpen ? <CapacityHandoff check={null} onBusyChange={setBusy} /> : null}
    </Drawer>
  </>;
}

export function CapacityCheckForm({ target, onBusyChange }: { target: CapacityTarget; onBusyChange?: (busy: boolean) => void }) {
  const formRef = useRef<HTMLDivElement>(null);
  const baseUrl = `/api/outsource/sourcing-aid?mode=capacity&skuId=${target.skuId}${target.alertId ? `&alertId=${target.alertId}` : ""}`;
  const directory = useDocumentRead<CapacityCheck>(baseUrl);
  const [supplierId, setSupplierId] = useState<number>();
  const [dueDate, setDueDate] = useState("");
  const [qty, setQty] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const query = supplierId && dueDate && qty ? new URLSearchParams({ mode: "capacity", skuId: String(target.skuId),
    supplierId: String(supplierId), dueDate, candidateQty: qty, ...(target.alertId ? { alertId: String(target.alertId) } : {}) }).toString() : null;
  // Any edit immediately withdraws previous results/actions, before a new request can start.
  const result = useDocumentRead<CapacityCheck>(submitted && submitted === query ? `/api/outsource/sourcing-aid?${submitted}` : null);
  const scenario = result.data?.scenario;
  const factory = result.data?.factories.find(row => row.id === scenario?.supplierId);
  const data = directory.data;
  // Retry removes its error button. Keep keyboard focus inside the persistent drawer
  // before that removal, so Escape and the drawer's tab containment keep working.
  const focusForRetry = () => formRef.current?.focus({ preventScroll: true });
  return <div ref={formRef} tabIndex={-1} aria-label="加工产能核对表单" style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 12, minWidth: 0, overflowWrap: "anywhere" }}>
    <Typography.Text strong>{target.code} · {target.name}</Typography.Text>
    <Alert type="info" showIcon message="人工核对，不自动开单"
      description="拟新增量由计划员输入，不取爆单观察销量。仅比较本系统未结JG全单计划量与申报情景；不含其他客户占用，不是可承诺产能。" />
    <LoadErrorAlert error={directory.error} onRetry={() => { focusForRetry(); setSubmitted(null); directory.retry(); }} subject="加工厂目录" retrying={directory.phase === "loading"} />
    {directory.phase === "loading" ? <Spin tip="读取加工厂目录"><div style={{ height: 60 }} /></Spin> : null}
    {data && <>
      <label htmlFor="capacity-factory">加工厂（目录，不代表该SKU已准入）</label>
      <Select id="capacity-factory" aria-label="加工厂" disabled={saving} value={supplierId} onChange={value => { setSupplierId(value); setSubmitted(null); }}
        showSearch optionFilterProp="label" placeholder="人工选择加工厂" style={{ width: "100%", minWidth: 0 }}
        options={data.factories.map(row => ({ value: row.id,
          label: `${row.code} ${row.name} · ${row.statusLabel} · ${row.hasApprovedHistory ? "有已批JG往来" : "无已批JG往来"}` }))} />
      {!data.factories.length && <Alert type="warning" showIcon message="尚无加工厂档案，请采购先核对供应商主档" />}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(180px, 100%), 1fr))", gap: 12, minWidth: 0 }}>
        <label>拟交付日期<DatePicker aria-label="拟交付日期" disabled={saving} format="YYYY-MM-DD" placeholder="选择交付日期" style={{ width: "100%" }}
          value={dueDate ? dayjs(dueDate) : null} onFocus={() => setSubmitted(null)}
          onChange={value => { setDueDate(value?.format("YYYY-MM-DD") ?? ""); setSubmitted(null); }} /></label>
        <label>拟新增量（{data.sku.baseUom}）<InputNumber aria-label="拟新增量" disabled={saving} stringMode min="0.0001" max="9999999999.9999" precision={4}
          value={qty} onChange={value => { setQty(value); setSubmitted(null); }} style={{ width: "100%" }} /></label>
      </div>
      <Button type="primary" aria-label="核对产能情景" aria-busy={result.phase === "loading"} disabled={!query || saving} loading={result.phase === "loading"} onClick={() => { if (submitted === query) result.retry(); else setSubmitted(query); }}>核对产能情景</Button>
    </>}
    <LoadErrorAlert error={result.error} onRetry={() => { focusForRetry(); result.retry(); }} subject="产能情景" retrying={result.phase === "loading"} />
    {scenario && factory && <section aria-label="本次产能核对结果" style={{ minWidth: 0 }}>
      <Typography.Paragraph strong>{factory.code} {factory.name} · {factory.statusLabel}</Typography.Paragraph>
      {factory.status !== "qualified" && <Alert type="warning" showIcon style={{ marginBottom: 12 }} message="该厂不是合格状态；本次比较不代表可以下单，须先核对准入或暂停原因" />}
      <Typography.Paragraph>拟新增 {formatQty(scenario.candidateQty)} {result.data?.sku.baseUom} · 拟交付 {scenario.dueDate}。与该月未结JG全单计划量 {formatQty(scenario.signal.scheduledQty)} 分开核对。</Typography.Paragraph>
      <SupplierDeclaredCapacity value={scenario.signal.declared} supplierName={factory.code} />
      <details><summary>历史吞吐与比较限制</summary>
        <p>{scenario.signal.explanation}</p>
        {scenario.signal.limitations.map(note => <p key={note}>{note}</p>)}
      </details>
      <Typography.Paragraph style={{ marginTop: 12 }}>下一步：采购核实真实可用产能与交期；计划员回补货页核对库存、在途和建议。此情景不会带入下单数量、锁定产能或关闭预警。</Typography.Paragraph>
      <Space wrap><Button href={target.replenishHref}>回到该SKU补货</Button></Space>
    </section>}
    {!target.alertId && scenario && <Alert type="info" showIcon message="当前未关联到可见源告警；本次仅核对产能，不能保存为来源待办依据。请在预警状态读取完成后重新进入。" />}
    <CapacityHandoff check={result.data ?? null} onBusyChange={value => { setSaving(value); onBusyChange?.(value); }} />
  </div>;
}
