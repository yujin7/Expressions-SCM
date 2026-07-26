"use client";

import SearchInput from "@/components/SearchInput";

/** E3-04 仓间调拨建议：逐仓出库流水代理逐仓需求，盈余仓 → 缺口仓贪心分配（只读，不自动开单） */
import { useCallback, useEffect, useState } from "react";
import { Alert, App, Space, Statistic, Table, Tag, Tooltip, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { fetchJson } from "@/components/fetchJson";
import SkuHoverCard from "@/components/SkuHoverCard";
import ListToolbar from "@/components/ListToolbar";
import { useListState } from "@/components/useListState";

interface TransferSuggestRow {
  skuId: number;
  code: string;
  name: string;
  baseUom: string;
  fromWarehouse: string;
  fromWarehouseId: number;
  toWarehouse: string;
  toWarehouseId: number;
  qty: number;
  fromCoverBefore: number | null;
  toCoverBefore: number;
  toCoverAfter: number;
  reason: string;
}

interface TransferSuggestData {
  rows: TransferSuggestRow[];
  total: number;
  summary: {
    skuCount: number;
    lineCount: number;
    totalQty: number;
    horizonDays: number;
    excludedSnapshotWarehouses: string[];
  };
}

const nz = (v: number): string => v.toLocaleString("zh-CN", { maximumFractionDigits: 2 });

export default function TransferSuggestClient() {
  const { message } = App.useApp();
  const [data, setData] = useState<TransferSuggestData | null>(null);
  const [loading, setLoading] = useState(false);
  // 列表页状态平台（E6-P1）：筛选/分页进 URL，密度与已保存视图存本地
  const listState = useListState({ key: "transfer-suggest", defaults: { q: "" }, defaultPageSize: 50 });
  const { filters, page, pageSize } = listState;
  const q = filters.q;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ q, page: String(page), pageSize: String(pageSize) });
      setData(await fetchJson<TransferSuggestData>(`/api/report/transfer-suggest?${params.toString()}`));
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [q, page, pageSize, message]);
  useEffect(() => { void load(); }, [load]);

  const columns: ColumnsType<TransferSuggestRow> = [
    {
      title: "SKU 编码",
      dataIndex: "code",
      width: 155,
      fixed: "left",
      render: (v: string) => <SkuHoverCard code={v} />,
    },
    { title: "名称", dataIndex: "name", ellipsis: true, width: 220 },
    { title: "调出仓", dataIndex: "fromWarehouse", width: 130 },
    { title: "调入仓", dataIndex: "toWarehouse", width: 130 },
    {
      title: "建议调拨量",
      dataIndex: "qty",
      width: 130,
      align: "right",
      render: (v: number, r) => (
        <Tag color="orange" style={{ marginInlineEnd: 0, fontWeight: 600 }}>{nz(v)} {r.baseUom}</Tag>
      ),
    },
    {
      title: "调出仓可销(前)",
      dataIndex: "fromCoverBefore",
      width: 125,
      align: "right",
      render: (v: number | null) =>
        v == null ? <Typography.Text type="secondary">无出库·呆滞</Typography.Text> : `${nz(v)} 天`,
    },
    {
      title: "调入仓可销(前→后)",
      dataIndex: "toCoverBefore",
      width: 155,
      align: "right",
      render: (v: number, r) => (
        <span>
          <Typography.Text type="danger" strong>{nz(v)}</Typography.Text>
          {" → "}
          <Typography.Text type="success" strong>{nz(r.toCoverAfter)}</Typography.Text>
          {" 天"}
        </span>
      ),
    },
    {
      title: "理由",
      dataIndex: "reason",
      ellipsis: true,
      render: (v: string) => (
        <Tooltip title={v}>
          <span>{v}</span>
        </Tooltip>
      ),
    },
  ];

  return (
    <div>
      <Typography.Title level={4} style={{ marginTop: 0 }}>调拨建议（先挪后买）</Typography.Title>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message="全网总量看着没问题时，货可能压在一个仓、另一个仓已断货。本页把视角下沉到逐仓：先挪自己的货，再花钱买新的。"
        description={
          data ? (
            <Typography.Text type="secondary">
              <b>逐仓需求为代理口径</b>：系统暂无逐仓需求信号（销量只到渠道维度，渠道↔仓库映射尚未建立），
              故以近 {data.summary.horizonDays} 天该仓的<b>出库流水</b>代理其真实需求（含调拨出库/盘亏等非纯销售出库，属发货强度而非销量）；
              映射建立后可更精确。
              盈余仓 = 可销天数超目标覆盖 2 倍，或无出库但有库存；缺口仓 = 可销天数低于告警线且有出库历史；调拨量已为调出仓保留告警线天数的自留缓冲。
              <br />
              <b>仅记账仓</b>参与建议：快照仓（保税/E/云）无实时账、无库存流水，既算不出该仓日均也无法承接实物调拨
              {data.summary.excludedSnapshotWarehouses.length > 0
                ? `（已排除：${data.summary.excludedSnapshotWarehouses.join("、")}）`
                : ""}
              ；委外仓（加工厂垫料）与在途虚拟仓非自有可调配库位，一并排除。
              <br />
              <b>只读建议，不自动开单</b>：采纳后请按 DB 调拨单正常流程开单审批过账。
            </Typography.Text>
          ) : null
        }
      />
      <Space size={40} style={{ marginBottom: 12 }} wrap>
        <Statistic title="涉及 SKU 数" value={data?.summary.skuCount ?? 0} />
        <Statistic title="建议条数" value={data?.summary.lineCount ?? 0} />
        <Statistic title="建议总量（基础单位）" value={data?.summary.totalQty ?? 0} />
      </Space>
      <ListToolbar
        state={listState}
        extra={
          <SearchInput
            key={q}
            allowClear
            defaultValue={q}
            placeholder="搜索 SKU 编码/名称"
            style={{ width: 260 }}
            onSearch={(v) => listState.setFilter({ q: v.trim() })}
          />
        }
      />
      <Table<TransferSuggestRow>
        rowKey={(r) => `${r.skuId}-${r.fromWarehouseId}-${r.toWarehouseId}`}
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
