"use client";

import SearchInput from "@/components/SearchInput";

/** 效期批次清单（仓库操作层）：逐批次×仓库的实物处置视图；PMC 决策视图见「风险库存处置」 */
import { Suspense, useCallback, useEffect, useState } from "react";
import { App, Card, Select, Table, Tag, Tooltip, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { fetchJson } from "@/components/fetchJson";
import { exportCsv } from "@/components/exportCsv";
import { formatQty, formatYuan } from "@/components/format";
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
  /** 非价格可见角色：服务端 maskSensitive 已删键 → undefined */
  amount?: string | null;
}

interface BrandMatrixRow {
  brand: string;
  buckets: Record<string, { batches: number; qty: number }>;
  batches: number;
  qty: number;
}

interface Data {
  today: string;
  rows: Row[];
  total: number;
  canSeeValue?: boolean;
  costCoverage: { covered: number; total: number } | null;
  bucketCounts: Record<string, { batches: number; qty: number; amount?: string }>;
  brandMatrix: BrandMatrixRow[];
  brands: string[];
  brand: string | null;
}

const BUCKETS: { key: string; label: string; color: string }[] = [
  { key: "expired", label: "已过期", color: "red" },
  { key: "m3", label: "≤3 个月", color: "orange" },
  { key: "m6", label: "3–6 个月", color: "gold" },
  { key: "m12", label: "6–12 个月", color: "lime" },
  { key: "m18", label: "12–18 个月", color: "green" },
  { key: "m24", label: "18–24 个月", color: "cyan" },
  { key: "rest", label: ">24 个月", color: "blue" },
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
    defaults: { q: "", bucket: "expired", warehouseId: "", brand: "" },
    defaultPageSize: 50,
  });
  const { filters, page, pageSize } = listState;
  const q = filters.q;
  const bucket = filters.bucket === BUCKET_ALL ? "" : filters.bucket;
  const warehouseId = filters.warehouseId ? Number(filters.warehouseId) : null;
  const brand = filters.brand || "";
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
      if (brand) params.set("brand", brand);
      setData(await fetchJson<Data>(`/api/inventory/expiry?${params.toString()}`));
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [q, bucket, warehouseId, brand, page, pageSize, message]);
  useEffect(() => { void load(); }, [load]);

  const doExport = async () => {
    const all: Row[] = [];
    let serverTotal = 0;
    for (let p2 = 1; p2 <= 40; p2++) { // struct#17: 提高上限至 2 万行
      const params = new URLSearchParams({ q, page: String(p2), pageSize: "500" });
      if (bucket) params.set("bucket", bucket);
      if (warehouseId) params.set("warehouseId", String(warehouseId));
      if (brand) params.set("brand", brand);
      const d = await fetchJson<Data>(`/api/inventory/expiry?${params.toString()}`);
      serverTotal = d.total;
      all.push(...d.rows);
      if (all.length >= d.total) break;
    }
    const withValue = Boolean(data?.canSeeValue);
    exportCsv(`效期批次-${data?.today ?? ""}`,
      ["SKU编码","名称","品牌","仓库","批次","生产日期","到期日","剩余天数","数量", ...(withValue ? ["金额"] : [])],
      all.map((r) => [r.skuCode, r.skuName, r.brand, r.warehouse, r.batchNo, r.productionDate, r.expiryDate, r.daysLeft, r.qty, ...(withValue ? [r.amount ?? ""] : [])]),
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
    // W2-5：金额（数量 × 单位成本，core/valuation）——没有它，处置队列只能按数量排序
    ...(data?.canSeeValue
      ? ([{
          title: "金额",
          dataIndex: "amount",
          width: 130,
          align: "right" as const,
          sorter: (a: Row, b: Row) => Number(a.amount ?? 0) - Number(b.amount ?? 0),
          render: (v: string | null | undefined) =>
            v == null
              ? <Tooltip title="该 SKU 无单位成本（sku_costs / 财务运营成本观察均无）"><Typography.Text type="secondary">无成本</Typography.Text></Tooltip>
              : formatYuan(v),
        }] as ColumnsType<Row>)
      : []),
  ];

  const matrixColumns: ColumnsType<BrandMatrixRow> = [
    {
      title: "品牌", dataIndex: "brand", width: 140, fixed: "left",
      render: (v: string) => (
        <a onClick={() => listState.setFilter({ brand: brand === v ? "" : v, bucket: BUCKET_ALL })} style={{ fontWeight: brand === v ? 600 : undefined }}>{v}</a>
      ),
    },
    ...BUCKETS.map((b) => ({
      title: b.label, key: b.key, align: "right" as const, width: 120,
      render: (_: unknown, r: BrandMatrixRow) => {
        const c = r.buckets[b.key] ?? { batches: 0, qty: 0 };
        return c.batches === 0
          ? <Typography.Text type="secondary">—</Typography.Text>
          : <a onClick={() => listState.setFilter({ brand: r.brand, bucket: b.key })}>{formatQty(String(c.qty))}<Typography.Text type="secondary">（{c.batches} 批）</Typography.Text></a>;
      },
    })),
    { title: "合计", key: "total", align: "right", width: 130, render: (_, r) => <Typography.Text strong>{formatQty(String(r.qty))}<Typography.Text type="secondary">（{r.batches} 批）</Typography.Text></Typography.Text> },
  ];

  return (
    <div>
      <Typography.Title level={4} style={{ marginTop: 0 }}>效期批次</Typography.Title>
      <CaliberNote
        summary={<>批次 × 仓库的实物处置视图；按 SKU 的决策见「风险库存处置」。{data ? <>　口径日 {data.today}，剩余天数升序。</> : null}</>}
        detail={<div><p>数据源：batch_stocks 参考层（效期盘点载体，非账本）。七段位与经营驾驶舱同源：已过期 / ≤3 月 / 3–6 月 / 6–12 月 / 12–18 月 / 18–24 月 / &gt;24 月。</p><p>「段位 × 品牌」矩阵按当前仓库筛选统计（不受段位/品牌/搜索影响）；点击单元格直达该品牌该段位的批次；无品牌 SKU 归「(未设品牌)」。指标 id：expiryByBrand。</p>{data?.canSeeValue ? <p>金额 = 数量 × 单位成本（唯一权威 core/valuation：sku_costs 优先，其次财务运营成本观察）。{data.costCoverage ? `本次口径内 ${data.costCoverage.covered}/${data.costCoverage.total} 个批次有单位成本，其余显示「无成本」且不计入段位金额。` : null}金额按 PRICE_VISIBLE_ROLES 服务端剥离。</p> : null}</div>}
      />
      <Card size="small" title="效期分布 · 段位 × 品牌" style={{ marginBottom: 12 }} extra={brand ? <a onClick={() => listState.setFilter({ brand: "" })}>清除品牌筛选「{brand}」</a> : null}>
        <Table<BrandMatrixRow>
          rowKey="brand"
          size="small"
          loading={loading && !data}
          pagination={false}
          columns={matrixColumns}
          dataSource={data?.brandMatrix ?? []}
          scroll={{ x: "max-content" }}
          rowClassName={(r) => (brand === r.brand ? "ant-table-row-selected" : "")}
        />
      </Card>
      <ListToolbar
        state={listState}
        onExport={() => void doExport()}
        extra={
          <>
            {BUCKETS.map((b) => (
              <Tooltip
                key={b.key}
                title={`${b.label}：${data?.bucketCounts[b.key]?.batches ?? 0} 批 / ${formatQty(String(data?.bucketCounts[b.key]?.qty ?? 0))}`}
              >
                <Tag.CheckableTag
                  className="expiry-bucket-filter"
                  checked={bucket === b.key}
                  onChange={(c) => listState.setFilter({ bucket: c ? b.key : BUCKET_ALL })}
                  style={{ border: "1px solid #d9d9d9", padding: "2px 10px" }}
                >
                  {b.label}
                  <span className="expiry-bucket-filter__count">
                    （{data?.bucketCounts[b.key]?.batches ?? 0} 批 / {formatQty(String(data?.bucketCounts[b.key]?.qty ?? 0))}
                    {data?.canSeeValue && data.bucketCounts[b.key]?.amount
                      ? ` / ${formatYuan(data.bucketCounts[b.key]!.amount!)}`
                      : ""}）
                  </span>
                </Tag.CheckableTag>
              </Tooltip>
            ))}
            <Select
              allowClear
              showSearch
              placeholder="全部品牌"
              style={{ width: 150 }}
              optionFilterProp="label"
              options={(data?.brands ?? []).map((b) => ({ value: b, label: b }))}
              value={brand || undefined}
              onChange={(v) => listState.setFilter({ brand: v ?? "" })}
            />
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
            <SearchInput
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
