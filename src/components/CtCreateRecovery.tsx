"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Alert, Button, Popconfirm, Space, Typography } from "antd";
import DocStatusTag from "./DocStatusTag";
import RecoveryDocumentLink from "./RecoveryDocumentLink";
import { ctCreateStorageKey, clearCtCreateRequest, loadCtCreateRequest, lookupCtCreateRequest,
  prepareCtCreateRequest, submitCtCreateRequest, cancelCtCreateRequest, withCtCreateLock,
  type CtCreatePayload, type CtCreateRequest, type CtCreateResult } from "./ct-create-request";

/** Consumers must be keyed by current account/roles so late responses cannot cross accounts. */
export function useCtCreateRecovery(actorId: number | null, allowed: boolean, onConfirmed: () => void) {
  const [request, setRequest] = useState<CtCreateRequest | null>(null);
  const [result, setResult] = useState<CtCreateResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false), [busy, setBusy] = useState(false);
  const pending = useRef(false), alive = useRef(true), permission = useRef(allowed);
  permission.current = allowed;
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const active = () => alive.current && permission.current;
  const show = (r: CtCreateRequest | null) => { setRequest(r); setResult(null); };
  useEffect(() => {
    if (actorId == null || !allowed) return;
    const restore = () => {
      if (pending.current) return;
      try { show(loadCtCreateRequest(localStorage, actorId)); setError(null); setReady(true); }
      catch (e) { setError((e as Error).message); setReady(false); }
    };
    restore();
    const changed = (event: StorageEvent) => { if (event.storageArea === localStorage && (event.key == null || event.key === ctCreateStorageKey(actorId))) restore(); };
    window.addEventListener("storage", changed);
    return () => window.removeEventListener("storage", changed);
  }, [actorId, allowed]);
  const run = async <T,>(action: (id: number) => Promise<T>): Promise<T | null> => {
    if (actorId == null || !allowed || !ready || pending.current) return null;
    pending.current = true; setBusy(true); setError(null);
    try { return await withCtCreateLock(actorId, async () => active() ? action(actorId) : null); }
    catch (e) { if (active()) setError(e instanceof Error ? e.message : "未能确认结果，请保留原请求核对"); return null; }
    finally { pending.current = false; if (alive.current) setBusy(false); }
  };
  const confirm = (found: CtCreateResult) => {
    if (!active()) return null;
    setResult(found); if (found.document) onConfirmed();
    return found;
  };
  const lookup = () => run(async id => {
    const current = loadCtCreateRequest(localStorage, id); show(current);
    if (current) return confirm(await lookupCtCreateRequest(current.requestKey));
  });
  const submit = (payload?: CtCreatePayload, edit = false) => run(async id => {
    let current = loadCtCreateRequest(localStorage, id);
    if (edit) {
      if (!current || current.requestKey !== request?.requestKey || !payload) throw Error("原请求已变化，请重新核对");
      const found = await lookupCtCreateRequest(current.requestKey);
      if (!active()) return null;
      if (found.document || found.cancelled) { show(current); return confirm(found); }
      current = prepareCtCreateRequest(localStorage, id, payload, current.requestKey);
    } else if (!current && payload) current = prepareCtCreateRequest(localStorage, id, payload);
    else if (payload && current) { show(current); throw Error("发现未确认的采购退货请求，未另建新单，请先核对或修正原请求"); }
    if (!current) throw Error("没有可重试的原请求");
    if (!active()) return null;
    show(current);
    return confirm(await submitCtCreateRequest(current));
  });
  const acknowledge = () => run(async id => {
    if (!request || (!result?.document && !result?.cancelled) || result.requestKey !== request.requestKey) return;
    const found = await lookupCtCreateRequest(request.requestKey);
    if (!found.document && !found.cancelled) throw Error("尚未确认原请求结果，请继续核对");
    if (active()) { const next = clearCtCreateRequest(localStorage, id, request.requestKey); show(next); return next === null; }
  });
  const cancel = () => run(async id => {
    const current = loadCtCreateRequest(localStorage, id);
    if (!current || current.requestKey !== request?.requestKey) throw Error("原请求已变化，请重新核对；未发送取消请求");
    show(current);
    return confirm(await cancelCtCreateRequest(current.requestKey));
  });
  return { request, result, error, ready, busy, lookup, submit, acknowledge, cancel };
}

export default function CtCreateRecovery({ recovery, onEdit, onAcknowledged, onOpenDocument }: {
  recovery: ReturnType<typeof useCtCreateRecovery>; onEdit?: (request: CtCreateRequest) => void; onAcknowledged?: () => void; onOpenDocument?: () => void;
}) {
  const { request, result, error, busy } = recovery;
  if (!request && !error) return null;
  const acknowledge = async () => { if (await recovery.acknowledge()) onAcknowledged?.(); };
  return <Alert style={{ marginBottom: 12 }} type={error ? "error" : result?.cancelled ? "info" : result?.document ? "success" : "warning"} showIcon
    message={result?.cancelled ? "原建单请求已取消，未生成退货单" : result?.document ? "已找到原采购退货单，请核对当前状态" : "采购退货建单结果待核对"}
    description={<Space direction="vertical" size={8} style={{ width: "100%" }}>
      {error && <Typography.Text role="alert">{error}</Typography.Text>}
      {request && <>
        <Typography.Text>采购订单 #{request.poId} · {request.lines.length}项实物明细 · 出库仓 #{request.warehouseId}。刷新或换页不会自动重发。</Typography.Text>
        <details><summary>为什么要先核对？</summary>
          <Typography.Paragraph style={{ overflowWrap: "anywhere", marginBottom: 0 }}>网络中断不代表保存失败。核对只读取原结果；重试沿用原请求，不重复建单。要改内容请使用「修正原请求」，已建单则打开原单处理。请求编号：{request.requestKey}</Typography.Paragraph>
        </details>
        {result && !result.document && !result.cancelled && <Typography.Text>服务器暂未找到原单。可重试、修正或明确取消原请求；不要更换请求编号另建。</Typography.Text>}
        {result?.cancelled && <Typography.Text>该请求已被阻止执行，迟到提交也不会建单。取消记录保留在服务器；确认后可准备下一笔。</Typography.Text>}
        {result?.document && <Space wrap><RecoveryDocumentLink docType="ct" id={result.document.id} onOpen={onOpenDocument}>查看本次创建的采购退货单 {result.document.docNo}</RecoveryDocumentLink><DocStatusTag status={result.document.status} /></Space>}
        <Space wrap size={8}>
          <Button disabled={busy} onClick={() => void recovery.lookup()}>核对原单</Button>
          {!result?.document && !result?.cancelled && <Button disabled={busy} onClick={() => void recovery.submit()}>重试原请求</Button>}
          {!result?.document && !result?.cancelled && onEdit && <Button disabled={busy} onClick={() => onEdit(request)}>修正原请求</Button>}
          {!result?.document && !result?.cancelled && !onEdit && <Link href="/matflow/ct">前往采购退货单据修正原请求</Link>}
          {!result?.document && !result?.cancelled && <Popconfirm title="取消尚未完成的建单请求？"
            description="若原请求已成功将找回原单，不会作废已有单据；否则会阻止迟到提交。"
            okText="确认取消请求" cancelText="继续核对" disabled={busy} onConfirm={() => recovery.cancel()}>
            <Button danger disabled={busy}>取消原建单请求</Button>
          </Popconfirm>}
          {result?.document && <Button disabled={busy} onClick={() => void acknowledge()}>确认原单，准备下一笔</Button>}
          {result?.cancelled && <Button disabled={busy} onClick={() => void acknowledge()}>确认取消，准备下一笔</Button>}
        </Space>
      </>}
    </Space>} />;
}
