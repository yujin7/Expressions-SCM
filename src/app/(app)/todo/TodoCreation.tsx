"use client";
import { useState } from "react";
import { Alert, Button, Col, Row, Typography } from "antd";
import { PlusOutlined } from "@ant-design/icons";
import { useTodoCreateRequest } from "@/components/useTodoCreateRequest";
import { todoItemHref } from "@/lib/todo-navigation";
import TodoCreateDrawer, { type TodoCreateDrawerProps } from "./TodoCreateDrawer";

export default function TodoCreation(props: Omit<TodoCreateDrawerProps, "onCancel" | "onCreated"> & { onChanged: () => void }) {
  const { request, error, ready } = useTodoCreateRequest(props.actorId);
  const [open, setOpen] = useState(false);
  const [createdId, setCreatedId] = useState<number | null>(null);
  return <>
    <Row justify="space-between" align="middle" style={{ marginBottom: 8 }}>
      <Col><Typography.Title level={4} style={{ margin: 0 }}>待办任务</Typography.Title></Col>
      <Col><Button type="primary" disabled={!ready || !!error} icon={<PlusOutlined />} onClick={() => setOpen(true)}>{request ? "恢复待办创建" : "新建待办"}</Button></Col>
    </Row>
    {error ? <Alert type="error" showIcon message={error} style={{ marginBottom: 12 }} /> : request ? <Alert type="warning" showIcon message="有待办创建请求结果尚未核对" description="刷新、关闭页面不会自动重发；使用上方恢复入口找回原任务。" style={{ marginBottom: 12 }} /> : null}
    {createdId ? <Alert type="success" showIcon message={`已确认待办 #${createdId}`} description={<><a href={todoItemHref(createdId)}>打开准确任务 #{createdId}</a> · 原列表筛选已保留；打开任务后可后退返回。</>} style={{ marginBottom: 12 }} /> : null}
    {open ? <TodoCreateDrawer {...props} onCancel={() => setOpen(false)} onCreated={id => { setCreatedId(id); setOpen(false); props.onChanged(); }} /> : null}
  </>;
}
