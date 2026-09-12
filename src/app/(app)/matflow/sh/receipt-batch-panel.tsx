"use client";

import { useEffect, useRef, useState } from "react";
import { Alert, Button, Popconfirm, Space, Typography } from "antd";
import { postJson } from "@/components/fetchJson";
import { formatAsOf } from "@/components/format";
import type { ReceiptBatchReview } from "@/server/modules/matflow/receipt-batch-status";

export type ReceiptBatchView = Omit<ReceiptBatchReview, "requestedAt" | "checkedAt"> & {
  requestedAt: string; checkedAt: string | null;
};

/** Parent keys this panel by receipt identity; POST is never aborted or automatically replayed. */
export default function ReceiptBatchPanel({ receiptId, review, canCheck, onChecked }: {
  receiptId: number; review: ReceiptBatchView | null; canCheck: boolean; onChecked: () => void;
}) {
  const busy = useRef(false);
  const mounted = useRef(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  async function check() {
    if (!canCheck || review?.state !== "pending" || busy.current) return;
    busy.current = true;
    setLoading(true);
    setError(null);
    try {
      await postJson(`/api/matflow/sh/${receiptId}/batch-check`, {});
      if (mounted.current) onChecked();
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : "未能确认建批核对结果，请先刷新收货详情。");
    } finally {
      busy.current = false;
      if (mounted.current) setLoading(false);
    }
  }
  if (!review) return <Typography.Text type="secondary">未记录自动建批请求（可能未启用或属于历史入库）；不能据此判断已建批。</Typography.Text>;
  const pending = review.state === "pending";
  return <Alert showIcon type={pending ? "warning" : "info"}
    message={pending ? "入库已完成 · 采购建批待核对" : review.state === "created" ? "建批核对已生成草稿 · 待人工提交审批" : "建批已核对 · 本次未生成草稿"}
    description={<Space direction="vertical" size={8} style={{ width: "100%" }}>
      <Typography.Text>{review.woDocNo} · 请求于 {formatAsOf(review.requestedAt)}{review.checkedAt ? ` · 核对于 ${formatAsOf(review.checkedAt)}` : ""}</Typography.Text>
      {pending ? <Typography.Text>库存已经入账，请勿重复入库。由PMC按当前工单与到料情况核对，符合条件时只生成加工单草稿。</Typography.Text>
        : review.reason ? <Typography.Text>{review.reason}；这是上次核对结果，不代表当前问题已解决。</Typography.Text> : null}
      <Space wrap size={[8, 8]}>
        {pending && canCheck ? <Popconfirm title="核对当前条件并生成合格草稿？" description="不会重复入库；不满足条件将保存原因，不自动审批。" okText="核对并生成" cancelText="取消" onConfirm={check}>
          <Button loading={loading}>核对并生成合格草稿</Button>
        </Popconfirm> : pending ? <Typography.Text type="secondary">请PMC或管理员处理建批核对。</Typography.Text> : null}
        {review.jgId && review.docNo ? <a href={`/outsource/jg?docId=${review.jgId}`}>查看 {review.docNo}</a> : null}
        {canCheck ? <a href={`/outsource/auto-chain?q=${encodeURIComponent(review.woDocNo)}`}>查看工单当前预演</a> : null}
      </Space>
      {error ? <Alert type="error" showIcon message={error} description="入库结果不受影响。请先刷新核对结果；同一收货单重试会返回已保存结果，不重复建批。" /> : null}
    </Space>} />;
}
