"use client";

import { useEffect, useRef, useState } from "react";
import { Alert, App, Button, Input, Modal, Popconfirm, Space } from "antd";
import { JsonRequestError } from "./fetchJson";
import { postStockDocCommand } from "./stock-doc-command";
import { viewportModalProps } from "./viewport-modal";
import type { StockDocActionHints } from "@/lib/stock-doc-actions";

export interface DocActionsDoc {
  id: number;
  docNo?: string;
  status: string;
  version: number;
  subtype: string;
  reversalOfId: number | null;
  actions?: StockDocActionHints;
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
 * 服务端下发当前身份操作提示；缺失则只读。写端仍重新强制授权。
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
  const [error, setError] = useState<string | null>(null), [mustReload, setMustReload] = useState(false);
  const pending = useRef(false), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const blocked = loading || mustReload;
  const recovery = error ? <Alert type="error" showIcon style={{ maxWidth: "100%" }} message={error}
    action={mustReload ? <Button size="small" onClick={onChanged}>核对原单状态</Button> : undefined} /> : null;

  const post = async (path: string, body: unknown, successText: string) => {
    const permitted = path === "short-close" ? doc.actions?.shortClose
      : doc.actions?.[path as "submit" | "withdraw" | "void" | "approve" | "reverse"];
    if (!permitted || pending.current || mustReload) return false;
    pending.current = true; setLoading(true); setError(null);
    try {
      await postStockDocCommand(apiBase, doc, path, body);
      if (!mounted.current) return false;
      message.success(successText);
      onChanged();
      return true;
    } catch (e) {
      if (mounted.current) {
        setError((e as Error).message);
        if (!(e instanceof JsonRequestError) || e.status !== 400) setMustReload(true);
      }
      return false;
    } finally {
      pending.current = false; if (mounted.current) setLoading(false);
    }
  };

  const reasonModal = (
    <Modal
      {...viewportModalProps}
      title={`${reasonAction?.title ?? "库存操作"} · ${doc.docNo ?? `#${doc.id}`}`}
      open={reasonAction != null}
      okText={reasonAction?.okText}
      okButtonProps={{ danger: true, disabled: blocked }}
      cancelText="取消"
      confirmLoading={loading}
      onCancel={() => { if (!pending.current) setReasonAction(null); }}
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
      {recovery}
      <Input.TextArea
        aria-label="库存操作原因"
        disabled={blocked}
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
      <Space wrap>
        {!reasonAction && recovery}
        {doc.actions?.submit ? <Popconfirm
          title="确认提交审批？"
          okText="提交"
          cancelText="取消"
          onConfirm={() => void post("submit", { version: doc.version }, "已提交审批")}
        >
          <Button type="primary" loading={loading} disabled={blocked}>
            提交
          </Button>
        </Popconfirm> : null}
        {doc.actions?.void ? <Button
          danger
          loading={loading}
          disabled={blocked}
          onClick={() => {
            setReasonText("");
            setReasonAction(REASON_ACTIONS.void);
          }}
        >
          作废
        </Button> : null}
        {reasonModal}
      </Space>
    );
  }

  if (doc.status === "pending") {
    return (
      <Space wrap>
        {!rejectOpen && recovery}
        {doc.actions?.approve ? <Popconfirm
          title="确认审批通过？"
          okText="通过"
          cancelText="取消"
          onConfirm={() =>
            void post("approve", { action: "approve", version: doc.version }, "审批已通过")
          }
        >
          <Button type="primary" loading={loading} disabled={blocked}>
            审批通过
          </Button>
        </Popconfirm> : null}
        {doc.actions?.approve ? <Button danger loading={loading} disabled={blocked} onClick={() => setRejectOpen(true)}>
          驳回
        </Button> : null}
        {doc.actions?.withdraw ? <Popconfirm
          title="撤回到草稿？"
          okText="撤回"
          cancelText="取消"
          onConfirm={() => void post("withdraw", { version: doc.version }, "已撤回到草稿")}
        >
          <Button loading={loading} disabled={blocked}>撤回</Button>
        </Popconfirm> : null}
        <Modal
          {...viewportModalProps}
          title="驳回单据"
          open={rejectOpen}
          okText="确认驳回"
          okButtonProps={{ danger: true, disabled: blocked }}
          cancelText="取消"
          confirmLoading={loading}
          onCancel={() => { if (!pending.current) setRejectOpen(false); }}
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
          {recovery}
          <Input.TextArea
            disabled={blocked}
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

  if ((doc.status === "approved" || doc.status === "in_progress") && doc.actions?.shortClose) {
    return (
      <Space wrap>
        {!reasonAction && recovery}
        <Button
          danger
          loading={loading}
          disabled={blocked}
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

  if (doc.status === "completed" && doc.actions?.reverse && doc.subtype !== "reversal" && !doc.reversalOfId) {
    return (
      <>
        {!reverseOpen && recovery}
        <Button danger loading={loading} disabled={blocked} onClick={() => setReverseOpen(true)}>
          红字冲销
        </Button>
        <Modal
          {...viewportModalProps}
          title="红字冲销"
          open={reverseOpen}
          okText="生成红字单"
          okButtonProps={{ danger: true, disabled: blocked }}
          cancelText="取消"
          confirmLoading={loading}
          onCancel={() => { if (!pending.current) setReverseOpen(false); }}
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
          {recovery}
          <Input.TextArea
            disabled={blocked}
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
