"use client";

/**
 * 人工关闭告警弹窗（闭环审计 #2）：原因码必选（MANUAL_CLOSE_REASON_CODES）、备注可选（原因为「其他」时必填），
 * POST /api/alerts/[id]/close —— 写路径在服务端回查会话与角色（告警 ownerRole 或 admin），同事务写审计 + alert_events(close)。
 *
 * 可复用挂载点：告警列表 / 库存预警 / 驾驶舱任何有 alertId 的地方传入即可。
 * 本组件只值导入零依赖常量模块 `@/lib/alert-close-reasons`，不 import `@/server` / `@/db`
 * （tests/architecture/client-server-boundary.test.ts）。
 */
import { useLayoutEffect, useRef, useState } from "react";
import { Alert, App, Input, Modal, Select, Space, Typography } from "antd";
import { postJson } from "@/components/fetchJson";
import { ALERT_CLOSE_REASON_LABELS, MANUAL_CLOSE_REASON_CODES, type ManualCloseReasonCode } from "@/lib/alert-close-reasons";

export interface AlertCloseResult {
  id: number;
  resolvedAt: string;
  reasonCode: ManualCloseReasonCode;
}

export interface AlertCloseModalProps {
  open: boolean;
  /** 为 null 时不渲染弹窗主体（调用方可常驻挂载） */
  alertId: number | null;
  /** 只用于弹窗上下文展示（标题 / 摘要），不参与提交 */
  alertTitle?: string | null;
  onCancel: () => void;
  /** 关闭成功后回调（刷新列表 / 行内打标） */
  onClosed?: (result: AlertCloseResult) => void;
  defaultReasonCode?: ManualCloseReasonCode;
}

/** 下拉选项：人工原因码 → 中文标签（auto_hysteresis 保留给引擎，不出现在这里） */
export const MANUAL_CLOSE_REASON_OPTIONS = MANUAL_CLOSE_REASON_CODES.map((code) => ({
  value: code,
  label: ALERT_CLOSE_REASON_LABELS[code].label,
}));

export default function AlertCloseModal({ open, alertId, alertTitle, onCancel, onClosed, defaultReasonCode = "fixed" }: AlertCloseModalProps) {
  const { message } = App.useApp();
  const [reasonCode, setReasonCode] = useState<ManualCloseReasonCode>(defaultReasonCode);
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const sessionVersion = useRef(0);

  // 在提交的界面切换时立即失效旧回调；同一告警关闭后再打开也属于新会话。
  // 不取消已发出的业务写请求：取消网络请求不等于服务端已回滚。
  useLayoutEffect(() => {
    sessionVersion.current += 1;
    submittingRef.current = false;
    setSubmitting(false);
    if (open) {
      setReasonCode(defaultReasonCode);
      setNote("");
    }
    return () => { sessionVersion.current += 1; };
  }, [open, alertId, defaultReasonCode]);

  const noteRequired = reasonCode === "manual";
  const submit = async () => {
    if (!open || alertId == null || submittingRef.current) return;
    if (noteRequired && !note.trim()) {
      message.warning("选择「其他（人工）」时请在备注说明原因");
      return;
    }
    const submittedSession = sessionVersion.current;
    submittingRef.current = true;
    setSubmitting(true);
    try {
      const r = await postJson<AlertCloseResult>(`/api/alerts/${alertId}/close`, {
        reasonCode,
        note: note.trim() || undefined,
      });
      if (sessionVersion.current === submittedSession) {
        message.success(`告警 #${r.id} 已关闭（${ALERT_CLOSE_REASON_LABELS[r.reasonCode]?.label ?? r.reasonCode}）`);
        onClosed?.(r);
      }
    } catch (e) {
      if (sessionVersion.current === submittedSession) message.error((e as Error).message);
    } finally {
      if (sessionVersion.current === submittedSession) {
        submittingRef.current = false;
        setSubmitting(false);
      }
    }
  };

  return (
    <Modal
      title={alertId == null ? "关闭告警" : `关闭告警 #${alertId}`}
      open={open && alertId != null}
      onOk={() => void submit()}
      onCancel={() => { if (!submittingRef.current) onCancel(); }}
      confirmLoading={submitting}
      closable={!submitting}
      maskClosable={!submitting}
      keyboard={!submitting}
      okText="关闭告警"
      okButtonProps={{ danger: true, disabled: submitting }}
      cancelText="取消"
      cancelButtonProps={{ disabled: submitting }}
      width="min(520px, 100vw)"
    >
      {alertTitle ? (
        <Typography.Paragraph ellipsis={{ rows: 2 }} style={{ marginBottom: 12 }}>
          {alertTitle}
        </Typography.Paragraph>
      ) : null}
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message="关闭只改变当前状态并写入台账；不删除告警，引擎下一轮若条件仍成立会另开新告警。"
      />
      <Space direction="vertical" size={8} style={{ width: "100%" }}>
        <div>
          <Typography.Text strong>关闭原因</Typography.Text>
          <Select<ManualCloseReasonCode>
            aria-label="关闭原因"
            disabled={submitting}
            value={reasonCode}
            onChange={(v) => setReasonCode(v)}
            options={MANUAL_CLOSE_REASON_OPTIONS}
            style={{ width: "100%", marginTop: 4 }}
          />
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>{ALERT_CLOSE_REASON_LABELS[reasonCode].hint}</Typography.Text>
        </div>
        <div>
          <Typography.Text strong>备注{noteRequired ? "（必填）" : "（可选）"}</Typography.Text>
          <Input.TextArea
            aria-label="关闭备注"
            disabled={submitting}
            rows={3}
            maxLength={500}
            showCount
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={noteRequired ? "请说明为何关闭" : "补充说明（进入台账，供误报复盘）"}
            style={{ marginTop: 4 }}
          />
        </div>
      </Space>
    </Modal>
  );
}
