"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Alert, Button, Space, Typography } from "antd";
import DocStatusTag from "./DocStatusTag";
import { STOCK_SUBTYPE_LABELS } from "./labels";
import { stockCreateStorageKey, clearStockCreateRequest, loadStockCreateRequest, lookupStockCreateRequest,
  prepareStockCreateRequest, submitStockCreateRequest, withStockCreateLock,
  type StockCreatePayload, type StockCreateRequest, type StockCreateResult } from "./stock-create-request";

/** Consumers must be keyed by current account/roles so late responses cannot cross accounts. */
export function useStockCreateRecovery(actorId: number | null, allowed: boolean, onConfirmed: () => void) {
  const [request, setRequest] = useState<StockCreateRequest | null>(null);
  const [result, setResult] = useState<StockCreateResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false), [busy, setBusy] = useState(false);
  const pending = useRef(false), alive = useRef(true), permission = useRef(allowed);
  permission.current = allowed;
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const active = () => alive.current && permission.current;
  const show = (r: StockCreateRequest | null) => { setRequest(r); setResult(null); };
  useEffect(() => {
    if (actorId == null || !allowed) return;
    const restore = () => {
      if (pending.current) return;
      try { show(loadStockCreateRequest(localStorage, actorId)); setError(null); setReady(true); }
      catch (e) { setError((e as Error).message); setReady(false); }
    };
    restore();
    const changed = (event: StorageEvent) => { if (event.storageArea === localStorage && (event.key == null || event.key === stockCreateStorageKey(actorId))) restore(); };
    window.addEventListener("storage", changed);
    return () => window.removeEventListener("storage", changed);
  }, [actorId, allowed]);
  const run = async <T,>(action: (id: number) => Promise<T>): Promise<T | null> => {
    if (actorId == null || !allowed || !ready || pending.current) return null;
    pending.current = true; setBusy(true); setError(null);
    try { return await withStockCreateLock(actorId, async () => active() ? action(actorId) : null); }
    catch (e) { if (active()) setError(e instanceof Error ? e.message : "未能确认结果，请保留原请求核对"); return null; }
    finally { pending.current = false; if (alive.current) setBusy(false); }
  };
  const confirm = (found: StockCreateResult) => {
    if (active()) { setResult(found); if (found.document) onConfirmed(); }
    return found;
  };
  const lookup = () => run(async id => {
    const current = loadStockCreateRequest(localStorage, id); show(current);
    if (current) return confirm(await lookupStockCreateRequest(current.requestKey));
  });
  const submit = (payload?: StockCreatePayload, edit = false) => run(async id => {
    let current = loadStockCreateRequest(localStorage, id);
    if (edit) {
      if (!current || current.requestKey !== request?.requestKey || !payload) throw Error("原请求已变化，请重新核对");
      const found = await lookupStockCreateRequest(current.requestKey);
      if (!active()) return null;
      if (found.document) { show(current); return confirm(found); }
      current = prepareStockCreateRequest(localStorage, id, payload, current.requestKey);
    } else if (!current && payload) current = prepareStockCreateRequest(localStorage, id, payload);
    else if (payload && current) { show(current); throw Error("发现未确认的库存请求，未另建新单，请先核对或修正原请求"); }
    if (!current) throw Error("没有可重试的原请求");
    if (!active()) return null;
    show(current);
    return confirm(await submitStockCreateRequest(current));
  });
  const acknowledge = () => run(async id => {
    if (!request || !result?.document || result.requestKey !== request.requestKey) return;
    const found = await lookupStockCreateRequest(request.requestKey);
    if (!found.document) throw Error("尚未确认原单，请继续核对");
    if (active()) show(clearStockCreateRequest(localStorage, id, request.requestKey));
  });
  return { request, result, error, ready, busy, lookup, submit, acknowledge };
}

export default function StockCreateRecovery({ recovery, onEdit }: {
  recovery: ReturnType<typeof useStockCreateRecovery>; onEdit?: (request: StockCreateRequest) => void;
}) {
  const { request, result, error, busy } = recovery;
  if (!request && !error) return null;
  return <Alert style={{ marginBottom: 12 }} type={error ? "error" : result?.document ? "success" : "warning"} showIcon
    message={result?.document ? "已找到原库存单，请核对当前状态" : "库存建单结果待核对"}
    description={<Space direction="vertical" size={8} style={{ width: "100%" }}>
      {error && <Typography.Text role="alert">{error}</Typography.Text>}
      {request && <>
        <Typography.Text>{STOCK_SUBTYPE_LABELS[request.subtype]} · {request.lines.length}项明细 · 仓库 #{request.warehouseId}{request.toWarehouseId ? ` → #${request.toWarehouseId}` : ""}。刷新或换页不会自动重发。</Typography.Text>
        <details><summary>为什么要先核对？</summary>
          <Typography.Paragraph style={{ overflowWrap: "anywhere", marginBottom: 0 }}>网络中断不代表保存失败。核对只读取原结果；重试沿用原请求，不重复建单。要改内容请使用「修正原请求」，已建单则打开原单处理。请求编号：{request.requestKey}</Typography.Paragraph>
        </details>
        {result && !result.document && <Typography.Text>服务器暂未找到原单。可重试或修正原请求；不要更换请求编号另建。</Typography.Text>}
        {result?.document && <Space wrap><Link href={`/inventory/docs?docId=${result.document.id}`}>打开原库存单 {result.document.docNo}</Link><DocStatusTag status={result.document.status} /></Space>}
        <Space wrap size={8}>
          <Button disabled={busy} onClick={() => void recovery.lookup()}>核对原单</Button>
          {!result?.document && <Button disabled={busy} onClick={() => void recovery.submit()}>重试原请求</Button>}
          {!result?.document && onEdit && <Button disabled={busy} onClick={() => onEdit(request)}>修正原请求</Button>}
          {!result?.document && !onEdit && <Link href="/inventory/docs">前往库存单据修正原请求</Link>}
          {result?.document && <Button disabled={busy} onClick={() => void recovery.acknowledge()}>确认原单，准备下一笔</Button>}
        </Space>
      </>}
    </Space>} />;
}
