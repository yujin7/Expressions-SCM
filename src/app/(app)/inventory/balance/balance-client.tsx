"use client";

import { useCallback, useEffect, useState } from "react";
import { Alert, App, Input, Space, Switch, Table, Tabs, Tag, Tooltip, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import RemoteSelect from "@/components/RemoteSelect";
import { fetchJson } from "@/components/fetchJson";
import { WAREHOUSE_KIND_LABELS } from "@/components/labels";

interface BalanceRow {
  skuId: number;
  skuCode: string;
  skuName: string;
  baseUom: string;
  spuCode: string;
  spuNameCn: string;
  warehouseId: number;
  warehouseName: string;
  warehouseKind: string;
  batchId: number | null;
  qty: string;
}

interface SpuBalanceRow {
  spuId: number;
  spuCode: string;
  spuNameCn: string;
  totalQty: string;
  skuCount: number;
}

const KIND_COLORS: Record<string, string> = {
  finished: "blue",
  raw: "green",
  packaging: "orange",
  outsource: "purple",
  transit: "cyan",
  snapshot: "default",
};

function SkuBalanceTab() {
  const { message } = App.useApp();
  const [rows, setRows] = useState<BalanceRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [q, setQ] = useState("");
  const [warehouseId, setWarehouseId] = useState<number | undefined>();
  const [includeZero, setIncludeZero] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        q,
        nonzero: includeZero ? "0" : "1",
        page: String(page),
        pageSize: String(pageSize),
      });
      if (warehouseId != null) params.set("warehouseId", String(warehouseId));
      const res = await fetchJson<{ rows: BalanceRow[]; total: number }>(
        `/api/inventory/balance?${params.toString()}`,
      );
      setRows(res.rows);
      setTotal(res.total);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [q, warehouseId, includeZero, page, pageSize, message]);

  useEffect(() => {
    void load();
  }, [load]);

  const columns: ColumnsType<BalanceRow> = [
    { title: "编码", dataIndex: "skuCode", width: 110 },
    { title: "名称", dataIndex: "skuName", width: 180 },
    { title: "所属产品", dataIndex: "spuNameCn", render: (_, r) => `${r.spuCode} ${r.spuNameCn}` },
    { title: "仓库", dataIndex: "warehouseName", width: 140 },
    {
      title: "仓库类型",
      dataIndex: "warehouseKind",
      width: 100,
      render: (v: string) => <Tag color={KIND_COLORS[v]}>{WAREHOUSE_KIND_LABELS[v] ?? v}</Tag>,
    },
    {
      title: "数量",
      dataIndex: "qty",
      width: 120,
      align: "right",
      render: (v: string, r) =>
        r.warehouseKind === "outsource" && Number(v) < 0 ? (
          <Tooltip title="加工厂垫料">
            <Typography.Text type="danger">{v}</Typography.Text>
          </Tooltip>
        ) : (
          v
        ),
    },
    { title: "基础单位", dataIndex: "baseUom", width: 90 },
  ];

  return (
    <div>
      <Space style={{ marginBottom: 16 }} wrap>
        <Input.Search
          allowClear
          placeholder="搜索 SKU 编码/名称"
          style={{ width: 260 }}
          onSearch={(value) => {
            setQ(value.trim());
            setPage(1);
          }}
        />
        <RemoteSelect
          api="/api/master/warehouse"
          getLabel={(r) => `${String(r.code)} ${String(r.name)}`}
          allowClear
          placeholder="全部仓库"
          style={{ width: 220 }}
          value={warehouseId}
          onChange={(v) => {
            setWarehouseId(v as number | undefined);
            setPage(1);
          }}
        />
        <Space size={8}>
          <Switch
            checked={includeZero}
            onChange={(v) => {
              setIncludeZero(v);
              setPage(1);
            }}
          />
          <Typography.Text>含零库存</Typography.Text>
        </Space>
      </Space>
      <Table<BalanceRow>
        rowKey={(r) => `${r.skuId}-${r.warehouseId}-${r.batchId ?? "nb"}`}
        size="middle"
        columns={columns}
        dataSource={rows}
        scroll={{ x: "max-content" }}
        loading={loading}
        pagination={{
          current: page,
          pageSize,
          total,
          showSizeChanger: true,
          showTotal: (t) => `共 ${t} 条`,
          onChange: (p, ps) => {
            setPage(p);
            setPageSize(ps);
          },
        }}
      />
    </div>
  );
}

function SpuBalanceTab() {
  const { message } = App.useApp();
  const [rows, setRows] = useState<SpuBalanceRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [q, setQ] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetchJson<{ rows: SpuBalanceRow[]; total: number }>(
        `/api/inventory/balance/spu?q=${encodeURIComponent(q)}&page=${page}&pageSize=${pageSize}`,
      );
      setRows(res.rows);
      setTotal(res.total);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [q, page, pageSize, message]);

  useEffect(() => {
    void load();
  }, [load]);

  const columns: ColumnsType<SpuBalanceRow> = [
    { title: "产品编码", dataIndex: "spuCode", width: 140 },
    { title: "产品名", dataIndex: "spuNameCn" },
    { title: "SKU 数", dataIndex: "skuCount", width: 100, align: "right" },
    { title: "合计数量", dataIndex: "totalQty", width: 140, align: "right" },
  ];

  return (
    <div>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="SPU 汇总按数量直加，仅同基础单位产品有参考意义（R3）"
      />
      <Space style={{ marginBottom: 16 }} wrap>
        <Input.Search
          allowClear
          placeholder="搜索产品编码/名称"
          style={{ width: 260 }}
          onSearch={(value) => {
            setQ(value.trim());
            setPage(1);
          }}
        />
      </Space>
      <Table<SpuBalanceRow>
        rowKey="spuId"
        size="middle"
        columns={columns}
        dataSource={rows}
        scroll={{ x: "max-content" }}
        loading={loading}
        pagination={{
          current: page,
          pageSize,
          total,
          showSizeChanger: true,
          showTotal: (t) => `共 ${t} 条`,
          onChange: (p, ps) => {
            setPage(p);
            setPageSize(ps);
          },
        }}
      />
    </div>
  );
}

export default function BalanceClient() {
  return (
    <div>
      <Typography.Title level={4} style={{ marginTop: 0 }}>
        库存余额
      </Typography.Title>
      <Tabs
        defaultActiveKey="sku"
        items={[
          { key: "sku", label: "SKU 明细", children: <SkuBalanceTab /> },
          { key: "spu", label: "SPU 汇总", children: <SpuBalanceTab /> },
        ]}
      />
    </div>
  );
}
