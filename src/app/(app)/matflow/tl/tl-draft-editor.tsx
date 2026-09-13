"use client";

import { useEffect, useRef, useState } from "react";
import { Alert, Button, Input, InputNumber, Modal, Select, Space, Table, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import RemoteSelect from "@/components/RemoteSelect";
import { viewportModalProps } from "@/components/viewport-modal";
import { JsonRequestError, patchJson } from "@/components/fetchJson";
import { draftQuantityUnits } from "@/lib/fl-draft-reallocation";

type ReturnLine = { id: number; skuCode: string; skuName: string | null; baseUom: string; qty: string;
  reason: string; batchId: number | null; batchNo: string | null; expiryDate: string | null };
export interface EditableTlDraft {
  id: number; docNo: string; version: number; jgDocNo: string; fromWarehouseName: string;
  toWarehouseId: number; remark: string | null; lines: ReturnLine[];
}

export default function TlDraftEditor({ doc, onClose, onSaved, onReload }: {
  doc: EditableTlDraft; onClose: () => void; onSaved: () => void; onReload: () => void;
}) {
  const [lines, setLines] = useState(() => doc.lines.map(line => ({ ...line })));
  const [toId, setToId] = useState<number | null>(doc.toWarehouseId);
  const [remark, setRemark] = useState(doc.remark ?? "");
  const [error, setError] = useState<string | null>(null);
  const [mustReload, setMustReload] = useState(false), [busy, setBusy] = useState(false);
  const lock = useRef(false), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const save = async () => {
    if (lock.current || mustReload || toId == null) return;
    try {
      if (!lines.length) throw new Error("至少保留一行退料明细");
      for (const line of lines) {
        if (draftQuantityUnits(line.qty) <= 0n) throw new Error("退料数量须大于0；不需退回的行请移除");
        if (!["surplus_return", "defect_exchange"].includes(line.reason)) throw new Error("请选择每行退料原因");
      }
    } catch (e) { setError((e as Error).message); return; }
    lock.current = true; setBusy(true); setError(null);
    try {
      const result = await patchJson<{ id: number; version: number; status: string }>(`/api/matflow/tl/${doc.id}`, {
        version: doc.version, toWarehouseId: toId, remark: remark.trim(),
        lines: lines.map(({ id, qty, reason }) => ({ id, qty, reason })),
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
    { title: "物料 / 原批次", key: "material", width: 230, render: (_, row) => <><div>{row.skuCode} · {row.skuName || "—"}</div>
      <Typography.Text type="secondary">{row.batchId == null ? "无批次历史库存" : row.batchNo ?? "批次身份待核对"} · {row.expiryDate ?? "效期未登记"}</Typography.Text></> },
    { title: "退回数量 / 单位", key: "qty", width: 180, render: (_, row) => <Space><InputNumber aria-label={`${row.skuCode} 退料数量 行${row.id}`} stringMode min="0.0001" precision={4} value={row.qty}
      disabled={busy || mustReload} onChange={value => { if (!lock.current) setLines(lines.map(line => line.id === row.id ? { ...line, qty: String(value ?? "") } : line)); }} style={{ width: 110 }} />{row.baseUom}</Space> },
    { title: "退料原因", key: "reason", width: 170, render: (_, row) => <Select aria-label={`${row.skuCode} 退料原因 行${row.id}`} value={row.reason} disabled={busy || mustReload} style={{ width: "100%" }}
      options={[{ value: "surplus_return", label: "剩料退回" }, { value: "defect_exchange", label: "不合格料退换" }]}
      onChange={(reason: string) => { if (!lock.current) setLines(lines.map(line => line.id === row.id ? { ...line, reason } : line)); }} /> },
    { title: "操作", key: "remove", width: 70, render: (_, row) => <Button type="link" danger disabled={busy || mustReload || lines.length <= 1}
      onClick={() => { if (!lock.current) setLines(lines.filter(line => line.id !== row.id)); }}>移除</Button> },
  ];
  return <Modal {...viewportModalProps} open width={900} title={`修改退料草稿 · ${doc.docNo}`} maskClosable={false} keyboard={!busy}
    onCancel={() => { if (!lock.current) onClose(); }} confirmLoading={busy} okText="保存草稿" cancelText="放弃修改"
    okButtonProps={{ disabled: busy || mustReload || toId == null }} cancelButtonProps={{ disabled: busy }} onOk={() => void save()}>
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <Alert type="info" showIcon message={`原加工通知单 ${doc.jgDocNo}、来源仓 ${doc.fromWarehouseName}、物料和批次保持不变。`}
        description="保存不提交、不审批、不过账；原审批历史保留。退料按实际原批次核对，不自动换成其他有效批次。若来源或批次本身错误，请先联系仓管核对原始流转，不借用其他工单库存。" />
      <div><Typography.Text>退回自有仓</Typography.Text><RemoteSelect aria-label="修改退回仓" api="/api/master/warehouse" style={{ width: "100%" }} value={toId} disabled={busy || mustReload}
        getLabel={row => `${String(row.code)} ${String(row.name)}`} filterRow={row => row.active === true && row.accountingMode === "realtime" && row.kind !== "outsource" && row.kind !== "snapshot"}
        onChange={(id: number) => { if (!lock.current) setToId(id); }} /></div>
      {error && <Alert type="error" showIcon message={error} action={mustReload ? <Button size="small" onClick={onReload}>关闭并核对原单</Button> : undefined} />}
      <Table size="small" rowKey="id" columns={columns} dataSource={lines} pagination={false} tableLayout="fixed" scroll={{ x: 650, y: 280 }} />
      <Input.TextArea aria-label="修改退料备注" value={remark} disabled={busy || mustReload} rows={2} maxLength={500} placeholder="备注（可选）"
        onChange={event => { if (!lock.current) setRemark(event.target.value); }} />
    </Space>
  </Modal>;
}
