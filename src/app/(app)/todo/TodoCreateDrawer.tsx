"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { Alert, App, Button, DatePicker, Drawer, Form, Input, Select } from "antd";
import dayjs, { type Dayjs } from "dayjs";
import { postJson } from "@/components/fetchJson";

interface Option<T> { value: T; label: string }
interface TodoFormValues {
  title: string;
  detail?: string;
  assigneeId: number;
  ownerRole?: string;
  priority: string;
  dueDate?: Dayjs | null;
  sourceRef?: string;
}

export interface TodoCreateDrawerProps {
  defaultAssigneeId?: number;
  assigneeOptions: Option<number>[];
  roleOptions: Option<string>[];
  priorityOptions: Option<string>[];
  onCancel: () => void;
  onCreated: () => void;
}

/** 每次打开独立挂载；手工待办仍由服务端创建，不添加来源去重或自动重试。 */
export default function TodoCreateDrawer({ defaultAssigneeId, assigneeOptions, roleOptions, priorityOptions, onCancel, onCreated }: TodoCreateDrawerProps) {
  const { message } = App.useApp();
  const [form] = Form.useForm<TodoFormValues>();
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const lifecycle = useRef({ active: false, version: 0, busy: false });

  useLayoutEffect(() => {
    const session = lifecycle.current;
    session.active = true;
    session.version += 1;
    return () => {
      session.active = false;
      session.version += 1;
    };
  }, []);

  const submit = async () => {
    const session = lifecycle.current;
    // 校验本身也是异步步骤；必须先同步上锁，不能只靠下一次 render 的 loading。
    if (!session.active || session.busy) return;
    session.busy = true;
    const version = session.version;
    const isCurrent = () => session.active && session.version === version;
    const unlock = () => {
      if (!isCurrent()) return;
      session.busy = false;
      setSubmitting(false);
    };
    setSubmitting(true);
    setSubmitError(null);

    let values: TodoFormValues;
    try {
      values = await form.validateFields();
    } catch {
      if (isCurrent()) message.warning("请检查必填项及输入内容");
      unlock();
      return;
    }
    if (!isCurrent()) return;

    let result: { created: boolean; reopened: boolean };
    try {
      result = await postJson<{ created: boolean; reopened: boolean }>("/api/todo", {
        ...values,
        dueDate: values.dueDate ? dayjs(values.dueDate).format("YYYY-MM-DD") : undefined,
      });
      if (!isCurrent()) return;
      if (!result || typeof result.created !== "boolean" || typeof result.reopened !== "boolean" || (result.created && result.reopened)) {
        throw new Error("未能确认创建结果。操作可能已在服务端完成，请先核对待办列表，勿重复提交");
      }
    } catch (error) {
      if (isCurrent()) {
        setSubmitError(error instanceof Error ? error.message : "创建结果未确认，请先核对待办列表，勿重复提交");
      }
      unlock();
      return;
    }

    // 成功后保持锁直到父组件卸载，避免关闭提交与下一次点击之间再次发出 POST。
    // 不取消已发出的写请求：卸载只让回调失效，不能证明服务端已回滚。
    message.success(result.created ? "已创建" : result.reopened ? "同来源待办已重新打开" : "已存在同来源的未完成待办");
    onCreated();
  };

  return (
    <Drawer
      title="新建待办"
      open
      onClose={() => { if (lifecycle.current.active && !lifecycle.current.busy) onCancel(); }}
      closable={!submitting}
      maskClosable={!submitting}
      keyboard={!submitting}
      width={480}
      extra={<Button type="primary" loading={submitting} disabled={submitting} onClick={() => void submit()}>保存</Button>}
    >
      {submitError && <Alert type="error" showIcon message={submitError} style={{ marginBottom: 12 }} />}
      <Form form={form} disabled={submitting} layout="vertical" initialValues={{ priority: "normal", assigneeId: defaultAssigneeId }}>
        <Form.Item name="title" label="标题" rules={[{ required: true, message: "标题必填" }]}><Input maxLength={200} /></Form.Item>
        <Form.Item name="detail" label="明细"><Input.TextArea rows={3} maxLength={2000} /></Form.Item>
        <Form.Item name="assigneeId" label="责任人" rules={[{ required: true, message: "必须指定责任人" }]}>
          <Select showSearch optionFilterProp="label" options={assigneeOptions} />
        </Form.Item>
        <Form.Item name="ownerRole" label="责任角色（部门）"><Select allowClear options={roleOptions} /></Form.Item>
        <Form.Item name="priority" label="优先级"><Select options={priorityOptions} /></Form.Item>
        <Form.Item name="dueDate" label="截止日期"><DatePicker style={{ width: "100%" }} /></Form.Item>
        <Form.Item name="sourceRef" label="关联单据 / 引用"><Input placeholder="如 PO20260901-001" maxLength={200} /></Form.Item>
      </Form>
    </Drawer>
  );
}
