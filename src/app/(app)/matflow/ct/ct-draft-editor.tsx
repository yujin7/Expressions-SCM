"use client";

import { useEffect, useRef, useState } from "react";
import { Alert, Button, Input, InputNumber, Modal, Space, Table, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { viewportModalProps } from "@/components/viewport-modal";
import { JsonRequestError, patchJson } from "@/components/fetchJson";
import { draftQuantityUnits } from "@/lib/fl-draft-reallocation";

type ReturnLine = { id: number; poLineId: number; skuCode: string; skuName: string; baseUom: string; qty: string;
  reason: string | null; batchId: number | null; batchNo: string | null; expiryDate: string | null };
export interface EditableCtDraft {
  id: number; docNo: string; version: number; poDocNo: string; warehouseName: string; remark: string | null; lines: ReturnLine[];
}

export default function CtDraftEditor({ doc, onClose, onSaved, onReload }: {
  doc: EditableCtDraft; onClose: () => void; onSaved: () => void; onReload: () => void;
}) {
  const [lines, setLines] = useState(() => doc.lines.map(line => ({ ...line })));
  const [remark, setRemark] = useState(doc.remark ?? "");
  const [error, setError] = useState<string | null>(null);
  const [mustReload, setMustReload] = useState(false), [busy, setBusy] = useState(false);
  const lock = useRef(false), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const save = async () => {
    if (lock.current || mustReload) return;
    try {
      if (!lines.length) throw new Error("至少保留一行退货明细");
      for (const line of lines) if (draftQuantityUnits(line.qty) <= 0n) throw new Error("退货数量须大于0；不需退回的行请移除");
    } catch (e) { setError((e as Error).message); return; }
    lock.current = true; setBusy(true); setError(null);
    try {
      const result = await patchJson<{ id: number; version: number; status: string }>(`/api/matflow/ct/${doc.id}`, {
        version: doc.version, remark: remark.trim(), lines: lines.map(({ id, qty, reason }) => ({ id, qty, reason: reason?.trim() || undefined })),
      });
      if (result.id !== doc.id || result.version !== doc.version + 1 || result.status !== "draft") throw new Error("保存响应与原单不符，请重新读取核对，不重复保存");
      if (mounted.current) onSaved();
    } catch (e) {
      if (!mounted.current) return;
      setError((e as Error).message);
      if (!(e instanceof JsonRequestError) || e.status !== 400) setMustReload(true);
    } finally { lock.current = false; if (mounted.current) setBusy(false); }
  };
  const columns: ColumnsType<ReturnLine> = [
    { title: "原采购行 / 物料 / 实物批次", key: "material", width: 280, render: (_, row) => <><div>PO行 #{row.poLineId} · {row.skuCode} · {row.skuName}</div>
      <Typography.Text type="secondary">{row.batchId == null ? "无批次历史库存" : row.batchNo ?? "批次身份待核对"} · {row.expiryDate ?? "效期未登记"}</Typography.Text></> },
    { title: "退货数量 / 单位", key: "qty", width: 180, render: (_, row) => <Space><InputNumber aria-label={`${row.skuCode} 退货数量 行${row.id}`} stringMode min="0.0001" precision={4} value={row.qty}
      disabled={busy || mustReload} onChange={value => { if (!lock.current) setLines(previous => previous.map(line => line.id === row.id ? { ...line, qty: String(value ?? "") } : line)); }} style={{ width: 110 }} />{row.baseUom}</Space> },
    { title: "退货原因", key: "reason", width: 200, render: (_, row) => <Input aria-label={`${row.skuCode} 退货原因 行${row.id}`} value={row.reason ?? ""} maxLength={200} disabled={busy || mustReload}
      onChange={event => { const value = event.target.value; if (!lock.current) setLines(previous => previous.map(line => line.id === row.id ? { ...line, reason: value } : line)); }} /> },
    { title: "操作", key: "remove", width: 70, render: (_, row) => <Button type="link" danger disabled={busy || mustReload || lines.length <= 1}
      onClick={() => { if (!lock.current) setLines(previous => previous.length > 1 ? previous.filter(line => line.id !== row.id) : previous); }}>移除</Button> },
  ];
  return <Modal {...viewportModalProps} open width={950} title={`修改采购退货草稿 · ${doc.docNo}`} maskClosable={false} keyboard={!busy}
    onCancel={() => { if (!lock.current) onClose(); }} confirmLoading={busy} okText="保存草稿" cancelText="放弃修改"
    okButtonProps={{ disabled: busy || mustReload }} cancelButtonProps={{ disabled: busy }} onOk={() => void save()}>
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <Alert type="info" showIcon message={`原采购订单 ${doc.poDocNo}、出库仓 ${doc.warehouseName}、采购行及批次保持不变。`}
        description="仅纠正数量、原因、备注或移除不退的行；保存不提交、不审批、不改变库存和PO已收数，原审批历史保留。来源或实物批次本身选错时，关闭后由具备资格的制单人或管理员作废错误草稿，再核对新建；不借用其他行或批次。" />
      {error && <Alert type="error" showIcon message={error} action={mustReload ? <Button size="small" onClick={onReload}>关闭并核对原单</Button> : undefined} />}
      <Table size="small" rowKey="id" columns={columns} dataSource={lines} pagination={false} tableLayout="fixed" scroll={{ x: 730, y: 280 }} />
      <Input.TextArea aria-label="修改退货备注" value={remark} disabled={busy || mustReload} rows={2} maxLength={500} placeholder="备注（可选）"
        onChange={event => { if (!lock.current) setRemark(event.target.value); }} />
    </Space>
  </Modal>;
}
