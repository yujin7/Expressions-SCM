"use client";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Alert, Button, Drawer, Space } from "antd";
import { useTodoMutationRequest } from "@/components/useTodoMutationRequest";
import { clearTodoMutation, loadTodoMutation, lookupTodoMutation, submitTodoMutation, todoMutationIsObsolete, TODO_MUTATION_CHANGED, TODO_MUTATION_OPEN,
  withTodoMutationLock, type TodoMutationLookup, type TodoMutationRequest } from "@/components/todo-mutation-request";
import { todoItemHref } from "@/lib/todo-navigation";
import styles from "./todo-client.module.css";

const labels = { open: "待处理", in_progress: "进行中", done: "已完成", cancelled: "已取消" };
function Intent({ request }: { request: TodoMutationRequest }) {
  return <div>原操作：{request.status ? `设为「${labels[request.status]}」` : "状态不变"}{request.assigneeId ? `；改派给用户 #${request.assigneeId}` : ""} · 所见版本 v{request.expectedVersion}</div>;
}

/** Recovery remains reachable even when the original task is filtered out or now closed. */
export default function TodoMutationRecovery({ actorId, onChanged }: { actorId: number; onChanged: () => void }) {
  const recovery = useTodoMutationRequest(actorId);
  const [open, setOpen] = useState(false);
  const [confirmed, setConfirmed] = useState<{ itemId: number; text: string } | null>(null);
  useEffect(() => {
    const show = (event: Event) => { if ((event as CustomEvent).detail === actorId) { setConfirmed(null); setOpen(true); } };
    const changed = () => {
      try { if (loadTodoMutation(localStorage, actorId)) setConfirmed(null); }
      catch { /* The recovery subscription shows storage errors without erasing evidence. */ }
    };
    window.addEventListener(TODO_MUTATION_OPEN, show);
    window.addEventListener(TODO_MUTATION_CHANGED, changed);
    window.addEventListener("storage", changed);
    return () => { window.removeEventListener(TODO_MUTATION_OPEN, show); window.removeEventListener(TODO_MUTATION_CHANGED, changed); window.removeEventListener("storage", changed); };
  }, [actorId]);
  return <>
    {recovery.error ? <Alert type="error" showIcon message={recovery.error} className={styles.feedback} />
      : recovery.request ? <Alert type="warning" showIcon message={`待办 #${recovery.request.itemId} 有原操作待确认`}
        description="刷新或关闭后仍可恢复；不会自动再次完成、取消或改派。"
        action={<Button onClick={() => { setConfirmed(null); setOpen(true); }}>恢复原操作</Button>} className={styles.feedback} /> : null}
    {confirmed ? <Alert type="success" showIcon message={confirmed.text} className={styles.feedback}
      description={<a href={todoItemHref(confirmed.itemId)}>查看当前待办 #{confirmed.itemId}</a>} closable onClose={() => setConfirmed(null)} /> : null}
    {open && recovery.request ? <TodoMutationRecoveryDrawer key={recovery.request.requestId} actorId={actorId} request={recovery.request} onClose={() => setOpen(false)}
      onConfirmed={(r, obsolete) => { setOpen(false); setConfirmed({ itemId: r.itemId, text: obsolete ? "已核对：旧版本操作未执行，本机记录已清理" : "原操作回执已确认，本机记录已清理；当前状态以任务详情为准" }); onChanged(); }} /> : null}
  </>;
}

export function TodoMutationRecoveryDrawer({ actorId, request, onClose, onConfirmed }: {
  actorId: number; request: TodoMutationRequest; onClose: () => void; onConfirmed: (result: TodoMutationLookup, obsolete: boolean) => void;
}) {
  const [result, setResult] = useState<TodoMutationLookup | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const life = useRef(0), locked = useRef(false), content = useRef<HTMLDivElement>(null);
  useEffect(() => { const generation = ++life.current; return () => { life.current = generation + 1; }; }, []);
  useLayoutEffect(() => {
    if (result || error) { content.current?.focus({ preventScroll: true }); content.current?.scrollIntoView({ block: "start" }); }
  }, [result, error]);
  const obsolete = !!result && todoMutationIsObsolete(request, result);
  const run = async (mode: "lookup" | "retry" | "ack") => {
    if (locked.current || life.current === 0) return;
    const generation = life.current, isCurrent = () => life.current === generation;
    locked.current = true; setBusy(true); setError(null);
    try {
      await withTodoMutationLock(actorId, async () => {
        if (!isCurrent()) return;
        const prior = loadTodoMutation(localStorage, actorId);
        if (!prior || JSON.stringify(prior) !== JSON.stringify(request)) throw Error("本机原请求已变化，请关闭后重新核对");
        let fresh = await lookupTodoMutation(prior);
        if (!isCurrent()) return;
        if (mode === "retry" && !fresh.receipt && !todoMutationIsObsolete(prior, fresh)) fresh = await submitTodoMutation(prior);
        if (!isCurrent()) return;
        setResult(fresh);
        if (mode === "ack") {
          const sameReceipt = !!result?.receipt && fresh.receipt?.eventId === result.receipt.eventId;
          const stillObsolete = obsolete && todoMutationIsObsolete(prior, fresh);
          if (!sameReceipt && !stillObsolete) throw Error("核对结果已变化，请阅读最新结果后再确认；原记录仍保留");
          clearTodoMutation(localStorage, actorId, prior.requestId);
          window.dispatchEvent(new Event(TODO_MUTATION_CHANGED));
          onConfirmed(fresh, stillObsolete);
        }
      });
    } catch (e) {
      if (isCurrent()) setError(e instanceof Error ? e.message : "原操作结果未确认，本机记录仍保留");
    } finally {
      if (isCurrent()) { locked.current = false; setBusy(false); }
    }
  };
  return <Drawer title={`恢复待办 #${request.itemId} 的原操作`} open width="min(560px, 100vw)" onClose={onClose} closable={!busy} maskClosable={!busy} keyboard={!busy}>
    <div className={styles.history} ref={content} tabIndex={-1}>
      <strong>{request.title}</strong><Intent request={request} />
      {request.note ? <details><summary>查看原备注</summary><p>{request.note}</p></details> : null}
      <p>仅在本机按账号保留有限原操作，不含密码。核对不会再次修改任务；重试也只使用原编号、原版本和原内容。关页或超时不代表服务器已取消。</p>
      {error ? <Alert type="error" showIcon message="原操作结果未确认" description={error} /> : null}
      {result?.receipt ? <Alert type="success" showIcon message={`原操作已保存 · 回执 #${result.receipt.eventId}`}
        description={<div>当时结果：{labels[result.receipt.originalResult.status]} · 责任人 #{result.receipt.originalResult.assigneeId} · v{result.receipt.originalResult.version}
          {result.receipt.originalResult.suspicious ? <p>当时创建不足10分钟即完成，已保留可疑标记（仅提示）。</p> : null}</div>} /> : null}
      {result ? <Alert type={result.receipt && result.current.version > result.receipt.originalResult.version ? "warning" : "info"} showIcon
        message={result.receipt && result.current.version > result.receipt.originalResult.version ? "任务后来已有更新；原回执不代表当前仍是原状态" : "本次核对时的当前任务"}
        description={<div>{labels[result.current.status]} · 责任人 {result.current.assigneeName ?? `#${result.current.assigneeId}`} · v{result.current.version}<br />
          <a href={todoItemHref(request.itemId)}>查看当前待办 #{request.itemId}</a></div>} /> : null}
      {result && !result.receipt ? <Alert type="warning" showIcon message={obsolete ? "旧版本操作未执行，已不能再执行" : "暂未查到原回执"}
        description={obsolete ? "任务版本已前进，服务端会拒绝此旧版本请求。确认后可清理本机记录，再根据当前任务决定下一步。" : "暂未查到不表示稍后不会完成。可继续核对，或明确重试原操作；不会换新编号或自动提交。"} /> : null}
      <Space wrap>
        <Button loading={busy} disabled={busy} onClick={() => void run("lookup")}>核对原操作结果</Button>
        {result && !result.receipt && !obsolete ? <Button disabled={busy} onClick={() => void run("retry")}>重试原操作</Button> : null}
        {result?.receipt || obsolete ? <Button type="primary" disabled={busy} onClick={() => void run("ack")}>{obsolete ? "确认未执行并清理本机记录" : "确认回执并清理本机记录"}</Button> : null}
      </Space>
      <details><summary>原请求编号</summary><small>{request.requestId}</small></details>
    </div>
  </Drawer>;
}
