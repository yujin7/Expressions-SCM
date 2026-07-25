"use client";

/** 效期批次清单（仓库操作层）：逐批次×仓库的实物处置视图；PMC 决策视图见「风险库存处置」 */
import { Suspense, useCallback, useEffect, useState } from "react";
import { App, Input, Select, Table, Tag, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { fetchJson } from "@/components/fetchJson";
import { exportCsv } from "@/components/exportCsv";
import { formatQty } from "@/components/format";
import ListToolbar from "@/components/ListToolbar";
import { useListState } from "@/components/useListState";
import SkuHoverCard from "@/components/SkuHoverCard";
import CaliberNote from "@/components/CaliberNote";

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

/** 段位「全部」（取消段位筛选）的哨兵值：仅存在于 URL，不下发给接口 */
const BUCKET_ALL = "all";

export default function ExpiryClient() {
  // useSearchParams（列表页状态平台 E6-P1）需要 Suspense 边界
  return (
    <Suspense>
      <ExpiryInner />
    </Suspense>
  );
}

function ExpiryInner() {
  const { message } = App.useApp();
  const [data, setData] = useState<Data | null>(null);
  const [loading, setLoading] = useState(false);
  // 列表页状态平台（E6-P1）：筛选/分页进 URL（?q= 风险库存处置点击直达），密度与已保存视图存本地
  const listState = useListState({
    key: "expiry",
    defaults: { q: "", bucket: "expired", warehouseId: "" },
    defaultPageSize: 50,
  });
  const { filters, page, pageSize } = listState;
  const q = filters.q;
  const bucket = filters.bucket === BUCKET_ALL ? "" : filters.bucket;
  const warehouseId = filters.warehouseId ? Number(filters.warehouseId) : null;
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

  const doExport = async () => {
    const all: Row[] = [];
    let serverTotal = 0;
    for (let p2 = 1; p2 <= 40; p2++) { // struct#17: 提高上限至 2 万行
      const params = new URLSearchParams({ q, page: String(p2), pageSize: "500" });
      if (bucket) params.set("bucket", bucket);
      if (warehouseId) params.set("warehouseId", String(warehouseId));
      const d = await fetchJson<Data>(`/api/inventory/expiry?${params.toString()}`);
      serverTotal = d.total;
      all.push(...d.rows);
      if (all.length >= d.total) break;
    }
    exportCsv(`效期批次-${data?.today ?? ""}`,
      ["SKU编码","名称","品牌","仓库","批次","生产日期","到期日","剩余天数","数量"],
      all.map((r) => [r.skuCode, r.skuName, r.brand, r.warehouse, r.batchNo, r.productionDate, r.expiryDate, r.daysLeft, r.qty]),
      all.length < serverTotal
        ? `……仅导出前 ${all.length} 行，服务端共 ${serverTotal} 行（浏览器分页取数已达上限）；请缩小筛选范围，或改用「导出任务」`
        : undefined,
    );
  };

  const columns: ColumnsType<Row> = [
    { title: "SKU 编码", dataIndex: "skuCode", width: 125, fixed: "left", render: (v: string) => <SkuHoverCard code={v} /> },
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
      <CaliberNote
        summary={<>批次 × 仓库的实物处置视图；按 SKU 的决策见「风险库存处置」。{data ? <>　口径日 {data.today}，剩余天数升序。</> : null}</>}
        detail={<div><p>数据源：batch_stocks 参考层（效期盘点载体，非账本）。段位：已过期 / ≤3 月 / 3–6 月；&gt;6 个月的健康批次不在风险段位（取消段位筛选可见全量）。</p></div>}
      />
      <ListToolbar
        state={listState}
        onExport={() => void doExport()}
        extra={
          <>
            {BUCKETS.map((b) => (
              <Tag.CheckableTag
                key={b.key}
                checked={bucket === b.key}
                onChange={(c) => listState.setFilter({ bucket: c ? b.key : BUCKET_ALL })}
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
              value={warehouseId ?? undefined}
              onChange={(v) => listState.setFilter({ warehouseId: v == null ? "" : String(v) })}
            />
            <Input.Search
              key={q}
              allowClear
              defaultValue={q}
              placeholder="搜索编码/名称/批次"
              style={{ width: 240 }}
              onSearch={(v) => listState.setFilter({ q: v.trim() })}
            />
          </>
        }
      />
      <Table<Row>
        rowKey="id"
        size={listState.tableSize}
        columns={columns}
        dataSource={data?.rows ?? []}
        loading={loading}
        scroll={{ x: "max-content" }}
        pagination={listState.paginationProps({ total: data?.total ?? 0 })}
      />
    </div>
  );
}
