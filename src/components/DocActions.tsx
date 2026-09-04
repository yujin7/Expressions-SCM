"use client";

import { useState } from "react";
import { App, Button, Input, Modal, Popconfirm, Space } from "antd";
import { postJson } from "./fetchJson";

export interface DocActionsDoc {
  id: number;
  status: string;
  version: number;
  subtype: string;
  reversalOfId: number | null;
}

/** 需要填原因的动作：作废草稿 / 短关（原因进 closed_reason，同事务写审计） */
type ReasonAction = { path: string; title: string; okText: string; placeholder: string; success: string };

const REASON_ACTIONS: Record<"void" | "shortClose", ReasonAction> = {
  void: {
    path: "void",
    title: "作废草稿",
    okText: "确认作废",
    placeholder: "作废原因（必填）——草稿也留痕，作废后不可恢复",
    success: "草稿已作废",
  },
  shortClose: {
    path: "short-close",
    title: "短关单据",
    okText: "确认短关",
    placeholder: "短关原因（必填）——只关闭未执行的剩余部分，已过账数量不受影响",
    success: "单据已短关",
  },
};

export interface DocActionsProps {
  /** 单据类型（当前仅库存单据） */
  docType: "stock-doc";
  doc: DocActionsDoc;
  onChanged: () => void;
  /** 如 /api/inventory/stock-doc */
  apiBase: string;
}

/**
 * 单据操作按钮组：提交 / 撤回 / 作废 / 审批通过 / 驳回 / 短关 / 红字冲销
 * （权限由服务端强制，403 直接提示）。
 */
export default function DocActions({ doc, onChanged, apiBase }: DocActionsProps) {
  const { message } = App.useApp();
  const [loading, setLoading] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectComment, setRejectComment] = useState("");
  const [reverseOpen, setReverseOpen] = useState(false);
  const [reverseReason, setReverseReason] = useState("");
  const [reasonAction, setReasonAction] = useState<ReasonAction | null>(null);
  const [reasonText, setReasonText] = useState("");

  const post = async (path: string, body: unknown, successText: string) => {
    setLoading(true);
    try {
      await postJson(`${apiBase}/${doc.id}/${path}`, body);
      message.success(successText);
      onChanged();
      return true;
    } catch (e) {
      message.error((e as Error).message);
      return false;
    } finally {
      setLoading(false);
    }
  };

  const reasonModal = (
    <Modal
      title={reasonAction?.title}
      open={reasonAction != null}
      okText={reasonAction?.okText}
      okButtonProps={{ danger: true }}
      cancelText="取消"
      confirmLoading={loading}
      onCancel={() => setReasonAction(null)}
      onOk={() => {
        if (!reasonAction) return;
        if (reasonText.trim().length < 2) {
          message.warning("请填写原因");
          return;
        }
        void post(
          reasonAction.path,
          { version: doc.version, reason: reasonText.trim() },
          reasonAction.success,
        ).then((ok) => {
          if (ok) {
            setReasonAction(null);
            setReasonText("");
          }
        });
      }}
    >
      <Input.TextArea
        rows={3}
        maxLength={500}
        placeholder={reasonAction?.placeholder}
        value={reasonText}
        onChange={(e) => setReasonText(e.target.value)}
      />
    </Modal>
  );

  if (doc.status === "draft") {
    return (
      <Space>
        <Popconfirm
          title="确认提交审批？"
          okText="提交"
          cancelText="取消"
          onConfirm={() => void post("submit", { version: doc.version }, "已提交审批")}
        >
          <Button type="primary" loading={loading}>
            提交
          </Button>
        </Popconfirm>
        <Button
          danger
          loading={loading}
          onClick={() => {
            setReasonText("");
            setReasonAction(REASON_ACTIONS.void);
          }}
        >
          作废
        </Button>
        {reasonModal}
      </Space>
    );
  }

  if (doc.status === "pending") {
    return (
      <Space>
        <Popconfirm
          title="确认审批通过？"
          okText="通过"
          cancelText="取消"
          onConfirm={() =>
            void post("approve", { action: "approve", version: doc.version }, "审批已通过")
          }
        >
          <Button type="primary" loading={loading}>
            审批通过
          </Button>
        </Popconfirm>
        <Button danger loading={loading} onClick={() => setRejectOpen(true)}>
          驳回
        </Button>
        <Popconfirm
          title="撤回到草稿？"
          okText="撤回"
          cancelText="取消"
          onConfirm={() => void post("withdraw", { version: doc.version }, "已撤回到草稿")}
        >
          <Button loading={loading}>撤回</Button>
        </Popconfirm>
        <Modal
          title="驳回单据"
          open={rejectOpen}
          okText="确认驳回"
          okButtonProps={{ danger: true }}
          cancelText="取消"
          confirmLoading={loading}
          onCancel={() => setRejectOpen(false)}
          onOk={() =>
            void post(
              "approve",
              { action: "reject", comment: rejectComment.trim() || undefined, version: doc.version },
              "已驳回",
            ).then((ok) => {
              if (ok) {
                setRejectOpen(false);
                setRejectComment("");
              }
            })
          }
        >
          <Input.TextArea
            rows={3}
            maxLength={200}
            placeholder="驳回意见（可选）"
            value={rejectComment}
            onChange={(e) => setRejectComment(e.target.value)}
          />
        </Modal>
      </Space>
    );
  }

  if (doc.status === "approved" || doc.status === "in_progress") {
    return (
      <Space>
        <Button
          danger
          loading={loading}
          onClick={() => {
            setReasonText("");
            setReasonAction(REASON_ACTIONS.shortClose);
          }}
        >
          短关
        </Button>
        {reasonModal}
      </Space>
    );
  }

  if (doc.status === "completed" && doc.subtype !== "reversal" && !doc.reversalOfId) {
    return (
      <>
        <Button danger loading={loading} onClick={() => setReverseOpen(true)}>
          红字冲销
        </Button>
        <Modal
          title="红字冲销"
          open={reverseOpen}
          okText="生成红字单"
          okButtonProps={{ danger: true }}
          cancelText="取消"
          confirmLoading={loading}
          onCancel={() => setReverseOpen(false)}
          onOk={() => {
            if (!reverseReason.trim()) {
              message.warning("请填写冲销原因");
              return;
            }
            void post("reverse", { reason: reverseReason.trim() }, "红字冲销单已生成").then((ok) => {
              if (ok) {
                setReverseOpen(false);
                setReverseReason("");
              }
            });
          }}
        >
          <Input.TextArea
            rows={3}
            maxLength={200}
            placeholder="冲销原因（必填）——纠错一律红字冲销，无反审批"
            value={reverseReason}
            onChange={(e) => setReverseReason(e.target.value)}
          />
        </Modal>
      </>
    );
  }

  return null;
}
