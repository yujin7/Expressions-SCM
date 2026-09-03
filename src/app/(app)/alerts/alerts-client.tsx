"use client";

/**
 * struct#15 系统告警：看门狗产出的数据过期/单据超时/预警引擎告警，与人工裁决复核清单分家（生命周期不同）。
 * 筛选（状态/类别/严重度/隐藏已知悉）与分页写进 URL（useListState）；总数由服务端返回；
 * 每行可展开看规则来源 / 参数快照 / 触发原因（AlertEvidence）。
 */
import { useCallback, useEffect, useState } from "react";
import { App, Button, Select, Space, Switch, Table, Tag, Tooltip, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { fetchJson } from "@/components/fetchJson";
import AlertEvidence, { ackText, type AlertEvidenceFields } from "@/components/AlertEvidence";
import CaliberNote from "@/components/CaliberNote";
import ListToolbar from "@/components/ListToolbar";
import LoadErrorAlert from "@/components/LoadErrorAlert";
import { useListState } from "@/components/useListState";
import { roleLabel, severityLabel } from "@/components/dictionary";

interface Row extends AlertEvidenceFields {
  id: number;
  category: string;
  title: string;
  detail: string | null;
  severity: string | null;
  status: string;
  createdAt: string;
  lastHitAt?: string | null;
  actionHref?: string | null;
  ownerRole?: string | null;
  refKey?: string | null;
}
interface ListData { rows: Row[]; total: number; page: number; pageSize: number }

// 与 systemAlerts 的 category 一一对应；新增告警类别必须同步补标签，
// 否则页面上会冒出 job_failure 这样的英文 slug（护栏：tests/architecture/alert-category-labels.test.ts）
const CAT: Record<string, string> = {
  data_freshness: "数据过期",
  doc_aging: "单据超时",
  integration_token: "凭据到期",
  job_failure: "任务失败",
  data_product_gate: "决策门禁降级",
  inventory_cover: "断货预警",
  sales_spike: "爆单预警",
  transfer_cost: "调拨成本异常",
  data_quality: "数据质量核对",
};
const SEV: Record<string, string> = { critical: "red", high: "orange", medium: "gold" };
const STATUS_OPTIONS = [{ value: "open", label: "待处理" }, { value: "resolved", label: "已关闭" }];

type Filters = { status?: string; category?: string; severity?: string; acked?: string };

const ts = (v: string | null | undefined): string => (v ? new Date(v).toLocaleString("zh-CN") : "—");

export default function AlertsClient() {
  const { message } = App.useApp();
  const listState = useListState<Filters>({ key: "system-alerts", defaults: { status: "open", category: "", severity: "", acked: "" }, defaultPageSize: 50 });
  const { filters } = listState;
  const [data, setData] = useState<ListData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const query = listState.queryString();
  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try { setData(await fetchJson<ListData>(`/api/alerts?${query}`)); }
    catch (e) { setError((e as Error).message); }
    finally { setLoading(false); }
  }, [query]);
  useEffect(() => { void load(); }, [load]);

  const handleAck = async (id: number) => {
    try { await fetchJson(`/api/alerts/${id}/ack`, { method: "POST", body: JSON.stringify({}) }); message.success("已知悉（留审计，事实闭环后自动关闭）"); await load(); }
    catch (e) { message.error((e as Error).message); }
  };

  const columns: ColumnsType<Row> = [
    { title: "类别", dataIndex: "category", width: 120, fixed: "left", render: (v: string) => <Tag>{CAT[v] ?? v}</Tag> },
    { title: "严重度", dataIndex: "severity", width: 80, render: (v: string | null) => (v ? <Tag color={SEV[v]}>{severityLabel(v)}</Tag> : "—") },
    {
      title: "告警", dataIndex: "title", ellipsis: true,
      render: (v: string, r) => (
        <Space direction="vertical" size={0}>
          <Typography.Text strong>{v}</Typography.Text>
          {r.detail ? <Typography.Text type="secondary" style={{ fontSize: 12 }} ellipsis>{r.detail}</Typography.Text> : null}
        </Space>
      ),
    },
    { title: "责任角色", dataIndex: "ownerRole", width: 100, render: (v: string | null | undefined) => (v ? roleLabel(v) : "—") },
    { title: "首次", dataIndex: "createdAt", width: 150, sorter: (a, b) => a.createdAt.localeCompare(b.createdAt), render: (v: string) => ts(v) },
    { title: "最近命中", dataIndex: "lastHitAt", width: 150, render: (v: string | null | undefined) => ts(v) },
    { title: "已知悉", key: "ack", width: 200, render: (_, r) => (r.ackedAt ? <Tooltip title={ackText(r)}><Tag color="default">已知悉 · {r.ackedByName ?? (r.ackedBy != null ? `#${r.ackedBy}` : "")}</Tag></Tooltip> : <Typography.Text type="secondary">未知悉</Typography.Text>) },
    {
      title: "操作", key: "ops", width: 160, fixed: "right",
      render: (_, r) => (
        <Space size={6}>
          {r.actionHref ? <a href={r.actionHref}>去处理</a> : null}
          {r.status === "open" && !r.ackedAt ? <Button size="small" onClick={() => void handleAck(r.id)}>已知悉</Button> : null}
        </Space>
      ),
    },
  ];

  return (
    <div>
      <Typography.Title level={4} style={{ marginTop: 0 }}>系统告警</Typography.Title>
      <CaliberNote
        summary="看门狗自动产出的数据、单据与决策门禁告警；来源恢复、数据重传或单据流转后自动关闭，「已知悉」只留审计不改状态。"
        detail={<div>失效的 A2/A3 仍须责任人撤回或重新验收。人工裁决事项见「复核清单与提醒」。同类别同去重键只保留一条待处理告警；连续 3 天未再命中才自动关闭（迟滞），一天的数据缺口不会关掉又打开。</div>}
      />
      <LoadErrorAlert error={error} onRetry={() => void load()} subject="系统告警" retrying={loading} />
      <ListToolbar
        state={listState}
        extra={(
          <Space wrap>
            <Select style={{ width: 110 }} value={filters.status || "open"} options={STATUS_OPTIONS} onChange={(v) => listState.setFilter({ status: v })} />
            <Select allowClear placeholder="类别" style={{ width: 150 }} value={filters.category || undefined} options={Object.entries(CAT).map(([value, label]) => ({ value, label }))} onChange={(v) => listState.setFilter({ category: v ?? "" })} />
            <Select allowClear placeholder="严重度" style={{ width: 110 }} value={filters.severity || undefined} options={["critical", "high", "medium"].map((v) => ({ value: v, label: severityLabel(v) }))} onChange={(v) => listState.setFilter({ severity: v ?? "" })} />
            <span>隐藏已知悉 <Switch size="small" checked={filters.acked === "0"} onChange={(on) => listState.setFilter({ acked: on ? "0" : "" })} /></span>
          </Space>
        )}
        primaryActions={<Button size="small" onClick={() => void load()} loading={loading}>刷新</Button>}
      />
      <Table<Row>
        rowKey="id"
        size={listState.tableSize}
        loading={loading}
        columns={columns}
        dataSource={data?.rows ?? []}
        scroll={{ x: 1100 }}
        locale={{ emptyText: error ? "数据未加载" : "当前条件下没有告警" }}
        pagination={listState.paginationProps({ total: data?.total ?? 0, showTotal: (t) => `共 ${t} 条告警` })}
        expandable={{ expandedRowRender: (r) => <AlertEvidence alert={r} /> }}
      />
    </div>
  );
}
