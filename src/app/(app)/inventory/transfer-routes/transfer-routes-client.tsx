"use client";

/**
 * D60 调拨线路与费用（/inventory/transfer-routes）：
 * Tab 线路汇总（transfer-routes/v2 读模型，paramPrefix ln）/ 费用明细（transfer_fees，paramPrefix fee）/
 * 异常（同读模型 anomalies，paramPrefix an）。元/件与费用仅 PRICE_VISIBLE_ROLES（服务端已剥离，前端只折叠展示）。
 * 判定文案（statusReason/feeReason/qtyReason）服务端不带数值；偏差百分比/σ 只在 moneyVisible 时由本页拼接。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Alert, App, Button, DatePicker, Form, Input, InputNumber, Modal, Select, Space, Statistic, Table, Tabs, Tag, Tooltip, Typography,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import { fetchJson, postJson } from "@/components/fetchJson";
import CaliberNote from "@/components/CaliberNote";
import { exportCsv } from "@/components/exportCsv";
import { formatQty } from "@/components/format";
import ListToolbar from "@/components/ListToolbar";
import LoadErrorAlert from "@/components/LoadErrorAlert";
import RemoteSelect from "@/components/RemoteSelect";
import { useListState } from "@/components/useListState";
import { hasAnyRole, useMe } from "@/components/useMe";
import { metricTooltip } from "@/components/metrics";
import { TRANSFER_TYPE_LABELS, TRANSFER_TYPES } from "@/lib/transfer-types";

interface RecentDoc {
  docId: number;
  docNo: string;
  date: string;
  qty: string;
  amount?: string | null;
  unitFee?: string | null;
}

interface LaneRow {
  laneKey: string;
  fromWarehouseId: number;
  toWarehouseId: number;
  fromWarehouse: string;
  toWarehouse: string;
  transferType: string;
  transferTypeLabel: string;
  docCount: number;
  docCount30: number;
  totalQty: string;
  amount?: string | null;
  avgUnitFee: string | null;
  medianUnitFee: string | null;
  samples: number;
  medianQty: string | null;
  scattered: boolean;
  status: "ok" | "watch" | "alert" | "insufficient" | "no_fee";
  latestDocNo: string | null;
  latestDate: string | null;
  latestDeviationPct: string | null;
  latestZ: number | null;
  statusReason: string;
  recentDocs: RecentDoc[];
}

interface AnomalyRow {
  docId: number;
  docNo: string;
  laneKey: string;
  fromWarehouse: string;
  toWarehouse: string;
  transferType: string;
  transferTypeLabel: string;
  date: string;
  qty: string;
  amount?: string | null;
  unitFee?: string | null;
  feeLevel: "ok" | "watch" | "alert";
  feePctDev: string | null;
  feeZ: number | null;
  feeSamples: number;
  feeInsufficient: boolean;
  feeReason: string;
  qtyLevel: "ok" | "watch" | "insufficient";
  qtyMedian: string | null;
  qtyRatio: string | null;
  qtySamples: number;
  qtyReason: string;
  level: "alert" | "watch";
}

interface RoutesModel {
  builtAt: string;
  asOf: string;
  windowStart: string;
  params: { windowDays: number; deviationPct: number; qtyDeviationX: number; batchMaxDocs: number };
  summary: {
    laneCount: number; docCount: number; feeDocCount: number; unclassifiedDocCount: number;
    anomalyCount: number; alertCount: number; scatteredLaneCount: number; totalQty: string; amount?: string | null;
  };
  lanes: LaneRow[];
  anomalies: AnomalyRow[];
  limitations: string[];
  moneyVisible: boolean;
}

interface FeeRow {
  id: number;
  stockDocId: number;
  docNo: string;
  docStatus: string;
  transferType: string | null;
  fromWarehouse: string | null;
  toWarehouse: string | null;
  feeType: string;
  feeTypeLabel: string;
  amount?: string;
  currency: string;
  carrier: string | null;
  bizDate: string;
  source: string;
  note: string | null;
  reversalOfId: number | null;
  reversed: boolean;
  createdByName: string | null;
  createdAt: string;
}

const TYPE_OPTIONS = [
  ...TRANSFER_TYPES.map((t) => ({ value: t, label: TRANSFER_TYPE_LABELS[t] })),
  { value: "unclassified", label: "未分类（存量）" },
];
const FEE_TYPE_LABELS: Record<string, string> = { freight: "运费", handling: "装卸/操作费", customs: "关税/报关费", other: "其他" };
const STATUS_TAG: Record<LaneRow["status"], { color: string; text: string }> = {
  alert: { color: "red", text: "异常" },
  watch: { color: "orange", text: "提醒" },
  insufficient: { color: "default", text: "样本不足" },
  ok: { color: "green", text: "正常" },
  no_fee: { color: "default", text: "未登记费用" },
};

const money = (v: string | null | undefined, visible: boolean): string =>
  !visible ? "***" : v == null ? "—" : Number(v).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const unit = (v: string | null | undefined, visible: boolean): string =>
  !visible ? "***" : v == null ? "—" : Number(v).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 4 });
/** 费用判定文案 + 数值：偏差 %/σ 只在价格可见时拼接（服务端文案本身不带数值） */
const feeReasonText = (reason: string, pctDev: string | null, z: number | null, visible: boolean): string =>
  !visible || pctDev == null ? reason : `${reason}（偏差 ${pctDev}%${z != null ? ` · ${z}σ` : ""}）`;
/** 数量判定文案 + 数值：件数/中位数/倍数全员可见，仅在判定为数量异常时拼接 */
const qtyReasonText = (r: Pick<AnomalyRow, "qtyLevel" | "qtyReason" | "qty" | "qtyMedian" | "qtyRatio">): string =>
  r.qtyLevel === "watch" && r.qtyMedian != null
    ? `${r.qtyReason}（本单 ${formatQty(r.qty)} 件 / 中位数 ${formatQty(r.qtyMedian)}${r.qtyRatio ? ` ×${r.qtyRatio}` : ""}）`
    : r.qtyReason;

function useRoutesModel(filters: { from?: string; to?: string; type?: string; level?: string }) {
  const [data, setData] = useState<RoutesModel | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<AbortController | null>(null);
  const load = useCallback(async (refresh = false) => {
    ref.current?.abort();
    const c = new AbortController();
    ref.current = c;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (filters.from) params.set("from", filters.from);
      if (filters.to) params.set("to", filters.to);
      if (filters.type) params.set("type", filters.type);
      if (filters.level) params.set("level", filters.level);
      if (refresh) params.set("refresh", "1");
      const next = await fetchJson<RoutesModel>(`/api/report/transfer-routes?${params.toString()}`, { signal: c.signal });
      if (!c.signal.aborted) setData(next);
    } catch (e) {
      if (!c.signal.aborted) setError((e as Error).message);
    } finally {
      if (ref.current === c) { ref.current = null; setLoading(false); }
    }
  }, [filters.from, filters.to, filters.type, filters.level]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => () => ref.current?.abort(), []);
  return { data, loading, error, reload: load };
}

function LaneFilters({ state }: { state: ReturnType<typeof useListState<{ q: string; from: string; to: string; type: string }>> }) {
  return (
    <Space wrap>
      <RemoteSelect
        api="/api/master/warehouse"
        getLabel={(r) => `${String(r.code)} ${String(r.name)}`}
        placeholder="转出仓"
        allowClear
        style={{ width: 200 }}
        value={state.filters.from ? Number(state.filters.from) : undefined}
        onChange={(v) => state.setFilter({ from: v == null ? "" : String(v) })}
      />
      <RemoteSelect
        api="/api/master/warehouse"
        getLabel={(r) => `${String(r.code)} ${String(r.name)}`}
        placeholder="转入仓"
        allowClear
        style={{ width: 200 }}
        value={state.filters.to ? Number(state.filters.to) : undefined}
        onChange={(v) => state.setFilter({ to: v == null ? "" : String(v) })}
      />
      <Select
        allowClear
        placeholder="调拨类型"
        style={{ width: 160 }}
        options={TYPE_OPTIONS}
        value={state.filters.type || undefined}
        onChange={(v) => state.setFilter({ type: v ?? "" })}
      />
    </Space>
  );
}

function LanesTab() {
  const me = useMe();
  const canRefresh = hasAnyRole(me, "warehouse", "pmc", "finance"); // 与 /api/report/transfer-routes 的 requireAnyRole 一致（D60/D62）
  // scattered=1：只看零散线路（驾驶舱「零散线路 N」计数深链到此）
  const listState = useListState({ key: "transfer-routes-lanes", paramPrefix: "ln", defaults: { q: "", from: "", to: "", type: "", scattered: "" }, defaultPageSize: 20 });
  const { filters, page, pageSize } = listState;
  const { data, loading, error, reload } = useRoutesModel({ from: filters.from, to: filters.to, type: filters.type });
  const q = filters.q.trim().toLowerCase();
  const onlyScattered = filters.scattered === "1";
  const rows = useMemo(() => {
    const all = (data?.lanes ?? []).filter((l) => !onlyScattered || l.scattered);
    return q ? all.filter((l) => `${l.fromWarehouse} ${l.toWarehouse} ${l.transferTypeLabel} ${l.latestDocNo ?? ""}`.toLowerCase().includes(q)) : all;
  }, [data, q, onlyScattered]);
  const visible = data?.moneyVisible ?? false;
  const onExport = () => {
    if (!data) return;
    exportCsv(
      `调拨线路-${data.asOf}`,
      ["转出仓", "转入仓", "类型", "30天单数", "零散", "窗口单数", "Σ件", "元/件(基线)", "中位数元/件", "Σ费用", "n", "件数中位数", "最近一单", "最近日期", "偏差%", "σ", "状态", "判定"],
      rows.map((r) => [r.fromWarehouse, r.toWarehouse, r.transferTypeLabel, r.docCount30, r.scattered ? "是" : "", r.docCount, r.totalQty, visible ? r.avgUnitFee : "***", visible ? r.medianUnitFee : "***", visible ? (r.amount ?? "") : "***", r.samples, r.medianQty, r.latestDocNo, r.latestDate, visible ? r.latestDeviationPct : "***", visible ? r.latestZ : "***", STATUS_TAG[r.status].text, feeReasonText(r.statusReason, r.latestDeviationPct, r.latestZ, visible)]),
    );
  };
  const columns: ColumnsType<LaneRow> = [
    { title: "线路", key: "lane", width: 240, fixed: "left", render: (_, r) => <span>{r.fromWarehouse} → {r.toWarehouse}</span> },
    { title: "类型", dataIndex: "transferTypeLabel", width: 110, render: (v: string, r) => <Tag color={r.transferType === "unclassified" ? "default" : "geekblue"}>{v}</Tag> },
    { title: "30 天单数", dataIndex: "docCount30", width: 100, align: "right", sorter: (a, b) => a.docCount30 - b.docCount30, render: (v: number, r) => r.scattered ? <Tooltip title={`30 天 > ${data?.params.batchMaxDocs ?? 4} 单：零散调拨，建议合并批次`}><Tag color="orange">{v} 零散</Tag></Tooltip> : v },
    { title: `窗口单数`, dataIndex: "docCount", width: 90, align: "right", sorter: (a, b) => a.docCount - b.docCount },
    { title: "Σ件", dataIndex: "totalQty", width: 110, align: "right", sorter: (a, b) => Number(a.totalQty) - Number(b.totalQty), render: (v: string) => formatQty(v) },
    { title: <Tooltip title={metricTooltip("transferLaneAvgFee")}>元/件（基线）</Tooltip>, dataIndex: "avgUnitFee", width: 120, align: "right", render: (v: string | null) => unit(v, visible) },
    { title: "中位数 元/件", dataIndex: "medianUnitFee", width: 120, align: "right", render: (v: string | null) => unit(v, visible) },
    { title: "Σ费用", dataIndex: "amount", width: 120, align: "right", render: (v: string | null | undefined) => money(v, visible) },
    { title: <Tooltip title={metricTooltip("transferLaneSamples")}>n</Tooltip>, dataIndex: "samples", width: 60, align: "right" },
    { title: "件数中位数", dataIndex: "medianQty", width: 110, align: "right", render: (v: string | null) => (v == null ? "—" : formatQty(v)) },
    {
      title: "最近一单",
      key: "latest",
      width: 170,
      render: (_, r) => r.latestDocNo ? <span>{r.latestDocNo}<br /><Typography.Text type="secondary">{r.latestDate}</Typography.Text></span> : "—",
    },
    {
      title: "偏差",
      key: "dev",
      width: 110,
      align: "right",
      sorter: visible ? (a, b) => Math.abs(Number(a.latestDeviationPct ?? 0)) - Math.abs(Number(b.latestDeviationPct ?? 0)) : undefined,
      render: (_, r) => !visible ? "***" : r.latestDeviationPct == null ? "—" : <span>{r.latestDeviationPct}%{r.latestZ != null ? <Typography.Text type="secondary"> · {r.latestZ}σ</Typography.Text> : null}</span>,
    },
    {
      title: "状态",
      dataIndex: "status",
      width: 110,
      render: (v: LaneRow["status"], r) => <Tooltip title={feeReasonText(r.statusReason, r.latestDeviationPct, r.latestZ, visible)}><Tag color={STATUS_TAG[v].color}>{STATUS_TAG[v].text}</Tag></Tooltip>,
    },
  ];
  return (
    <div>
      <ListToolbar
        state={listState}
        onExport={data ? onExport : undefined}
        extra={(
          <Space wrap>
            <LaneFilters state={listState as unknown as ReturnType<typeof useListState<{ q: string; from: string; to: string; type: string }>>} />
            <Select allowClear placeholder="零散" style={{ width: 120 }} options={[{ value: "1", label: "仅零散线路" }]} value={filters.scattered || undefined} onChange={(v) => listState.setFilter({ scattered: v ?? "" })} />
          </Space>
        )}
        primaryActions={canRefresh ? <Button onClick={() => void reload(true)} loading={loading}>重算</Button> : undefined}
      />
      {error ? <LoadErrorAlert error={error} onRetry={() => void reload()} /> : null}
      {data ? (
        <Space size="large" wrap style={{ marginBottom: 12 }}>
          <a onClick={() => listState.setFilter({ scattered: "" })}><Statistic title="线路" value={data.summary.laneCount} /></a>
          <Statistic title={`窗口单数（${data.params.windowDays} 天）`} value={data.summary.docCount} />
          <a href="/inventory/transfer-routes?tr_tab=fees&fee_view=active"><Statistic title="登记费用单数" value={data.summary.feeDocCount} /></a>
          <Statistic title="Σ费用" value={money(data.summary.amount, visible)} />
          <a onClick={() => listState.setFilter({ scattered: "1" })}><Statistic title="零散线路" value={data.summary.scatteredLaneCount} /></a>
          <a onClick={() => listState.setFilter({ type: "unclassified", scattered: "" })}><Statistic title="未分类存量单" value={data.summary.unclassifiedDocCount} /></a>
        </Space>
      ) : null}
      <Table<LaneRow>
        rowKey="laneKey"
        size={listState.tableSize}
        loading={loading}
        columns={columns}
        dataSource={rows.slice((page - 1) * pageSize, page * pageSize)}
        pagination={listState.paginationProps({ total: rows.length, showTotal: (t) => `共 ${t} 条线路` })}
        scroll={{ x: 1700 }}
        expandable={{
          expandedRowRender: (r) => (
            <Table<RecentDoc>
              rowKey="docId"
              size="small"
              pagination={false}
              dataSource={r.recentDocs}
              columns={[
                { title: "单号", dataIndex: "docNo", width: 180, render: (v: string) => <a href={`/inventory/docs?q=${encodeURIComponent(v)}`}>{v}</a> },
                { title: "完成日", dataIndex: "date", width: 120 },
                { title: "件数", dataIndex: "qty", width: 120, align: "right", render: (v: string) => formatQty(v) },
                { title: "费用", dataIndex: "amount", width: 120, align: "right", render: (v: string | null | undefined) => money(v, visible) },
                { title: "元/件", dataIndex: "unitFee", width: 120, align: "right", render: (v: string | null | undefined) => unit(v, visible) },
              ]}
            />
          ),
        }}
      />
      {data ? (
        <Typography.Paragraph type="secondary" style={{ marginTop: 12, fontSize: 12 }}>
          来源：SCM 已完成调拨单 + 人工登记费用 · 时点：{data.asOf}（窗口起 {data.windowStart}，构建 {new Date(data.builtAt).toLocaleString("zh-CN")}）· 限制：{data.limitations.join(" ")}
        </Typography.Paragraph>
      ) : null}
    </div>
  );
}

function FeeModal({ open, onClose, onSaved }: { open: boolean; onClose: () => void; onSaved: () => void }) {
  const { message } = App.useApp();
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);
  const submit = async () => {
    try {
      const v = await form.validateFields();
      setSaving(true);
      const res = await postJson<{ warning: { level: string; reason: string } | null }>("/api/inventory/transfer-fees", {
        stockDocId: v.stockDocId,
        feeType: v.feeType,
        amount: String(v.amount),
        carrier: v.carrier || undefined,
        bizDate: v.bizDate ? v.bizDate.format("YYYY-MM-DD") : undefined,
        note: v.note || undefined,
      });
      if (res.warning && res.warning.level !== "ok") message.warning(`已登记；${res.warning.reason}`);
      else message.success("费用已登记");
      form.resetFields();
      onSaved();
      onClose();
    } catch (e) {
      if (e instanceof Error && e.message) message.error(e.message);
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal title="登记调拨费用" open={open} onCancel={onClose} onOk={() => void submit()} confirmLoading={saving} okText="登记" cancelText="取消" destroyOnHidden>
      <Form form={form} layout="vertical">
        <Form.Item name="stockDocId" label="调拨单（已审批/已完成）" rules={[{ required: true, message: "必须选择调拨单" }]}>
          <RemoteSelect
            api="/api/inventory/stock-doc?subtype=transfer&status=completed"
            getLabel={(r) => `${String(r.docNo)} ${String(r.warehouseName ?? "")}→${String(r.toWarehouseName ?? "")}`}
            placeholder="搜索已完成调拨单"
          />
        </Form.Item>
        <Form.Item name="feeType" label="费用类型" rules={[{ required: true, message: "必须选择费用类型" }]} initialValue="freight">
          <Select options={Object.entries(FEE_TYPE_LABELS).map(([value, label]) => ({ value, label }))} />
        </Form.Item>
        <Form.Item name="amount" label="金额（元，≥0；纠错走红字作废）" rules={[{ required: true, message: "必须填写金额" }]}>
          <InputNumber min={0} precision={2} style={{ width: "100%" }} />
        </Form.Item>
        <Form.Item name="bizDate" label="费用发生日" rules={[{ required: true, message: "必须填写发生日" }]}>
          <DatePicker style={{ width: "100%" }} />
        </Form.Item>
        <Form.Item name="carrier" label="承运商"><Input maxLength={100} /></Form.Item>
        <Form.Item name="note" label="备注"><Input.TextArea rows={2} maxLength={500} /></Form.Item>
      </Form>
    </Modal>
  );
}

function FeesTab() {
  const { message, modal } = App.useApp();
  const me = useMe();
  const canWrite = hasAnyRole(me, "warehouse", "finance", "admin");
  const canSeeMoney = hasAnyRole(me, "purchasing", "pmc", "finance", "admin");
  const listState = useListState({ key: "transfer-fees", paramPrefix: "fee", defaults: { q: "", from: "", to: "", type: "", feeType: "", view: "" }, defaultPageSize: 50 });
  const { filters, page, pageSize } = listState;
  const [rows, setRows] = useState<FeeRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ q: filters.q, page: String(page), pageSize: String(pageSize) });
      if (filters.from) params.set("from", filters.from);
      if (filters.to) params.set("to", filters.to);
      if (filters.type) params.set("type", filters.type);
      if (filters.feeType) params.set("feeType", filters.feeType);
      if (filters.view) params.set("view", filters.view);
      const res = await fetchJson<{ rows: FeeRow[]; total: number }>(`/api/inventory/transfer-fees?${params.toString()}`);
      setRows(res.rows);
      setTotal(res.total);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [filters.q, filters.from, filters.to, filters.type, filters.feeType, filters.view, page, pageSize]);
  useEffect(() => { void load(); }, [load]);

  const reverse = (r: FeeRow) => {
    let reason = "";
    modal.confirm({
      title: `作废费用 #${r.id}（${r.docNo} ${r.feeTypeLabel}）`,
      content: (
        <div>
          <Typography.Paragraph type="secondary">作废 = 插入一条负额红字，原记录保留可追溯。</Typography.Paragraph>
          <Input.TextArea rows={2} placeholder="作废原因（必填）" onChange={(e) => { reason = e.target.value; }} />
        </div>
      ),
      okText: "红字作废",
      cancelText: "取消",
      onOk: async () => {
        if (!reason.trim()) { message.error("作废原因必填"); throw new Error("reason"); }
        try {
          await postJson("/api/inventory/transfer-fees", { reversalOfId: r.id, reason: reason.trim() });
          message.success("已红字作废");
          void load();
        } catch (e) {
          message.error((e as Error).message);
          throw e;
        }
      },
    });
  };

  const columns: ColumnsType<FeeRow> = [
    { title: "单号", dataIndex: "docNo", width: 170, fixed: "left", render: (v: string) => <a href={`/inventory/docs?q=${encodeURIComponent(v)}`}>{v}</a> },
    { title: "线路", key: "lane", width: 220, render: (_, r) => <span>{r.fromWarehouse ?? "—"} → {r.toWarehouse ?? "—"}</span> },
    { title: "类型", dataIndex: "transferType", width: 110, render: (v: string | null) => <Tag>{v ? (TRANSFER_TYPE_LABELS[v as keyof typeof TRANSFER_TYPE_LABELS] ?? v) : "未分类"}</Tag> },
    { title: "费用类型", dataIndex: "feeTypeLabel", width: 110 },
    { title: "金额", dataIndex: "amount", width: 120, align: "right", render: (v: string | undefined, r) => <span style={r.reversalOfId ? { color: "#cf1322" } : undefined}>{money(v, canSeeMoney)}</span> },
    { title: "发生日", dataIndex: "bizDate", width: 110 },
    { title: "承运商", dataIndex: "carrier", width: 140, ellipsis: true, render: (v: string | null) => v ?? "—" },
    {
      title: "状态",
      key: "state",
      width: 110,
      render: (_, r) => r.reversalOfId ? <Tag color="red">红字（冲 #{r.reversalOfId}）</Tag> : r.reversed ? <Tag>已作废</Tag> : <Tag color="green">有效</Tag>,
    },
    { title: "备注", dataIndex: "note", ellipsis: true, render: (v: string | null) => v ?? "" },
    { title: "登记人", dataIndex: "createdByName", width: 100, render: (v: string | null) => v ?? "—" },
    {
      title: "操作",
      key: "act",
      width: 90,
      fixed: "right",
      render: (_, r) => canWrite && !r.reversalOfId && !r.reversed ? <Button size="small" danger onClick={() => reverse(r)}>作废</Button> : null,
    },
  ];
  return (
    <div>
      <ListToolbar
        state={listState}
        extra={
          <Space wrap>
            <LaneFilters state={listState as unknown as ReturnType<typeof useListState<{ q: string; from: string; to: string; type: string }>>} />
            <Select allowClear placeholder="费用类型" style={{ width: 140 }} options={Object.entries(FEE_TYPE_LABELS).map(([value, label]) => ({ value, label }))} value={filters.feeType || undefined} onChange={(v) => listState.setFilter({ feeType: v ?? "" })} />
            <Select style={{ width: 130 }} options={[{ value: "", label: "全部记录" }, { value: "active", label: "仅有效" }]} value={filters.view} onChange={(v) => listState.setFilter({ view: v })} />
          </Space>
        }
        primaryActions={canWrite ? <Button type="primary" onClick={() => setOpen(true)}>登记费用</Button> : null}
      />
      {error ? <LoadErrorAlert error={error} onRetry={() => void load()} /> : null}
      <Table<FeeRow>
        rowKey="id"
        size={listState.tableSize}
        loading={loading}
        columns={columns}
        dataSource={rows}
        pagination={listState.paginationProps({ total, showTotal: (t) => `共 ${t} 条费用` })}
        scroll={{ x: 1500 }}
      />
      <FeeModal open={open} onClose={() => setOpen(false)} onSaved={() => void load()} />
    </div>
  );
}

function AnomaliesTab() {
  const me = useMe();
  const canRefresh = hasAnyRole(me, "warehouse", "pmc", "finance"); // 与 /api/report/transfer-routes 的 requireAnyRole 一致（D60/D62）
  const listState = useListState({ key: "transfer-anomalies", paramPrefix: "an", defaults: { q: "", from: "", to: "", type: "", level: "" }, defaultPageSize: 20 });
  const { filters, page, pageSize } = listState;
  const { data, loading, error, reload } = useRoutesModel({ from: filters.from, to: filters.to, type: filters.type, level: filters.level });
  const q = filters.q.trim().toLowerCase();
  const rows = useMemo(() => {
    const all = data?.anomalies ?? [];
    return q ? all.filter((a) => `${a.docNo} ${a.fromWarehouse} ${a.toWarehouse}`.toLowerCase().includes(q)) : all;
  }, [data, q]);
  const visible = data?.moneyVisible ?? false;
  const onExport = () => {
    if (!data) return;
    exportCsv(
      `调拨异常-${data.asOf}`,
      ["级别", "单号", "转出仓", "转入仓", "类型", "完成日", "数量", "件数中位数", "倍数", "数量判定", "元/件", "费用偏差%", "σ", "费用样本", "费用判定"],
      rows.map((r) => [r.level === "alert" ? "异常" : "提醒", r.docNo, r.fromWarehouse, r.toWarehouse, r.transferTypeLabel, r.date, r.qty, r.qtyMedian, r.qtyRatio, qtyReasonText(r), visible ? (r.unitFee ?? "") : "***", visible ? r.feePctDev : "***", visible ? r.feeZ : "***", r.feeSamples, feeReasonText(r.feeReason, r.feePctDev, r.feeZ, visible)]),
    );
  };
  const columns: ColumnsType<AnomalyRow> = [
    { title: "级别", dataIndex: "level", width: 80, fixed: "left", render: (v: AnomalyRow["level"]) => <Tag color={v === "alert" ? "red" : "orange"}>{v === "alert" ? "异常" : "提醒"}</Tag> },
    { title: "单号", dataIndex: "docNo", width: 170, render: (v: string) => <a href={`/inventory/docs?q=${encodeURIComponent(v)}`}>{v}</a> },
    { title: "线路", key: "lane", width: 220, render: (_, r) => <span>{r.fromWarehouse} → {r.toWarehouse}</span> },
    { title: "类型", dataIndex: "transferTypeLabel", width: 100 },
    { title: "完成日", dataIndex: "date", width: 110 },
    {
      title: "数量 vs 中位数",
      key: "qty",
      width: 170,
      align: "right",
      sorter: (a, b) => Number(a.qtyRatio ?? 0) - Number(b.qtyRatio ?? 0),
      render: (_, r) => (
        <span>
          {formatQty(r.qty)}
          {r.qtyMedian != null ? <Typography.Text type="secondary"> / {formatQty(r.qtyMedian)}{r.qtyRatio ? `（×${r.qtyRatio}）` : ""}</Typography.Text> : null}
          {r.qtyLevel === "watch" ? <Tag color="orange" style={{ marginInlineStart: 6 }}>数量异常</Tag> : null}
        </span>
      ),
    },
    {
      title: "单位费 vs 基线",
      key: "fee",
      width: 200,
      align: "right",
      sorter: visible ? (a, b) => Math.abs(Number(a.feePctDev ?? 0)) - Math.abs(Number(b.feePctDev ?? 0)) : undefined,
      render: (_, r) => !visible ? "***" : (
        <span>
          {unit(r.unitFee, true)}
          {r.feePctDev != null ? <Typography.Text type={r.feeLevel === "alert" ? "danger" : "warning"}> {r.feePctDev}%</Typography.Text> : null}
          {r.feeZ != null ? <Typography.Text type="secondary"> · {r.feeZ}σ</Typography.Text> : null}
          <Typography.Text type="secondary"> n={r.feeSamples}</Typography.Text>
        </span>
      ),
    },
    {
      title: "说明",
      key: "reason",
      ellipsis: true,
      render: (_, r) => {
        const fee = feeReasonText(r.feeReason, r.feePctDev, r.feeZ, visible);
        const qty = qtyReasonText(r);
        return <Tooltip title={`${fee}；${qty}`}><span>{r.feeLevel !== "ok" ? fee : qty}</span></Tooltip>;
      },
    },
  ];
  return (
    <div>
      <ListToolbar
        state={listState}
        extra={
          <Space wrap>
            <LaneFilters state={listState as unknown as ReturnType<typeof useListState<{ q: string; from: string; to: string; type: string }>>} />
            <Select allowClear placeholder="级别" style={{ width: 110 }} options={[{ value: "alert", label: "异常" }, { value: "watch", label: "提醒" }]} value={filters.level || undefined} onChange={(v) => listState.setFilter({ level: v ?? "" })} />
          </Space>
        }
        onExport={data ? onExport : undefined}
        primaryActions={canRefresh ? <Button onClick={() => void reload(true)} loading={loading}>重算</Button> : undefined}
      />
      {error ? <LoadErrorAlert error={error} onRetry={() => void reload()} /> : null}
      {data ? (
        <Alert
          type={data.summary.alertCount > 0 ? "error" : data.summary.anomalyCount > 0 ? "warning" : "success"}
          showIcon
          style={{ marginBottom: 12 }}
          message={`异常 ${data.summary.alertCount} · 提醒 ${data.summary.anomalyCount - data.summary.alertCount} · 零散线路 ${data.summary.scatteredLaneCount}`}
          description={`偏差 > ${data.params.deviationPct}% 提醒不阻断；样本 < 8 只提醒并标样本不足；数量异常 = 本单 > 同线路中位数 × ${data.params.qtyDeviationX}。看门狗（system_alerts category=transfer_cost）每日两批投递。`}
        />
      ) : null}
      <Table<AnomalyRow>
        rowKey="docId"
        size={listState.tableSize}
        loading={loading}
        columns={columns}
        dataSource={rows.slice((page - 1) * pageSize, page * pageSize)}
        pagination={listState.paginationProps({ total: rows.length, showTotal: (t) => `共 ${t} 条` })}
        scroll={{ x: 1300 }}
      />
    </div>
  );
}

export default function TransferRoutesClient() {
  const tabState = useListState({ key: "transfer-routes-tab", paramPrefix: "tr", defaults: { tab: "" }, paginated: false });
  const tab = tabState.filters.tab || "lanes";
  return (
    <div>
      <Typography.Title level={4} style={{ marginTop: 0 }}>调拨线路与费用</Typography.Title>
      <CaliberNote
        summary="线路 = (转出仓, 转入仓, 调拨类型)；基线 = 同线路近 180 天已完成单据的数量加权均价；偏差超阈值只提醒不阻断（D60）。"
        detail={<div><p>参数可在运行参数调整。费用只做统计维度：不进库存成本、不参与过账、不跨线路轧差；金额仅采购/PMC/财务/管理员可见（服务端已剥离）。</p><p>存量未分类调拨单归入「未分类」线路。</p></div>}
      />
      <Tabs
        activeKey={tab}
        onChange={(k) => tabState.setFilter({ tab: k === "lanes" ? "" : k })}
        destroyOnHidden
        items={[
          { key: "lanes", label: "线路汇总", children: <LanesTab /> },
          { key: "fees", label: "费用明细", children: <FeesTab /> },
          { key: "anomalies", label: "异常", children: <AnomaliesTab /> },
        ]}
      />
    </div>
  );
}
