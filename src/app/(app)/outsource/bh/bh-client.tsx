"use client";

import { useDocumentTarget } from "@/components/useDocumentTarget";
import { DOCUMENT_TRANSIENT_PARAMS } from "@/lib/document-links";

import SearchInput from "@/components/SearchInput";

import { Suspense, useRef, useState } from "react";
import { Alert, App, Button, DatePicker, Descriptions, Form, Input, InputNumber, Modal, Popconfirm, Select, Space, Table, Tabs, Tag, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { DeleteOutlined, PlusOutlined, ReloadOutlined } from "@ant-design/icons";
import dayjs, { type Dayjs } from "dayjs";
import RemoteSelect from "@/components/RemoteSelect";
import ChainStrip from "@/components/ChainStrip";
import ApprovalBrief from "@/components/ApprovalBrief";
import DocStatusTag from "@/components/DocStatusTag";
import DocWindowFilterTag from "@/components/DocWindowFilterTag";
import { postJson, putJson } from "@/components/fetchJson";
import { useDocumentRead } from "@/components/useDocumentRead";
import DocumentDrawer from "@/components/DocumentDrawer";
import LoadErrorAlert from "@/components/LoadErrorAlert";
import ListToolbar from "@/components/ListToolbar";
import { useListState } from "@/components/useListState";
import { ORDER_TYPE_LABELS, formatOrderType, toOptions } from "@/components/labels";
import ApprovalTimeline from "@/components/ApprovalTimeline";
import styles from "./bh-editor.module.css";

interface BhRow {
  id: number;
  docNo: string;
  status: string;
  orderType: string | null;
  lineCount: number;
  createdByName: string | null;
  createdAt: string;
}

interface BhLine {
  id: number;
  skuId: number;
  skuCode: string;
  skuName: string;
  baseUom: string;
  qty: string;
  expectDate: string | null;
}

interface DocApproval {
  approverName: string | null;
  action: "approve" | "reject";
  comment: string | null;
  createdAt: string;
}

interface BhDetail {
  id: number;
  docNo: string;
  status: string;
  remark: string | null;
  orderType: string | null;
  version: number;
  createdAt: string;
  createdByName: string | null;
  lines: BhLine[];
  approvals: DocApproval[];
  sourceSkuLocked: boolean;
  origin: { note: string; edited: boolean };
  actions: {
    edit: boolean; editReason: string | null; submit: boolean; void: boolean;
    withdraw: boolean; approve: boolean; approvalReason: string | null;
    complete: boolean; shortClose: boolean;
  };
}

interface CreateFormValues {
  orderType?: string;
  remark?: string;
  reason?: string;
  lines?: { skuId: number; qty: string; expectDate?: Dayjs | null }[];
}

const STATUS_TABS = [
  { key: "", label: "全部" },
  { key: "draft", label: "草稿" },
  { key: "pending", label: "待审批" },
  { key: "approved", label: "已审批" },
  { key: "void", label: "已作废" },
];

/** 提交/审批/驳回按钮组（委外链通用请求体：submit {version}，approve {action,comment,version}） */
function BhActions({
  doc,
  onChanged,
  onEdit,
  onError,
}: {
  doc: BhDetail;
  onChanged: () => void;
  onEdit: () => void;
  onError: (message: string | null) => void;
}) {
  const { message } = App.useApp();
  const [loading, setLoading] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectComment, setRejectComment] = useState("");
  const [shortCloseOpen, setShortCloseOpen] = useState(false);
  const [shortCloseReason, setShortCloseReason] = useState("");
  const writing = useRef(false);

  const post = async (path: string, body: unknown, successText: string) => {
    if (writing.current) return false;
    writing.current = true;
    onError(null);
    setLoading(true);
    try {
      await postJson(`/api/outsource/bh/${doc.id}/${path}`, body);
      message.success(successText);
      onChanged();
      return true;
    } catch (e) {
      onError((e as Error).message);
      return false;
    } finally {
      writing.current = false;
      setLoading(false);
    }
  };

  if (doc.status === "draft") {
    return (
      <Space wrap>
      {doc.actions?.edit && <Button disabled={loading} onClick={onEdit}>修改草稿</Button>}
      {doc.actions?.submit && <Popconfirm
        title="确认提交审批？"
        okText="提交"
        cancelText="取消"
        onConfirm={() => void post("submit", { version: doc.version }, "已提交审批")}
      >
        <Button type="primary" loading={loading}>
          提交
        </Button>
      </Popconfirm>}
      {doc.actions?.void && <Popconfirm
        title="作废本单？"
        description="作废后不可恢复；单据与审计仍保留，不删除历史。"
        okText="作废"
        okButtonProps={{ danger: true }}
        cancelText="取消"
        onConfirm={() => void post("transition", { action: "void", version: doc.version }, "已作废")}
      >
        <Button danger loading={loading}>作废</Button>
      </Popconfirm>}
      </Space>
    );
  }

  if (doc.status === "pending") {
    return (
      <Space wrap>
        {doc.actions?.approve && <Popconfirm
          title="确认审批通过？"
          okText="通过"
          cancelText="取消"
          onConfirm={() =>
            void post("approve", { action: "approve", version: doc.version }, "审批已通过")
          }
        >
          <Button type="primary" loading={loading}>
            审批通过
          </Button>
        </Popconfirm>}
        {doc.actions?.approve && <Button danger loading={loading} onClick={() => setRejectOpen(true)}>
          驳回
        </Button>}
        {/* 撤回：制单人收回自己的提交（服务端校验 createdBy，非制单人会被拒） */}
        {doc.actions?.withdraw && <Popconfirm
          title="撤回本单？"
          description="撤回后回到草稿，可继续修改再提交。"
          okText="撤回"
          cancelText="取消"
          onConfirm={() => void post("withdraw", { version: doc.version }, "已撤回，单据回到草稿")}
        >
          <Button loading={loading}>撤回</Button>
        </Popconfirm>}
        <Modal
          title="驳回单据"
          open={rejectOpen}
          okText="确认驳回"
          okButtonProps={{ danger: true }}
          cancelText="取消"
          confirmLoading={loading}
          onCancel={() => setRejectOpen(false)}
          onOk={() =>
            void post(
              "approve",
              { action: "reject", comment: rejectComment.trim() || undefined, version: doc.version },
              "已驳回",
            ).then((ok) => {
              if (ok) {
                setRejectOpen(false);
                setRejectComment("");
              }
            })
          }
        >
          <Input.TextArea
            rows={3}
            maxLength={200}
            placeholder="驳回意见（可选）"
            value={rejectComment}
            onChange={(e) => setRejectComment(e.target.value)}
          />
        </Modal>
      </Space>
    );
  }

  // 已审批/执行中：完成 或 短关。此前 BH/WO/PO 没有任何到达「已完成」的路径，
  // 少送尾数的单据会永久卡在「执行中」。
  if (doc.status === "approved" || doc.status === "in_progress") {
    return (
      <Space wrap>
        {doc.actions?.complete ? (
          <Popconfirm
            title="标记本单已完成？"
            okText="完成"
            cancelText="取消"
            onConfirm={() => void post("transition", { action: "complete", version: doc.version }, "已完成")}
          >
            <Button type="primary" loading={loading}>完成</Button>
          </Popconfirm>
        ) : null}
        {doc.actions?.shortClose && <Button loading={loading} onClick={() => setShortCloseOpen(true)}>短关</Button>}
        <Modal
          title="短关单据"
          open={shortCloseOpen}
          okText="确认短关"
          cancelText="取消"
          confirmLoading={loading}
          onCancel={() => setShortCloseOpen(false)}
          onOk={() =>
            void post(
              "transition",
              { action: "short_close", reason: shortCloseReason.trim(), version: doc.version },
              "已短关",
            ).then((ok) => {
              if (ok) {
                setShortCloseOpen(false);
                setShortCloseReason("");
              }
            })
          }
        >
          <Input.TextArea
            rows={3}
            maxLength={200}
            placeholder="短关原因（必填，例如：供应商少送 3 支，不再补）"
            value={shortCloseReason}
            onChange={(e) => setShortCloseReason(e.target.value)}
          />
        </Modal>
      </Space>
    );
  }

  return null;
}

function BhInner() {
  const { message } = App.useApp();
  const [form] = Form.useForm<CreateFormValues>();
  // 列表页状态平台（E6-P1）：筛选/分页进 URL，密度与已保存视图存本地
  // from/to = 制单时间窗（上海业务日，含首尾）：全链漏斗「计划」级点数字回链到本页时带过来
  const listState = useListState({ transientParams: DOCUMENT_TRANSIENT_PARAMS, key: "bh", defaults: { q: "", status: "", from: "", to: "" }, defaultPageSize: 20 });
  const { filters, page, pageSize } = listState;
  const q = filters.q;
  const status = filters.status;
  const from = filters.from;
  const to = filters.to;

  const [createOpen, setCreateOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [editTarget, setEditTarget] = useState<BhDetail | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<{ id: number; message: string | null } | null>(null);

  const documentSelection = useDocumentTarget();
  const { id: detailId, setId: setDetailId } = documentSelection;
  const params = new URLSearchParams({ q, page: String(page), pageSize: String(pageSize) });
  if (status) params.set("status", status);
  if (from) params.set("from", from);
  if (to) params.set("to", to);
  const listRead = useDocumentRead<{ rows: BhRow[]; total: number }>(`/api/outsource/bh?${params}`);
  const rows = listRead.data?.rows ?? [];
  const total = listRead.data?.total ?? 0;
  const loading = listRead.phase === "loading";
  const load = listRead.retry;
  const detailRead = useDocumentRead<BhDetail>(detailId == null ? null : `/api/outsource/bh/${detailId}`);
  const detail = detailRead.data;
  const detailLoading = detailRead.phase === "loading";

  const handleCreate = async () => {
    if (savingRef.current) return;
    savingRef.current = true;
    try {
      const values = await form.validateFields();
      const lines = (values.lines ?? []).filter((l) => l && l.skuId != null);
      if (lines.length === 0) {
        message.warning("至少添加一行明细");
        return;
      }
      setSaving(true);
      setSaveError(null);
      const body = {
        orderType: values.orderType || undefined,
        remark: values.remark?.trim() || undefined,
        lines: lines.map((l) => ({
          skuId: l.skuId,
          qty: String(l.qty),
          expectDate: l.expectDate ? l.expectDate.format("YYYY-MM-DD") : undefined,
        })),
      };
      const result = editTarget
        ? await putJson<{ id: number }>(`/api/outsource/bh/${editTarget.id}`, { ...body, version: editTarget.version, reason: values.reason?.trim() })
        : await postJson<{ id: number }>("/api/outsource/bh", body);
      message.success(editTarget ? "草稿已修正，可核对后重新提交" : "备货申请已创建（草稿）");
      setCreateOpen(false);
      setEditTarget(null);
      form.resetFields();
      setDetailId(result.id);
      detailRead.retry();
      void load();
    } catch (e) {
      if (e instanceof Error && e.message) setSaveError(e.message);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const columns: ColumnsType<BhRow> = [
    {
      title: "单据号",
      dataIndex: "docNo",
      width: 160,
      render: (v: string, r) => (
        <Typography.Link onClick={() => setDetailId(r.id)}>{v}</Typography.Link>
      ),
    },
    {
      title: "订单类型",
      dataIndex: "orderType",
      width: 120,
      render: (v: string | null) => (v ? <Tag color="blue">{formatOrderType(v)}</Tag> : "—"),
    },
    { title: "行数", dataIndex: "lineCount", width: 80, align: "right" },
    { title: "状态", dataIndex: "status", width: 100, render: (v: string) => <DocStatusTag status={v} /> },
    { title: "制单人", dataIndex: "createdByName", width: 100, render: (v: string | null) => v ?? "—" },
    {
      title: "时间",
      dataIndex: "createdAt",
      width: 160,
      render: (v: string) => dayjs(v).format("YYYY-MM-DD HH:mm"),
    },
    {
      title: "操作",
      key: "_actions",
      width: 80,
      render: (_, r) => (
        <Button type="link" size="small" onClick={() => setDetailId(r.id)}>
          查看
        </Button>
      ),
    },
  ];

  const lineColumns: ColumnsType<BhLine> = [
    { title: "SKU 编码", dataIndex: "skuCode", width: 120 },
    { title: "名称", dataIndex: "skuName" },
    { title: "数量", dataIndex: "qty", width: 110, align: "right" },
    { title: "基础单位", dataIndex: "baseUom", width: 90 },
    {
      title: "期望到货",
      dataIndex: "expectDate",
      width: 110,
      render: (v: string | null) => v ?? "—",
    },
  ];

  return (
    <div>
      <Typography.Title level={4} style={{ marginTop: 0 }}>
        备货申请（BH）
      </Typography.Title>
      <Tabs
        activeKey={status}
        items={STATUS_TABS}
        onChange={(key) => listState.setFilter({ status: key })}
      />
      <ListToolbar
        state={listState}
        primaryActions={
          <>
            <Button icon={<ReloadOutlined />} onClick={() => void load()}>
              刷新
            </Button>
            <Button
              type="primary"
              icon={<PlusOutlined />}
              onClick={() => {
                form.resetFields();
                setEditTarget(null);
                setSaveError(null);
                setCreateOpen(true);
              }}
            >
              新建备货申请
            </Button>
          </>
        }
        extra={
          <>
            <SearchInput
              key={q}
              allowClear
              defaultValue={q}
              placeholder="搜索单号 / SKU 编码 / 货品名称"
              style={{ width: 240 }}
              onSearch={(value) => listState.setFilter({ q: value.trim() })}
            />
            <DocWindowFilterTag from={from} to={to} onClear={() => listState.setFilter({ from: "", to: "" })} />
          </>
        }
      />
      <LoadErrorAlert error={listRead.error} onRetry={load} subject="备货申请列表" />
      <Table<BhRow>
        rowKey="id"
        size={listState.tableSize}
        columns={columns}
        dataSource={rows}
        loading={loading}
        scroll={{ x: "max-content" }}
        pagination={listState.paginationProps({ total: total })}
      />

      <Modal
        title={editTarget ? `修改草稿 · ${editTarget.docNo}` : "新建备货申请"}
        className={styles.editor}
        style={{ top: 24, paddingBottom: 24 }}
        open={createOpen}
        onOk={() => void handleCreate()}
        onCancel={() => {
          if (savingRef.current) return;
          setCreateOpen(false);
          if (editTarget) setDetailId(editTarget.id);
        }}
        confirmLoading={saving}
        okButtonProps={{ "aria-label": "保存草稿", "aria-busy": saving }}
        width={720}
        forceRender
        maskClosable={false}
        cancelButtonProps={{ disabled: saving }}
        closable={!saving}
        okText="保存草稿"
        cancelText="取消"
      >
        {saveError && <Alert type="error" showIcon message="保存未完成确认，输入已保留" description={<>
          {saveError}
          {editTarget && <div><Button type="link" onClick={() => {
            setCreateOpen(false); setDetailId(editTarget.id); detailRead.retry();
          }}>查看服务器当前单据</Button><Typography.Text type="secondary">核对结果后再修改；不会自动覆盖新版本。</Typography.Text></div>}
        </>} style={{ marginBottom: 12 }} />}
        {editTarget && <Alert type="info" showIcon message={editTarget.sourceSkuLocked
          ? "已绑定来源SKU：可修正数量、日期和备注；不能增删或替换SKU。原始计划/首单证据保留。"
          : "仅修改当前草稿，保存保留单号和制单人。提交审批后需先撤回或驳回才能再修改。"} style={{ marginBottom: 12 }} />}
        <Form form={form} layout="vertical" disabled={saving}>
          {editTarget && <Form.Item name="reason" label="修改原因" rules={[{ required: true, whitespace: true, message: "请填写修改原因" }]}>
            <Input.TextArea rows={2} maxLength={500} placeholder="说明数量、日期或其他内容为何需要调整" />
          </Form.Item>}
          <Form.Item name="orderType" label="订单类型">
            <Select allowClear options={toOptions(ORDER_TYPE_LABELS)} placeholder="常规备货/新品首单/紧急需求/月备货" />
          </Form.Item>
          <Form.Item name="remark" label="备注">
            <Input.TextArea rows={2} maxLength={500} />
          </Form.Item>
          <Typography.Text strong>明细行</Typography.Text>
          <Form.List name="lines" initialValue={[{}]}>
            {(fields, { add, remove }) => (
              <div style={{ marginTop: 8 }}>
                {fields.map(({ key, name, ...restField }) => (
                  <div key={key} className={styles.line}>
                    <Form.Item
                      {...restField}
                      name={[name, "skuId"]}
                      label={`明细 ${name + 1} · SKU`}
                      className={styles.sku}
                      rules={[{ required: true, message: "必须选择 SKU" }]}
                      style={{ marginBottom: 8 }}
                    >
                      <RemoteSelect
                        api="/api/master/sku"
                        getLabel={(r) => `${String(r.code)} ${String(r.name)}${r.baseUom ? ` · ${String(r.baseUom)}` : ""}`}
                        placeholder="选择 SKU"
                        disabled={saving || editTarget?.sourceSkuLocked}
                        style={{ width: "100%" }}
                      />
                    </Form.Item>
                    <Form.Item
                      {...restField}
                      name={[name, "qty"]}
                      label="数量（基础单位）"
                      rules={[{ required: true, message: "数量必填" }]}
                      style={{ marginBottom: 8 }}
                    >
                      <InputNumber stringMode min="0.0001" max="9999999999.9999" precision={4} placeholder="数量" style={{ width: "100%" }} />
                    </Form.Item>
                    <Form.Item {...restField} name={[name, "expectDate"]} label="期望到货日" style={{ marginBottom: 8 }}>
                      <DatePicker placeholder="期望到货日" style={{ width: "100%" }} />
                    </Form.Item>
                    <Button
                      type="text"
                      danger
                      icon={<DeleteOutlined />}
                      aria-label={`删除明细 ${name + 1}`}
                      className={styles.remove}
                      disabled={saving || fields.length <= 1 || editTarget?.sourceSkuLocked}
                      onClick={() => remove(name)}
                    />
                  </div>
                ))}
                <Button type="dashed" disabled={saving || editTarget?.sourceSkuLocked} block icon={<PlusOutlined />} onClick={() => add({})}>
                  添加明细行
                </Button>
              </div>
            )}
          </Form.List>
        </Form>
      </Modal>

      <DocumentDrawer
        key={detailId ?? "invalid-document"}
        title={
          detail ? (
            <Space>
              <span>{detail.docNo}</span>
              <DocStatusTag status={detail.status} />
            </Space>
          ) : (
            "备货申请详情"
          )
        }
        open={documentSelection.present}
        readError={documentSelection.error ?? detailRead.error}
        onRetry={detailId != null ? detailRead.retry : undefined}
        onClose={() => setDetailId(null)}
        width={720}
        loading={detailLoading}
        extra={
          detail ? (
            <BhActions
              key={`${detail.id}:${detail.version}`}
              doc={detail}
              onEdit={() => {
                setEditTarget(detail); setSaveError(null); form.resetFields();
                form.setFieldsValue({ orderType: detail.orderType ?? undefined, remark: detail.remark ?? "", reason: "",
                  lines: detail.lines.map(l => ({ skuId: l.skuId, qty: l.qty, expectDate: l.expectDate ? dayjs(l.expectDate) : null })) });
                setDetailId(null);
                setCreateOpen(true);
              }}
              onError={message => setActionError({ id: detail.id, message })}
              onChanged={() => {
                detailRead.retry();
                void load();
              }}
            />
          ) : null
        }
      >
        <LoadErrorAlert error={detailRead.error} onRetry={detailRead.retry} subject="备货申请详情" />
        {detail ? (
          <div>
            {actionError?.id === detail.id && actionError.message && <Alert type="error" showIcon message={actionError.message}
              action={<Button onClick={detailRead.retry}>刷新核对</Button>} style={{ marginBottom: 12 }} />}
            {detail.actions?.approvalReason && detail.status === "pending" && <Alert type="info" showIcon
              message={detail.actions.approvalReason} style={{ marginBottom: 12 }} />}
            {detail.actions?.editReason && <Alert type="warning" showIcon message={detail.actions.editReason} style={{ marginBottom: 12 }} />}
            {detail.origin?.edited && <Alert type="info" showIcon message={detail.origin.note} style={{ marginBottom: 12 }} />}
            <ChainStrip docType="bh" id={detail.id} />
            {detail.status === "pending" ? <ApprovalBrief docType="bh" docId={detail.id} /> : null}
            <Descriptions column={{ xs: 1, sm: 2 }} size="small" bordered styles={{ label: { width: 112, whiteSpace: "nowrap" } }} style={{ marginBottom: 16 }}>
              <Descriptions.Item label="订单类型">{formatOrderType(detail.orderType)}</Descriptions.Item>
              <Descriptions.Item label="制单人">{detail.createdByName ?? "—"}</Descriptions.Item>
              <Descriptions.Item label="制单时间">
                {dayjs(detail.createdAt).format("YYYY-MM-DD HH:mm")}
              </Descriptions.Item>
              <Descriptions.Item label="备注">{detail.remark ?? "—"}</Descriptions.Item>
            </Descriptions>
            <Typography.Title level={5}>明细行</Typography.Title>
            <Table<BhLine>
              rowKey="id"
              size="small"
              columns={lineColumns}
              dataSource={detail.lines}
              pagination={false}
              scroll={{ x: "max-content" }}
              style={{ marginBottom: 24 }}
            />
            {detail.approvals.length > 0 ? (
              <>
                <Typography.Title level={5}>审批记录</Typography.Title>
                <ApprovalTimeline items={detail.approvals} />
              </>
            ) : null}
          </div>
        ) : null}
      </DocumentDrawer>
    </div>
  );
}

export default function BhClient() {
  // useListState 读 useSearchParams，需要 Suspense 边界
  return (
    <Suspense>
      <BhInner />
    </Suspense>
  );
}
