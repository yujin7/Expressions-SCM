"use client";

/**
 * D60 / IAL-05 各地各仓库存明细与周转（/inventory/warehouses）：读模型 warehouse-inventory/v1，
 * 按 region_code 分组、parent_id 标上级；周转窗口 30/90/365 可切；金额仅 PRICE_VISIBLE_ROLES（服务端已剥离）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Button, Segmented, Space, Statistic, Table, Tag, Tooltip, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { fetchJson } from "@/components/fetchJson";
import { formatQty } from "@/components/format";
import { WAREHOUSE_KIND_LABELS } from "@/components/labels";
import ListToolbar from "@/components/ListToolbar";
import LoadErrorAlert from "@/components/LoadErrorAlert";
import { metricTooltip } from "@/components/metrics";
import { useListState } from "@/components/useListState";

interface Row {
  warehouseId: number;
  code: string;
  name: string;
  kind: string;
  accountingMode: "realtime" | "snapshot";
  regionCode: string;
  parentId: number | null;
  parentName: string | null;
  onHand: string;
  skuCount: number;
  amount?: string | null;
  valuationCoveragePct: number | null;
  valuationIncomplete: boolean;
  snapshotDate: string | null;
  outboundQty: string | null;
  openingOnHand: string | null;
  avgOnHand: string | null;
  turns: number | null;
  dio: number | null;
  turnoverNote: string | null;
}

interface Region {
  regionCode: string;
  warehouseCount: number;
  onHand: string;
  amount?: string | null;
  outboundQty: string;
  turns: number | null;
  dio: number | null;
  warehouseIds: number[];
}

interface Model {
  builtAt: string;
  asOf: string;
  windowDays: number;
  windowStart: string;
  rows: Row[];
  regions: Region[];
  summary: {
    warehouseCount: number; realtimeCount: number; snapshotCount: number; physicalActiveCount: number;
    onHand: string; amount?: string | null; valuationCoveragePct: number | null;
    outboundQty: string; avgOnHand: string; turns: number | null; dio: number | null; latestSnapshotDate: string | null;
  };
  limitations: string[];
  moneyVisible: boolean;
}

const money = (v: string | null | undefined, visible: boolean): string =>
  !visible ? "***" : v == null ? "—" : Number(v).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export default function WarehousesClient() {
  const listState = useListState({ key: "inventory-warehouses", defaults: { q: "", window: "", region: "", mode: "" }, defaultPageSize: 50 });
  const { filters, page, pageSize } = listState;
  const windowDays = filters.window || "90";
  const [data, setData] = useState<Model | null>(null);
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
      const params = new URLSearchParams({ window: windowDays });
      if (refresh) params.set("refresh", "1");
      const next = await fetchJson<Model>(`/api/report/warehouse-inventory?${params.toString()}`, { signal: c.signal });
      if (!c.signal.aborted) setData(next);
    } catch (e) {
      if (!c.signal.aborted) setError((e as Error).message);
    } finally {
      if (ref.current === c) { ref.current = null; setLoading(false); }
    }
  }, [windowDays]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => () => ref.current?.abort(), []);

  const visible = data?.moneyVisible ?? false;
  const q = filters.q.trim().toLowerCase();
  const rows = useMemo(() => {
    let all = data?.rows ?? [];
    if (filters.region) all = all.filter((r) => r.regionCode === filters.region);
    if (filters.mode) all = all.filter((r) => r.accountingMode === filters.mode);
    if (q) all = all.filter((r) => `${r.code} ${r.name} ${r.parentName ?? ""}`.toLowerCase().includes(q));
    return all;
  }, [data, filters.region, filters.mode, q]);
  const regionOptions = (data?.regions ?? []).map((r) => ({ label: `${r.regionCode}（${r.warehouseCount}）`, value: r.regionCode }));

  const columns: ColumnsType<Row> = [
    { title: "地区", dataIndex: "regionCode", width: 80, fixed: "left" },
    {
      title: "仓库",
      key: "wh",
      width: 220,
      fixed: "left",
      render: (_, r) => (
        <span>
          <a href={`/inventory/balance?warehouseId=${r.warehouseId}`}>{r.code} {r.name}</a>
          {r.parentName ? <><br /><Typography.Text type="secondary">上级：{r.parentName}</Typography.Text></> : null}
        </span>
      ),
    },
    { title: "类型", dataIndex: "kind", width: 100, render: (v: string, r) => <Tag color={r.accountingMode === "snapshot" ? "default" : "blue"}>{WAREHOUSE_KIND_LABELS[v] ?? v}</Tag> },
    { title: "在库", dataIndex: "onHand", width: 120, align: "right", render: (v: string) => formatQty(v) },
    { title: "SKU 数", dataIndex: "skuCount", width: 80, align: "right" },
    {
      title: "金额",
      dataIndex: "amount",
      width: 140,
      align: "right",
      render: (v: string | null | undefined, r) => (
        <span>
          {money(v, visible)}
          {visible && r.valuationIncomplete ? <Tooltip title={`成本覆盖率 ${r.valuationCoveragePct}%（<80%）`}><Tag color="orange" style={{ marginInlineStart: 4 }}>不完整</Tag></Tooltip> : null}
        </span>
      ),
    },
    { title: `窗口出库（${windowDays}d）`, dataIndex: "outboundQty", width: 140, align: "right", render: (v: string | null) => (v == null ? <Typography.Text type="secondary">无流水</Typography.Text> : formatQty(v)) },
    { title: "平均在库", dataIndex: "avgOnHand", width: 120, align: "right", render: (v: string | null) => (v == null ? "—" : formatQty(v)) },
    { title: <Tooltip title={metricTooltip("warehouseTurns")}>周转</Tooltip>, dataIndex: "turns", width: 90, align: "right", render: (v: number | null, r) => (v == null ? <Tooltip title={r.turnoverNote ?? ""}><Typography.Text type="secondary">{r.accountingMode === "snapshot" ? "无流水" : "—"}</Typography.Text></Tooltip> : `${v} 次/年`) },
    { title: <Tooltip title={metricTooltip("warehouseDio")}>DIO</Tooltip>, dataIndex: "dio", width: 90, align: "right", render: (v: number | null, r) => (v == null ? <Tooltip title={r.turnoverNote ?? ""}><span>—</span></Tooltip> : `${v} 天`) },
    { title: "数据截止", key: "asof", width: 120, render: (_, r) => r.accountingMode === "snapshot" ? (r.snapshotDate ?? "无快照") : "实时" },
  ];

  return (
    <div>
      <Typography.Title level={4} style={{ marginTop: 0 }}>各仓库存与周转</Typography.Title>
      <ListToolbar
        state={listState}
        extra={
          <Space wrap>
            <Segmented
              options={[{ label: "30 天", value: "30" }, { label: "90 天", value: "90" }, { label: "365 天", value: "365" }]}
              value={windowDays}
              onChange={(v) => listState.setFilter({ window: String(v) === "90" ? "" : String(v) })}
            />
            <Segmented
              options={[{ label: "全部", value: "" }, { label: "实时仓", value: "realtime" }, { label: "快照仓", value: "snapshot" }]}
              value={filters.mode}
              onChange={(v) => listState.setFilter({ mode: String(v) })}
            />
            {regionOptions.length > 1 ? (
              <Segmented options={[{ label: "全部地区", value: "" }, ...regionOptions]} value={filters.region} onChange={(v) => listState.setFilter({ region: String(v) })} />
            ) : null}
          </Space>
        }
        primaryActions={<Button onClick={() => void load(true)} loading={loading}>重算</Button>}
      />
      {error ? <LoadErrorAlert error={error} onRetry={() => void load()} /> : null}
      {data ? (
        <Space size="large" wrap style={{ marginBottom: 12 }}>
          <Statistic title="启用仓库" value={data.summary.warehouseCount} suffix={`（实时 ${data.summary.realtimeCount} / 快照 ${data.summary.snapshotCount}）`} />
          <Statistic title="在库合计" value={formatQty(data.summary.onHand)} />
          <Statistic title="金额合计" value={money(data.summary.amount, visible)} suffix={visible && data.summary.valuationCoveragePct != null && data.summary.valuationCoveragePct < 80 ? <Tag color="orange">不完整 {data.summary.valuationCoveragePct}%</Tag> : undefined} />
          <Statistic title={`总周转（实时仓 n=${data.summary.realtimeCount}）`} value={data.summary.turns == null ? "—" : `${data.summary.turns} 次/年`} />
          <Statistic title="总 DIO" value={data.summary.dio == null ? "—" : `${data.summary.dio} 天`} />
        </Space>
      ) : null}
      {data && data.regions.length > 1 ? (
        <Table<Region>
          rowKey="regionCode"
          size="small"
          pagination={false}
          style={{ marginBottom: 12 }}
          dataSource={data.regions}
          scroll={{ x: 700 }}
          columns={[
            { title: "地区", dataIndex: "regionCode", width: 90 },
            { title: "仓库数", dataIndex: "warehouseCount", width: 80, align: "right" },
            { title: "在库", dataIndex: "onHand", width: 120, align: "right", render: (v: string) => formatQty(v) },
            { title: "金额", dataIndex: "amount", width: 140, align: "right", render: (v: string | null | undefined) => money(v, visible) },
            { title: "窗口出库", dataIndex: "outboundQty", width: 120, align: "right", render: (v: string) => formatQty(v) },
            { title: "周转", dataIndex: "turns", width: 100, align: "right", render: (v: number | null) => (v == null ? "—" : `${v} 次/年`) },
            { title: "DIO", dataIndex: "dio", width: 90, align: "right", render: (v: number | null) => (v == null ? "—" : `${v} 天`) },
          ]}
        />
      ) : null}
      <Table<Row>
        rowKey="warehouseId"
        size={listState.tableSize}
        loading={loading}
        columns={columns}
        dataSource={rows.slice((page - 1) * pageSize, page * pageSize)}
        pagination={listState.paginationProps({ total: rows.length, showTotal: (t) => `共 ${t} 个仓库` })}
        scroll={{ x: 1400 }}
      />
      {data ? (
        <Alert
          type="info"
          showIcon
          style={{ marginTop: 12 }}
          message={`来源：SCM 账 + 快照仓最新快照 · 时点：${data.asOf}（快照最新 ${data.summary.latestSnapshotDate ?? "无"}） · 覆盖：启用仓 ${data.summary.warehouseCount} 个`}
          description={data.limitations.join(" ")}
        />
      ) : null}
    </div>
  );
}
