"use client";

import { Alert, Modal, Space, Table, Tag, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";

export interface FefoPreviewGroup {
  skuId: number;
  skuCode: string;
  skuName: string;
  requestedQty: string;
  allocations: { batchId: number; batchNo: string; expiryDate: string | null; qty: string }[];
  fallbackQty: string;
  shortBy: string;
  expiredLots: number;
  batchCoverage: boolean;
  note: string;
}

interface AllocationRow {
  key: string;
  sku: string;
  source: "batch" | "legacy" | "uncovered";
  batchNo: string;
  expiryDate: string | null;
  qty: string;
}

export function FefoPreviewModal({
  open,
  loading,
  groups,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  loading: boolean;
  groups: FefoPreviewGroup[];
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const rows: AllocationRow[] = groups.flatMap((group) => {
    const batchRows = group.allocations.map((allocation) => ({
      key: `${group.skuId}:batch:${allocation.batchId}`,
      sku: `${group.skuCode} · ${group.skuName}`,
      source: "batch" as const,
      batchNo: allocation.batchNo,
      expiryDate: allocation.expiryDate,
      qty: allocation.qty,
    }));
    const fallback = Number(group.fallbackQty) > 0
      ? [{
          key: `${group.skuId}:legacy`,
          sku: `${group.skuCode} · ${group.skuName}`,
          source: "legacy" as const,
          batchNo: "历史无批次",
          expiryDate: null,
          qty: group.fallbackQty,
        }]
      : [];
    const uncovered = !group.batchCoverage
      ? [{
          key: `${group.skuId}:uncovered`,
          sku: `${group.skuCode} · ${group.skuName}`,
          source: "uncovered" as const,
          batchNo: "尚未批次化",
          expiryDate: null,
          qty: group.requestedQty,
        }]
      : [];
    return [...batchRows, ...fallback, ...uncovered];
  });
  const hasShortage = groups.some((group) => Number(group.shortBy) > 0);
  const hasLegacy = groups.some((group) => Number(group.fallbackQty) > 0 || !group.batchCoverage);
  const excludedLots = groups.reduce((sum, group) => sum + group.expiredLots, 0);

  const columns: ColumnsType<AllocationRow> = [
    { title: "SKU", dataIndex: "sku", width: 240 },
    {
      title: "分配来源",
      dataIndex: "source",
      width: 110,
      render: (source: AllocationRow["source"]) =>
        source === "batch"
          ? <Tag color="blue">FEFO 批次</Tag>
          : <Tag color="gold">{source === "legacy" ? "历史回落" : "原口径"}</Tag>,
    },
    { title: "批次", dataIndex: "batchNo", width: 150 },
    { title: "有效期", dataIndex: "expiryDate", width: 120, render: (value: string | null) => value ?? "—" },
    { title: "本次分配", dataIndex: "qty", align: "right", width: 120 },
  ];

  return (
    <Modal
      title="FEFO 批次预分配"
      open={open}
      width="min(860px, calc(100vw - 24px))"
      okText="确认按此规则建单"
      cancelText="返回修改"
      okButtonProps={{ disabled: loading || hasShortage }}
      confirmLoading={loading}
      onOk={onConfirm}
      onCancel={onCancel}
      destroyOnHidden
    >
      <Space direction="vertical" size={12} style={{ width: "100%" }}>
        <Typography.Text type="secondary">
          系统按最早有效期优先分配；保存时会在同一事务内重新校验可用量，实际批次写入草稿明细并在审批时再次受非负库存约束。
        </Typography.Text>
        {hasShortage ? (
          <Alert
            type="error"
            showIcon
            message="可发库存不足，不能确认"
            description={groups
              .filter((group) => Number(group.shortBy) > 0)
              .map((group) => `${group.skuCode} 缺 ${group.shortBy}`)
              .join("；")}
          />
        ) : null}
        {hasLegacy ? (
          <Alert
            type="warning"
            showIcon
            message="部分数量无法进入批次追溯"
            description="历史无批次库存会按迁移期回落路径出库；尚未批次化的 SKU 继续按原口径处理。"
          />
        ) : null}
        {excludedLots > 0 ? (
          <Alert type="info" showIcon message={`已排除 ${excludedLots} 个过期正库存批次`} />
        ) : null}
        <Table<AllocationRow>
          rowKey="key"
          size="small"
          columns={columns}
          dataSource={rows}
          pagination={false}
          loading={loading}
          scroll={{ x: 740 }}
        />
      </Space>
    </Modal>
  );
}
