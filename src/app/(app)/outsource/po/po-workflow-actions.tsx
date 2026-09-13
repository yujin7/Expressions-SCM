"use client";

import { useEffect, useRef, useState } from "react";
import { Alert, App, Button, Input, Modal, Space, Typography } from "antd";
import type { PoTaskActions } from "@/server/modules/outsource/po-task-actions";
import { fetchJson, JsonRequestError } from "@/components/fetchJson";
import { readClosingSnapshot } from "@/components/doc-transition-recovery";

type Action = "submit" | "approve" | "reject" | "withdraw" | "confirm" | "confirmToken";
type Doc = { id: number; docNo: string; version: number; status: string; taskActions: PoTaskActions | null };
const labels: Record<Action, string> = { submit: "提交审批", approve: "审批通过", reject: "驳回", withdraw: "撤回", confirm: "确认（代录）", confirmToken: "生成供应商确认链接" };
const hints: Record<Action, string> = {
  submit: "提交时进行采购价格比对；价格异动会生成待审改价申请，采购单留在草稿，不要反复提交。",
  approve: "核对物料、数量、价格及履约条件后批准；批准不产生收货或库存流水。",
  reject: "驳回后回到草稿，由制单人核对更正；本操作不修改已发生的库存事实。",
  withdraw: "撤回后回到草稿，不占审批轮次。请先确认不再需要审批人处理当前提交。",
  confirm: "仅记录内部代录备注并进入执行中，不回填逐行承诺交期，也不表示供应商已实际提交确认。",
  confirmToken: "生成后原确认链接立即失效。新链接30天有效、仅可使用一次；请只发送给本采购单对应供应商。若上次生成结果不明，先核对后再决定是否重新生成。",
};

/** Keyed by exact document/version in the caller. A failed action permits reads, never automatic resubmission. */
export default function PoWorkflowActions({ doc, onChanged }: { doc: Doc; onChanged: () => void }) {
  const { message } = App.useApp();
  const [action, setAction] = useState<Action | null>(null), [note, setNote] = useState("");
  const [loading, setLoading] = useState(false), [error, setError] = useState<string | null>(null);
  const [priceReview, setPriceReview] = useState(false), [link, setLink] = useState<string | null>(null);
  const busy = useRef(false), failed = useRef(false), alive = useRef(true), latest = useRef(doc);
  const opened = useRef({ id: doc.id, version: doc.version });
  latest.current = doc;
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const submit = async () => {
    if (!action || busy.current || failed.current || !alive.current || !latest.current.taskActions?.[action]) return;
    const source = opened.current;
    if (source.id !== doc.id || source.version !== doc.version) {
      failed.current = true; setError("单据版本已变化，尚未发送操作，请先刷新核对。"); return;
    }
    const stillCurrent = () => alive.current && latest.current.id === source.id && latest.current.version === source.version && latest.current.taskActions?.[action];
    busy.current = true; setLoading(true); setLink(null);
    try {
      const path = action === "reject" ? "approve" : action === "confirmToken" ? "confirm-token" : action;
      const body = action === "confirmToken" ? undefined : { version: source.version,
        ...(["approve", "reject"].includes(action) ? { action, comment: note.trim() || undefined } : {}),
        ...(action === "confirm" ? { note: note.trim() || undefined } : {}) };
      const result = await fetchJson<{ status?: string; path?: string }>(`/api/outsource/po/${source.id}/${path}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(20_000),
      });
      if (!stillCurrent()) return;
      if (action === "confirmToken") {
        if (!result || typeof result.path !== "string" || !/^\/supplier\/confirm\/[0-9a-f-]{36}$/i.test(result.path)) throw Error("确认链接响应异常，请核对后再决定是否重新生成");
        setLink(`${window.location.origin}${result.path}`); setAction(null); return;
      }
      const target = { submit: "pending", approve: "approved", reject: "draft", withdraw: "draft", confirm: "in_progress" }[action];
      if (result?.status !== target) throw Error("响应状态与本次操作不一致，请先核对");
      const current = await readClosingSnapshot(`/api/outsource/po/${source.id}`, "po", source.id);
      if (!stillCurrent()) return;
      if (current.status !== target) throw Error("处理后单据状态已有变化，请刷新核对当前状态与审批记录");
      setAction(null); message.success("操作已完成并核对"); onChanged();
    } catch (e) {
      failed.current = true;
      if (alive.current) {
        setPriceReview(e instanceof JsonRequestError && e.status === 409 && e.code === "PO_PRICE_REVIEW_REQUIRED");
        setError(`${e instanceof Error ? e.message : "未取得处理结果"}。请先刷新核对单据状态、审批和改价记录；不会自动重发。`);
      }
    } finally { busy.current = false; if (alive.current) setLoading(false); }
  };
  const feedback = error ? <Alert type={priceReview ? "warning" : "error"} showIcon message={priceReview ? "采购价格需审批" : "操作结果待核对"}
    description={<Space direction="vertical" size={8}><span>{error}</span><Space wrap>
      <Button onClick={onChanged} disabled={loading}>刷新核对，不重新提交</Button>
      {priceReview ? <Typography.Link href="/outsource/pc">查看价格变更申请</Typography.Link> : null}
    </Space></Space>} /> : null;
  return <section aria-label="采购操作与资格" style={{ marginBottom: 12 }}>
    <Alert showIcon type="info" message="当前操作资格" description={doc.taskActions?.reason ?? "操作资格暂不可用，请刷新核对；不会根据单据状态猜测权限。"}
      action={<Button onClick={onChanged} disabled={loading}>刷新核对</Button>} style={{ marginBottom: 12 }} />
    {action === null ? feedback : null}
    {!error ? <Space wrap>{(Object.keys(labels) as Action[]).filter(a => doc.taskActions?.[a]).map(a => <Button key={a} loading={loading}
      danger={a === "reject"} onClick={() => { if (busy.current || failed.current) return; opened.current = { id: doc.id, version: doc.version }; setNote(""); setAction(a); }}>
      {labels[a]}</Button>)}</Space> : null}
    {link && doc.taskActions?.confirmToken ? <Alert type="success" message="新链接已生成，请只发送给对应供应商" style={{ marginTop: 12 }}
      description={<Typography.Paragraph copyable={{ text: link }} style={{ marginBottom: 0, overflowWrap: "anywhere" }}>{link}</Typography.Paragraph>} /> : null}
    <Modal open={action !== null} title={action ? labels[action] : "采购操作"} style={{ top: 24 }}
      styles={{ body: { maxHeight: "calc(100dvh - 200px)", overflowY: "auto" } }}
      okText="确认操作" cancelText={error ? "关闭，稍后核对" : "取消"} confirmLoading={loading}
      closable={!loading} maskClosable={!loading} keyboard={!loading}
      okButtonProps={{ disabled: !!error || !action || !doc.taskActions?.[action] }}
      onCancel={() => { if (!busy.current) setAction(null); }} onOk={() => void submit()}>
      {feedback}
      <Typography.Paragraph>{doc.docNo} · 版本 {doc.version}</Typography.Paragraph>
      <Typography.Paragraph type="secondary">{action ? hints[action] : null}</Typography.Paragraph>
      {action === "reject" || action === "confirm" ? <Input.TextArea aria-label={action === "reject" ? "驳回意见" : "代录确认备注"}
        value={note} onChange={e => setNote(e.target.value)} rows={3} maxLength={200} disabled={loading || !!error || !doc.taskActions?.[action]} /> : null}
    </Modal>
  </section>;
}
