"use client";

import { useEffect, useRef, useState } from "react";
import { Alert, Button, Drawer, Input, Space, Spin } from "antd";
import dayjs from "dayjs";
import { fetchJson } from "@/components/fetchJson";
import { useDocumentRead } from "@/components/useDocumentRead";
import LoadErrorAlert from "@/components/LoadErrorAlert";
import type { WorkItemHistoryPage } from "@/server/modules/todo/history";
import styles from "./todo-client.module.css";

const labels: Record<string, string> = { create: "创建", assign: "改派", update: "更新", complete: "完成待办", cancel: "取消", reopen: "重新打开", follow_up: "跟进记录" };
const statuses: Record<string, string> = { open: "待处理", in_progress: "进行中", done: "已完成", cancelled: "已取消" };

/** Parent-owned drawer survives desktop/mobile table reconstruction; one item per mount. */
export default function TodoHistoryDrawer({ id, title, onClose }: { id: number; title: string; onClose: () => void }) {
  const [before, setBefore] = useState<number | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<number | null>(null);
  const live = useRef(false);
  const pending = useRef<{ requestId: string; note: string } | null>(null);
  const locked = useRef(false);
  const content = useRef<HTMLDivElement>(null);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const read = useDocumentRead<WorkItemHistoryPage>(`/api/todo/${id}/history${before ? `?before=${before}` : ""}`);
  // A paging/retry trigger can disappear after the read. Keep Escape and Tab inside the drawer.
  const retainFocus = () => content.current?.focus({ preventScroll: true });
  const retry = () => { retainFocus(); read.retry(); };

  const save = async () => {
    if (locked.current || !live.current || (!pending.current && note.trim().length < 5)) return;
    locked.current = true;
    pending.current ??= { requestId: crypto.randomUUID(), note: note.trim() };
    setBusy(true); setError(null); setSaved(null);
    try {
      const result = await fetchJson<{ eventId: number; replayed: boolean }>(`/api/todo/${id}/history`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(pending.current), signal: AbortSignal.timeout(30_000),
      });
      if (!Number.isSafeInteger(result.eventId) || result.eventId <= 0 || typeof result.replayed !== "boolean") throw new Error("未能确认保存回执");
      if (!live.current) return;
      pending.current = null; setNote(""); setSaved(result.eventId); setBefore(null); read.retry();
    } catch (e) {
      if (live.current) setError(`${e instanceof Error ? e.message : "保存结果未确认"}。原内容与提交标识已保留，可核对记录或确认同一提交；不会自动重试。`);
    } finally {
      if (live.current) { locked.current = false; setBusy(false); }
    }
  };

  return <Drawer title={`#${id} 跟进与记录`} open width={560} onClose={onClose} closable={!busy} maskClosable={!busy} keyboard={!busy}>
    <div className={styles.history} ref={content} tabIndex={-1}>
      <strong>{title}</strong>
      <p>追加跟进或结果依据，不改变待办状态、完成时间，也不会关闭来源告警。历史记录只追加、不覆盖。</p>
      <label htmlFor={`todo-note-${id}`}>本次跟进</label>
      <Input.TextArea id={`todo-note-${id}`} value={note} onChange={e => setNote(e.target.value)} disabled={busy || !!error} autoSize={{ minRows: 3, maxRows: 6 }} maxLength={1000} placeholder="记录实际进展、待确认事项、下一步或受控凭据位置" />
      <div className={styles.noteActions}><span>{note.length}/1000 · 至少5字</span><Button type="primary" loading={busy} disabled={busy || (!error && note.trim().length < 5)} onClick={() => void save()}>{error ? "确认同一提交" : "保存跟进"}</Button></div>
      {error ? <Alert type="error" showIcon message="保存结果未确认" description={error} /> : null}
      {saved ? <Alert type="success" showIcon message={`跟进已保存（记录 #${saved}）`} /> : null}
      <Space wrap><Button size="small" onClick={() => { retainFocus(); setBefore(null); read.retry(); }}>最新记录</Button>{read.data?.nextBefore ? <Button size="small" onClick={() => { retainFocus(); setBefore(read.data!.nextBefore); }}>更早20条</Button> : null}</Space>
      <LoadErrorAlert error={read.error} subject="待办记录" onRetry={retry} retrying={read.phase === "loading"} />
      {read.phase === "loading" ? <Spin aria-label="正在读取待办记录" /> : null}
      {read.data?.rows.length === 0 ? <p>暂无可显示的操作记录；这不表示已处理。</p> : null}
      <ol className={styles.historyList}>{read.data?.rows.map(event => <li key={event.id}>
        <div><strong>{labels[event.action] ?? event.action}</strong> · {event.actorName}</div>
        <small>{dayjs(event.at).format("YYYY-MM-DD HH:mm:ss")} · #{event.id}</small>
        {event.status ? <div>状态：{statuses[event.status]}</div> : null}
        {event.assigneeId ? <div>责任人编号：#{event.assigneeId}</div> : null}
        {event.note ? <p>{event.note}</p> : null}
      </li>)}</ol>
    </div>
  </Drawer>;
}
