"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { App, Button, Card, Col, Progress, Row, Space, Statistic, Switch, Table, Tag, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { ReloadOutlined } from "@ant-design/icons";
import DecisionVisual from "@/components/DecisionVisual";
import DocStatusTag from "@/components/DocStatusTag";
import RemoteSelect from "@/components/RemoteSelect";
import { fetchJson } from "@/components/fetchJson";
import { formatQty } from "@/components/format";
import { useListState } from "@/components/useListState";

interface WipRow {
  jgId: number;
  jgNo: string;
  woNo: string;
  supplierId: number;
  supplierName: string;
  productSkuCode: string;
  productName: string;
  orderQty: string;
  receivedGood: string;
  receivedConcession: string;
  pendingQty: string;
  issuedMaterialLines: number;
  status: string;
  dueDate: string | null;
  overdue: boolean;
}

interface WipSummary {
  wipCount: number;
  overdueCount: number;
  pendingTotal: string;
}

export default function WipClient() {
  const { message } = App.useApp();
  const [rows, setRows] = useState<WipRow[]>([]);
  const [summary, setSummary] = useState<WipSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const viewState = useListState({
    key: "wip-report",
    defaults: { supplierId: "", overdueOnly: "" },
    paginated: false,
  });
  const supplierId = viewState.filters.supplierId
    ? Number(viewState.filters.supplierId)
    : undefined;
  const overdueOnly = viewState.filters.overdueOnly === "1";

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (supplierId != null) params.set("supplierId", String(supplierId));
      if (overdueOnly) params.set("overdueOnly", "1");
      const res = await fetchJson<{ rows: WipRow[]; summary: WipSummary }>(
        `/api/report/wip?${params.toString()}`,
      );
      setRows(res.rows);
      setSummary(res.summary);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [supplierId, overdueOnly, message]);

  useEffect(() => {
    void load();
  }, [load]);

  const supplierSummary = useMemo(() => {
    const bySupplier = new Map<string, { name: string; pending: number; jobs: number; overdue: number }>();
    for (const row of rows) {
      const current = bySupplier.get(row.supplierName) ?? {
        name: row.supplierName,
        pending: 0,
        jobs: 0,
        overdue: 0,
      };
      current.pending += Number(row.pendingQty) || 0;
      current.jobs += 1;
      current.overdue += row.overdue ? 1 : 0;
      bySupplier.set(row.supplierName, current);
    }
    const ranked = [...bySupplier.values()].sort((a, b) => b.pending - a.pending);
    const maxPending = Math.max(...ranked.map((item) => item.pending), 0);
    const pendingTotal = ranked.reduce((sum, item) => sum + item.pending, 0);
    return { ranked, maxPending, pendingTotal };
  }, [rows]);

  const columns: ColumnsType<WipRow> = [
    // 单号回链到各自列表页（?q=单号 精确命中，列表页打开详情抽屉）——此前是纯文本死胡同
    {
      title: "JG 单号", dataIndex: "jgNo", width: 150,
      render: (v: string) => <a href={`/outsource/jg?q=${encodeURIComponent(v)}`}>{v}</a>,
    },
    {
      title: "工单", dataIndex: "woNo", width: 150,
      render: (v: string) => <a href={`/outsource/wo?q=${encodeURIComponent(v)}`}>{v}</a>,
    },
    { title: "加工厂", dataIndex: "supplierName", width: 140 },
    { title: "成品", key: "product", render: (_, r) => `${r.productSkuCode} ${r.productName}` },
    { title: "订单数量", dataIndex: "orderQty", width: 100, align: "right", render: (v: string) => formatQty(v) },
    { title: "已收合格", dataIndex: "receivedGood", width: 100, align: "right", render: (v: string) => formatQty(v) },
    { title: "已收让步", dataIndex: "receivedConcession", width: 100, align: "right", render: (v: string) => formatQty(v) },
    {
      title: "待收数量",
      dataIndex: "pendingQty",
      width: 100,
      align: "right",
      render: (v: string, r) =>
        r.overdue ? <Typography.Text type="danger">{formatQty(v)}</Typography.Text> : formatQty(v),
    },
    { title: "发料行数", dataIndex: "issuedMaterialLines", width: 90, align: "right" },
    { title: "状态", dataIndex: "status", width: 100, render: (v: string) => <DocStatusTag status={v} /> },
    {
      title: "交期",
      dataIndex: "dueDate",
      width: 110,
      render: (v: string | null, r) =>
        v == null ? "—" : r.overdue ? <Typography.Text type="danger">{v}（逾期）</Typography.Text> : v,
    },
  ];

  return (
    <div>
      <Typography.Title level={4} style={{ marginTop: 0 }}>
        委外在制看板
      </Typography.Title>
      <Typography.Paragraph type="secondary">
        全部未作废 JG 的收货进度（已收合格/让步=已入库检验口径；待收=订单数量−正常行累计实收）。
      </Typography.Paragraph>
      <Row gutter={[10, 10]} className="compact-kpi-row">
        <Col span={8}>
          <Card size="small">
            <Statistic title="在制 JG 数" value={summary?.wipCount ?? "—"} />
          </Card>
        </Col>
        <Col span={8}>
          <Card size="small">
            <Statistic
              title="逾期数"
              value={summary?.overdueCount ?? "—"}
              valueStyle={(summary?.overdueCount ?? 0) > 0 ? { color: "#cf1322" } : undefined}
            />
          </Card>
        </Col>
        <Col span={8}>
          <Card size="small">
            <Statistic title="待收总量" value={summary ? formatQty(summary.pendingTotal) : "—"} />
          </Card>
        </Col>
      </Row>
      <Space style={{ marginBottom: 16 }} wrap>
        <RemoteSelect
          api="/api/master/supplier"
          getLabel={(r) => `${String(r.code)} ${String(r.name)}`}
          allowClear
          placeholder="全部加工厂"
          style={{ width: 240 }}
          value={supplierId}
          onChange={(v) => viewState.setFilter({ supplierId: v == null ? "" : String(v) })}
        />
        <Space size={8}>
          <Switch
            checked={overdueOnly}
            onChange={(checked) => viewState.setFilter({ overdueOnly: checked ? "1" : "" })}
          />
          <Typography.Text>仅逾期</Typography.Text>
        </Space>
        <Button icon={<ReloadOutlined />} onClick={() => void load()}>
          刷新
        </Button>
      </Space>
      <DecisionVisual
        title="委外待收集中度"
        question="待收数量集中在哪些加工厂，逾期订单是否需要立即催交或调整产能？"
        metricId="wipPendingQty"
        grain="加工厂 / JG"
        unit="基础数量"
        source={{ tier: "ledger", source: "JG 委外订单与收货正常行" }}
        coverage={{ covered: rows.length, total: summary?.wipCount ?? rows.length, label: "当前筛选在制 JG" }}
        activeFilters={[
          supplierId != null ? `加工厂 ID ${supplierId}` : "全部加工厂",
          overdueOnly ? "仅逾期" : "全部在制",
        ]}
        summary={`当前 ${rows.length} 个在制 JG，待收 ${formatQty(String(supplierSummary.pendingTotal))}；其中逾期 ${summary?.overdueCount ?? 0} 个，分布在 ${supplierSummary.ranked.length} 家加工厂。`}
        caveat="数量可能混合不同 SKU 的基础单位，只能用于识别集中度与催交优先级；跨品类总量不代表可替代产能。"
        state={loading ? "loading" : rows.length === 0 ? "empty" : "ready"}
        height={Math.max(220, Math.min(420, supplierSummary.ranked.length * 52 + 36))}
        fitContent
        dataView={
          <>
            <style>{`.wip-row-overdue > td { background: #fff1f0 !important; }`}</style>
            <Table<WipRow>
              rowKey="jgId"
              size="middle"
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
          {supplierSummary.ranked.map((supplier) => {
            const share = supplierSummary.pendingTotal > 0
              ? Math.round((supplier.pending / supplierSummary.pendingTotal) * 100)
              : 0;
            const relative = supplierSummary.maxPending > 0
              ? Math.round((supplier.pending / supplierSummary.maxPending) * 100)
              : 0;
            return (
              <div key={supplier.name}>
                <Space style={{ display: "flex", justifyContent: "space-between", marginBottom: 2 }} wrap>
                  <Typography.Text strong>{supplier.name}</Typography.Text>
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
    </div>
  );
}
