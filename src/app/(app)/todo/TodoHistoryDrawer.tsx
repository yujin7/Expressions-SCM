"use client";

import { useRef, useState } from "react";
import { Button, Drawer, Space, Spin } from "antd";
import dayjs from "dayjs";
import { useMe } from "@/components/useMe";
import TodoNoteForm from "./TodoNoteForm";
import { useDocumentRead } from "@/components/useDocumentRead";
import LoadErrorAlert from "@/components/LoadErrorAlert";
import type { WorkItemHistoryPage } from "@/server/modules/todo/history";
import styles from "./todo-client.module.css";

const labels: Record<string, string> = { create: "创建", assign: "改派", update: "更新", complete: "完成待办", cancel: "取消", reopen: "重新打开", follow_up: "跟进记录", capacity_check: "产能核对依据" };
const statuses: Record<string, string> = { open: "待处理", in_progress: "进行中", done: "已完成", cancelled: "已取消" };

/** Parent-owned drawer survives desktop/mobile table reconstruction; one item per mount. */
export default function TodoHistoryDrawer({ id, title, onClose }: { id: number; title: string; onClose: () => void }) {
  const me = useMe();
  return me ? <HistoryContent key={`${me.id}:${me.roles.join(",")}:${id}`} id={id} title={title} onClose={onClose} actorId={me.id} /> : <Drawer title="跟进与记录" open onClose={onClose}><Spin /></Drawer>;
}
function HistoryContent({ id, title, onClose, actorId }: { id: number; title: string; onClose: () => void; actorId: number }) {
  const [before, setBefore] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const content = useRef<HTMLDivElement>(null);
  const read = useDocumentRead<WorkItemHistoryPage>(`/api/todo/${id}/history${before ? `?before=${before}` : ""}`);
  // Paging/retry triggers can disappear; submit controls become disabled. Keep keyboard focus inside.
  const retainFocus = () => content.current?.focus({ preventScroll: true });
  const retry = () => { retainFocus(); read.retry(); };

  return <Drawer title={`#${id} 跟进与记录`} open width={560} onClose={onClose} closable={!busy} maskClosable={!busy} keyboard={!busy}>
    <div className={styles.history} ref={content} tabIndex={-1}>
      <strong>{title}</strong>
      <p>追加跟进或结果依据，不改变待办状态、完成时间，也不会关闭来源告警。历史记录只追加、不覆盖。</p>
      <TodoNoteForm id={id} actorId={actorId} onBusy={setBusy} onSaved={() => { setBefore(null); read.retry(); }} />
      <Space wrap><Button size="small" onClick={() => { retainFocus(); setBefore(null); read.retry(); }}>最新记录</Button>{read.data?.nextBefore ? <Button size="small" onClick={() => { retainFocus(); setBefore(read.data!.nextBefore); }}>更早20条</Button> : null}</Space>
      <LoadErrorAlert error={read.error} subject="待办记录" onRetry={retry} retrying={read.phase === "loading"} />
      {read.phase === "loading" ? <Spin aria-label="正在读取待办记录" /> : null}
      {read.data?.rows.length === 0 ? <p>暂无可显示的操作记录；这不表示已处理。</p> : null}
      <ol className={styles.historyList}>{read.data?.rows.map(event => <li key={event.id}>
        <div><strong>{labels[event.action] ?? event.action}</strong> · {event.actorName}</div>
        <small>{dayjs(event.at).format("YYYY-MM-DD HH:mm:ss")} · #{event.id}</small>
        {event.status ? <div>状态：{statuses[event.status]}</div> : null}
        {event.assigneeId ? <div>责任人编号：#{event.assigneeId}</div> : null}
        {event.sourceAlertId ? <a href={`/alerts?id=${event.sourceAlertId}`}>查看来源告警 #{event.sourceAlertId}</a> : null}
        {event.note ? event.action === "capacity_check" ? <details><summary>查看核对时点的来源、情景与负责人依据</summary><p>{event.note}</p></details> : <p>{event.note}</p> : null}
      </li>)}</ol>
    </div>
  </Drawer>;
}
