"use client";

import { useLatestRead } from "@/components/useLatestRead";

import { Suspense, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { App, DatePicker, Table, Tag, Tooltip, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import dayjs from "dayjs";
import ExportButton from "@/components/ExportButton";
import RemoteSelect from "@/components/RemoteSelect";
import ListToolbar from "@/components/ListToolbar";
import { useListState } from "@/components/useListState";
import { fetchJson } from "@/components/fetchJson";
import { formatYuan } from "@/components/format";

import CaliberNote from "@/components/CaliberNote";
import { LEDGER_SOURCE_LABELS } from "@/components/labels";

/** 服务端 LEDGER_MONEY_CALIBRE 的形状（文案权威在服务端，这里只是类型） */
interface MoneyCalibre {
  key: string;
  costSource: string;
  amountBasis: string;
  balanceBasis: string;
  windowNote: string;
  costAsOfNote: string;
}

interface LedgerRow {
  id: number;
  occurredAt: string;
  skuCode: string;
  skuName: string;
  warehouseName: string;
  batchId: number | null;
  batchNo: string | null;
  qtyDelta: string;
  balanceQty: string;
  sourceDocType: string;
  sourceDocId: number;
  sourceDocNo: string | null;
  sourceHref: string | null;
  action: string;
  /** 非价格可见角色：服务端 maskSensitive 已删键 → undefined */
  amount?: string | null;
  balanceAmount?: string | null;
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
  const [canSeeValue, setCanSeeValue] = useState(false);
  const [moneyCalibre, setMoneyCalibre] = useState<MoneyCalibre | null>(null);
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

  const beginLoadRead = useLatestRead();
  const load = useCallback(async () => {
    const readRequest = beginLoadRead();
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
      if (skuId != null) params.set("skuId", String(skuId));
      if (warehouseId != null) params.set("warehouseId", String(warehouseId));
      if (from) params.set("from", from);
      if (to) params.set("to", to);
      const res = await fetchJson<{ rows: LedgerRow[]; total: number; canSeeValue?: boolean; moneyCalibre?: MoneyCalibre | null }>(
        `/api/inventory/ledger?${params.toString()}`, { signal: readRequest.signal });
      if (!readRequest.isCurrent()) return;
      setRows(res.rows);
      setTotal(res.total);
      setCanSeeValue(Boolean(res.canSeeValue));
      setMoneyCalibre(res.moneyCalibre ?? null);
    } catch (e) {
      if (!readRequest.isCurrent()) return;
      message.error((e as Error).message);
    } finally {
      if (readRequest.isCurrent()) { setLoading(false); }
    }
  }, [beginLoadRead, skuId, warehouseId, from, to, page, pageSize, message]);

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
      title: "批次",
      dataIndex: "batchNo",
      width: 130,
      render: (v: string | null, r) =>
        v ? <Tag color="blue">{v}</Tag>
          : r.batchId != null ? <Tag>#{r.batchId}</Tag>
            : <Typography.Text type="secondary">无批次</Typography.Text>,
    },
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
      title: "累计余额",
      dataIndex: "balanceQty",
      width: 140,
      align: "right",
      render: (v: string) => (
        <Tooltip title="该 SKU×仓库在当前筛选窗口内、截至本行的累计余额（服务端按时间顺序计算，翻页仍正确）">
          <span>{v}</span>
        </Tooltip>
      ),
    },
    ...(canSeeValue
      ? ([
          {
            title: "金额",
            dataIndex: "amount",
            width: 130,
            align: "right",
            render: (v: string | null | undefined) =>
              v == null ? <Typography.Text type="secondary">无成本</Typography.Text> : formatYuan(v),
          },
          {
            /* 这一列可以是负数、成本是「今天的」、余额只在窗口内累计——三件事都必须挂在列上，
               否则它会被读成「当时的库存价值」。 */
            title: (
              <Tooltip title={moneyCalibre ? `${moneyCalibre.balanceBasis}。${moneyCalibre.windowNote} ${moneyCalibre.costAsOfNote}` : ""}>
                <span>累计余额金额 ⓘ</span>
              </Tooltip>
            ),
            dataIndex: "balanceAmount",
            width: 160,
            align: "right",
            render: (v: string | null | undefined) =>
              v == null
                ? <Typography.Text type="secondary">无成本</Typography.Text>
                : <Typography.Text type={Number(v) < 0 ? "danger" : undefined}>{formatYuan(v)}</Typography.Text>,
          },
        ] as ColumnsType<LedgerRow>)
      : []),
    {
      title: "来源",
      dataIndex: "sourceDocType",
      width: 210,
      render: (v: string, r) => {
        const label = LEDGER_SOURCE_LABELS[v] ?? v;
        const text = r.sourceDocNo ?? `#${r.sourceDocId}`;
        return r.sourceHref ? (
          <Link href={r.sourceHref}>{label} {text}</Link>
        ) : (
          <span>{label} {text}</span>
        );
      },
    },
    { title: "动作", dataIndex: "action", width: 120 },
  ];

  return (
    <div>
      <Typography.Title level={4} style={{ marginTop: 0 }}>
        库存流水
      </Typography.Title>
      <CaliberNote
        summary={<>仅追加事实表 stock_ledger；时间窗按**上海业务日**含首尾（选到某天即包含当天全天）。{moneyCalibre ? <>　金额口径 {moneyCalibre.key}。</> : null}</>}
        detail={
          <div>
            <p>累计余额 = 该 (SKU × 仓库) 在**当前筛选窗口内**、截至本行的累计（服务端窗口函数计算，翻页仍正确）。</p>
            {/* 金额口径文案唯一权威在服务端（inventory/queries.ts 的 LEDGER_MONEY_CALIBRE） */}
            {moneyCalibre ? (
              <>
                <p><b>金额口径（{moneyCalibre.key}）</b></p>
                <p>· {moneyCalibre.costSource}</p>
                <p>· {moneyCalibre.amountBasis}</p>
                <p>· {moneyCalibre.balanceBasis}</p>
                <p>· {moneyCalibre.windowNote}</p>
                <p>· {moneyCalibre.costAsOfNote}</p>
              </>
            ) : null}
          </div>
        }
      />
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
