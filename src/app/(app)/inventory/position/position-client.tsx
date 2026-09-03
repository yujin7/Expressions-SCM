"use client";

/**
 * 库存日级走向（D51/D52）：当月逐日出入库明细钻取页 + 历史月末序列 + 各仓明细。
 * 数据只读 `inventory-position/v1` 读模型；金额字段由服务端按角色剥离（缺 amount = 无权限）。
 */
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { App, Button, Card, Col, Row, Segmented, Select, Statistic, Table, Tag, Tooltip, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { ReloadOutlined } from "@ant-design/icons";
import CaliberNote from "@/components/CaliberNote";
import { exportCsv } from "@/components/exportCsv";
import { fetchJson } from "@/components/fetchJson";
import { formatQty } from "@/components/format";
import ListToolbar from "@/components/ListToolbar";
import { useListState } from "@/components/useListState";
import { hasAnyRole, useMe } from "@/components/useMe";
import type {
  DailyPoint,
  InventoryPositionReadModel,
  MonthEndPoint,
  ValueDto,
  WarehouseBlock,
} from "@/server/modules/report/inventory-position";

type Tab = "daily" | "monthEnd" | "warehouses";
const TABS: { value: Tab; label: string }[] = [
  { value: "daily", label: "当月逐日出入库" },
  { value: "monthEnd", label: "历史月末与环比" },
  { value: "warehouses", label: "各仓在库明细" },
];

/** 服务端剥离 amount 后的金额对象（非价格可见角色） */
type MaybeValue = Partial<ValueDto> | null | undefined;

function money(v: MaybeValue): string {
  if (!v) return "—";
  if (v.amount == null) return "无权限";
  const n = Number(v.amount);
  return Number.isFinite(n) ? n.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : v.amount;
}

function coverageTag(v: MaybeValue) {
  if (!v || v.coveragePct == null) return null;
  return (
    <Tooltip title={`估值覆盖率 ${v.coveragePct}%（按数量）；未计价 SKU ${v.uncoveredSkus ?? 0} 个`}>
      <Tag color={v.incomplete ? "orange" : "green"} style={{ marginInlineStart: 6 }}>
        {v.incomplete ? "不完整" : "覆盖"} {v.coveragePct}%
      </Tag>
    </Tooltip>
  );
}

function pct(v: number | null): string {
  if (v == null) return "—";
  return `${v > 0 ? "+" : ""}${v}%`;
}

/** 深链库存流水：上海日界整日 */
function ledgerHref(date: string, warehouseId?: number): string {
  const p = new URLSearchParams({ from: `${date}T00:00:00+08:00`, to: `${date}T23:59:59+08:00` });
  if (warehouseId) p.set("warehouseId", String(warehouseId));
  return `/inventory/ledger?${p.toString()}`;
}

export default function PositionClient() {
  // useSearchParams（列表页状态平台）需要 Suspense 边界
  return (
    <Suspense>
      <PositionInner />
    </Suspense>
  );
}

function PositionInner() {
  const { message } = App.useApp();
  const me = useMe();
  const canRefresh = hasAnyRole(me, "pmc", "finance");
  const [data, setData] = useState<InventoryPositionReadModel | null>(null);
  const [loading, setLoading] = useState(false);
  const listState = useListState({
    key: "inventory-position",
    defaults: { tab: "daily", source: "all", months: "12" },
    defaultPageSize: 31,
  });
  const { filters, page, pageSize } = listState;
  const tab = (TABS.some((t) => t.value === filters.tab) ? filters.tab : "daily") as Tab;
  const source = filters.source === "realtime" || filters.source === "snapshot" ? filters.source : "all";
  const months = Number(filters.months) || 12;

  const load = useCallback(async (refresh = false) => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ months: String(months) });
      if (refresh) params.set("refresh", "1");
      setData(await fetchJson<InventoryPositionReadModel>(`/api/report/inventory-position?${params.toString()}`));
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [months, message]);
  useEffect(() => { void load(); }, [load]);

  const dailyRows = useMemo(() => {
    const rows = data?.daily ?? [];
    if (source === "realtime") return rows.filter((r) => r.realtime);
    if (source === "snapshot") return rows.filter((r) => r.snapshot);
    return rows;
  }, [data, source]);
  const monthRows = useMemo(() => [...(data?.monthEnd ?? [])].reverse(), [data]);
  const whRows = data?.warehouses ?? [];

  const dailyColumns: ColumnsType<DailyPoint> = [
    { title: "日期", dataIndex: "date", width: 110, fixed: "left" },
    { title: "实时仓 入", width: 110, align: "right", render: (_, r) => (r.realtime ? formatQty(r.realtime.in) : <Typography.Text type="secondary">无账期</Typography.Text>) },
    { title: "实时仓 出", width: 110, align: "right", render: (_, r) => (r.realtime ? formatQty(r.realtime.out) : "—") },
    { title: "实时仓 净", width: 110, align: "right", render: (_, r) => (r.realtime ? <Typography.Text type={Number(r.realtime.net) < 0 ? "danger" : Number(r.realtime.net) > 0 ? "success" : undefined}>{formatQty(r.realtime.net)}</Typography.Text> : "—") },
    { title: "入库金额", width: 140, align: "right", render: (_, r) => (r.realtime ? <>{money(r.realtime.inValue)}{coverageTag(r.realtime.inValue)}</> : "—") },
    { title: "出库金额", width: 140, align: "right", render: (_, r) => (r.realtime ? <>{money(r.realtime.outValue)}{coverageTag(r.realtime.outValue)}</> : "—") },
    {
      title: "快照仓 净变动",
      width: 170,
      align: "right",
      render: (_, r) => r.snapshot ? (
        <Tooltip title={`相邻快照差分：入 ${formatQty(r.snapshot.in)} / 出 ${formatQty(r.snapshot.out)}；${r.snapshot.warehouses} 个快照仓；差分跨 ${r.snapshot.maxSpanDays} 天`}>
          <span>{formatQty(r.snapshot.net)} <Tag color="blue">snapshot_delta</Tag></span>
        </Tooltip>
      ) : <Typography.Text type="secondary">无快照</Typography.Text>,
    },
    { title: "快照净变动金额", width: 140, align: "right", render: (_, r) => (r.snapshot ? money(r.snapshot.netValue) : "—") },
    { title: "流水", width: 90, render: (_, r) => (r.realtime && r.realtime.ledgerRows > 0 ? <Link href={ledgerHref(r.date)}>{r.realtime.ledgerRows} 条</Link> : "—") },
  ];

  const monthColumns: ColumnsType<MonthEndPoint> = [
    { title: "月份", dataIndex: "yearMonth", width: 100, fixed: "left", render: (v: string, r) => (r.isCurrent ? <>{v} <Tag>当前时点</Tag></> : v) },
    { title: "实时仓月末", width: 130, align: "right", render: (_, r) => (r.realtime ? formatQty(r.realtime.qty) : <Typography.Text type="secondary">未覆盖</Typography.Text>) },
    { title: "快照仓月末", width: 150, align: "right", render: (_, r) => (r.snapshot ? <Tooltip title={`快照日 ${r.snapshot.asOf ?? "—"}`}><span>{formatQty(r.snapshot.qty)}</span></Tooltip> : <Typography.Text type="secondary">无快照</Typography.Text>) },
    { title: "合计在库", width: 130, align: "right", render: (_, r) => (r.total ? formatQty(r.total.qty) : "—") },
    { title: "库存金额", width: 170, align: "right", render: (_, r) => (r.total ? <>{money(r.total.value)}{coverageTag(r.total.value)}</> : "—") },
    { title: "数量环比", width: 100, align: "right", render: (_, r) => pct(r.momQtyPct) },
    { title: "金额环比", width: 100, align: "right", render: (_, r) => pct(r.momValuePct) },
  ];

  const whColumns: ColumnsType<WarehouseBlock> = [
    { title: "仓库", width: 200, fixed: "left", render: (_, r) => <Link href={`/inventory/balance?warehouseId=${r.warehouseId}`}>{r.code} {r.name}</Link> },
    { title: "模式", dataIndex: "mode", width: 90, render: (v: string) => (v === "snapshot" ? <Tag color="blue">快照仓</Tag> : <Tag color="green">实时仓</Tag>) },
    { title: "地区", dataIndex: "regionCode", width: 70 },
    { title: "在库数量", dataIndex: "qty", width: 120, align: "right", render: (v: string) => formatQty(v) },
    { title: "SKU 数", dataIndex: "skus", width: 80, align: "right" },
    { title: "时点", width: 110, render: (_, r) => (r.mode === "snapshot" ? (r.bizDate ?? "—") : "实时") },
    { title: "库存金额", width: 170, align: "right", render: (_, r) => <>{money(r.value)}{coverageTag(r.value)}</> },
  ];

  const doExport = () => {
    if (!data) return;
    if (tab === "daily") {
      exportCsv(`库存逐日走向-${data.currentMonth}`, ["日期", "实时入", "实时出", "实时净", "入库金额", "出库金额", "快照净变动", "快照净变动金额", "来源"],
        dailyRows.map((r) => [r.date, r.realtime?.in ?? "", r.realtime?.out ?? "", r.realtime?.net ?? "", r.realtime?.inValue.amount ?? "", r.realtime?.outValue.amount ?? "", r.snapshot?.net ?? "", r.snapshot?.netValue.amount ?? "", r.snapshot ? "snapshot_delta" : ""]));
    } else if (tab === "monthEnd") {
      exportCsv(`库存月末序列-${data.currentMonth}`, ["月份", "实时仓月末", "快照仓月末", "快照日", "合计", "库存金额", "覆盖率%", "数量环比%", "金额环比%"],
        monthRows.map((r) => [r.yearMonth, r.realtime?.qty ?? "", r.snapshot?.qty ?? "", r.snapshot?.asOf ?? "", r.total?.qty ?? "", r.total?.value.amount ?? "", r.total?.value.coveragePct ?? "", r.momQtyPct ?? "", r.momValuePct ?? ""]));
    } else {
      exportCsv(`各仓在库-${data.today}`, ["仓库编码", "仓库", "模式", "地区", "在库数量", "SKU数", "快照日", "库存金额", "覆盖率%"],
        whRows.map((r) => [r.code, r.name, r.mode, r.regionCode, r.qty, r.skus, r.bizDate ?? "", r.value.amount ?? "", r.value.coveragePct ?? ""]));
    }
  };

  const slice = <T,>(rows: T[]): T[] => rows.slice((page - 1) * pageSize, page * pageSize);
  const totalOf = tab === "daily" ? dailyRows.length : tab === "monthEnd" ? monthRows.length : whRows.length;

  return (
    <div>
      <Typography.Title level={4} style={{ marginTop: 0 }}>库存日级走向</Typography.Title>
      <CaliberNote
        summary={<>当月 = 当前时点在库；历史月 = 月末日终（实时仓流水倒推、快照仓当月最后快照）；缺日/缺月留空不补零。{data ? <>　口径日 {data.today}，流水最早 {data.ledgerFirstDay ?? "—"}，最新快照 {data.latestSnapshotDate ?? "—"}。</> : null}</>}
        detail={<div>{(data?.limitations ?? []).map((l) => <p key={l}>{l}</p>)}<p>读模型 {data?.key ?? "inventory-position/v1"}，构建于 {data?.builtAt ?? "—"}。</p></div>}
      />
      <Row gutter={[12, 12]} style={{ marginBottom: 12 }}>
        <Col xs={24} sm={12} lg={6}>
          <Card size="small"><Statistic title="实时仓在库（SCM 账）" value={formatQty(data?.current.realtime.qty ?? null)} suffix={<span style={{ fontSize: 12 }}>· {data?.current.realtime.skus ?? 0} SKU</span>} /></Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card size="small"><Statistic title={`快照仓在库（${data?.current.snapshot.bizDate ?? "无快照"}）`} value={formatQty(data?.current.snapshot.qty ?? null)} suffix={<span style={{ fontSize: 12 }}>· {data?.current.snapshot.skus ?? 0} SKU</span>} /></Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card size="small"><Statistic title="全网合计在库" value={formatQty(data?.current.total.qty ?? null)} /></Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card size="small">
            <Statistic title="库存金额（成本口径）" value={money(data?.current.total.value)} />
            <div style={{ marginTop: 4 }}>
              {coverageTag(data?.current.total.value)}
              {data?.current.total.value && data.current.total.value.incomplete ? <Link href="/report/margin" style={{ fontSize: 12 }}>未计价清单</Link> : null}
            </div>
          </Card>
        </Col>
      </Row>
      <ListToolbar
        state={listState}
        onExport={doExport}
        primaryActions={canRefresh ? <Button icon={<ReloadOutlined />} onClick={() => void load(true)} loading={loading}>重算读模型</Button> : undefined}
        extra={
          <>
            <Segmented options={TABS} value={tab} onChange={(v) => listState.setFilter({ tab: String(v) })} />
            {tab === "daily" ? (
              <Select
                style={{ width: 160 }}
                value={source}
                options={[{ value: "all", label: "实时 + 快照" }, { value: "realtime", label: "仅有账期日" }, { value: "snapshot", label: "仅有快照差分日" }]}
                onChange={(v) => listState.setFilter({ source: v })}
              />
            ) : null}
            {tab === "monthEnd" ? (
              <Select
                style={{ width: 120 }}
                value={String(months)}
                options={[3, 6, 12, 24].map((m) => ({ value: String(m), label: `近 ${m} 个月` }))}
                onChange={(v) => listState.setFilter({ months: v })}
              />
            ) : null}
          </>
        }
      />
      {tab === "daily" ? (
        <Table<DailyPoint> rowKey="date" size={listState.tableSize} columns={dailyColumns} dataSource={slice(dailyRows)} loading={loading} scroll={{ x: "max-content" }} pagination={listState.paginationProps({ total: totalOf })} />
      ) : tab === "monthEnd" ? (
        <Table<MonthEndPoint> rowKey="yearMonth" size={listState.tableSize} columns={monthColumns} dataSource={slice(monthRows)} loading={loading} scroll={{ x: "max-content" }} pagination={listState.paginationProps({ total: totalOf })} />
      ) : (
        <Table<WarehouseBlock> rowKey="warehouseId" size={listState.tableSize} columns={whColumns} dataSource={slice(whRows)} loading={loading} scroll={{ x: "max-content" }} pagination={listState.paginationProps({ total: totalOf })} />
      )}
    </div>
  );
}
