"use client";

import { useCallback, useEffect, useState } from "react";
import { App, DatePicker, Space, Table, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import dayjs from "dayjs";
import ExportButton from "@/components/ExportButton";
import RemoteSelect from "@/components/RemoteSelect";
import { fetchJson } from "@/components/fetchJson";
import { formatQty } from "@/components/format";
import { LEDGER_SOURCE_LABELS } from "@/components/labels";

interface LedgerRow {
  id: number;
  occurredAt: string;
  skuCode: string;
  skuName: string;
  warehouseName: string;
  qtyDelta: string;
  sourceDocType: string;
  sourceDocId: number;
  action: string;
}

export default function LedgerClient() {
  const { message } = App.useApp();
  const [rows, setRows] = useState<LedgerRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [skuId, setSkuId] = useState<number | undefined>();
  const [warehouseId, setWarehouseId] = useState<number | undefined>();
  const [from, setFrom] = useState<string | undefined>();
  const [to, setTo] = useState<string | undefined>();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
      if (skuId != null) params.set("skuId", String(skuId));
      if (warehouseId != null) params.set("warehouseId", String(warehouseId));
      if (from) params.set("from", from);
      if (to) params.set("to", to);
      const res = await fetchJson<{ rows: LedgerRow[]; total: number }>(
        `/api/inventory/ledger?${params.toString()}`,
      );
      setRows(res.rows);
      setTotal(res.total);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [skuId, warehouseId, from, to, page, pageSize, message]);

  useEffect(() => {
    void load();
  }, [load]);

  const columns: ColumnsType<LedgerRow> = [
    {
      title: "时间",
      dataIndex: "occurredAt",
      width: 170,
      render: (v: string) => dayjs(v).format("YYYY-MM-DD HH:mm:ss"),
    },
    { title: "SKU", dataIndex: "skuCode", render: (_, r) => `${r.skuCode} ${r.skuName}` },
    { title: "仓库", dataIndex: "warehouseName", width: 140 },
    {
      title: "数量±",
      dataIndex: "qtyDelta",
      width: 120,
      align: "right",
      render: (v: string) => {
        const n = Number(v);
        return (
          <Typography.Text type={n < 0 ? "danger" : "success"}>
            {n >= 0 ? `+${v}` : v}
          </Typography.Text>
        );
      },
    },
    {
      title: "来源",
      dataIndex: "sourceDocType",
      width: 160,
      render: (v: string, r) => `${LEDGER_SOURCE_LABELS[v] ?? v} #${r.sourceDocId}`,
    },
    { title: "动作", dataIndex: "action", width: 120 },
  ];

  return (
    <div>
      <Typography.Title level={4} style={{ marginTop: 0 }}>
        库存流水
      </Typography.Title>
      <Space style={{ marginBottom: 16 }} wrap>
        <RemoteSelect
          api="/api/master/sku"
          getLabel={(r) => `${String(r.code)} ${String(r.name)}`}
          allowClear
          placeholder="全部 SKU"
          style={{ width: 260 }}
          value={skuId}
          onChange={(v) => {
            setSkuId(v as number | undefined);
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
        <DatePicker.RangePicker
          allowClear
          onChange={(values) => {
            setFrom(values?.[0] ? values[0].format("YYYY-MM-DD") : undefined);
            setTo(values?.[1] ? values[1].format("YYYY-MM-DD") : undefined);
            setPage(1);
          }}
        />
        <ExportButton
          href={`/api/export/ledger?${new URLSearchParams({
            ...(skuId != null ? { skuId: String(skuId) } : {}),
            ...(warehouseId != null ? { warehouseId: String(warehouseId) } : {}),
            ...(from ? { from } : {}),
            ...(to ? { to } : {}),
          }).toString()}`}
        />
      </Space>
      <Table<LedgerRow>
        rowKey="id"
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
