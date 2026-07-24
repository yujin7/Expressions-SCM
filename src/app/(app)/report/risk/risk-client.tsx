"use client";

/** F 项：风险库存处置工作台——效期批次 × 货盘处置注记 × 销速 三源融合（只读，spec/13） */
import { useCallback, useEffect, useState } from "react";
import { Alert, App, Input, Space, Table, Tag, Tooltip, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { fetchJson } from "@/components/fetchJson";

interface RiskRow {
  skuId: number;
  code: string;
  name: string;
  brand: string | null;
  action: string;
  onHand: number;
  daily: number;
  cover: number | null;
  minDaysLeft: number | null;
  expiredQty: number;
  nearQty: number;
  palletRemark: string | null;
  remarkMonth: string | null;
}

interface RiskData {
  today: string;
  slowThreshold: number;
  rows: RiskRow[];
  total: number;
  byAction: Record<string, number>;
}

const ACTION_COLORS: Record<string, string> = {
  报废评审: "red",
  禁售隔离: "volcano",
  商务处置: "purple",
  促销清库: "orange",
  优先出库: "gold",
  滞销关注: "blue",
};
const ACTION_ORDER = ["报废评审", "禁售隔离", "商务处置", "促销清库", "优先出库", "滞销关注"];

export default function RiskClient() {
  const { message } = App.useApp();
  const [data, setData] = useState<RiskData | null>(null);
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState("");
  const [action, setAction] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ q, page: String(page), pageSize: String(pageSize) });
      if (action) params.set("action", action);
      setData(await fetchJson<RiskData>(`/api/report/risk?${params.toString()}`));
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [q, action, page, pageSize, message]);
  useEffect(() => { void load(); }, [load]);

  const columns: ColumnsType<RiskRow> = [
    {
      title: "建议动作",
      dataIndex: "action",
      width: 100,
      fixed: "left",
      render: (v: string) => <Tag color={ACTION_COLORS[v]}>{v}</Tag>,
    },
    { title: "SKU 编码", dataIndex: "code", width: 120, render: (v: string) => <a href={`/inventory/balance?q=${encodeURIComponent(v)}`}>{v}</a> },
    { title: "名称", dataIndex: "name", ellipsis: true, width: 220 },
    { title: "品牌", dataIndex: "brand", width: 100, render: (v: string | null) => v ?? "—" },
    { title: "在库", dataIndex: "onHand", width: 95, align: "right", render: (v: number) => v.toLocaleString("zh-CN") },
    {
      title: "最短剩余效期",
      dataIndex: "minDaysLeft",
      width: 115,
      align: "right",
      render: (v: number | null) =>
        v == null ? "—" : v <= 0 ? (
          <Typography.Text type="danger" strong>已过期 {-v} 天</Typography.Text>
        ) : v <= 90 ? (
          <Typography.Text type="warning">{v} 天</Typography.Text>
        ) : (
          `${v} 天`
        ),
    },
    { title: "过期量", dataIndex: "expiredQty", width: 90, align: "right", render: (v: number) => (v > 0 ? <Typography.Text type="danger">{v.toLocaleString("zh-CN")}</Typography.Text> : "—") },
    { title: "90天内到期量", dataIndex: "nearQty", width: 110, align: "right", render: (v: number) => (v > 0 ? v.toLocaleString("zh-CN") : "—") },
    { title: "日均销", dataIndex: "daily", width: 85, align: "right" },
    {
      title: "可销天数",
      dataIndex: "cover",
      width: 95,
      align: "right",
      render: (v: number | null) => (v == null ? <Typography.Text type="secondary">无动销</Typography.Text> : Math.round(v).toLocaleString("zh-CN")),
    },
    {
      title: "货盘注记",
      dataIndex: "palletRemark",
      ellipsis: true,
      render: (v: string | null, r) =>
        v ? (
          <Tooltip title={`${v}（${r.remarkMonth ?? "月份未知"} 货盘表）`}>
            <span>{v}</span>
          </Tooltip>
        ) : (
          "—"
        ),
    },
  ];

  return (
    <div>
      <Typography.Title level={4} style={{ marginTop: 0 }}>风险库存处置</Typography.Title>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message="三源融合（只读建议，不自动开单）：批次效期 × 货盘处置注记（PMC 货盘表备注） × 近3月销速。报废/禁售/盘点等操作走各自单据流程。"
        description={data ? <Typography.Text type="secondary">口径日 {data.today}；滞销阈值 {data.slowThreshold} 天（运行参数 slow_days_threshold）；注记为对应月份货盘表原文。</Typography.Text> : null}
      />
      <Space style={{ marginBottom: 12 }} wrap>
        {ACTION_ORDER.map((a) => (
          <Tag.CheckableTag
            key={a}
            checked={action === a}
            onChange={(c) => { setAction(c ? a : null); setPage(1); }}
            style={{ border: "1px solid #d9d9d9", padding: "2px 10px" }}
          >
            {a}（{data?.byAction[a] ?? 0}）
          </Tag.CheckableTag>
        ))}
        <Input.Search allowClear placeholder="搜索编码/名称" style={{ width: 240 }} onSearch={(v) => { setQ(v.trim()); setPage(1); }} />
      </Space>
      <Table<RiskRow>
        rowKey="skuId"
        size="small"
        columns={columns}
        dataSource={data?.rows ?? []}
        loading={loading}
        scroll={{ x: "max-content" }}
        pagination={{
          current: page,
          pageSize,
          total: data?.total ?? 0,
          showSizeChanger: true,
          showTotal: (t) => `共 ${t} 条`,
          onChange: (p, ps) => { setPage(p); setPageSize(ps); },
        }}
      />
    </div>
  );
}
