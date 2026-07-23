"use client";

import { useCallback, useEffect, useState } from "react";
import {
  App,
  Alert,
  Button,
  DatePicker,
  Descriptions,
  Divider,
  Drawer,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tabs,
  Tag,
  Timeline,
  Tooltip,
  Typography,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import {
  DeleteOutlined,
  InfoCircleOutlined,
  PlusOutlined,
  ReloadOutlined,
  ThunderboltOutlined,
} from "@ant-design/icons";
import dayjs, { type Dayjs } from "dayjs";
import RemoteSelect from "@/components/RemoteSelect";
import DocStatusTag from "@/components/DocStatusTag";
import { fetchJson, postJson } from "@/components/fetchJson";
import { ORDER_TYPE_LABELS, formatOrderType, toOptions } from "@/components/labels";

interface WoRow {
  id: number;
  docNo: string;
  status: string;
  productSkuCode: string;
  productSkuName: string;
  qty: string;
  supplierName: string;
  orderType: string | null;
  dueDate: string | null;
  createdByName: string | null;
  createdAt: string;
}

interface WoLine {
  id: number;
  materialSkuId: number;
  skuCode: string;
  skuName: string;
  baseUom: string;
  qtyPer: string;
  planLossRatePct: string;
  grossReq: string;
  onHandAt: string;
  inTransitAt: string;
  suggestedQty: string;
}

interface DocApproval {
  approverName: string | null;
  action: "approve" | "reject";
  comment: string | null;
  createdAt: string;
}

interface WoDetail {
  id: number;
  docNo: string;
  status: string;
  remark: string | null;
  version: number;
  bhId: number | null;
  productSkuId: number;
  productSkuCode: string;
  productSkuName: string;
  qty: string;
  supplierId: number;
  supplierName: string;
  /** 敏感字段：非可见角色时后端已剥离（键不存在） */
  feeRatePlan?: string;
  orderType: string | null;
  dueDate: string | null;
  bomId: number;
  createdAt: string;
  createdByName: string | null;
  lines: WoLine[];
  approvals: DocApproval[];
}

interface CreateFormValues {
  bhId?: number;
  productSkuId: number;
  qty: number;
  supplierId: number;
  feeRatePlan: number;
  dueDate?: Dayjs;
  orderType?: string;
  remark?: string;
}

interface GenerateFormValues {
  poGroups?: {
    supplierId: number;
    lines?: { materialSkuId: number; qty: number; price: number }[];
  }[];
  jgQty?: number;
  jgDueDate?: Dayjs;
}

const STATUS_TABS = [
  { key: "", label: "全部" },
  { key: "draft", label: "草稿" },
  { key: "pending", label: "待审批" },
  { key: "approved", label: "已审批" },
];

function WoActions({
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
      await postJson(`/api/outsource/wo/${doc.id}/${path}`, body);
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
          title="确认审批通过？通过后将按生效 BOM 生成需求快照。"
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

export default function WoClient() {
  const { message, modal } = App.useApp();
  const [form] = Form.useForm<CreateFormValues>();
  const [genForm] = Form.useForm<GenerateFormValues>();
  const [rows, setRows] = useState<WoRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [status, setStatus] = useState("");
  const [q, setQ] = useState("");

  const [createOpen, setCreateOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [bhOptions, setBhOptions] = useState<{ value: number; label: string }[]>([]);

  const [detailId, setDetailId] = useState<number | null>(null);
  const [detail, setDetail] = useState<WoDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  /** 该 WO 已生成的 JG 单号（null=未生成） */
  const [existingJgNo, setExistingJgNo] = useState<string | null>(null);

  const [genOpen, setGenOpen] = useState(false);
  const [generating, setGenerating] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ q, page: String(page), pageSize: String(pageSize) });
      if (status) params.set("status", status);
      const res = await fetchJson<{ rows: WoRow[]; total: number }>(
        `/api/outsource/wo?${params.toString()}`,
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
        const res = await fetchJson<WoDetail>(`/api/outsource/wo/${id}`);
        setDetail(res);
        if (res.status === "approved") {
          // 委外链列表统一返回 {rows,total}
          const jgs = await fetchJson<{ rows: { docNo: string }[]; total: number }>(
            `/api/outsource/jg?woId=${id}&page=1&pageSize=1`,
          );
          setExistingJgNo(jgs.rows[0]?.docNo ?? null);
        } else {
          setExistingJgNo(null);
        }
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
    else {
      setDetail(null);
      setExistingJgNo(null);
    }
  }, [detailId, loadDetail]);

  // 创建弹窗打开时拉取已审批 BH 供关联（委外链列表返回 {rows,total}，RemoteSelect 不适用）
  useEffect(() => {
    if (!createOpen) return;
    let cancelled = false;
    fetchJson<{ rows: { id: number; docNo: string; orderType: string | null }[]; total: number }>(
      "/api/outsource/bh?status=approved&page=1&pageSize=999",
    )
      .then((res) => {
        if (!cancelled) {
          setBhOptions(
            res.rows.map((r) => ({
              value: r.id,
              label: `${r.docNo}${r.orderType ? `（${formatOrderType(r.orderType)}）` : ""}`,
            })),
          );
        }
      })
      .catch(() => {
        /* 下拉加载失败保持空 */
      });
    return () => {
      cancelled = true;
    };
  }, [createOpen]);

  const handleCreate = async () => {
    try {
      const values = await form.validateFields();
      setSaving(true);
      await postJson<{ id: number }>("/api/outsource/wo", {
        bhId: values.bhId ?? undefined,
        productSkuId: values.productSkuId,
        qty: String(values.qty),
        supplierId: values.supplierId,
        feeRatePlan: String(values.feeRatePlan),
        dueDate: values.dueDate ? values.dueDate.format("YYYY-MM-DD") : undefined,
        orderType: values.orderType || undefined,
        remark: values.remark?.trim() || undefined,
      });
      message.success("委外工单已创建（草稿）");
      setCreateOpen(false);
      form.resetFields();
      void load();
    } catch (e) {
      if (e instanceof Error && e.message) message.error(e.message);
    } finally {
      setSaving(false);
    }
  };

  const openGenerate = () => {
    if (!detail) return;
    genForm.resetFields();
    genForm.setFieldsValue({
      poGroups: [
        {
          supplierId: detail.supplierId,
          lines: detail.lines.map((l) => ({
            materialSkuId: l.materialSkuId,
            qty: Number(Number(l.suggestedQty) > 0 ? l.suggestedQty : l.grossReq),
            price: 0,
          })),
        },
      ],
      jgQty: Number(detail.qty),
      jgDueDate: detail.dueDate ? dayjs(detail.dueDate) : undefined,
    });
    setGenOpen(true);
  };

  const handleGenerate = async () => {
    if (!detail) return;
    try {
      const values = await genForm.validateFields();
      const groups = (values.poGroups ?? [])
        .filter((g) => g && g.supplierId != null && (g.lines ?? []).length > 0)
        .map((g) => ({
          supplierId: g.supplierId,
          lines: (g.lines ?? []).map((l) => ({
            materialSkuId: l.materialSkuId,
            qty: String(l.qty),
            price: String(l.price ?? 0),
          })),
        }));
      setGenerating(true);
      const res = await postJson<{ pos: { docNo: string }[]; jg: { docNo: string } }>(
        `/api/outsource/wo/${detail.id}/generate`,
        {
          poGroups: groups,
          jg: {
            qty: values.jgQty != null ? String(values.jgQty) : undefined,
            dueDate: values.jgDueDate ? values.jgDueDate.format("YYYY-MM-DD") : undefined,
          },
        },
      );
      setGenOpen(false);
      modal.success({
        title: "单据生成成功",
        content: (
          <div>
            {res.pos.length > 0 ? <div>采购订单：{res.pos.map((p) => p.docNo).join("、")}</div> : null}
            <div>加工通知单：{res.jg.docNo}</div>
          </div>
        ),
      });
      void loadDetail(detail.id);
      void load();
    } catch (e) {
      if (e instanceof Error && e.message) message.error(e.message);
    } finally {
      setGenerating(false);
    }
  };

  const columns: ColumnsType<WoRow> = [
    {
      title: "单据号",
      dataIndex: "docNo",
      width: 160,
      render: (v: string, r) => (
        <Typography.Link onClick={() => setDetailId(r.id)}>{v}</Typography.Link>
      ),
    },
    {
      title: "成品",
      key: "product",
      render: (_, r) => `${r.productSkuCode} ${r.productSkuName}`,
    },
    { title: "数量", dataIndex: "qty", width: 100, align: "right" },
    { title: "加工厂", dataIndex: "supplierName", width: 140 },
    {
      title: "订单类型",
      dataIndex: "orderType",
      width: 110,
      render: (v: string | null) => (v ? <Tag color="blue">{formatOrderType(v)}</Tag> : "—"),
    },
    { title: "交期", dataIndex: "dueDate", width: 110, render: (v: string | null) => v ?? "—" },
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

  const lineColumns: ColumnsType<WoLine> = [
    { title: "物料", key: "material", render: (_, r) => `${r.skuCode} ${r.skuName}` },
    { title: "单位用量", dataIndex: "qtyPer", width: 90, align: "right" },
    { title: "损耗率%", dataIndex: "planLossRatePct", width: 85, align: "right" },
    { title: "毛需求", dataIndex: "grossReq", width: 100, align: "right" },
    {
      title: (
        <Tooltip title="自有实时仓口径，不含保税/云仓（D20）">
          在手 <InfoCircleOutlined />
        </Tooltip>
      ),
      dataIndex: "onHandAt",
      width: 100,
      align: "right",
    },
    { title: "在途", dataIndex: "inTransitAt", width: 100, align: "right" },
    { title: "建议量", dataIndex: "suggestedQty", width: 100, align: "right" },
  ];

  return (
    <div>
      <Typography.Title level={4} style={{ marginTop: 0 }}>
        委外工单（WO）
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
        <Input.Search
          allowClear
          placeholder="搜索单据号"
          style={{ width: 240 }}
          onSearch={(value) => {
            setQ(value.trim());
            setPage(1);
          }}
        />
        <Space>
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
            新建委外工单
          </Button>
        </Space>
      </Space>
      <Table<WoRow>
        rowKey="id"
        size="middle"
        columns={columns}
        dataSource={rows}
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
        title="新建委外工单"
        open={createOpen}
        onOk={() => void handleCreate()}
        onCancel={() => setCreateOpen(false)}
        confirmLoading={saving}
        width={640}
        forceRender
        maskClosable={false}
        okText="保存草稿"
        cancelText="取消"
      >
        <Form form={form} layout="vertical">
          <Form.Item name="bhId" label="关联备货申请（可选，仅已审批）">
            <Select allowClear showSearch optionFilterProp="label" options={bhOptions} placeholder="选择备货申请" />
          </Form.Item>
          <Form.Item
            name="productSkuId"
            label="成品 SKU"
            rules={[{ required: true, message: "必须选择成品 SKU" }]}
          >
            <RemoteSelect
              api="/api/master/sku?type=finished"
              getLabel={(r) => `${String(r.code)} ${String(r.name)}`}
              placeholder="选择成品（须有生效 BOM）"
            />
          </Form.Item>
          <Form.Item name="qty" label="数量" rules={[{ required: true, message: "数量必填" }]}>
            <InputNumber min={0.0001} precision={4} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item
            name="supplierId"
            label="加工厂"
            rules={[{ required: true, message: "必须选择加工厂" }]}
          >
            <RemoteSelect
              api="/api/master/supplier"
              getLabel={(r) => `${String(r.code)} ${String(r.name)}`}
              filterRow={(r) => Array.isArray(r.kinds) && (r.kinds as string[]).includes("processor")}
              placeholder="选择加工厂"
            />
          </Form.Item>
          <Form.Item
            name="feeRatePlan"
            label="加工费计划单价（元）"
            rules={[{ required: true, message: "加工费计划单价必填" }]}
          >
            <InputNumber min={0.01} precision={2} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item name="dueDate" label="交期">
            <DatePicker style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item name="orderType" label="订单类型">
            <Select allowClear options={toOptions(ORDER_TYPE_LABELS)} placeholder="常规备货/新品首单/紧急需求/月备货" />
          </Form.Item>
          <Form.Item name="remark" label="备注">
            <Input.TextArea rows={2} maxLength={500} />
          </Form.Item>
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
            "委外工单详情"
          )
        }
        open={detailId != null}
        onClose={() => setDetailId(null)}
        width={860}
        loading={detailLoading}
        extra={
          detail ? (
            <Space>
              {detail.status === "approved" && existingJgNo == null ? (
                <Button type="primary" icon={<ThunderboltOutlined />} onClick={openGenerate}>
                  生成单据
                </Button>
              ) : null}
              <WoActions
                doc={{ id: detail.id, status: detail.status, version: detail.version }}
                onChanged={() => {
                  void loadDetail(detail.id);
                  void load();
                }}
              />
            </Space>
          ) : null
        }
      >
        {detail ? (
          <div>
            {detail.status === "approved" && existingJgNo != null ? (
              <Alert
                type="info"
                showIcon
                style={{ marginBottom: 16 }}
                message={`该工单已生成加工通知单 ${existingJgNo}，不可重复生成。`}
              />
            ) : null}
            <Descriptions column={2} size="small" bordered style={{ marginBottom: 16 }}>
              <Descriptions.Item label="成品">
                {detail.productSkuCode} {detail.productSkuName}
              </Descriptions.Item>
              <Descriptions.Item label="数量">{detail.qty}</Descriptions.Item>
              <Descriptions.Item label="加工厂">{detail.supplierName}</Descriptions.Item>
              <Descriptions.Item label="加工费计划单价">
                {detail.feeRatePlan != null ? detail.feeRatePlan : "—"}
              </Descriptions.Item>
              <Descriptions.Item label="订单类型">{formatOrderType(detail.orderType)}</Descriptions.Item>
              <Descriptions.Item label="交期">{detail.dueDate ?? "—"}</Descriptions.Item>
              <Descriptions.Item label="关联备货申请">
                {detail.bhId != null ? `#${detail.bhId}` : "—"}
              </Descriptions.Item>
              <Descriptions.Item label="BOM">#{detail.bomId}</Descriptions.Item>
              <Descriptions.Item label="制单人">{detail.createdByName ?? "—"}</Descriptions.Item>
              <Descriptions.Item label="制单时间">
                {dayjs(detail.createdAt).format("YYYY-MM-DD HH:mm")}
              </Descriptions.Item>
              <Descriptions.Item label="备注" span={2}>
                {detail.remark ?? "—"}
              </Descriptions.Item>
            </Descriptions>
            <Typography.Title level={5}>需求表（wo_line 快照）</Typography.Title>
            {detail.lines.length > 0 ? (
              <Table<WoLine>
                rowKey="id"
                size="small"
                columns={lineColumns}
                dataSource={detail.lines}
                pagination={false}
                style={{ marginBottom: 24 }}
              />
            ) : (
              <Typography.Paragraph type="secondary" style={{ marginBottom: 24 }}>
                审批通过后按生效 BOM 生成需求快照（毛需求/在手/在途/建议量）。
              </Typography.Paragraph>
            )}
            {detail.approvals.length > 0 ? (
              <>
                <Typography.Title level={5}>审批记录</Typography.Title>
                <Timeline
                  items={detail.approvals.map((a) => ({
                    color: a.action === "approve" ? "green" : "red",
                    children: (
                      <div>
                        <div>
                          {a.approverName ?? "—"} {a.action === "approve" ? "审批通过" : "驳回"}
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

      <Modal
        title={`生成采购订单 / 加工通知单${detail ? ` — ${detail.docNo}` : ""}`}
        open={genOpen}
        onOk={() => void handleGenerate()}
        onCancel={() => setGenOpen(false)}
        confirmLoading={generating}
        width={860}
        forceRender
        maskClosable={false}
        okText="生成"
        cancelText="取消"
      >
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          message="按需求快照预填：可按供应商分组拆分 PO（0..n 张），数量/单价逐行可改；同时生成 1 张加工通知单。"
        />
        <Form form={genForm} layout="vertical">
          <Form.List name="poGroups">
            {(groups, { add: addGroup, remove: removeGroup }) => (
              <div>
                {groups.map((group) => (
                  <div
                    key={group.key}
                    style={{ border: "1px solid #f0f0f0", borderRadius: 8, padding: 12, marginBottom: 12 }}
                  >
                    <Space align="baseline" style={{ display: "flex", justifyContent: "space-between" }}>
                      <Form.Item
                        name={[group.name, "supplierId"]}
                        label="供应商"
                        rules={[{ required: true, message: "必须选择供应商" }]}
                        style={{ marginBottom: 8 }}
                      >
                        <RemoteSelect
                          api="/api/master/supplier"
                          getLabel={(r) => `${String(r.code)} ${String(r.name)}`}
                          placeholder="选择供应商"
                          style={{ width: 280 }}
                        />
                      </Form.Item>
                      <Button
                        type="text"
                        danger
                        icon={<DeleteOutlined />}
                        onClick={() => removeGroup(group.name)}
                      >
                        删除该 PO
                      </Button>
                    </Space>
                    <Form.List name={[group.name, "lines"]}>
                      {(lines, { add: addLine, remove: removeLine }) => (
                        <div>
                          {lines.map((line) => (
                            <Space key={line.key} align="baseline" style={{ display: "flex", marginBottom: 4 }} wrap>
                              <Form.Item
                                name={[line.name, "materialSkuId"]}
                                rules={[{ required: true, message: "必须选择物料" }]}
                                style={{ marginBottom: 8 }}
                              >
                                <RemoteSelect
                                  api="/api/master/sku?type=raw,packaging"
                                  getLabel={(r) => `${String(r.code)} ${String(r.name)}`}
                                  placeholder="选择物料（原料/包材）"
                                  style={{ width: 300 }}
                                />
                              </Form.Item>
                              <Form.Item
                                name={[line.name, "qty"]}
                                rules={[{ required: true, message: "数量必填" }]}
                                style={{ marginBottom: 8 }}
                              >
                                <InputNumber min={0.0001} precision={4} placeholder="数量" style={{ width: 130 }} />
                              </Form.Item>
                              <Form.Item
                                name={[line.name, "price"]}
                                rules={[{ required: true, message: "单价必填" }]}
                                style={{ marginBottom: 8 }}
                              >
                                <InputNumber min={0} precision={2} placeholder="单价" style={{ width: 120 }} />
                              </Form.Item>
                              <Button
                                type="text"
                                danger
                                icon={<DeleteOutlined />}
                                onClick={() => removeLine(line.name)}
                              />
                            </Space>
                          ))}
                          <Button type="dashed" block icon={<PlusOutlined />} onClick={() => addLine({ price: 0 })}>
                            添加物料行
                          </Button>
                        </div>
                      )}
                    </Form.List>
                  </div>
                ))}
                <Button
                  type="dashed"
                  block
                  icon={<PlusOutlined />}
                  onClick={() => addGroup({ lines: [] })}
                >
                  添加 PO 分组（按供应商）
                </Button>
              </div>
            )}
          </Form.List>
          <Divider />
          <Typography.Text strong>加工通知单（JG）</Typography.Text>
          <Space style={{ marginTop: 8 }} align="baseline" wrap>
            <Form.Item name="jgQty" label="加工数量" style={{ marginBottom: 8 }}>
              <InputNumber min={0.0001} precision={4} style={{ width: 160 }} />
            </Form.Item>
            <Form.Item name="jgDueDate" label="交期" style={{ marginBottom: 8 }}>
              <DatePicker style={{ width: 160 }} />
            </Form.Item>
          </Space>
        </Form>
      </Modal>
    </div>
  );
}
