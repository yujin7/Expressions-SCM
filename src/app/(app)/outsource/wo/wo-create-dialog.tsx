"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import dayjs, { type Dayjs } from "dayjs";
import { Alert, Button, DatePicker, Form, Input, InputNumber, Modal, Select, Space } from "antd";
import RemoteSelect from "@/components/RemoteSelect";
import DocStatusTag from "@/components/DocStatusTag";
import { ORDER_TYPE_LABELS, formatOrderType, toOptions } from "@/components/labels";
import { clearWoCreateRequest, loadWoCreateRequest, lookupWoCreateRequest, prepareWoCreateRequest, submitWoCreateRequest, withWoCreateLock,
  type WoCreatePayload, type WoCreateRequest, type WoCreateResult } from "@/components/wo-create-request";

type FormValues = Omit<WoCreatePayload, "dueDate"> & { dueDate?: Dayjs };
/** Parent keys by actor so drafts, in-flight responses and recovery UI never cross accounts. */
export default function WoCreateDialog({ actorId, allowed, open, onClose, onResume, onCreated }: {
  actorId: number | null; allowed: boolean; open: boolean; onClose: () => void; onResume: () => void; onCreated: () => void;
}) {
  const [form] = Form.useForm<FormValues>();
  const [request, setRequest] = useState<WoCreateRequest | null>(null);
  const [result, setResult] = useState<WoCreateResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const pending = useRef(false), alive = useRef(true);
  const recoveryBody = useRef<HTMLDivElement>(null);
  const currentActor = useRef(actorId); currentActor.current = actorId;
  const currentAllowed = useRef(allowed); currentAllowed.current = allowed;
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    if (open && recoveryBody.current) recoveryBody.current.scrollTop = 0;
  }, [open, error, result]);
  const active = (id: number) => alive.current && currentActor.current === id && currentAllowed.current;
  const showRequest = (r: WoCreateRequest | null) => {
    setRequest(r); setResult(null); setEditing(false);
    if (r) form.setFieldsValue({ ...r, dueDate: r.dueDate ? dayjs(r.dueDate) : undefined });
    else form.resetFields();
  };
  useEffect(() => {
    if (actorId == null || !allowed) return;
    const restore = () => {
      if (pending.current) return;
      try { showRequest(loadWoCreateRequest(localStorage, actorId)); setError(null); setReady(true); }
      catch (e) { setError((e as Error).message); setReady(false); }
    };
    restore();
    const onStorage = (event: StorageEvent) => {
      if (event.storageArea === localStorage && (event.key === null || event.key === `scm:wo-create:v1:${actorId}`)) restore();
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
    // Form identity is stable; callback is scoped to this actor's mounted dialog.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- Restore only on actor/permission changes, not on each form render.
  }, [actorId, allowed]);

  const run = async (action: (id: number) => Promise<void>) => {
    if (actorId == null || !allowed || pending.current || !ready) return;
    const id = actorId;
    pending.current = true; setBusy(true); setError(null);
    try { await withWoCreateLock(id, async () => { if (active(id)) await action(id); }); }
    catch (e) { if (active(id)) setError((e as Error).message); }
    finally { pending.current = false; if (alive.current && currentActor.current === id) setBusy(false); }
  };
  const lookup = () => run(async id => {
    const current = loadWoCreateRequest(localStorage, id);
    if (!current) { if (active(id)) showRequest(null); return; }
    if (active(id)) showRequest(current);
    const found = await lookupWoCreateRequest(current.requestKey);
    if (active(id)) { setResult(found); if (found.document) onCreated(); }
  });
  const submit = (retry: boolean) => run(async id => {
    let current = loadWoCreateRequest(localStorage, id);
    if (!retry && (!current || editing)) {
      const values = await form.validateFields();
      if (!active(id)) return;
      current = prepareWoCreateRequest(localStorage, id, { ...values, qty: String(values.qty), feeRatePlan: String(values.feeRatePlan),
        bhId: values.bhId ?? undefined, dueDate: values.dueDate?.format("YYYY-MM-DD"), orderType: values.orderType || undefined, remark: values.remark?.trim() || undefined,
      }, editing ? request?.requestKey : undefined);
    }
    if (!current) throw Error("没有可重试的创建请求，请先填写工单");
    if (!active(id)) return;
    showRequest(current); // Freeze exactly the persisted payload, including when another tab created it first.
    const found = await submitWoCreateRequest(current);
    if (active(id)) { setResult(found); onCreated(); onClose(); }
  });
  const acknowledge = () => run(async id => {
    if (!result?.document || !request || result.requestKey !== request.requestKey) return;
    // Re-read the server receipt before clearing recovery data or enabling a new intent.
    const found = await lookupWoCreateRequest(request.requestKey);
    if (!found.document) throw Error("尚未确认原工单，请继续核对，不要清除恢复记录");
    if (!active(id)) return;
    const remaining = clearWoCreateRequest(localStorage, id, request.requestKey);
    if (active(id)) { showRequest(remaining); setError(null); onClose(); }
  });
  const canEdit = !request || editing;
  const found = result?.document;
  const close = () => { if (!pending.current) onClose(); };

  if (!allowed || actorId == null) return null;
  const recovery = request || error ? <Alert style={{ marginBottom: 12 }} showIcon type={error ? "error" : found ? "success" : "warning"}
    message={found ? `已找回工单 ${found.docNo}` : "创建结果待核对"}
    description={<Space direction="vertical" size={8} style={{ width: "100%" }}>
      <span>{error ?? (found ? "这是已保存的工单，不会重复建单；请进入核对当前状态，再按正常流程处理。" : "已保留原创建内容。刷新或网络中断后先核对，也可安全重试原请求；不会自动提交审批。")}</span>
      {request ? <Space wrap size={8}>
        <Button loading={busy} onClick={() => void lookup()}>核对创建结果</Button>
        {!found ? <Button disabled={busy} onClick={() => void submit(true)}>重试原请求</Button> : null}
        {found ? <><DocStatusTag status={found.status} /><Link href={`/outsource/wo?docId=${found.id}`} onClick={close}>打开工单核对 →</Link>
          <Button disabled={busy} onClick={() => void acknowledge()}>已核对，准备新工单</Button></> : null}
        {result?.document === null ? <Button disabled={busy} onClick={() => { setEditing(true); setError(null); onResume(); }}>修改未确认请求</Button> : null}
      </Space> : null}
      {editing ? <span>仍使用原请求编号。若原请求稍后完成，新内容会被拒绝，请找回原工单，不会再创建第二张。</span> : null}
    </Space>} /> : null;

  return <>
    {!open ? recovery : null}
    <Modal title="新建委外工单" open={open} onCancel={close} width={640} style={{ top: 24 }} forceRender maskClosable={false}
      closable={!busy} keyboard={!busy} cancelButtonProps={{ disabled: busy }} confirmLoading={busy}
      okButtonProps={{ disabled: !ready || busy || Boolean(found) }} okText={request && !editing ? "重试原请求" : "保存草稿"} cancelText="关闭"
      onOk={() => void submit(Boolean(request && !editing))}>
      <div ref={recoveryBody} style={{ maxHeight: "calc(100dvh - 180px)", overflowY: "auto", paddingInlineEnd: 4 }}>
      {recovery}
      <Form form={form} layout="vertical" disabled={busy || !canEdit || !ready}>
        <Form.Item name="bhId" label="关联备货申请（可选，仅已审批）">
          <RemoteSelect api="/api/outsource/bh?status=approved" getLabel={r => `${String(r.docNo)}${r.orderType ? `（${formatOrderType(String(r.orderType))}）` : ""}`}
            placeholder="搜索已审批备货单号 / SKU" onChange={() => form.setFieldValue("orderType", undefined)} />
        </Form.Item>
        <Form.Item name="productSkuId" label="成品 SKU" rules={[{ required: true, message: "必须选择成品 SKU" }]}>
          <RemoteSelect api="/api/master/sku?type=finished" getLabel={r => `${String(r.code)} ${String(r.name)}`} placeholder="选择成品（须有生效 BOM）" />
        </Form.Item>
        <Form.Item name="qty" label="数量" rules={[{ required: true, message: "数量必填" }]}>
          <InputNumber stringMode min="0.0001" precision={4} style={{ width: "100%" }} />
        </Form.Item>
        <Form.Item name="supplierId" label="加工厂" rules={[{ required: true, message: "必须选择加工厂" }]}>
          <RemoteSelect api="/api/master/supplier" getLabel={r => `${String(r.code)} ${String(r.name)}`} filterRow={r => Array.isArray(r.kinds) && r.kinds.includes("processor")} placeholder="选择加工厂" />
        </Form.Item>
        <Form.Item name="feeRatePlan" label="加工费计划单价（元）" rules={[{ required: true, message: "加工费计划单价必填" }]}>
          <InputNumber stringMode min="0.01" precision={2} style={{ width: "100%" }} />
        </Form.Item>
        <Form.Item name="dueDate" label="交期"><DatePicker style={{ width: "100%" }} /></Form.Item>
        <Form.Item name="orderType" label="订单类型" extra="关联申请已有类型时必须继承；未分类或无来源时可人工明确。成品返单10–20天是目标，首批收货不等于全量交付。">
          <Select allowClear options={toOptions(ORDER_TYPE_LABELS)} placeholder="选择类型；关联申请留空时继承来源" />
        </Form.Item>
        <Form.Item name="remark" label="备注"><Input.TextArea rows={2} maxLength={500} /></Form.Item>
      </Form>
      </div>
    </Modal>
  </>;
}
