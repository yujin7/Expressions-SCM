"use client";

import { Button, Card, Col, Grid, Progress, Row, Space, Statistic, Switch, Table, Tabs, Tag, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { ReloadOutlined } from "@ant-design/icons";
import DecisionVisual from "@/components/DecisionVisual";
import DocStatusTag from "@/components/DocStatusTag";
import RemoteSelect from "@/components/RemoteSelect";
import ListToolbar from "@/components/ListToolbar";
import LoadErrorAlert from "@/components/LoadErrorAlert";
import ContextHelp from "@/components/ContextHelp";
import { useDocumentRead } from "@/components/useDocumentRead";
import type { WipResult, WipRow } from "@/server/modules/report/wip";
import ProcessingCycles from "./processing-cycles";
import { AsyncExportButton } from "@/components/ExportButton";
import { formatQty } from "@/components/format";
import { useListState } from "@/components/useListState";

export default function WipClient() {
  const wide = Grid.useBreakpoint().md;
  const viewState = useListState({
    key: "wip-report",
    defaults: { supplierId: "", overdueOnly: "", mode: "progress" },
    defaultDensity: "small",
    paginated: false,
  });
  const supplierId = viewState.filters.supplierId
    ? Number(viewState.filters.supplierId)
    : undefined;
  const overdueOnly = viewState.filters.overdueOnly === "1";

  const cycleMode = viewState.filters.mode === "cycles";
  const url = `/api/report/wip?${viewState.queryString()}`;
  const read = useDocumentRead<WipResult>(cycleMode ? null : url);
  const rows = read.data?.rows ?? [], summary = read.data?.summary;
  const supplierRows = read.data?.suppliers ?? [];
  const loading = read.phase === "loading";

  const columns: ColumnsType<WipRow> = [
    // 单号回链到各自列表页（?q=单号 精确命中，列表页打开详情抽屉）——此前是纯文本死胡同
    {
      title: "加工单 / 成品", key: "identity", width: wide ? 240 : 164, fixed: "left",
      render: (_, r) => <Space direction="vertical" size={2}>
        <a href={`/outsource/jg?q=${encodeURIComponent(r.jgNo)}`}>{r.jgNo}</a>
        <Typography.Text>{r.productSkuCode} · {r.productName}</Typography.Text>
        <Typography.Text type="secondary">{r.baseUom} · {r.supplierName}（#{r.supplierId}）</Typography.Text>
      </Space>,
    },
    {
      title: "工单", dataIndex: "woNo", width: 150,
      render: (v: string) => <a href={`/outsource/wo?q=${encodeURIComponent(v)}`}>{v}</a>,
    },
    { title: "订单数量", dataIndex: "orderQty", width: 100, align: "right", render: (v: string) => formatQty(v) },
    { title: "已检合格", dataIndex: "receivedGood", width: 100, align: "right", render: (v: string) => formatQty(v) },
    { title: "已检让步", dataIndex: "receivedConcession", width: 100, align: "right", render: (v: string) => formatQty(v) },
    {
      title: "待正常收货",
      dataIndex: "pendingQty",
      width: 140,
      align: "right",
      sorter: (a, b) => Number(a.pendingQty) - Number(b.pendingQty),
      render: (v: string, r) =>
        <Space direction="vertical" size={0}><Typography.Text type={r.overdue ? "danger" : undefined}>{formatQty(v)}</Typography.Text>
          {Number(r.overReceivedQty) > 0 && <Tag color="warning">超收 {formatQty(r.overReceivedQty)}</Tag>}
          {!r.inWip && <Typography.Text type="secondary">已结束，不计在制</Typography.Text>}</Space>,
    },
    { title: "发料行数", dataIndex: "issuedMaterialLines", width: 90, align: "right" },
    { title: "状态", dataIndex: "status", width: 100, render: (v: string) => <DocStatusTag status={v} /> },
    {
      title: "交期",
      dataIndex: "dueDate",
      width: 110,
      sorter: (a, b) => (a.dueDate ?? "9999").localeCompare(b.dueDate ?? "9999"),
      render: (v: string | null, r) =>
        v == null ? "—" : r.overdue ? <Typography.Text type="danger">{v}（逾期）</Typography.Text> : v,
    },
  ];

  const progressPanel = <>
      <LoadErrorAlert error={read.error} onRetry={read.retry} subject="委外在制" retrying={loading} />
      <Row gutter={[10, 10]} className="compact-kpi-row">
        <Col xs={12} md={8}>
          <Card size="small">
            <Statistic title="在制 JG 数" value={summary?.wipCount ?? "—"} />
          </Card>
        </Col>
        <Col xs={12} md={8}>
          <Card size="small">
            <Statistic
              title="逾期数"
              value={summary?.overdueCount ?? "—"}
              valueStyle={(summary?.overdueCount ?? 0) > 0 ? { color: "#cf1322" } : undefined}
            />
          </Card>
        </Col>
        <Col xs={24} md={8}>
          <Card size="small">
            <Statistic title="待正常收货 · 跨SKU参考量" value={summary ? formatQty(summary.pendingTotal) : "—"} />
          </Card>
        </Col>
      </Row>
      <ListToolbar state={viewState} extra={<>
        <RemoteSelect
          api="/api/master/supplier"
          getLabel={(r) => `${String(r.code)} ${String(r.name)}`}
          allowClear
          placeholder="全部加工厂"
          style={{ width: 220, maxWidth: "100%" }}
          value={supplierId}
          onChange={(v) => viewState.setFilter({ supplierId: v == null ? "" : String(v) })}
        />
        <Space size={8}>
          <Switch
            aria-label="仅逾期"
            checked={overdueOnly}
            onChange={(checked) => viewState.setFilter({ overdueOnly: checked ? "1" : "" })}
          />
          <Typography.Text>仅逾期</Typography.Text>
        </Space>
      </>} primaryActions={<>{read.data && <AsyncExportButton kind="wip" label="导出当前范围" params={{ mode: "progress", ...(supplierId ? { supplierId } : {}), overdueOnly }} />}<Button icon={<ReloadOutlined />} loading={loading} onClick={read.retry}>
          刷新
        </Button></>} />
      <DecisionVisual
        title="委外待收集中度"
        question="待收数量集中在哪些加工厂，逾期订单是否需要立即催交或调整产能？"
        metricId="wipPendingQty"
        grain="加工厂 / JG"
        unit="基础数量"
        source={{ tier: "ledger", source: "生效JG与正常SH实收记录，非净入库" }}
        coverage={{ covered: summary?.wipCount ?? 0, total: summary?.wipCount ?? 0, label: "当前筛选在制 JG" }}
        activeFilters={[
          supplierId != null ? `加工厂 ID ${supplierId}` : "全部加工厂",
          overdueOnly ? "仅逾期" : "明细含已结束记录",
        ]}
        summary={summary ? `当前 ${summary.wipCount} 个在制 JG，待收 ${formatQty(summary.pendingTotal)}；逾期 ${summary.overdueCount} 个，分布在 ${supplierRows.length} 家加工厂。` : "当前数据尚未确认"}
        caveat="数量可能混合不同 SKU 的基础单位，只能用于识别集中度与催交优先级；跨品类总量不代表可替代产能。"
        state={read.phase === "error" ? "error" : loading ? "loading" : rows.length === 0 ? "empty" : "ready"}
        stateDetail={read.error}
        height={220}
        fitContent
        dataView={
          <>
            <style>{`.wip-row-overdue > td { background: #fff1f0 !important; }`}</style>
            <Table<WipRow>
              rowKey="jgId"
              size={viewState.tableSize}
              columns={columns}
              dataSource={rows}
              loading={loading}
              scroll={{ x: 1250 }}
              rowClassName={(r) => (r.overdue ? "wip-row-overdue" : "")}
              pagination={{ pageSize: 50, showTotal: (t) => `共 ${t} 条` }}
            />
          </>
        }
      >
        <Space direction="vertical" size={10} style={{ width: "100%" }}>
          {!supplierRows.length && <Typography.Text type="secondary">当前范围无在制加工单，可在数据明细中核对已结束记录。</Typography.Text>}
          {supplierRows.map((supplier) => {
            const share = supplier.sharePct;
            const relative = supplier.relativePct;
            return (
              <div key={supplier.supplierId}>
                <Space style={{ display: "flex", justifyContent: "space-between", marginBottom: 2 }} wrap>
                  <Button type="link" style={{ padding: 0, height: "auto", whiteSpace: "normal", textAlign: "left" }} onClick={() => viewState.setFilter({ supplierId: String(supplier.supplierId) })}>{supplier.name}（#{supplier.supplierId}）</Button>
                  <Space size={4}>
                    <Tag bordered={false}>{supplier.jobs} 个 JG</Tag>
                    {supplier.overdue > 0 ? <Tag color="error">逾期 {supplier.overdue}</Tag> : null}
                    <Typography.Text>{formatQty(String(supplier.pending))} · {share}%</Typography.Text>
                  </Space>
                </Space>
                <Progress
                  percent={relative}
                  showInfo={false}
                  strokeColor={supplier.overdue > 0 ? "#dc2626" : "#2563eb"}
                  aria-label={`${supplier.name}待收 ${formatQty(String(supplier.pending))}，占当前待收 ${share}%，逾期 ${supplier.overdue} 个`}
                />
              </div>
            );
          })}
        </Space>
      </DecisionVisual>
      </>;

  return (
    <div>
      <Typography.Title level={4} style={{ marginTop: 0 }}>
        委外在制看板
      </Typography.Title>
      <Typography.Paragraph type="secondary">
        已批准/执行中才算在制；已完成和短关保留查阅。待收是正常行实收口径，不是待合格入库量。
        <ContextHelp label="查看在制口径" title="在制与收货口径" content="图、卡和明细使用相同筛选。已检合格/让步来自已完成SH检验记录，不是冲销后库存净额；超收单独显示，待收不为负。跨SKU可能混合不同基础单位，仅作规模参考，不代表可替代产能。" />
      </Typography.Paragraph>
      <Tabs activeKey={viewState.filters.mode} onChange={mode => viewState.setFilter({ mode, overdueOnly: "" })}
        destroyOnHidden items={[{ key: "progress", label: "在制进度", children: progressPanel }, { key: "cycles", label: "加工周期与返单", children: <ProcessingCycles view={viewState} url={url} /> }]} />
    </div>
  );
}
