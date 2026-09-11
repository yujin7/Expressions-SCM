"use client";

/**
 * 补货建议「不采纳」弹窗（闭环审计 #12）：计划员看过建议、判断不需要下单时留痕。
 * POST /api/replenish/decline { skuId, reason, reasonCode } —— 只写审计（decline_suggestion），不改建议、不开单据；
 * 同人同 SKU 同业务日重复提交服务端只留第一条（duplicate=true）。
 * 只值导入零依赖常量模块 `@/lib/replenish-decline-reasons`（客户端/服务端边界）。
 */
import { useEffect, useState } from "react";
import { Alert, App, Input, Modal, Select, Space, Typography } from "antd";
import { postJson } from "@/components/fetchJson";
import { DECLINE_REASON_CODES, DECLINE_REASON_LABELS, type DeclineReasonCode } from "@/lib/replenish-decline-reasons";

export interface DeclineTarget {
  skuId: number;
  code: string;
  name: string;
  baseUom: string;
  suggestQty: string | null;
  heldQty: string | null;
}

export interface DeclineResult {
  skuId: number;
  skuCode: string;
  businessDate: string;
  reasonCode: DeclineReasonCode;
  duplicate: boolean;
}

const REASON_OPTIONS = DECLINE_REASON_CODES.map((code) => ({ value: code, label: DECLINE_REASON_LABELS[code].label }));

export default function DeclineSuggestionModal({ target, onCancel, onDeclined }: { target: DeclineTarget | null; onCancel: () => void; onDeclined: (r: DeclineResult) => void }) {
  const { message } = App.useApp();
  const [reasonCode, setReasonCode] = useState<DeclineReasonCode>("reference_stock_sufficient");
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  useEffect(() => {
    if (target) {
      setReasonCode("reference_stock_sufficient");
      setReason("");
    }
  }, [target]);

  const submit = async () => {
    if (!target) return;
    if (!reason.trim()) {
      message.warning("必须填写放弃原因（进入审计留痕）");
      return;
    }
    setSubmitting(true);
    try {
      const r = await postJson<DeclineResult>("/api/replenish/decline", { skuId: target.skuId, reason: reason.trim(), reasonCode });
      if (r.duplicate) message.info(`${r.skuCode} 今日已复核并放弃过，本次不再重复留痕`);
      else message.success(`${r.skuCode} 已记为「已复核并放弃」（${DECLINE_REASON_LABELS[r.reasonCode]?.label ?? r.reasonCode}）`);
      onDeclined(r);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const qty = target?.suggestQty ?? target?.heldQty ?? null;
  return (
    <Modal
      title="不采纳建议（已复核并放弃）"
      open={target != null}
      onOk={() => void submit()}
      onCancel={onCancel}
      confirmLoading={submitting}
      okText="记录放弃"
      cancelText="取消"
      width="min(520px, 100vw)"
    >
      {target ? (
        <Typography.Paragraph style={{ marginBottom: 12 }}>
          <b>{target.code}</b> {target.name !== target.code ? target.name : ""}
          {qty != null ? <Typography.Text type="secondary">　建议 {Number(qty).toLocaleString("zh-CN")} {target.baseUom}</Typography.Text> : null}
        </Typography.Paragraph>
      ) : null}
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message="只留痕不动数：不改建议量、不开单据；「已复核并放弃」在闭环报表单列，不进采纳率分母。"
      />
      <Space direction="vertical" size={8} style={{ width: "100%" }}>
        <div>
          <Typography.Text strong>原因类别</Typography.Text>
          <Select<DeclineReasonCode>
            aria-label="放弃原因类别"
            value={reasonCode}
            onChange={(v) => setReasonCode(v)}
            options={REASON_OPTIONS}
            style={{ width: "100%", marginTop: 4 }}
          />
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>{DECLINE_REASON_LABELS[reasonCode].hint}</Typography.Text>
        </div>
        <div>
          <Typography.Text strong>放弃原因（必填）</Typography.Text>
          <Input.TextArea
            aria-label="放弃原因"
            rows={3}
            maxLength={500}
            showCount
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="例如：海外仓已有 3,000 件，本月不需补货"
            style={{ marginTop: 4 }}
          />
        </div>
      </Space>
    </Modal>
  );
}
