"use client";

import { useEffect, useRef, useState } from "react";
import { Alert, App, Button, Input, Modal, Space, Typography } from "antd";
import { hasAnyRole, useMe } from "@/components/useMe";
import DocStatusTag from "./DocStatusTag";
import { clearClosingMarker, closingStorageKey, postClosingAction, readClosingMarker, readClosingSnapshot, startClosingMarker,
  type ClosingAction, type ClosingMarker, type ClosingSnapshot } from "./doc-transition-recovery";

export function canComplete(status: string): boolean { return status === "in_progress"; }
export function canShortClose(status: string): boolean { return status === "approved" || status === "in_progress"; }
interface Props {
  docType: "po" | "wo";
  doc: { id: number; docNo: string; status: string; version: number };
  onChanged: () => void;
  allowed?: boolean;
  labels: { completeHint: string; shortCloseHint: string };
}

/** Identity-keyed lifetime; terminal documents must retain the reconciliation entry point. */
export default function DocTransitionActions(props: Props) {
  const me = useMe();
  if (!me) return null;
  return <ClosingActions key={`${me.id}:${props.docType}:${props.doc.id}`} {...props} actorId={me.id}
    canAct={hasAnyRole(me, "pmc", "ops") && props.allowed !== false} />;
}

export function ClosingActions({ docType, doc, onChanged, labels, actorId, canAct }: Props & { actorId: number; canAct: boolean }) {
  const { message } = App.useApp();
  const key = closingStorageKey(actorId, docType, doc.id), base = `/api/outsource/${docType}/${doc.id}`;
  const [ready, setReady] = useState(false), [loading, setLoading] = useState(false);
  const [marker, setMarker] = useState<ClosingMarker | null>(null);
  const [error, setError] = useState<string | null>(null), [checked, setChecked] = useState<ClosingSnapshot | null>(null);
  const [action, setAction] = useState<ClosingAction | null>(null), [reason, setReason] = useState("");
  const pending = useRef(false), alive = useRef(true), permitted = useRef(canAct);
  const openedVersion = useRef(doc.version);
  permitted.current = canAct;

  useEffect(() => {
    alive.current = true;
    const restore = () => {
      try { setMarker(readClosingMarker(localStorage, key)); setError(null); }
      catch (e) { setError(e instanceof Error ? e.message : "本机核对记录读取失败"); }
      setChecked(null); setReady(true);
    };
    restore();
    const onStorage = (event: StorageEvent) => {
      if (event.storageArea === localStorage && (event.key === key || event.key === null) && !pending.current) restore();
    };
    window.addEventListener("storage", onStorage);
    return () => { alive.current = false; window.removeEventListener("storage", onStorage); };
  }, [key]);

  const check = async () => {
    if (pending.current) return;
    pending.current = true; setLoading(true); setChecked(null);
    try {
      const result = await readClosingSnapshot(base, docType, doc.id);
      if (alive.current) {
        setChecked(result);
        // A valid server read does not repair an invalid local reconciliation marker.
        readClosingMarker(localStorage, key);
        setError(null);
      }
    } catch (e) { if (alive.current) setError(e instanceof Error ? e.message : "核对失败，请重试读取"); }
    finally { pending.current = false; if (alive.current) setLoading(false); }
  };
  const acknowledge = () => {
    if (pending.current || !checked || !marker) return;
    try {
      if (!clearClosingMarker(localStorage, key, marker.token)) throw Error("核对记录已变化，请重新读取当前单据");
      setMarker(null); setChecked(null); setAction(null); setReason(""); onChanged();
    } catch (e) { setChecked(null); setError(e instanceof Error ? e.message : "记录未清除，请先核对"); }
  };
  const submit = async () => {
    if (!alive.current || pending.current || !permitted.current || !ready || marker || error || !action) return;
    if (openedVersion.current !== doc.version) { setError("单据版本已变化，请先核对当前状态；尚未提交收口"); return; }
    if ((action === "complete" && !canComplete(doc.status)) || (action === "short_close" && !canShortClose(doc.status))) return;
    if (action === "short_close" && (!reason.trim() || reason.trim().length > 500)) return;
    pending.current = true; setLoading(true); setChecked(null);
    try {
      const saved = startClosingMarker(localStorage, key, action, doc.version);
      setMarker(saved);
      const response = await postClosingAction(base, action, doc.version, reason);
      if (!alive.current || !permitted.current) return;
      // Successful response is followed by an exact GET; failed GET never triggers another POST.
      const current = await readClosingSnapshot(base, docType, doc.id);
      if (!alive.current || !permitted.current) return;
      if (current.status !== response.status) throw Error("收口响应已返回，但单据状态随后发生变化，请核对当前记录");
      if (!clearClosingMarker(localStorage, key, saved.token)) throw Error("另一标签的核对记录已变化，请重新核对");
      setMarker(null); setAction(null); setReason("");
      message.success(response.idempotent ? "单据已处于目标状态，已刷新核对" : action === "complete" ? "已标记完成并核对" : "已短关并核对");
      onChanged();
    } catch (e) {
      if (alive.current) {
        setError(`${e instanceof Error ? e.message : "未取得处理结果"}。请核对当前状态与短关原因，勿重复提交。`);
        try { setMarker(readClosingMarker(localStorage, key)); } catch { /* Keep the error and block new writes. */ }
      }
    } finally { pending.current = false; if (alive.current) setLoading(false); }
  };
  const needsCheck = Boolean(marker || error);
  const feedback = needsCheck ? <Alert type={error ? "error" : "warning"} showIcon
    message="收口操作待核对" style={{ marginBottom: 12 }}
    description={<Space direction="vertical" size={8} style={{ width: "100%" }}>
      <span>{error ?? "本机保留了这张单据的收口核对记录。关闭页面或刷新不会自动重发。"}</span>
      {checked ? <div role="status">{checked.docNo} 当前为 <DocStatusTag status={checked.status} /> 版本 {checked.version}。
        {checked.closedReason ? <div style={{ overflowWrap: "anywhere" }}>短关原因：{checked.closedReason}</div> : null}
        <div>这是读取时的当前状态，不证明本次请求已执行或未执行；请核对后刷新单据，再决定下一步。</div>
      </div> : null}
      <Space wrap>
        <Button loading={loading} onClick={() => void check()}>核对当前状态</Button>
        {checked && marker ? <Button disabled={loading} onClick={acknowledge}>已核对，刷新单据</Button> : null}
      </Space>
    </Space>} /> : null;

  if (!needsCheck && (!canAct || (!canComplete(doc.status) && !canShortClose(doc.status)))) return null;
  return <section aria-label="单据收口" style={{ marginBottom: 12 }}>
    {action === null ? feedback : null}
    {!needsCheck && canAct ? <Space wrap>
      <Typography.Text type="secondary">收口本单</Typography.Text>
      {canComplete(doc.status) ? <Button disabled={!ready || loading} onClick={() => { openedVersion.current = doc.version; setReason(""); setAction("complete"); }}>完成</Button> : null}
      {canShortClose(doc.status) ? <Button danger disabled={!ready || loading} onClick={() => { openedVersion.current = doc.version; setReason(""); setAction("short_close"); }}>短关</Button> : null}
    </Space> : null}
    <Modal title={action === "complete" ? "确认标记完成" : "短关单据"} open={action !== null}
      style={{ top: 24 }} styles={{ body: { maxHeight: "calc(100dvh - 200px)", overflowY: "auto" } }}
      okText={action === "complete" ? "确认完成" : "确认短关"} cancelText={needsCheck ? "关闭，稍后核对" : "取消"}
      closable={!loading} maskClosable={!loading} keyboard={!loading} confirmLoading={loading}
      okButtonProps={{ danger: action === "short_close", disabled: !canAct || needsCheck || (action === "short_close" && reason.trim().length === 0) }}
      onCancel={() => { if (!pending.current) setAction(null); }} onOk={() => void submit()}>
      {feedback}
      <Typography.Paragraph>{doc.docNo} · 版本 {doc.version}</Typography.Paragraph>
      <Typography.Paragraph type="secondary">{action === "complete" ? labels.completeHint : labels.shortCloseHint}</Typography.Paragraph>
      {action === "short_close" ? <Input.TextArea aria-label="短关原因" rows={3} maxLength={500} showCount
        disabled={loading || needsCheck || !canAct} placeholder="填写短关原因，保存在单据与审计记录中"
        value={reason} onChange={e => setReason(e.target.value)} /> : null}
    </Modal>
  </section>;
}
