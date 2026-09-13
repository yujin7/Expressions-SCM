"use client";

import { useEffect, useRef, useState } from "react";
import { Alert, Button, Input, Modal, Space } from "antd";
import { JsonRequestError, postJson } from "@/components/fetchJson";
import { viewportModalProps } from "@/components/viewport-modal";

export default function CtDraftVoid({ doc, onClose, onSaved, onReload }: {
  doc: { id: number; docNo: string; version: number }; onClose: () => void; onSaved: () => void; onReload: () => void;
}) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [mustReload, setMustReload] = useState(false), [busy, setBusy] = useState(false);
  const lock = useRef(false), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const save = async () => {
    if (lock.current || mustReload) return;
    const trimmed = reason.trim();
    if (!trimmed || trimmed.length > 500) { setError("请填写1–500字的作废原因"); return; }
    lock.current = true; setBusy(true); setError(null);
    try {
      const result = await postJson<{ id: number; version: number; status: string; closedReason: string }>(`/api/matflow/ct/${doc.id}/void`, { version: doc.version, reason: trimmed });
      if (result.id !== doc.id || result.version !== doc.version + 1 || result.status !== "void" || result.closedReason !== trimmed) {
        throw new Error("作废响应与原单不符，请重新读取核对，不重复操作");
      }
      if (mounted.current) onSaved();
    } catch (e) {
      if (!mounted.current) return;
      setError((e as Error).message);
      if (!(e instanceof JsonRequestError) || e.status !== 400) setMustReload(true);
    } finally { lock.current = false; if (mounted.current) setBusy(false); }
  };
  return <Modal {...viewportModalProps} open width={560} title={`作废未生效草稿 · ${doc.docNo}`} maskClosable={false} keyboard={!busy}
    onCancel={() => { if (!lock.current) onClose(); }} onOk={() => void save()} okText="确认作废" cancelText="保留草稿"
    confirmLoading={busy} okButtonProps={{ danger: true, disabled: busy || mustReload }} cancelButtonProps={{ disabled: busy }}>
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <Alert type="warning" showIcon message="作废后原单不可再编辑或提交。"
        description="原来源、实物批次、明细及审批历史全部保留，不改库存或采购已收数。若仍需退货，请核对后明确新建正确单据；本操作不会自动建单。" />
      {error && <Alert type="error" showIcon message={error} action={mustReload ? <Button size="small" onClick={onReload}>关闭并核对原单</Button> : undefined} />}
      <Input.TextArea aria-label="采购退货作废原因" placeholder="说明来源或批次错误及核对结论（必填）" rows={3} maxLength={500} showCount value={reason}
        disabled={busy || mustReload} onChange={event => { if (!lock.current) setReason(event.target.value); }} />
    </Space>
  </Modal>;
}
