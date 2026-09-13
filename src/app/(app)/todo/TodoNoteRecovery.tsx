"use client";
import { useState } from "react";
import { Alert, Button } from "antd";
import { useTodoNoteRequest } from "@/components/useTodoNoteRequest";
import TodoHistoryDrawer from "./TodoHistoryDrawer";

/** Independent of filters, pagination and whether the original task has since closed. */
export default function TodoNoteRecovery({ actorId }: { actorId: number }) {
  const { request, error } = useTodoNoteRequest(actorId);
  const [openId, setOpenId] = useState<number | null>(null);
  return <>
    {error ? <Alert type="error" showIcon message={error} /> : request ? <Alert type="warning" showIcon
      message={`待办 #${request.itemId} 的原跟进结果待核对`}
      action={<Button onClick={() => setOpenId(request.itemId)}>恢复原跟进</Button>} style={{ marginBottom: 12 }} /> : null}
    {openId ? <TodoHistoryDrawer key={openId} id={openId} title="恢复本机原跟进；以服务端回执和历史记录为准" onClose={() => setOpenId(null)} /> : null}
  </>;
}
