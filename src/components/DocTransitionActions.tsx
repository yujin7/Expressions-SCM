"use client";

/**
 * 手工收口按钮：完成 / 短关（`/api/outsource/{po,wo}/[id]/transition`）。
 *
 * 事故背景：`transitionPO` / `transitionWO` 的服务、路由、测试（tests/outsource/short-close-supply.test.ts）
 * 早就齐了，唯独**没有任何按钮**。于是供应商少送尾数的 PO 永久停在「执行中」、
 * 委外工单永远停在「已审批」——在办量只增不减，OTIF 的 pending 桶被这些永不收口的单据撑大。
 *
 * 角色门禁与路由一致：complete / short_close 由服务层 `requireAnyRole(user, "pmc", "ops")` 把关
 * （admin 由 hasAnyRole 兜底）。这里只决定按钮显不显示——服务端仍是唯一权威，
 * 藏起来的按钮不是权限。短关必须填原因（schema `transitionDocSchema` 与状态机双重强制），
 * 所以短关走带必填输入的 Modal，完成走 Popconfirm。
 */
import { useState } from "react";
import { App, Button, Input, Modal, Popconfirm, Space, Typography } from "antd";
import { postJson } from "@/components/fetchJson";
import { hasAnyRole, useMe } from "@/components/useMe";

/** 状态机（docflow/state.ts）：approved -[short_close]→ closed；in_progress -[complete|short_close]→ … */
export function canComplete(status: string): boolean {
  return status === "in_progress";
}
export function canShortClose(status: string): boolean {
  return status === "approved" || status === "in_progress";
}

export default function DocTransitionActions({
  docType,
  doc,
  onChanged,
  labels,
}: {
  /** 接口前缀：/api/outsource/{docType}/[id]/transition */
  docType: "po" | "wo";
  doc: { id: number; status: string; version: number };
  onChanged: () => void;
  /** 单据口径的中文说明（不同单据「完成/短关」意味着什么不一样，必须写明白） */
  labels: { completeHint: string; shortCloseHint: string };
}) {
  const { message } = App.useApp();
  const me = useMe();
  // 与 transitionPO / transitionWO 的 requireAnyRole(user, "pmc", "ops") 同口径
  const canAct = hasAnyRole(me, "pmc", "ops");
  const [loading, setLoading] = useState(false);
  const [shortCloseOpen, setShortCloseOpen] = useState(false);
  const [reason, setReason] = useState("");

  if (!canAct) return null;
  const showComplete = canComplete(doc.status);
  const showShortClose = canShortClose(doc.status);
  if (!showComplete && !showShortClose) return null;

  const post = async (action: "complete" | "short_close", body: Record<string, unknown>) => {
    setLoading(true);
    try {
      const r = await postJson<{ status: string; idempotent: boolean }>(
        `/api/outsource/${docType}/${doc.id}/transition`,
        { action, version: doc.version, ...body },
      );
      message.success(r.idempotent ? "该单据已处于目标状态" : action === "complete" ? "已标记完成" : "已短关");
      onChanged();
      return true;
    } catch (e) {
      message.error((e as Error).message);
      return false;
    } finally {
      setLoading(false);
    }
  };

  return (
    <Space>
      {showComplete ? (
        <Popconfirm
          title="确认标记完成？"
          description={labels.completeHint}
          okText="完成"
          cancelText="取消"
          onConfirm={() => void post("complete", {})}
        >
          <Button loading={loading}>完成</Button>
        </Popconfirm>
      ) : null}
      {showShortClose ? (
        <Button danger loading={loading} onClick={() => { setReason(""); setShortCloseOpen(true); }}>
          短关
        </Button>
      ) : null}
      <Modal
        title="短关单据"
        open={shortCloseOpen}
        okText="确认短关"
        okButtonProps={{ danger: true, disabled: reason.trim().length === 0 }}
        cancelText="取消"
        confirmLoading={loading}
        onCancel={() => setShortCloseOpen(false)}
        onOk={() =>
          void post("short_close", { reason: reason.trim() }).then((ok) => {
            if (ok) { setShortCloseOpen(false); setReason(""); }
          })
        }
      >
        <Typography.Paragraph type="secondary">{labels.shortCloseHint}</Typography.Paragraph>
        <Input.TextArea
          rows={3}
          maxLength={500}
          placeholder="短关原因（必填，会写入单据的 closed_reason 与审计日志）"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </Modal>
    </Space>
  );
}
