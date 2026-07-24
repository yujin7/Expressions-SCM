"use client";

/** 主数据健康度仪表——逐 active SKU 主数据完整度评分 + 缺失清单（只读，不写库） */
import { useCallback, useEffect, useState } from "react";
import { Alert, App, Input, Progress, Space, Statistic, Table, Tag, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { fetchJson } from "@/components/fetchJson";

interface DataHealthRow {
  skuId: number;
  code: string;
  name: string;
  skuType: string;
  brand: string | null;
  missing: string[];
  score: number;
}

interface DataHealthSummary {
  totalSkus: number;
  fullyHealthy: number;
  byDimension: Record<string, number>;
}

interface DataHealthData {
  rows: DataHealthRow[];
  total: number;
  summary: DataHealthSummary;
}

const DIMENSIONS = ["生产周期", "起订量", "BOM", "条码", "品牌"];

const TYPE_LABELS: Record<string, string> = {
  finished: "成品",
  semi: "半成品",
  raw: "原料",
  packaging: "包材",
  service: "服务",
};

function scoreColor(v: number): string {
  return v < 50 ? "#cf1322" : v < 80 ? "#d46b08" : "#389e0d";
}

export default function DataHealthClient() {
  const { message } = App.useApp();
  const [data, setData] = useState<DataHealthData | null>(null);
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState("");
  const [missing, setMissing] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ q, page: String(page), pageSize: String(pageSize) });
      if (missing) params.set("missing", missing);
      setData(await fetchJson<DataHealthData>(`/api/report/data-health?${params.toString()}`));
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [q, missing, page, pageSize, message]);
  useEffect(() => { void load(); }, [load]);

  const summary = data?.summary;
  const healthRate = summary && summary.totalSkus > 0 ? Math.round((100 * summary.fullyHealthy) / summary.totalSkus) : 0;

  const columns: ColumnsType<DataHealthRow> = [
    {
      title: "完整度",
      dataIndex: "score",
      width: 150,
      fixed: "left",
      render: (v: number) => (
        <Progress percent={v} size="small" strokeColor={scoreColor(v)} format={(p) => `${p}分`} style={{ width: 130, marginBottom: 0 }} />
      ),
    },
    {
      title: "SKU 编码",
      dataIndex: "code",
      width: 150,
      render: (v: string) => <a href={`/inventory/balance?q=${encodeURIComponent(v)}`}>{v}</a>,
    },
    { title: "名称", dataIndex: "name", ellipsis: true, width: 220 },
    { title: "类型", dataIndex: "skuType", width: 90, render: (v: string) => TYPE_LABELS[v] ?? v },
    { title: "品牌", dataIndex: "brand", width: 110, render: (v: string | null) => v ?? "—" },
    {
      title: "缺失项",
      dataIndex: "missing",
      render: (v: string[]) => (
        <Space size={4} wrap>
          {v.map((m) => (
            <Tag color="red" key={m} style={{ marginInlineEnd: 0 }}>{m}</Tag>
          ))}
        </Space>
      ),
    },
  ];

  return (
    <div>
      <Typography.Title level={4} style={{ marginTop: 0 }}>主数据健康度</Typography.Title>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message="完整度评分 = 各适用维度完整占比（按货品类型裁剪：成品评 生产周期/起订量/BOM/条码/品牌，其余类型仅评 条码/品牌）。"
        description="仅列出存在缺失项的 SKU；完全健康的 SKU 不入列表，仅计入下方汇总。只读报表，不修改任何主数据。"
      />
      <Space size="large" style={{ marginBottom: 12 }} wrap>
        <Statistic title="总 SKU" value={summary?.totalSkus ?? 0} />
        <Statistic title="完全健康" value={summary?.fullyHealthy ?? 0} suffix={summary ? `/ ${healthRate}%` : undefined} />
        <Statistic title="待修复" value={data?.total ?? 0} valueStyle={{ color: "#cf1322" }} />
      </Space>
      <Space style={{ marginBottom: 12 }} wrap>
        {DIMENSIONS.map((d) => (
          <Tag.CheckableTag
            key={d}
            checked={missing === d}
            onChange={(c) => { setMissing(c ? d : null); setPage(1); }}
            style={{ border: "1px solid #d9d9d9", padding: "2px 10px" }}
          >
            {d} 缺失（{summary?.byDimension[d] ?? 0}）
          </Tag.CheckableTag>
        ))}
        <Input.Search allowClear placeholder="搜索编码/名称" style={{ width: 240 }} onSearch={(v) => { setQ(v.trim()); setPage(1); }} />
      </Space>
      <Table<DataHealthRow>
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
          showTotal: (t) => `共 ${t} 条待修复`,
          onChange: (p, ps) => { setPage(p); setPageSize(ps); },
        }}
      />
    </div>
  );
}
