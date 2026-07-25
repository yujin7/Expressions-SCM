"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { App, Button, DatePicker, Descriptions, Drawer, Form, Input, InputNumber, Modal, Popconfirm, Select, Space, Table, Tabs, Tag, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { DeleteOutlined, PlusOutlined, ReloadOutlined } from "@ant-design/icons";
import dayjs, { type Dayjs } from "dayjs";
import RemoteSelect from "@/components/RemoteSelect";
import ChainStrip from "@/components/ChainStrip";
import ApprovalBrief from "@/components/ApprovalBrief";
import DocStatusTag from "@/components/DocStatusTag";
import { fetchJson, postJson } from "@/components/fetchJson";
import ListToolbar from "@/components/ListToolbar";
import { useListState } from "@/components/useListState";
import { ORDER_TYPE_LABELS, formatOrderType, toOptions } from "@/components/labels";
import ApprovalTimeline from "@/components/ApprovalTimeline";

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
}

interface CreateFormValues {
  orderType?: string;
  remark?: string;
  lines?: { skuId: number; qty: number; expectDate?: Dayjs }[];
}

const STATUS_TABS = [
  { key: "", label: "全部" },
  { key: "draft", label: "草稿" },
  { key: "pending", label: "待审批" },
  { key: "approved", label: "已审批" },
];

/** 提交/审批/驳回按钮组（委外链通用请求体：submit {version}，approve {action,comment,version}） */
function BhActions({
  doc,
  onChanged,
}: {
  doc: { id: number; status: string; version: number };
  onChanged: () => void;
}) {
  const { message } = App.useApp();
  const [loading, setLoading] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectComment, setRejectComment] = useState("");

  const post = async (path: string, body: unknown, successText: string) => {
    setLoading(true);
    try {
      await postJson(`/api/outsource/bh/${doc.id}/${path}`, body);
      message.success(successText);
      onChanged();
      return true;
    } catch (e) {
      message.error((e as Error).message);
      return false;
    } finally {
      setLoading(false);
    }
  };

  if (doc.status === "draft") {
    return (
      <Popconfirm
        title="确认提交审批？"
        okText="提交"
        cancelText="取消"
        onConfirm={() => void post("submit", { version: doc.version }, "已提交审批")}
      >
        <Button type="primary" loading={loading}>
          提交
        </Button>
      </Popconfirm>
    );
  }

  if (doc.status === "pending") {
    return (
      <Space>
        <Popconfirm
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
        </Popconfirm>
        <Button danger loading={loading} onClick={() => setRejectOpen(true)}>
          驳回
        </Button>
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

  return null;
}

function BhInner() {
  const { message } = App.useApp();
  const [form] = Form.useForm<CreateFormValues>();
  const [rows, setRows] = useState<BhRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  // 列表页状态平台（E6-P1）：筛选/分页进 URL，密度与已保存视图存本地
  const listState = useListState({ key: "bh", defaults: { q: "", status: "" }, defaultPageSize: 20 });
  const { filters, page, pageSize } = listState;
  const q = filters.q;
  const status = filters.status;

  const [createOpen, setCreateOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  const [detailId, setDetailId] = useState<number | null>(null);
  const [detail, setDetail] = useState<BhDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ q, page: String(page), pageSize: String(pageSize) });
      if (status) params.set("status", status);
      const res = await fetchJson<{ rows: BhRow[]; total: number }>(
        `/api/outsource/bh?${params.toString()}`,
      );
      setRows(res.rows);
      setTotal(res.total);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [q, status, page, pageSize, message]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadDetail = useCallback(
    async (id: number) => {
      setDetailLoading(true);
      try {
        const res = await fetchJson<BhDetail>(`/api/outsource/bh/${id}`);
        setDetail(res);
      } catch (e) {
        message.error((e as Error).message);
      } finally {
        setDetailLoading(false);
      }
    },
    [message],
  );

  useEffect(() => {
    if (detailId != null) void loadDetail(detailId);
    else setDetail(null);
  }, [detailId, loadDetail]);

  const handleCreate = async () => {
    try {
      const values = await form.validateFields();
      const lines = (values.lines ?? []).filter((l) => l && l.skuId != null);
      if (lines.length === 0) {
        message.warning("至少添加一行明细");
        return;
      }
      setSaving(true);
      await postJson<{ id: number }>("/api/outsource/bh", {
        orderType: values.orderType || undefined,
        remark: values.remark?.trim() || undefined,
        lines: lines.map((l) => ({
          skuId: l.skuId,
          qty: String(l.qty),
          expectDate: l.expectDate ? l.expectDate.format("YYYY-MM-DD") : undefined,
        })),
      });
      message.success("备货申请已创建（草稿）");
      setCreateOpen(false);
      form.resetFields();
      void load();
    } catch (e) {
      if (e instanceof Error && e.message) message.error(e.message);
    } finally {
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
      <Space style={{ marginBottom: 12, display: "flex", justifyContent: "flex-end" }} wrap>
        <Button icon={<ReloadOutlined />} onClick={() => void load()}>
          刷新
        </Button>
        <Button
          type="primary"
          icon={<PlusOutlined />}
          onClick={() => {
            form.resetFields();
            setCreateOpen(true);
          }}
        >
          新建备货申请
        </Button>
      </Space>
      <ListToolbar
        state={listState}
        extra={
          <Input.Search
            key={q}
            allowClear
            defaultValue={q}
            placeholder="搜索单据号"
            style={{ width: 240 }}
            onSearch={(value) => listState.setFilter({ q: value.trim() })}
          />
        }
      />
      <Table<BhRow>
        rowKey="id"
        size={listState.tableSize}
        columns={columns}
        dataSource={rows}
        loading={loading}
        pagination={listState.paginationProps({ total: total })}
      />

      <Modal
        title="新建备货申请"
        open={createOpen}
        onOk={() => void handleCreate()}
        onCancel={() => setCreateOpen(false)}
        confirmLoading={saving}
        width={720}
        forceRender
        maskClosable={false}
        okText="保存草稿"
        cancelText="取消"
      >
        <Form form={form} layout="vertical">
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
                  <Space key={key} align="baseline" style={{ display: "flex", marginBottom: 4 }} wrap>
                    <Form.Item
                      {...restField}
                      name={[name, "skuId"]}
                      rules={[{ required: true, message: "必须选择 SKU" }]}
                      style={{ marginBottom: 8 }}
                    >
                      <RemoteSelect
                        api="/api/master/sku"
                        getLabel={(r) => `${String(r.code)} ${String(r.name)}`}
                        placeholder="选择 SKU"
                        style={{ width: 280 }}
                      />
                    </Form.Item>
                    <Form.Item
                      {...restField}
                      name={[name, "qty"]}
                      rules={[{ required: true, message: "数量必填" }]}
                      style={{ marginBottom: 8 }}
                    >
                      <InputNumber min={0.0001} precision={4} placeholder="数量" style={{ width: 130 }} />
                    </Form.Item>
                    <Form.Item {...restField} name={[name, "expectDate"]} style={{ marginBottom: 8 }}>
                      <DatePicker placeholder="期望到货日" style={{ width: 140 }} />
                    </Form.Item>
                    <Button
                      type="text"
                      danger
                      icon={<DeleteOutlined />}
                      disabled={fields.length <= 1}
                      onClick={() => remove(name)}
                    />
                  </Space>
                ))}
                <Button type="dashed" block icon={<PlusOutlined />} onClick={() => add({})}>
                  添加明细行
                </Button>
              </div>
            )}
          </Form.List>
        </Form>
      </Modal>

      <Drawer
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
        open={detailId != null}
        onClose={() => setDetailId(null)}
        width={720}
        loading={detailLoading}
        extra={
          detail ? (
            <BhActions
              doc={{ id: detail.id, status: detail.status, version: detail.version }}
              onChanged={() => {
                void loadDetail(detail.id);
                void load();
              }}
            />
          ) : null
        }
      >
        {detail ? (
          <div>
            <ChainStrip docType="bh" id={detail.id} />
            {detail.status === "pending" ? <ApprovalBrief docType="bh" docId={detail.id} /> : null}
            <Descriptions column={2} size="small" bordered style={{ marginBottom: 16 }}>
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
      </Drawer>
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
