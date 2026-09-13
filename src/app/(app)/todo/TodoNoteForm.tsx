"use client";
import { useEffect, useRef, useState } from "react";
import { Alert, Button, Input, Space } from "antd";
import { useTodoNoteRequest } from "@/components/useTodoNoteRequest";
import { clearTodoNote, loadTodoNote, lookupTodoNote, prepareTodoNote, submitTodoNote, TODO_NOTE_CHANGED, withTodoNoteLock } from "@/components/todo-note-request";
import { todoItemHref } from "@/lib/todo-navigation";
import styles from "./todo-client.module.css";

export default function TodoNoteForm({ id, actorId, onSaved, onBusy }: { id: number; actorId: number; onSaved: () => void; onBusy: (busy: boolean) => void }) {
  const recovery = useTodoNoteRequest(actorId);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<number | null>(null);
  const [missing, setMissing] = useState(false);
  const live = useRef(false), locked = useRef(false), content = useRef<HTMLDivElement>(null);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const request = recovery.request;
  const other = request && request.itemId !== id;
  const note = request && !other ? request.note : draft;
  const run = async (mode: "save" | "retry" | "lookup") => {
    if (locked.current || !live.current || !recovery.ready || recovery.error || other) return;
    locked.current = true; setBusy(true); onBusy(true); setError(null); setSaved(null); setMissing(false);
    content.current?.focus({ preventScroll: true });
    try {
      await withTodoNoteLock(actorId, async () => {
        if (!live.current) return;
        const prior = loadTodoNote(localStorage, actorId);
        if (mode !== "save" && (!prior || prior.requestId !== request?.requestId || prior.itemId !== id)) throw Error("原请求已变化，请重新核对");
        const r = mode === "save" ? prepareTodoNote(localStorage, actorId, id, draft) : prior!;
        window.dispatchEvent(new Event(TODO_NOTE_CHANGED));
        const result = mode === "lookup" ? await lookupTodoNote(r) : await submitTodoNote(r);
        if (!live.current) return;
        if (result.eventId === null) { setMissing(true); return; }
        clearTodoNote(localStorage, actorId, r.requestId);
        window.dispatchEvent(new Event(TODO_NOTE_CHANGED));
        setDraft(""); setSaved(result.eventId); onSaved();
      });
    } catch (e) {
      if (live.current) setError(`${e instanceof Error ? e.message : "保存结果未确认"}。不会自动重试；不要另建同一条跟进。`);
    } finally {
      if (live.current) { locked.current = false; setBusy(false); onBusy(false); }
    }
  };
  return <div className={styles.history} ref={content} tabIndex={-1}>
    {recovery.error ? <Alert type="error" showIcon message={recovery.error} /> : null}
    {other ? <Alert type="warning" showIcon message={`待办 #${request.itemId} 有原跟进尚未核对`} description={<a href={todoItemHref(request.itemId)}>返回原待办，或使用待办页顶部“恢复原跟进”</a>} /> : null}
    <label htmlFor={`todo-note-${id}`}>本次跟进</label>
    <Input.TextArea id={`todo-note-${id}`} value={note} onChange={e => setDraft(e.target.value)} disabled={busy || !recovery.ready || !!request || !!recovery.error} autoSize={{ minRows: 3, maxRows: 6 }} maxLength={1000} placeholder="记录实际进展、下一步或受控凭据位置；不要填写密码等密钥" />
    <small>{note.length}/1000 · 至少5字。提交前在本机保存恢复副本，确认回执后删除；不要在共用浏览器记录敏感内容。</small>
    <Space wrap>
      {request && !other ? <><Button loading={busy} disabled={busy} onClick={() => void run("lookup")}>核对原跟进结果</Button><Button disabled={busy} onClick={() => void run("retry")}>确认同一提交</Button></>
        : <Button type="primary" loading={busy} disabled={busy || !recovery.ready || !!recovery.error || !!other || draft.trim().length < 5} onClick={() => void run("save")}>保存跟进</Button>}
    </Space>
    {request && !other ? <Alert type="info" showIcon message="原跟进请求已保存在本机" description="刷新、关闭后可从待办页顶部恢复。先核对原结果；未查到不代表稍后不会完成，同一提交会沿用原标识和内容。" /> : null}
    {missing ? <Alert type="warning" showIcon message="暂未查到原记录" description="可以稍后核对，或明确确认同一提交；不会自动另建记录。" /> : null}
    {error ? <Alert type="error" showIcon message="跟进结果未确认" description={error} /> : null}
    {saved ? <Alert type="success" showIcon message={`跟进已确认（记录 #${saved}）`} /> : null}
  </div>;
}
