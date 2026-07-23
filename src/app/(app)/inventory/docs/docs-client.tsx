"use client";

import { useCallback, useEffect, useState } from "react";
import {
  App,
  Button,
  Descriptions,
  Drawer,
  Form,
  Input,
  InputNumber,
  Modal,
  Select,
  Space,
  Table,
  Tabs,
  Tag,
  Timeline,
  Typography,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import { DeleteOutlined, PlusOutlined, ReloadOutlined } from "@ant-design/icons";
import dayjs from "dayjs";
import ExportButton from "@/components/ExportButton";
import RemoteSelect from "@/components/RemoteSelect";
import DocStatusTag from "@/components/DocStatusTag";
import DocActions from "@/components/DocActions";
import { fetchJson, postJson } from "@/components/fetchJson";
import { STOCK_SUBTYPE_LABELS, toOptions } from "@/components/labels";

interface DocRow {
  id: number;
  docNo: string;
  subtype: string;
  status: string;
  warehouseName: string;
  toWarehouseName: string | null;
  lineCount: number;
  createdByName: string;
  createdAt: string;
}

interface DocLine {
  id: number;
  skuId: number;
  skuCode: string;
  skuName: string;
  baseUom: string;
  qty: string;
  price: string | null;
}

interface DocApproval {
  approverName: string;
  action: "approve" | "reject";
  comment: string | null;
  createdAt: string;
}

interface DocDetail {
  id: number;
  docNo: string;
  subtype: string;
  status: string;
  version: number;
  remark: string | null;
  warehouseId: number;
  warehouseName: string;
  toWarehouseId: number | null;
  toWarehouseName: string | null;
  reversalOfId: number | null;
  lines: DocLine[];
  approvals: DocApproval[];
  createdByName: string;
  createdAt: string;
}

interface CreateFormValues {
  subtype: string;
  warehouseId: number;
  toWarehouseId?: number;
  remark?: string;
  lines?: { skuId: number; qty: number; price?: number }[];
}

const SUBTYPE_COLORS: Record<string, string> = {
  opening: "cyan",
  issue_out: "orange",
  sales_out: "blue",
  transfer: "geekblue",
  reversal: "red",
  purchase_in: "green",
  outsource_in: "purple",
  outsource_in_spare: "magenta",
  count_adjust: "gold",
  loss_writeoff: "volcano",
  transit_writeoff: "default",
};

/** 可手工创建的子类型（reversal 只能由红字冲销生成） */
const MANUAL_SUBTYPE_LABELS: Record<string, string> = {
  opening: "期初",
  issue_out: "领料出",
  sales_out: "销售出",
  transfer: "调拨",
};

const STATUS_TABS = [
  { key: "", label: "全部" },
  { key: "draft", label: "草稿" },
  { key: "pending", label: "待审批" },
  { key: "completed", label: "已完成" },
  { key: "closed", label: "已关闭" },
];

function SubtypeTag({ subtype }: { subtype: string }) {
  return <Tag color={SUBTYPE_COLORS[subtype] ?? "default"}>{STOCK_SUBTYPE_LABELS[subtype] ?? subtype}</Tag>;
}

export default function DocsClient() {
  const { message } = App.useApp();
  const [form] = Form.useForm<CreateFormValues>();
  const [rows, setRows] = useState<DocRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [status, setStatus] = useState("");
  const [subtype, setSubtype] = useState<string | undefined>();
  const [q, setQ] = useState("");

  const [createOpen, setCreateOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const createSubtype = Form.useWatch("subtype", form);

  const [detailId, setDetailId] = useState<number | null>(null);
  const [detail, setDetail] = useState<DocDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ q, page: String(page), pageSize: String(pageSize) });
      if (status) params.set("status", status);
      if (subtype) params.set("subtype", subtype);
      const res = await fetchJson<{ rows: DocRow[]; total: number }>(
        `/api/inventory/stock-doc?${params.toString()}`,
      );
      setRows(res.rows);
      setTotal(res.total);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [q, status, subtype, page, pageSize, message]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadDetail = useCallback(
    async (id: number) => {
      setDetailLoading(true);
      try {
        const res = await fetchJson<DocDetail>(`/api/inventory/stock-doc/${id}`);
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
      const body = {
        subtype: values.subtype,
        warehouseId: values.warehouseId,
        toWarehouseId: values.subtype === "transfer" ? values.toWarehouseId : undefined,
        remark: values.remark?.trim() || undefined,
        lines: lines.map((l) => ({
          skuId: l.skuId,
          qty: l.qty,
          price: values.subtype === "opening" ? l.price : undefined,
        })),
      };
      await postJson<{ id: number }>("/api/inventory/stock-doc", body);
      message.success("单据已创建（草稿）");
      setCreateOpen(false);
      form.resetFields();
      void load();
    } catch (e) {
      if (e instanceof Error && e.message) message.error(e.message);
    } finally {
      setSaving(false);
    }
  };

  const columns: ColumnsType<DocRow> = [
    {
      title: "单据号",
      dataIndex: "docNo",
      width: 160,
      render: (v: string, r) => (
        <Typography.Link onClick={() => setDetailId(r.id)}>{v}</Typography.Link>
      ),
    },
    { title: "类型", dataIndex: "subtype", width: 120, render: (v: string) => <SubtypeTag subtype={v} /> },
    {
      title: "仓库",
      dataIndex: "warehouseName",
      render: (_, r) =>
        r.subtype === "transfer" && r.toWarehouseName
          ? `${r.warehouseName} → ${r.toWarehouseName}`
          : r.warehouseName,
    },
    { title: "行数", dataIndex: "lineCount", width: 70, align: "right" },
    { title: "制单人", dataIndex: "createdByName", width: 100 },
    {
      title: "时间",
      dataIndex: "createdAt",
      width: 160,
      render: (v: string) => dayjs(v).format("YYYY-MM-DD HH:mm"),
    },
    { title: "状态", dataIndex: "status", width: 100, render: (v: string) => <DocStatusTag status={v} /> },
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

  const lineColumns: ColumnsType<DocLine> = [
    { title: "SKU 编码", dataIndex: "skuCode", width: 110 },
    { title: "名称", dataIndex: "skuName" },
    { title: "数量", dataIndex: "qty", width: 110, align: "right" },
    {
      title: "单价",
      dataIndex: "price",
      width: 100,
      align: "right",
      render: (v: string | null) => v ?? "—",
    },
    { title: "基础单位", dataIndex: "baseUom", width: 90 },
  ];

  return (
    <div>
      <Typography.Title level={4} style={{ marginTop: 0 }}>
        库存单据
      </Typography.Title>
      <Tabs
        activeKey={status}
        items={STATUS_TABS}
        onChange={(key) => {
          setStatus(key);
          setPage(1);
        }}
      />
      <Space style={{ marginBottom: 16, display: "flex", justifyContent: "space-between" }} wrap>
        <Space wrap>
          <Input.Search
            allowClear
            placeholder="搜索单据号"
            style={{ width: 240 }}
            onSearch={(value) => {
              setQ(value.trim());
              setPage(1);
            }}
          />
          <Select
            allowClear
            placeholder="全部类型"
            style={{ width: 160 }}
            options={toOptions(STOCK_SUBTYPE_LABELS)}
            value={subtype}
            onChange={(v) => {
              setSubtype(v);
              setPage(1);
            }}
          />
        </Space>
        <Space>
          <ExportButton
            href={`/api/export/stock-docs?${new URLSearchParams({
              q,
              ...(status ? { status } : {}),
              ...(subtype ? { subtype } : {}),
            }).toString()}`}
          />
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
            新建单据
          </Button>
        </Space>
      </Space>
      <Table<DocRow>
        rowKey="id"
        size="middle"
        columns={columns}
        dataSource={rows}
        scroll={{ x: "max-content" }}
        loading={loading}
        pagination={{
          current: page,
          pageSize,
          total,
          showSizeChanger: true,
          showTotal: (t) => `共 ${t} 条`,
          onChange: (p, ps) => {
            setPage(p);
            setPageSize(ps);
          },
        }}
      />

      <Modal
        title="新建库存单据"
        open={createOpen}
        onOk={() => void handleCreate()}
        onCancel={() => setCreateOpen(false)}
        confirmLoading={saving}
        width="min(720px, 100vw)"
        forceRender
        maskClosable={false}
        okText="保存草稿"
        cancelText="取消"
      >
        <Form form={form} layout="vertical">
          <Form.Item name="subtype" label="类型" rules={[{ required: true, message: "必须选择单据类型" }]}>
            <Select
              options={toOptions(MANUAL_SUBTYPE_LABELS)}
              placeholder="期初/领料出/销售出/调拨（红字冲销不可手工创建）"
            />
          </Form.Item>
          <Form.Item name="warehouseId" label="仓库" rules={[{ required: true, message: "必须选择仓库" }]}>
            <RemoteSelect
              api="/api/master/warehouse"
              getLabel={(r) => `${String(r.code)} ${String(r.name)}`}
              placeholder="选择仓库"
            />
          </Form.Item>
          {createSubtype === "transfer" ? (
            <Form.Item
              name="toWarehouseId"
              label="目标仓库"
              rules={[{ required: true, message: "调拨必须选择目标仓库" }]}
            >
              <RemoteSelect
                api="/api/master/warehouse"
                getLabel={(r) => `${String(r.code)} ${String(r.name)}`}
                placeholder="选择目标仓库"
              />
            </Form.Item>
          ) : null}
          <Form.Item name="remark" label="备注">
            <Input.TextArea rows={2} maxLength={200} />
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
                    {createSubtype === "opening" ? (
                      <Form.Item {...restField} name={[name, "price"]} style={{ marginBottom: 8 }}>
                        <InputNumber min={0} precision={2} placeholder="单价（可选）" style={{ width: 130 }} />
                      </Form.Item>
                    ) : null}
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
            "单据详情"
          )
        }
        open={detailId != null}
        onClose={() => setDetailId(null)}
        width="min(720px, 100vw)"
        loading={detailLoading}
        extra={
          detail ? (
            <DocActions
              docType="stock-doc"
              apiBase="/api/inventory/stock-doc"
              doc={{
                id: detail.id,
                status: detail.status,
                version: detail.version,
                subtype: detail.subtype,
                reversalOfId: detail.reversalOfId,
              }}
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
            <Descriptions column={2} size="small" bordered style={{ marginBottom: 16 }}>
              <Descriptions.Item label="类型">
                <SubtypeTag subtype={detail.subtype} />
              </Descriptions.Item>
              <Descriptions.Item label="仓库">
                {detail.subtype === "transfer" && detail.toWarehouseName
                  ? `${detail.warehouseName} → ${detail.toWarehouseName}`
                  : detail.warehouseName}
              </Descriptions.Item>
              <Descriptions.Item label="制单人">{detail.createdByName}</Descriptions.Item>
              <Descriptions.Item label="制单时间">
                {dayjs(detail.createdAt).format("YYYY-MM-DD HH:mm")}
              </Descriptions.Item>
              <Descriptions.Item label="备注">{detail.remark ?? "—"}</Descriptions.Item>
              <Descriptions.Item label="红字引用">
                {detail.reversalOfId != null ? `#${detail.reversalOfId}` : "—"}
              </Descriptions.Item>
            </Descriptions>
            <Typography.Title level={5}>明细行</Typography.Title>
            <Table<DocLine>
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
                <Timeline
                  items={detail.approvals.map((a) => ({
                    color: a.action === "approve" ? "green" : "red",
                    children: (
                      <div>
                        <div>
                          {a.approverName} {a.action === "approve" ? "审批通过" : "驳回"}
                          <Typography.Text type="secondary" style={{ marginLeft: 8 }}>
                            {dayjs(a.createdAt).format("YYYY-MM-DD HH:mm")}
                          </Typography.Text>
                        </div>
                        {a.comment ? <Typography.Text type="secondary">{a.comment}</Typography.Text> : null}
                      </div>
                    ),
                  }))}
                />
              </>
            ) : null}
          </div>
        ) : null}
      </Drawer>
    </div>
  );
}
