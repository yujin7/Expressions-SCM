"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { Alert, App, Button, DatePicker, Drawer, Form, Input, Select, Space } from "antd";
import dayjs, { type Dayjs } from "dayjs";
import { clearTodoCreate, loadTodoCreate, lookupTodoCreate, prepareTodoCreate, submitTodoCreate, TODO_CREATE_CHANGED, withTodoCreateLock, type TodoCreateRequest } from "@/components/todo-create-request";
import { todoItemHref } from "@/lib/todo-navigation";
import TodoAssigneeSelect from "@/components/TodoAssigneeSelect";

interface Option<T> { value: T; label: string }
interface TodoFormValues { title: string; detail?: string; assigneeId: number; ownerRole?: string; priority: "low" | "normal" | "high"; dueDate?: Dayjs | null; sourceRef?: string }
export interface TodoCreateDrawerProps {
  actorId: number;
  defaultAssigneeId?: number;
  roleOptions: Option<string>[];
  priorityOptions: Option<string>[];
  onCancel: () => void;
  onCreated: (id: number) => void;
}

/** Actor-keyed mount; persisted requests are independent of the current list's filters. */
export default function TodoCreateDrawer({ actorId, defaultAssigneeId, roleOptions, priorityOptions, onCancel, onCreated }: TodoCreateDrawerProps) {
  const { message } = App.useApp();
  const [form] = Form.useForm<TodoFormValues>();
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [pending, setPending] = useState<TodoCreateRequest | null>(null);
  const [editing, setEditing] = useState(false);
  const [missing, setMissing] = useState(false);
  const [found, setFound] = useState<Awaited<ReturnType<typeof lookupTodoCreate>> | null>(null);
  const lifecycle = useRef({ active: false, version: 0, busy: false });
  const content = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const session = lifecycle.current; session.active = true; session.version += 1;
    const sync = () => {
      try { const r = loadTodoCreate(localStorage, actorId); setPending(r); setStorageError(null); setReady(true); }
      catch (e) { setStorageError(e instanceof Error ? e.message : "本机创建记录无法读取"); setReady(true); }
    };
    sync();
    try { const r = loadTodoCreate(localStorage, actorId); if (r) form.setFieldsValue({ ...r, detail: r.detail ?? undefined, ownerRole: r.ownerRole ?? undefined, sourceRef: r.sourceRef ?? undefined, dueDate: r.dueDate ? dayjs(r.dueDate) : null }); } catch { /* sync already displays storage failure */ }
    window.addEventListener("storage", sync); window.addEventListener(TODO_CREATE_CHANGED, sync);
    return () => { session.active = false; session.version += 1; window.removeEventListener("storage", sync); window.removeEventListener(TODO_CREATE_CHANGED, sync); };
  }, [actorId, form]);
  useLayoutEffect(() => {
    if (submitError || found || missing) {
      content.current?.focus({ preventScroll: true });
      content.current?.scrollIntoView({ block: "start" });
    }
  }, [submitError, found, missing]);

  const submit = async (mode: "save" | "lookup" | "retry" | "edit" | "ack" = "save") => {
    const session = lifecycle.current;
    if (!session.active || session.busy || !ready || storageError) return;
    session.busy = true; const version = session.version;
    const isCurrent = () => session.active && session.version === version;
    const unlock = () => { if (isCurrent()) { session.busy = false; setSubmitting(false); } };
    setSubmitting(true); setSubmitError(null); setMissing(false); content.current?.focus({ preventScroll: true });
    let values: TodoFormValues | undefined;
    let completed = false;
    if (mode === "save") {
      try { values = await form.validateFields(); }
      catch { if (isCurrent()) message.warning("请检查必填项及输入内容"); unlock(); return; }
      if (!isCurrent()) return;
    }
    try {
      await withTodoCreateLock(actorId, async () => {
        if (!isCurrent()) return;
        let r = loadTodoCreate(localStorage, actorId);
        if ((pending || mode !== "save") && (!r || r.requestId !== pending?.requestId)) throw Error("原请求已变化，请关闭后重新核对");
        if (mode === "save") {
          r = prepareTodoCreate(localStorage, actorId, { ...values!, dueDate: values!.dueDate ? dayjs(values!.dueDate).format("YYYY-MM-DD") : null }, editing ? pending?.requestId : undefined);
          window.dispatchEvent(new Event(TODO_CREATE_CHANGED)); setEditing(false); setFound(null);
        }
        if (!r) throw Error("没有待核对的创建请求");
        if (mode === "lookup" || mode === "edit") {
          const result = await lookupTodoCreate(r);
          if (!isCurrent()) return;
          setFound(result.itemId ? result : null); setMissing(result.itemId === null);
          if (mode === "edit" && result.itemId === null) {
            form.setFieldsValue({ ...r, detail: r.detail ?? undefined, ownerRole: r.ownerRole ?? undefined, sourceRef: r.sourceRef ?? undefined, dueDate: r.dueDate ? dayjs(r.dueDate) : null }); setEditing(true);
          }
          return;
        }
        const result = mode === "ack" ? found : await submitTodoCreate(r);
        if (!isCurrent()) return;
        if (!result?.itemId || result.requestId !== r.requestId) throw Error("原创建回执未确认");
        clearTodoCreate(localStorage, actorId, r.requestId); window.dispatchEvent(new Event(TODO_CREATE_CHANGED));
        message.success(`已确认待办 #${result.itemId}，可从页面提示打开准确任务`);
        completed = true;
        onCreated(result.itemId);
      });
    } catch (error) { if (isCurrent()) setSubmitError(error instanceof Error ? error.message : "创建结果未确认，请先核对，勿重复提交"); }
    finally { if (!completed) unlock(); }
  };

  return <Drawer title={pending ? "恢复待办创建" : "新建待办"} open width="min(480px, 100vw)"
    onClose={() => { if (lifecycle.current.active && !lifecycle.current.busy) onCancel(); }} closable={!submitting} maskClosable={!submitting} keyboard={!submitting}
    extra={!pending || editing ? <Button type="primary" loading={submitting} disabled={submitting || !ready || !!storageError} onClick={() => void submit()}>保存</Button> : null}>
    <div ref={content} tabIndex={-1}>
      {storageError ? <Alert type="error" showIcon message={storageError} /> : null}
      {submitError ? <Alert type="error" showIcon message={submitError} style={{ marginBottom: 12 }} /> : null}
      {pending ? <Alert type="info" showIcon message="原创建请求已保存在本机，不会自动重发" description="先核对结果；未查到不代表稍后不会完成。修改仍沿用原编号，不能覆盖已经创建的任务。" style={{ marginBottom: 12 }} /> : null}
      {pending && !editing ? <Space wrap style={{ marginBottom: 12 }}>
        <Button disabled={submitting} onClick={() => void submit("lookup")}>核对原创建结果</Button>
        <Button loading={submitting} disabled={submitting} onClick={() => void submit("retry")}>确认同一创建</Button>
        <Button disabled={submitting} onClick={() => void submit("edit")}>核对后修改原请求</Button>
      </Space> : null}
      {missing ? <Alert type="warning" showIcon message="暂未查到原任务；原请求仍保留" style={{ marginBottom: 12 }} /> : null}
      {found?.itemId ? <Alert type="success" showIcon message={`原请求已创建待办 #${found.itemId}`} style={{ marginBottom: 12 }} description={<>
        <p>以下为原始创建内容，可能与本机后来修改的内容不同：</p>
        <p>{found.originalIntent?.title} · 责任人 #{found.originalIntent?.assigneeId} · {found.originalIntent?.dueDate ?? "无截止日"}</p>
        <details><summary>完整原始创建依据</summary><pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{JSON.stringify(found.originalIntent, null, 2)}</pre></details>
        <Space wrap><a href={todoItemHref(found.itemId)}>打开原任务</a><Button disabled={submitting} onClick={() => void submit("ack")}>已核对原任务</Button></Space>
      </>} /> : null}
      <Form form={form} disabled={submitting || !ready || !!storageError || (!!pending && !editing)} layout="vertical" initialValues={{ priority: "normal", assigneeId: defaultAssigneeId }}>
        <Form.Item name="title" label="标题" rules={[{ required: true, message: "标题必填" }]}><Input maxLength={200} /></Form.Item>
        <Form.Item name="detail" label="明细"><Input.TextArea rows={3} maxLength={2000} /></Form.Item>
        <Form.Item name="assigneeId" label="责任人" rules={[{ required: true, message: "必须指定责任人" }]}><TodoAssigneeSelect aria-label="责任人" /></Form.Item>
        <Form.Item name="ownerRole" label="责任角色（部门）"><Select allowClear options={roleOptions} /></Form.Item>
        <Form.Item name="priority" label="优先级"><Select options={priorityOptions} /></Form.Item>
        <Form.Item name="dueDate" label="截止日期"><DatePicker style={{ width: "100%" }} /></Form.Item>
        <Form.Item name="sourceRef" label="关联单据 / 引用"><Input placeholder="如 PO20260901-001" maxLength={200} /></Form.Item>
      </Form>
      <small>提交前在本机保存恢复副本，确认后删除。不要填写密码或密钥；共用浏览器请注意敏感信息。</small>
    </div>
  </Drawer>;
}
