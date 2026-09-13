"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Alert, Button, Space, Table, Typography } from "antd";
import DocStatusTag from "./DocStatusTag";
import { formatQty } from "./format";
import { bhCreateStorageKey, clearBhCreateRequest, loadBhCreateRequest, lookupBhCreateRequest, prepareBhCreateRequest,
  submitBhCreateRequest, withBhCreateLock, type BhCreatePayload, type BhCreateRequest, type BhCreateResult } from "./bh-create-request";

/** Consumers are keyed by current actor/roles; late responses never cross accounts. */
export function useBhCreateRecovery(actorId: number | null, allowed: boolean, onConfirmed: () => void) {
  const [request, setRequest] = useState<BhCreateRequest | null>(null);
  const [result, setResult] = useState<BhCreateResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false), [busy, setBusy] = useState(false);
  const pending = useRef(false), alive = useRef(true), permission = useRef(allowed);
  permission.current = allowed;
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const active = () => alive.current && permission.current;
  const show = (r: BhCreateRequest | null) => { setRequest(r); setResult(null); };
  useEffect(() => {
    if (actorId == null || !allowed) return;
    const restore = () => {
      if (pending.current) return;
      try { show(loadBhCreateRequest(localStorage, actorId)); setError(null); setReady(true); }
      catch (e) { setError((e as Error).message); setReady(false); }
    };
    restore();
    const changed = (event: StorageEvent) => { if (event.storageArea === localStorage && (event.key == null || event.key === bhCreateStorageKey(actorId))) restore(); };
    window.addEventListener("storage", changed);
    return () => window.removeEventListener("storage", changed);
  }, [actorId, allowed]);
  const run = async <T,>(action: (id: number) => Promise<T>): Promise<T | null> => {
    if (actorId == null || !allowed || !ready || pending.current) return null;
    pending.current = true; setBusy(true); setError(null);
    try { return await withBhCreateLock(actorId, async () => active() ? action(actorId) : null); }
    catch (e) { if (active()) setError((e as Error).message); return null; }
    finally { pending.current = false; if (alive.current) setBusy(false); }
  };
  const confirm = (found: BhCreateResult) => { if (active()) { setResult(found); if (found.document) onConfirmed(); } return found; };
  const lookup = () => run(async id => {
    const current = loadBhCreateRequest(localStorage, id); show(current);
    if (current) return confirm(await lookupBhCreateRequest(current.requestKey));
  });
  const submit = (payload?: BhCreatePayload, edit = false) => run(async id => {
    let current = loadBhCreateRequest(localStorage, id);
    if (edit) {
      if (!current || current.requestKey !== request?.requestKey || !payload) throw Error("原请求已变化，请重新核对");
      const found = await lookupBhCreateRequest(current.requestKey);
      if (!active()) return null;
      if (found.document) { show(current); return confirm(found); }
      current = prepareBhCreateRequest(localStorage, id, payload, current.requestKey);
    } else if (!current && payload) current = prepareBhCreateRequest(localStorage, id, payload);
    else if (payload && current) { show(current); throw Error("发现尚未确认的原请求，未另发新单，请先核对"); }
    if (!current) throw Error("没有可重试的原请求");
    if (!active()) return null;
    show(current);
    return confirm(await submitBhCreateRequest(current));
  });
  const acknowledge = () => run(async id => {
    if (!request || !result?.document || result.requestKey !== request.requestKey) return;
    const found = await lookupBhCreateRequest(request.requestKey);
    if (!found.document) throw Error("尚未确认原单，请继续核对");
    if (active()) show(clearBhCreateRequest(localStorage, id, request.requestKey));
  });
  return { request, result, error, ready, busy, lookup, submit, acknowledge };
}

export default function BhCreateRecovery({ recovery, onEdit }: {
  recovery: ReturnType<typeof useBhCreateRecovery>; onEdit?: (request: BhCreateRequest) => void;
}) {
  const { request, result, error, busy } = recovery;
  if (!request && !error) return null;
  return <Alert style={{ marginBottom: 16 }} type={error ? "error" : result?.document ? "success" : "warning"} showIcon
    message={result?.document ? "已找到原备货申请，请核对后继续" : "有一笔备货创建请求待核对"}
    description={<Space direction="vertical" style={{ width: "100%" }}>
      {error && <Typography.Text>{error}</Typography.Text>}
      {request && <>
        <Typography.Text>{request.source === "manual" ? "手工创建" : "实时补货"} · 原请求 {request.lines.length} 项。刷新或换页不会自动重发；未找到不等于可以换键新建。</Typography.Text>
        <details><summary>查看原请求明细与备注</summary>
          <Typography.Paragraph style={{ overflowWrap: "anywhere" }}>请求编号：{request.requestKey}；{request.remark || "未填写备注"}</Typography.Paragraph>
          <Table rowKey="originalLine" size="small" dataSource={request.lines.map((line, originalLine) => ({ ...line, originalLine }))} pagination={{ pageSize: 5, hideOnSinglePage: true }} scroll={{ x: 440 }}
            columns={[{ title: "SKU编号", dataIndex: "skuId", width: 110 }, { title: "原请求数量", dataIndex: "qty", width: 140, render: (v: string) => formatQty(v) }, { title: "期望日期", dataIndex: "expectDate", width: 130, render: (v?: string) => v || "—" }]} />
        </details>
        {result && !result.document && <Typography.Text>服务器暂未找到原单。可重试原请求；需要修正时先重新核对，不自动分配新编号。</Typography.Text>}
        {result?.document && <Space wrap><Link href={`/outsource/bh?docId=${result.document.id}`}>打开原备货申请 {result.document.docNo}</Link><DocStatusTag status={result.document.status} /></Space>}
        <Space wrap>
          <Button disabled={busy} onClick={() => void recovery.lookup()}>核对原单</Button>
          {!result?.document && <Button disabled={busy} onClick={() => void recovery.submit()}>重试原请求</Button>}
          {!result?.document && onEdit && <Button disabled={busy} onClick={() => onEdit(request)}>修正原请求</Button>}
          {!result?.document && !onEdit && <Link href={request.source === "manual" ? "/outsource/bh" : "/replenish"}>前往原请求修正入口</Link>}
          {result?.document && <Button disabled={busy} onClick={() => void recovery.acknowledge()}>确认原单，准备下一笔</Button>}
        </Space>
      </>}
    </Space>} />;
}
