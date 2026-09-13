"use client";

import { Alert, Modal, Space, Table, Tag, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import LoadErrorAlert from "@/components/LoadErrorAlert";
import { compareDecimalValues } from "@/lib/decimal-sort";
import type { FefoPreviewGroup } from "@/components/useFefoPreview";

interface AllocationRow {
  key: string;
  sku: string;
  source: "batch" | "explicit" | "legacy" | "uncovered";
  batchNo: string;
  expiryDate: string | null;
  qty: string;
  baseUom: string;
}

export function FefoPreviewModal({
  open,
  loading,
  groups,
  error,
  onRetry,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  loading: boolean;
  groups: FefoPreviewGroup[] | null;
  error: string | null;
  onRetry: () => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const current = !loading && !error ? groups ?? [] : [];
  const rows: AllocationRow[] = current.flatMap((group) => {
    const batchRows = group.allocations.map((allocation) => ({
      key: `${group.skuId}:batch:${allocation.batchId}`,
      sku: `${group.skuCode} · ${group.skuName}`,
      source: group.mode === "explicit" ? "explicit" as const : "batch" as const,
      batchNo: allocation.batchNo,
      expiryDate: allocation.expiryDate,
      qty: allocation.qty,
      baseUom: group.baseUom,
    }));
    const fallback = compareDecimalValues(group.fallbackQty, "0") > 0
      ? [{
          key: `${group.skuId}:legacy`,
          sku: `${group.skuCode} · ${group.skuName}`,
          source: "legacy" as const,
          batchNo: "历史无批次",
          expiryDate: null,
          qty: group.fallbackQty,
          baseUom: group.baseUom,
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
          baseUom: group.baseUom,
        }]
      : [];
    return [...batchRows, ...fallback, ...uncovered];
  });
  const hasShortage = current.some((group) => compareDecimalValues(group.shortBy, "0") > 0);
  const hasLegacy = current.some((group) => compareDecimalValues(group.fallbackQty, "0") > 0 || !group.batchCoverage);
  const excludedLots = current.reduce((sum, group) => sum + group.expiredLots, 0);

  const columns: ColumnsType<AllocationRow> = [
    { title: "SKU", dataIndex: "sku", width: 240 },
    {
      title: "分配来源",
      dataIndex: "source",
      width: 110,
      render: (source: AllocationRow["source"]) =>
        source === "batch"
          ? <Tag color="blue">FEFO 批次</Tag>
          : source === "explicit" ? <Tag color="geekblue">原指定批次</Tag>
          : <Tag color="gold">{source === "legacy" ? "历史回落" : "原口径"}</Tag>,
    },
    { title: "批次", dataIndex: "batchNo", width: 150 },
    { title: "有效期", dataIndex: "expiryDate", width: 120, render: (value: string | null) => value ?? "—" },
    { title: "本次分配", dataIndex: "qty", align: "right", width: 120, render: (value: string, row) => `${value} ${row.baseUom}` },
  ];

  return (
    <Modal
      title="FEFO 批次预分配"
      open={open}
      width="min(860px, calc(100vw - 24px))"
      okText="确认按此规则建单"
      cancelText="返回修改"
      // AntD Modal.confirmLoading also blocks cancel; this is a cancellable GET, not a write.
      okButtonProps={{ loading, disabled: loading || !!error || current.length === 0 || hasShortage }}
      onOk={() => { if (!loading && !error && current.length > 0 && !hasShortage) onConfirm(); }}
      onCancel={onCancel}
      destroyOnHidden
    >
      <Space direction="vertical" size={12} style={{ width: "100%" }}>
        <LoadErrorAlert error={error} onRetry={onRetry} subject="批次预览" retrying={loading} />
        <Typography.Text type="secondary">
          自动行按最早有效期优先分配，原请求指定批次保持指定批次；本次仅核对，不预留库存。保存时在同一事务内重新校验可用量，实际批次写入草稿明细并在审批时再次受非负库存约束。
        </Typography.Text>
        {current.some(group => group.riskDisposalId != null && group.mode === "explicit") && <Alert type="warning" showIcon message="仅限报废评审用途" description="原指定批次已核对报废评审来源；过期批次仅用于报废，不可转作普通出库。保存仍会复核评审状态。" />}
        {hasShortage ? (
          <Alert
            type="error"
            showIcon
            message="可发库存不足，不能确认"
            description={current
              .filter((group) => compareDecimalValues(group.shortBy, "0") > 0)
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
          locale={{ emptyText: loading ? "正在读取本次批次依据…" : error ? "读取未完成，未沿用旧预览" : "尚未取得可确认的批次依据" }}
          scroll={{ x: 740 }}
        />
      </Space>
    </Modal>
  );
}
