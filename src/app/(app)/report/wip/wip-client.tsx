"use client";

import { useCallback, useEffect, useState } from "react";
import { App, Button, Card, Col, Row, Space, Statistic, Switch, Table, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { ReloadOutlined } from "@ant-design/icons";
import DocStatusTag from "@/components/DocStatusTag";
import RemoteSelect from "@/components/RemoteSelect";
import { fetchJson } from "@/components/fetchJson";
import { formatQty } from "@/components/format";

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
  const [supplierId, setSupplierId] = useState<number | undefined>();
  const [overdueOnly, setOverdueOnly] = useState(false);

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

  const columns: ColumnsType<WipRow> = [
    { title: "JG 单号", dataIndex: "jgNo", width: 150 },
    { title: "工单", dataIndex: "woNo", width: 150 },
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
      <Row gutter={16} style={{ marginBottom: 16 }}>
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
          onChange={(v) => setSupplierId(v as number | undefined)}
        />
        <Space size={8}>
          <Switch checked={overdueOnly} onChange={setOverdueOnly} />
          <Typography.Text>仅逾期</Typography.Text>
        </Space>
        <Button icon={<ReloadOutlined />} onClick={() => void load()}>
          刷新
        </Button>
      </Space>
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
    </div>
  );
}
