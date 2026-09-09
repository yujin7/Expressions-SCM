"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Button, Checkbox, Collapse, Empty, Grid, Input, Pagination, Radio, Select, Space, Spin, Table, Tag, Typography } from "antd";
import { fetchJson } from "@/components/fetchJson";
import { LIFECYCLE_LABELS } from "@/components/format";
import { COMMERCIAL_ROLE_LABELS } from "@/components/labels";
import { shanghaiTimestampOf } from "@/server/core/business-day";
import type { SkuSourceStatus, SkuStatusSource, SourceStatusRow } from "@/server/modules/master/sku-source-status";

type Confirmation = { requestId: string; fingerprint: string; source: "jst" | "jdy"; rowId: number; lifecycle: string; reason: string; independentlyVerified: true };
const statusLabel: Record<string, string> = { running: "进行中", failed: "失败", succeeded: "成功" };

function SourceRecords({ source, selection, onSelect, canWrite, frozen }: {
  source: SkuStatusSource; selection: string | undefined; onSelect: (key: string) => void; canWrite: boolean; frozen: boolean;
}) {
  const screens = Grid.useBreakpoint();
  const [page, setPage] = useState(1);
  const content = useRef<HTMLDivElement>(null);
  const current = Math.min(page, Math.max(1, Math.ceil(source.rows.length / 5)));
  const changePage = (next: number) => { content.current?.focus({ preventScroll: true }); setPage(next); };
  const gate = (row: SourceStatusRow) => row.confirmable ? <span>身份已确认；仍须独立核实业务状态</span> : <Typography.Text type="warning">{row.reasons.join("；")}</Typography.Text>;
  const status = (row: SourceStatusRow) => <>{row.meaning ?? `未知原值：${row.rawStatus ?? "缺失"}`}<br /><Typography.Text type="secondary" style={{ fontSize: 12 }}>{row.sourceAsOf ?? "日期未知"} · {row.ageDays == null ? "龄期未知" : `${row.ageDays} 天前`}</Typography.Text></>;
  if (!source.rows.length) return <Typography.Paragraph type="secondary" style={{ margin: 0, padding: "8px 0" }}>无可关联来源观察；不代表已删除或已停用</Typography.Paragraph>;
  return <div ref={content} tabIndex={-1} aria-label={`${source.label}记录`}>
    {screens.sm === false ? <div style={{ display: "grid", gap: 8 }}>
      {source.rows.slice((current - 1) * 5, current * 5).map(row => <div key={row.id} style={{ padding: 10, border: "1px solid #e4e7ec", borderRadius: 8, overflowWrap: "anywhere" }}>
        {canWrite ? <Radio aria-label={`选择${source.label}来源行${row.id}`} checked={selection === `${source.key}:${row.id}`} disabled={frozen || !row.confirmable} onChange={() => onSelect(`${source.key}:${row.id}`)}>{row.externalCode}</Radio> : <strong>{row.externalCode}</strong>}
        <div style={{ marginTop: 4 }}>{status(row)}</div>
        <div style={{ fontSize: 12, color: "#667085", margin: "4px 0" }}>批次 #{row.jobId} · 行 {row.rowNo}</div>
        <div>{gate(row)}</div>
      </div>)}
    </div> : <Table<SourceStatusRow> size="small" rowKey="id" dataSource={source.rows.slice((current - 1) * 5, current * 5)} scroll={{ x: 500 }} pagination={false}
      rowSelection={canWrite ? { type: "radio", selectedRowKeys: source.rows.filter(row => selection === `${source.key}:${row.id}`).map(row => row.id),
        onChange: keys => onSelect(`${source.key}:${String(keys[0])}`), getCheckboxProps: row => ({ disabled: frozen || !row.confirmable, "aria-label": `选择${source.label}来源行${row.id}` }) } : undefined}
      columns={[
        { title: "来源记录", key: "record", width: 165, render: (_, row) => <div style={{ overflowWrap: "anywhere" }}>{row.externalCode}<br /><Typography.Text type="secondary" style={{ fontSize: 12 }}>批次 #{row.jobId} · 行 {row.rowNo}</Typography.Text></div> },
        { title: "状态 / 截止", key: "status", width: 150, render: (_, row) => status(row) },
        { title: "核对资格", key: "gate", render: (_, row) => gate(row) },
      ]} />}
    {source.rows.length > 5 && <Pagination style={{ marginTop: 8 }} size="small" current={current} pageSize={5} total={source.rows.length} showSizeChanger={false} onChange={changePage} />}
  </div>;
}

export default function SkuSourceStatusPanel({ skuId, onConfirmed, onPendingChange }: { skuId: number; onConfirmed: (lifecycle: string) => void; onPendingChange: (pending: boolean) => void }) {
  const [data, setData] = useState<SkuSourceStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selection, setSelection] = useState<string>();
  const [lifecycle, setLifecycle] = useState<string>();
  const [reason, setReason] = useState("");
  const [verified, setVerified] = useState(false);
  const [pending, setPending] = useState<Confirmation | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<string | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);
  const alive = useRef(true);
  const formRef = useRef<HTMLDivElement>(null);
  const submitting = useRef(false);
  useEffect(() => { onPendingChange(pending !== null); return () => onPendingChange(false); }, [pending, onPendingChange]);
  const load = useCallback(async () => {
    formRef.current?.focus({ preventScroll: true });
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    setLoading(true); setData(null); setError(null); setSelection(undefined); setVerified(false);
    try {
      const next = await fetchJson<SkuSourceStatus>(`/api/master/sku/${skuId}/source-status`, { signal: controller.signal });
      if (!controller.signal.aborted) setData(next);
    } catch (e) { if (!controller.signal.aborted) setError((e as Error).message); }
    finally { if (!controller.signal.aborted) setLoading(false); }
  }, [skuId]);
  useEffect(() => { alive.current = true; void load(); return () => { alive.current = false; request.current?.abort(); }; }, [load]);

  async function olderHistory() {
    const before = data?.history.at(-1)?.id;
    if (!before || historyLoading) return;
    formRef.current?.focus({ preventScroll: true });
    setHistoryLoading(true); setHistoryError(null);
    const currentRequest = request.current;
    try {
      const next = await fetchJson<SkuSourceStatus>(`/api/master/sku/${skuId}/source-status?before=${before}`);
      if (alive.current && request.current === currentRequest) setData(previous => previous ? { ...previous, history: [...previous.history, ...next.history], historyHasMore: next.historyHasMore } : previous);
    } catch (e) { if (alive.current && request.current === currentRequest) setHistoryError((e as Error).message); }
    finally { if (alive.current) setHistoryLoading(false); }
  }

  async function submit(retry?: Confirmation) {
    if (submitting.current) return;
    if (!retry && (!data || !selection || !lifecycle || !verified || reason.trim().length < 6)) return;
    const [source, rowId] = (selection ?? "").split(":");
    const body: Confirmation = retry ?? { requestId: crypto.randomUUID(), fingerprint: data!.fingerprint, source: source as "jst" | "jdy",
      rowId: Number(rowId), lifecycle: lifecycle!, reason: reason.trim(), independentlyVerified: true };
    submitting.current = true;
    // Move focus before disabling controls so keyboard users can still leave the form.
    formRef.current?.focus({ preventScroll: true });
    setPending(body); setSaving(true); setSaveError(null); setReceipt(null);
    const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      const result = await fetchJson<{ auditId: number; lifecycle: string; replayed: boolean }>(`/api/master/sku/${skuId}/source-status`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: controller.signal });
      if (!result || !Number.isSafeInteger(result.auditId) || result.auditId <= 0 || result.lifecycle !== body.lifecycle || typeof result.replayed !== "boolean") throw new Error("未能确认保存回执；原提交已保留，请核对同一次提交");
      if (!alive.current) return;
      setPending(null); setReason(""); setLifecycle(undefined); setVerified(false);
      setReceipt(`确认记录 #${result.auditId}：${LIFECYCLE_LABELS[result.lifecycle] ?? result.lifecycle}。${result.replayed ? "已核对原提交，未重复写入。" : "仅更新生命周期，其余主档及库存未变。"}`);
      onConfirmed(result.lifecycle); await load();
    } catch (e) {
      if (!alive.current) return;
      setSaveError(controller.signal.aborted ? "等待回执超时，提交结果未知。请核对同一次提交，不要重复发起。" : (e as Error).message);
    } finally { clearTimeout(timeout); submitting.current = false; if (alive.current) setSaving(false); }
  }

  const frozen = saving || pending !== null;
  return <div ref={formRef} tabIndex={-1} aria-label="商品来源核对内容" style={{ minWidth: 0 }}>
    <Typography.Paragraph type="secondary" style={{ marginBottom: 12 }}>
      外部“启用”不是内部“在售”。这里只展示来源并记录人工核实，不自动认领商品、不更改用途/启用/效期，也不下单或过账。
    </Typography.Paragraph>
    {receipt && <Alert role="status" type="success" showIcon message={receipt} style={{ marginBottom: 12 }} />}
    {loading ? <Spin aria-label="正在读取商品来源状态" /> : error ? <Alert type="error" showIcon message="来源状态读取失败" description={error}
      action={<Button onClick={() => void load()}>重新读取</Button>} /> : data && <>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 12 }}>
        <span>系统：<Tag>{LIFECYCLE_LABELS[data.sku.lifecycle] ?? data.sku.lifecycle}</Tag></span>
        <span>{data.sku.active ? "已启用" : "已停用"} · 用途 {COMMERCIAL_ROLE_LABELS[data.sku.commercialRole] ?? data.sku.commercialRole}</span>
        <Button size="small" disabled={frozen} onClick={() => void load()}>刷新依据</Button>
      </div>
      {data.sources.map(source => <section key={source.key} style={{ marginBottom: 16 }} aria-label={source.label}>
        <Typography.Text strong>{source.label}</Typography.Text>
        <div style={{ color: "#667085", fontSize: 12, margin: "4px 0 8px", overflowWrap: "anywhere" }}>
          {source.mode === "changes" ? "修改流：新批次没有出现 ≠ 删除" : "完整镜像：仅看最近成功批次"} · 最新尝试：
          {source.latestAttempt ? `${statusLabel[source.latestAttempt.status] ?? source.latestAttempt.status}（${source.latestAttempt.finishedAt ? shanghaiTimestampOf(new Date(source.latestAttempt.finishedAt)) : "未结束"}）` : "没有运行记录"}
          {source.latestSuccess && <span> · 最近成功批次 #{source.latestSuccess.jobId ?? "未知"} / 截止 {source.latestSuccess.sourceAsOf ?? "未知"}</span>}
        </div>
        <SourceRecords source={source} selection={selection} onSelect={key => { setSelection(key); setVerified(false); }} canWrite={data.canWrite} frozen={frozen} />
        {source.truncated && <Alert type="warning" message={`共 ${source.total} 条关联观察，仅展示前100条；请先核对异常身份范围。`} />}
      </section>)}
      {data.canWrite ? <div aria-label="人工确认商品生命周期" style={{ padding: 12, border: "1px solid #e4e7ec", borderRadius: 8 }}>
        <Typography.Text strong>人工确认内部生命周期</Typography.Text>
        <div style={{ display: "grid", gap: 10, marginTop: 10 }}>
          <label>核实后的生命周期
            <Select aria-label="核实后的生命周期" value={lifecycle} placeholder="请选择，不从外部状态推断" disabled={frozen} onChange={setLifecycle}
              style={{ width: "100%", marginTop: 4 }} options={Object.entries(LIFECYCLE_LABELS).map(([value, label]) => ({ value, label }))} />
          </label>
          <label style={{ display: "grid", gap: 4 }}>业务核实依据
            <Input.TextArea aria-label="业务核实依据" value={reason} disabled={frozen} onChange={e => setReason(e.target.value)} maxLength={500} autoSize={{ minRows: 2, maxRows: 4 }} placeholder="说明与谁/哪份资料核实，以及为何选择该状态；至少6字" />
            <span style={{ textAlign: "right", color: "#667085", fontSize: 12 }}>{reason.length} / 500</span>
          </label>
          <Checkbox checked={verified} disabled={frozen} onChange={e => setVerified(e.target.checked)}>我已独立核实业务状态，并注意来源截止和历史性；外部启用不代表在售</Checkbox>
          {saveError && <Alert role="alert" type="error" showIcon message="未取得成功回执" description={saveError} />}
          <Space wrap>
            {pending ? <Button loading={saving} onClick={() => void submit(pending)}>核对同一次提交</Button> : <Button type="primary" disabled={!selection || !lifecycle || !verified || reason.trim().length < 6} onClick={() => void submit()}>确认并留痕</Button>}
            {pending && !saving && <Button onClick={() => { setPending(null); setSaveError(null); void load(); }}>放弃重试并刷新核对</Button>}
          </Space>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>回执不确定时请先核对同一次提交，或明确放弃重试后再关闭；放弃重试不会撤销可能已保存的记录。冲突时刷新依据后重新选择。允许明确确认维持原状态。</Typography.Text>
        </div>
      </div> : <Typography.Paragraph type="secondary">当前为只读；计划或管理员可进行人工状态确认。</Typography.Paragraph>}
      <Collapse style={{ marginTop: 12 }} items={[{ key: "history", label: `确认历史（已载入${data.history.length}条）`, children: data.history.length ? <div style={{ display: "grid", gap: 10 }}>
        {data.history.map(item => <div key={item.id} style={{ overflowWrap: "anywhere", borderBottom: "1px solid #f0f0f0", paddingBottom: 8 }}>
          <strong>#{item.id} {LIFECYCLE_LABELS[item.from] ?? item.from} → {LIFECYCLE_LABELS[item.to] ?? item.to}</strong>
          <div>{item.actor} · {shanghaiTimestampOf(new Date(item.at))}</div><div>{item.reason}</div>
          <Typography.Text type="secondary">{item.source} · {item.externalCode} · 原值 {item.rawStatus ?? "缺失"} · 截止 {item.sourceAsOf ?? "未知"} · 批次 #{item.jobId}</Typography.Text>
        </div>)}
        {historyError && <Alert type="error" message="更早历史读取失败" description={historyError} />}
        {data.historyHasMore && <Button loading={historyLoading} onClick={() => void olderHistory()}>读取更早确认</Button>}
      </div> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="尚无人工状态确认记录" /> }]} />
    </>}
  </div>;
}
