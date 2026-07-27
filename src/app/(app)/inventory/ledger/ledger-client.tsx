"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { App, DatePicker, Table, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import dayjs from "dayjs";
import ExportButton from "@/components/ExportButton";
import RemoteSelect from "@/components/RemoteSelect";
import ListToolbar from "@/components/ListToolbar";
import { useListState } from "@/components/useListState";
import { fetchJson } from "@/components/fetchJson";

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
  // useSearchParams（列表页状态平台 E6-P1）需要 Suspense 边界
  return (
    <Suspense>
      <LedgerInner />
    </Suspense>
  );
}

function LedgerInner() {
  const { message } = App.useApp();
  const [rows, setRows] = useState<LedgerRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  // 列表页状态平台（E6-P1）：筛选/分页进 URL，密度与已保存视图存本地
  const listState = useListState({
    key: "ledger",
    defaults: { skuId: "", warehouseId: "", from: "", to: "" },
    defaultPageSize: 20,
  });
  const { filters, page, pageSize } = listState;
  const skuId = filters.skuId ? Number(filters.skuId) : undefined;
  const warehouseId = filters.warehouseId ? Number(filters.warehouseId) : undefined;
  const from = filters.from || undefined;
  const to = filters.to || undefined;

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
      <ListToolbar
        state={listState}
        primaryActions={
          <ExportButton
            href={`/api/export/ledger?${new URLSearchParams({
              ...(skuId != null ? { skuId: String(skuId) } : {}),
              ...(warehouseId != null ? { warehouseId: String(warehouseId) } : {}),
              ...(from ? { from } : {}),
              ...(to ? { to } : {}),
            }).toString()}`}
          />
        }
        extra={
          <>
            <RemoteSelect
              api="/api/master/sku"
              getLabel={(r) => `${String(r.code)} ${String(r.name)}`}
              allowClear
              placeholder="全部 SKU"
              style={{ width: 260 }}
              value={skuId}
              onChange={(v) => listState.setFilter({ skuId: v == null ? "" : String(v) })}
            />
            <RemoteSelect
              api="/api/master/warehouse"
              getLabel={(r) => `${String(r.code)} ${String(r.name)}`}
              allowClear
              placeholder="全部仓库"
              style={{ width: 220 }}
              value={warehouseId}
              onChange={(v) => listState.setFilter({ warehouseId: v == null ? "" : String(v) })}
            />
            <DatePicker.RangePicker
              allowClear
              value={from || to ? [from ? dayjs(from) : null, to ? dayjs(to) : null] : null}
              onChange={(values) =>
                listState.setFilter({
                  from: values?.[0] ? values[0].format("YYYY-MM-DD") : "",
                  to: values?.[1] ? values[1].format("YYYY-MM-DD") : "",
                })
              }
            />
          </>
        }
      />
      <Table<LedgerRow>
        rowKey="id"
        size={listState.tableSize}
        columns={columns}
        dataSource={rows}
        scroll={{ x: "max-content" }}
        loading={loading}
        pagination={listState.paginationProps({ total: total })}
      />
    </div>
  );
}
