"use client";

import { useEffect, useRef, useState } from "react";
import { Alert, Button, Input, InputNumber, Modal, Space, Table, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import RemoteSelect from "@/components/RemoteSelect";
import OutsourceWarehouseSelect from "@/components/OutsourceWarehouseSelect";
import { viewportModalProps } from "@/components/viewport-modal";
import { fetchJson, JsonRequestError, patchJson } from "@/components/fetchJson";
import { useLatestRead } from "@/components/useLatestRead";
import { applyDraftFefo, draftMaterialTotals, type DraftMaterialLine, type FefoDraftResponse } from "@/lib/fl-draft-reallocation";

export interface EditableFlDraft {
  id: number; docNo: string; version: number; jgDocNo: string; supplierId: number;
  fromWarehouseId: number; toWarehouseId: number; remark: string | null; lines: DraftMaterialLine[];
}

export default function FlDraftEditor({ doc, onClose, onSaved, onReload }: {
  doc: EditableFlDraft; onClose: () => void; onSaved: () => void; onReload: () => void;
}) {
  const [lines, setLines] = useState(() => doc.lines.map(line => ({ ...line })));
  const [fromId, setFromId] = useState<number | null>(doc.fromWarehouseId);
  const [toId, setToId] = useState<number | null>(doc.toWarehouseId);
  const [remark, setRemark] = useState(doc.remark ?? "");
  const [needsAllocation, setNeedsAllocation] = useState(false);
  const [notes, setNotes] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [mustReload, setMustReload] = useState(false);
  const [busy, setBusy] = useState<"read" | "save" | null>(null);
  const lock = useRef(false), mounted = useRef(true);
  const beginRead = useLatestRead();
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const changeLines = (next: DraftMaterialLine[]) => { if (lock.current) return; setLines(next); setNeedsAllocation(true); setNotes([]); };
  const reallocate = async () => {
    if (lock.current || fromId == null || mustReload) return;
    let totals; try { totals = draftMaterialTotals(lines); } catch (e) { setError((e as Error).message); return; }
    lock.current = true; setBusy("read"); setError(null); setNeedsAllocation(true);
    const read = beginRead();
    try {
      const results: FefoDraftResponse[] = [];
      const signal = AbortSignal.any([read.signal, AbortSignal.timeout(15000)]);
      // At most three independent reads at once; one deadline for the whole preview.
      for (let offset = 0; offset < totals.length; offset += 3) {
        results.push(...await Promise.all(totals.slice(offset, offset + 3).map(total => {
          const query = new URLSearchParams({ skuId: String(total.skuId), warehouseId: String(fromId), qty: total.qty });
          return fetchJson<FefoDraftResponse>(`/api/inventory/fefo-suggest?${query}`, { cache: "no-store", signal });
        })));
      }
      if (!read.isCurrent() || !mounted.current) return;
      const next = applyDraftFefo(lines, results);
      setLines(next); setNotes(results.map(r => `${lines.find(l => l.skuId === r.skuId)?.skuCode}：${r.note}`)); setNeedsAllocation(false);
    } catch (e) { if (read.isCurrent() && mounted.current) setError(`配批未完成，原明细保留：${(e as Error).message}`); }
    finally { lock.current = false; if (mounted.current) setBusy(null); }
  };
  const save = async () => {
    if (lock.current || needsAllocation || mustReload || fromId == null || toId == null) return;
    try { draftMaterialTotals(lines); } catch (e) { setError((e as Error).message); return; }
    lock.current = true; setBusy("save"); setError(null);
    try {
      const result = await patchJson<{ id: number; version: number; status: string }>(`/api/matflow/fl/${doc.id}`, {
        version: doc.version, fromWarehouseId: fromId, toWarehouseId: toId, remark: remark.trim(),
        lines: lines.map(({ skuId, qty, batchId }) => ({ skuId, qty, batchId })),
      });
      if (result.id !== doc.id || result.version !== doc.version + 1 || result.status !== "draft") throw new Error("保存响应与当前单据不符，请先重新读取核对，不重复保存");
      if (mounted.current) onSaved();
    } catch (e) {
      if (!mounted.current) return;
      setError((e as Error).message);
      if (!(e instanceof JsonRequestError) || e.status !== 400) setMustReload(true);
    } finally { lock.current = false; if (mounted.current) setBusy(null); }
  };
  const columns: ColumnsType<DraftMaterialLine & { key: number }> = [
    { title: "物料", key: "sku", width: 200, render: (_, row) => <><div>{row.skuCode}</div><Typography.Text type="secondary">{row.skuName || "—"}</Typography.Text></> },
    { title: "数量 / 单位", key: "qty", width: 170, render: (_, row) => <Space><InputNumber aria-label={`${row.skuCode} 发料数量 ${row.key + 1}`} stringMode min="0.0001" precision={4} disabled={busy != null || mustReload} value={row.qty} onChange={value => changeLines(lines.map((line, index) => index === row.key ? { ...line, qty: String(value ?? "") } : line))} style={{ width: 110 }} /><span>{row.baseUom}</span></Space> },
    { title: "保存的批次 / 效期", key: "batch", width: 230, render: (_, row) => <><div>{row.batchId == null ? "无批次历史库存" : row.batchNo ?? "批次身份待核对"}</div><Typography.Text type="secondary">{row.batchId == null ? "不代表已具备批次追溯" : row.expiryDate ?? "效期未登记，需人工核对"}</Typography.Text></> },
    { title: "操作", key: "remove", width: 70, render: (_, row) => <Button type="link" danger disabled={busy != null || mustReload || lines.length <= 1} onClick={() => changeLines(lines.filter((_, index) => index !== row.key))}>移除</Button> },
  ];
  return <Modal {...viewportModalProps} open width={900} title={`修改发料草稿 · ${doc.docNo}`} maskClosable={false} keyboard={busy == null}
    onCancel={() => { if (!lock.current) onClose(); }} confirmLoading={busy === "save"} okText="保存草稿" cancelText="放弃修改"
    okButtonProps={{ disabled: busy != null || needsAllocation || mustReload || fromId == null || toId == null }} cancelButtonProps={{ disabled: busy != null }} onOk={() => void save()}>
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <Alert type="info" showIcon message={`原加工通知单 ${doc.jgDocNo} 保持不变；保存不提交、不审批、不占用库存。原审批历史保留。`} />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(230px,1fr))", gap: 12, width: "100%" }}>
        <div><Typography.Text>发料仓</Typography.Text><RemoteSelect aria-label="修改发料仓" api="/api/master/warehouse" style={{ width: "100%" }} value={fromId} disabled={busy != null || mustReload}
          getLabel={row => `${String(row.code)} ${String(row.name)}`} filterRow={row => row.active === true && row.accountingMode === "realtime" && row.kind !== "outsource" && row.kind !== "snapshot"}
          onChange={(id: number) => { if (lock.current) return; setFromId(id); setNeedsAllocation(true); setNotes([]); }} /></div>
        <div><Typography.Text>加工厂收料仓</Typography.Text><OutsourceWarehouseSelect supplierId={doc.supplierId} value={toId} onChange={setToId} disabled={busy != null || mustReload} label="修改加工厂收料仓" /></div>
      </div>
      <Button loading={busy === "read"} disabled={busy != null || mustReload || fromId == null} onClick={() => void reallocate()}>按当前库存重新配批</Button>
      {needsAllocation && <Alert type="warning" showIcon message="数量或源仓已变化，须重新配批并核对下表后才能保存；不会自动套用未核对的批次。" />}
      {error && <Alert type="error" showIcon message={error} action={mustReload ? <Button size="small" onClick={onReload}>关闭并核对原单</Button> : undefined} />}
      <Table size="small" rowKey="key" columns={columns} dataSource={lines.map((line, key) => ({ ...line, key }))} pagination={false} tableLayout="fixed" scroll={{ x: 670, y: 280 }} />
      {notes.length > 0 && <Alert type="warning" showIcon message="配批已更新到表格，尚未保存；请核对数量、批次和缺失信息。" description={<ul style={{ margin: 0, paddingLeft: 18 }}>{notes.map((note, index) => <li key={index}>{note}</li>)}</ul>} />}
      <Input.TextArea aria-label="修改发料备注" value={remark} disabled={busy != null || mustReload} rows={2} maxLength={500} placeholder="备注（可选）" onChange={event => setRemark(event.target.value)} />
    </Space>
  </Modal>;
}
