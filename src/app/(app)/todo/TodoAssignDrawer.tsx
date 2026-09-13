"use client";
import { useLayoutEffect, useRef, useState } from "react";
import { Alert, Button, Drawer } from "antd";
import TodoAssigneeSelect from "@/components/TodoAssigneeSelect";
import type { WorkItemRow } from "./todo-client";
import styles from "./todo-client.module.css";

export default function TodoAssignDrawer({ row, busy, error, recoverable, onClose, onConfirm, onRecover }: {
  row: WorkItemRow; busy: boolean; error?: string; recoverable?: boolean;
  onClose: () => void; onConfirm: (assigneeId: number) => void; onRecover: () => void;
}) {
  const [selected, setSelected] = useState<number>();
  const [label, setLabel] = useState("");
  const content = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { if (error) { content.current?.focus({ preventScroll: true }); content.current?.scrollIntoView({ block: "start" }); } }, [error]);
  const valid = Number.isSafeInteger(selected) && Number(selected) > 0 && Number(selected) <= 2147483647 && selected !== row.assigneeId;
  return <Drawer title={`改派待办 #${row.id}`} open width="min(480px, 100vw)" onClose={onClose} closable={!busy} maskClosable={!busy} keyboard={!busy}>
    <div className={styles.history} ref={content} tabIndex={-1}>
      <strong>{row.title}</strong>
      <div>当前责任人：{row.assigneeName ?? "姓名未提供"} · #{row.assigneeId}<br /><small>所见版本 v{row.version}；只改派本条待办，不变更来源单据或部门归属。</small></div>
      {error ? <Alert showIcon type="error" message="改派未确认" description={error} /> : null}
      {recoverable ? <Button onClick={onRecover} disabled={busy}>核对原改派结果</Button> : null}
      <label htmlFor={`todo-assign-${row.id}`}>新责任人</label>
      <TodoAssigneeSelect id={`todo-assign-${row.id}`} aria-label="新责任人" excludeId={row.assigneeId}
        value={selected} disabled={busy || !!recoverable}
        onChange={(value, option) => {
          setSelected(typeof value === "number" ? value : undefined);
          setLabel(!Array.isArray(option) && typeof option?.label === "string" ? option.label : "");
        }} />
      {valid ? <div role="status">将改派给：{label || `#${selected}`}</div> : <p>选择人员后再确认；同名人员请核对编号与角色。</p>}
      <p>候选仅包含启用账号，每次最多50人，可搜索或加载更多。保存时仍核对当前权限、人员状态与任务版本。</p>
      <Button type="primary" loading={busy} disabled={busy || !valid || !!recoverable} onClick={() => { if (valid && !busy && !recoverable) { content.current?.focus({ preventScroll: true }); onConfirm(selected!); } }}>确认改派</Button>
    </div>
  </Drawer>;
}
