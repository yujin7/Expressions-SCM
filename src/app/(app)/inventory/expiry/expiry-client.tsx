"use client";

/** 效期批次清单（仓库操作层）：逐批次×仓库的实物处置视图；PMC 决策视图见「风险库存处置」 */
import { useCallback, useEffect, useState } from "react";
import { Alert, App, Input, Select, Space, Table, Tag, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { fetchJson } from "@/components/fetchJson";
import { formatQty } from "@/components/format";

interface Row {
  id: number;
  skuCode: string;
  skuName: string;
  brand: string | null;
  warehouse: string;
  batchNo: string | null;
  productionDate: string | null;
  expiryDate: string;
  daysLeft: number;
  qty: number;
  bucket: string;
}

interface Data {
  today: string;
  rows: Row[];
  total: number;
  bucketCounts: Record<string, { batches: number; qty: number }>;
}

const BUCKETS: { key: string; label: string; color: string }[] = [
  { key: "expired", label: "已过期", color: "red" },
  { key: "m3", label: "≤3 个月", color: "orange" },
  { key: "m6", label: "3–6 个月", color: "gold" },
];

export default function ExpiryClient() {
  const { message } = App.useApp();
  const [data, setData] = useState<Data | null>(null);
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState("");
  const [bucket, setBucket] = useState<string | null>("expired");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [warehouseId, setWarehouseId] = useState<number | null>(null);
  const [warehouses, setWarehouses] = useState<{ id: number; name: string }[]>([]);
  useEffect(() => {
    fetch("/api/master/warehouse?page=1&pageSize=500")
      .then((r) => r.json())
      .then((d) => {
        const rows = (d.rows ?? d.data ?? []) as { id: number; name: string }[];
        setWarehouses(rows.filter((w) => w.id && w.name));
      })
      .catch(() => setWarehouses([]));
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ q, page: String(page), pageSize: String(pageSize) });
      if (bucket) params.set("bucket", bucket);
      if (warehouseId) params.set("warehouseId", String(warehouseId));
      setData(await fetchJson<Data>(`/api/inventory/expiry?${params.toString()}`));
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [q, bucket, warehouseId, page, pageSize, message]);
  useEffect(() => { void load(); }, [load]);

  const columns: ColumnsType<Row> = [
    { title: "SKU 编码", dataIndex: "skuCode", width: 125, fixed: "left", render: (v: string) => <a href={`/inventory/balance?q=${encodeURIComponent(v)}`}>{v}</a> },
    { title: "名称", dataIndex: "skuName", ellipsis: true, width: 220 },
    { title: "品牌", dataIndex: "brand", width: 100, render: (v: string | null) => v ?? "—" },
    { title: "仓库", dataIndex: "warehouse", width: 130, ellipsis: true },
    { title: "批次", dataIndex: "batchNo", width: 110, render: (v: string | null) => v ?? "—" },
    { title: "生产日期", dataIndex: "productionDate", width: 105, render: (v: string | null) => v ?? "—" },
    { title: "到期日", dataIndex: "expiryDate", width: 105 },
    {
      title: "剩余天数",
      dataIndex: "daysLeft",
      width: 110,
      align: "right",
      render: (v: number) =>
        v <= 0 ? (
          <Typography.Text type="danger" strong>已过期 {-v} 天</Typography.Text>
        ) : v <= 90 ? (
          <Typography.Text type="warning">{v} 天</Typography.Text>
        ) : (
          `${v} 天`
        ),
    },
    { title: "数量", dataIndex: "qty", width: 100, align: "right", render: (v: number) => formatQty(String(v)) },
  ];

  return (
    <div>
      <Typography.Title level={4} style={{ marginTop: 0 }}>效期批次</Typography.Title>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message="逐批次×仓库的实物处置视图（batch_stocks 参考层，效期盘点载体）。按 SKU 的处置决策（报废/禁售/促销）见「风险库存处置」。>6 个月的健康批次不在风险段位（取消段位筛选可见全量）。"
        description={data ? <Typography.Text type="secondary">口径日 {data.today}；剩余天数升序（最紧急最上）。</Typography.Text> : null}
      />
      <Space style={{ marginBottom: 12 }} wrap>
        {BUCKETS.map((b) => (
          <Tag.CheckableTag
            key={b.key}
            checked={bucket === b.key}
            onChange={(c) => { setBucket(c ? b.key : null); setPage(1); }}
            style={{ border: "1px solid #d9d9d9", padding: "2px 10px" }}
          >
            {b.label}（{data?.bucketCounts[b.key]?.batches ?? 0} 批 / {formatQty(String(data?.bucketCounts[b.key]?.qty ?? 0))}）
          </Tag.CheckableTag>
        ))}
        <Select
          allowClear
          showSearch
          placeholder="全部仓库"
          style={{ width: 180 }}
          optionFilterProp="label"
          options={warehouses.map((w) => ({ value: w.id, label: w.name }))}
          onChange={(v) => { setWarehouseId(v ?? null); setPage(1); }}
        />
        <Input.Search allowClear placeholder="搜索编码/名称/批次" style={{ width: 240 }} onSearch={(v) => { setQ(v.trim()); setPage(1); }} />
      </Space>
      <Table<Row>
        rowKey="id"
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
