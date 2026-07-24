"use client";

import { useCallback, useEffect, useState } from "react";
import {
  App,
  Badge,
  Button,
  DatePicker,
  Descriptions,
  Drawer,
  Form,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Switch,
  Table,
  Tabs,
  Tag,
  Timeline,
  Typography,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import { ReloadOutlined } from "@ant-design/icons";
import dayjs from "dayjs";
import DocStatusTag from "@/components/DocStatusTag";
import { fetchJson, patchJson, postJson } from "@/components/fetchJson";
import { useMe } from "@/components/useMe";
import { formatOrderType } from "@/components/labels";

interface JgRow {
  id: number;
  docNo: string;
  status: string;
  woId: number;
  supplierName: string;
  productSkuCode: string;
  productSkuName: string;
  qty: string;
  dueDate: string | null;
  inProduction: boolean;
  createdByName: string | null;
  createdAt: string;
}

interface FeeSegment {
  id: number;
  /** 敏感字段：非可见角色时后端已剥离（键不存在） */
  feeRate?: string;
  effectiveFrom: string;
}

interface DocApproval {
  approverName: string | null;
  action: "approve" | "reject";
  comment: string | null;
  createdAt: string;
}

interface JgDetail {
  id: number;
  docNo: string;
  status: string;
  remark: string | null;
  version: number;
  woId: number;
  woDocNo: string;
  supplierId: number;
  supplierName: string;
  productSkuId: number;
  productSkuCode: string;
  productSkuName: string;
  qty: string;
  dueDate: string | null;
  /** 敏感字段：非可见角色时后端已剥离（键不存在） */
  feeRateCurrent?: string;
  orderType: string | null;
  inProduction: boolean;
  confirmedAt: string | null;
  confirmNote: string | null;
  pkgRequiredDate: string | null;
  pkgSupplierReplyDate: string | null;
  pkgReadyDate: string | null;
  pkgRefNos: string[] | null;
  urgentFlag: boolean;
  priority: string | null;
  isPaused: boolean;
  revisedDates: { from: string | null; to: string; reason: string; by: string; at: string }[] | null;
  createdAt: string;
  createdByName: string | null;
  feeSegments: FeeSegment[];
  approvals: DocApproval[];
}

const STATUS_TABS = [
  { key: "", label: "全部" },
  { key: "draft", label: "草稿" },
  { key: "pending", label: "待审批" },
  { key: "approved", label: "已审批" },
  { key: "in_progress", label: "执行中" },
  { key: "completed", label: "已完成" },
];

export default function JgClient() {
  const { message } = App.useApp();
  const [rows, setRows] = useState<JgRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [status, setStatus] = useState("");
  const [q, setQ] = useState("");

  const me = useMe();
  const canPlan = !!me && (me.roles.includes("pmc") || me.roles.includes("admin"));
  const canRevise = !!me && ["pmc", "purchasing", "admin"].some((r) => me.roles.includes(r));
  const [planForm] = Form.useForm();
  const [planSaving, setPlanSaving] = useState(false);
  const [reviseOpen, setReviseOpen] = useState(false);
  const [reviseForm] = Form.useForm();
  const [detailId, setDetailId] = useState<number | null>(null);
  const [detail, setDetail] = useState<JgDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);

  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectComment, setRejectComment] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmNote, setConfirmNote] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ q, page: String(page), pageSize: String(pageSize) });
      if (status) params.set("status", status);
      const res = await fetchJson<{ rows: JgRow[]; total: number }>(
        `/api/outsource/jg?${params.toString()}`,
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
        const res = await fetchJson<JgDetail>(`/api/outsource/jg/${id}`);
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

  const refresh = () => {
    if (detail) void loadDetail(detail.id);
    void load();
  };

  const post = async (path: string, body: unknown, successText: string) => {
    if (!detail) return false;
    setActionLoading(true);
    try {
      await postJson(`/api/outsource/jg/${detail.id}/${path}`, body);
      message.success(successText);
      refresh();
      return true;
    } catch (e) {
      message.error((e as Error).message);
      return false;
    } finally {
      setActionLoading(false);
    }
  };

  const columns: ColumnsType<JgRow> = [
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
      title: "交期",
      dataIndex: "dueDate",
      width: 150,
      render: (v: string | null, r) => (
        <Space size={4}>
          {v ?? "—"}
          {(r as { urgentFlag?: boolean }).urgentFlag ? <Tag color="red">紧急</Tag> : null}
          {(r as { isPaused?: boolean }).isPaused ? <Tag color="orange">暂停</Tag> : null}
        </Space>
      ),
    },
    {
      title: "生产中",
      dataIndex: "inProduction",
      width: 90,
      render: (v: boolean) =>
        v ? <Badge status="processing" text="生产中" /> : <Badge status="default" text="未开始" />,
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

  const segmentColumns: ColumnsType<FeeSegment> = [
    {
      title: "加工费单价",
      dataIndex: "feeRate",
      width: 130,
      align: "right",
      render: (v: string | undefined) => (v != null ? v : "—"),
    },
    {
      title: "生效时间",
      dataIndex: "effectiveFrom",
      render: (v: string) => dayjs(v).format("YYYY-MM-DD HH:mm:ss"),
    },
  ];

  const actions = detail ? (
    <Space>
      {detail.status === "draft" ? (
        <Popconfirm
          title="确认提交审批？"
          okText="提交"
          cancelText="取消"
          onConfirm={() => void post("submit", { version: detail.version }, "已提交审批")}
        >
          <Button type="primary" loading={actionLoading}>
            提交
          </Button>
        </Popconfirm>
      ) : null}
      {detail.status === "pending" ? (
        <>
          <Popconfirm
            title="确认审批通过？"
            okText="通过"
            cancelText="取消"
            onConfirm={() =>
              void post("approve", { action: "approve", version: detail.version }, "审批已通过")
            }
          >
            <Button type="primary" loading={actionLoading}>
              审批通过
            </Button>
          </Popconfirm>
          <Button danger loading={actionLoading} onClick={() => setRejectOpen(true)}>
            驳回
          </Button>
        </>
      ) : null}
      {detail.status === "approved" ? (
        <Button type="primary" loading={actionLoading} onClick={() => setConfirmOpen(true)}>
          加工厂确认（代录）
        </Button>
      ) : null}
    </Space>
  ) : null;

  return (
    <div>
      <Typography.Title level={4} style={{ marginTop: 0 }}>
        加工通知单（JG）
      </Typography.Title>
      <Typography.Paragraph type="secondary">
        加工通知单由委外工单「生成单据」派生（一工单一 JG），本页不提供手工创建；加工费改价请前往「价格变更」发起。
      </Typography.Paragraph>
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
        <Button icon={<ReloadOutlined />} onClick={() => void load()}>
          刷新
        </Button>
      </Space>
      <Table<JgRow>
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

      <Drawer
        title={
          detail ? (
            <Space>
              <span>{detail.docNo}</span>
              <DocStatusTag status={detail.status} />
              {detail.inProduction ? <Badge status="processing" text="生产中" /> : null}
            </Space>
          ) : (
            "加工通知单详情"
          )
        }
        open={detailId != null}
        onClose={() => setDetailId(null)}
        width={760}
        loading={detailLoading}
        extra={actions}
      >
        {detail ? (
          <div>
            <Descriptions column={2} size="small" bordered style={{ marginBottom: 16 }}>
              <Descriptions.Item label="关联工单">{detail.woDocNo}</Descriptions.Item>
              <Descriptions.Item label="加工厂">{detail.supplierName}</Descriptions.Item>
              <Descriptions.Item label="成品">
                {detail.productSkuCode} {detail.productSkuName}
              </Descriptions.Item>
              <Descriptions.Item label="数量">{detail.qty}</Descriptions.Item>
              <Descriptions.Item label="交期">{detail.dueDate ?? "—"}</Descriptions.Item>
              <Descriptions.Item label="加工费现价">
                {detail.feeRateCurrent != null ? detail.feeRateCurrent : "—"}
              </Descriptions.Item>
              <Descriptions.Item label="订单类型">{formatOrderType(detail.orderType)}</Descriptions.Item>
              <Descriptions.Item label="确认时间">
                {detail.confirmedAt ? dayjs(detail.confirmedAt).format("YYYY-MM-DD HH:mm") : "未确认"}
              </Descriptions.Item>
              <Descriptions.Item label="确认备注">{detail.confirmNote ?? "—"}</Descriptions.Item>
              <Descriptions.Item label="制单人">{detail.createdByName ?? "—"}</Descriptions.Item>
              <Descriptions.Item label="制单时间">
                {dayjs(detail.createdAt).format("YYYY-MM-DD HH:mm")}
              </Descriptions.Item>
              <Descriptions.Item label="备注">{detail.remark ?? "—"}</Descriptions.Item>
            </Descriptions>
            <Typography.Title level={5}>加工费分段（结算按收货时点取价）</Typography.Title>
            <Table<FeeSegment>
              rowKey="id"
              size="small"
              columns={segmentColumns}
              dataSource={detail.feeSegments}
              pagination={false}
              style={{ marginBottom: 24 }}
            />
            <Typography.Title level={5}>包材齐套与计划属性（04 §2）</Typography.Title>
            <Form
              form={planForm}
              layout="inline"
              disabled={!canPlan}
              initialValues={{
                pkgRequiredDate: detail.pkgRequiredDate ? dayjs(detail.pkgRequiredDate) : undefined,
                pkgSupplierReplyDate: detail.pkgSupplierReplyDate ? dayjs(detail.pkgSupplierReplyDate) : undefined,
                pkgReadyDate: detail.pkgReadyDate ? dayjs(detail.pkgReadyDate) : undefined,
                pkgRefNos: detail.pkgRefNos ?? [],
                urgentFlag: detail.urgentFlag,
                priority: detail.priority ?? undefined,
                isPaused: detail.isPaused,
              }}
              style={{ marginBottom: 8, rowGap: 8 }}
            >
              <Form.Item name="pkgRequiredDate" label="包材需求日">
                <DatePicker />
              </Form.Item>
              <Form.Item name="pkgSupplierReplyDate" label="供应商回复日">
                <DatePicker />
              </Form.Item>
              <Form.Item name="pkgReadyDate" label="齐套日">
                <DatePicker />
              </Form.Item>
              <Form.Item name="pkgRefNos" label="关联包材单号">
                <Select mode="tags" style={{ minWidth: 220 }} placeholder="PO-2026…（回车添加）" open={false} />
              </Form.Item>
              <Form.Item name="priority" label="优先级">
                <Select allowClear style={{ width: 90 }} options={["高", "中", "低"].map((v) => ({ value: v, label: v }))} />
              </Form.Item>
              <Form.Item name="urgentFlag" label="紧急" valuePropName="checked">
                <Switch />
              </Form.Item>
              <Form.Item name="isPaused" label="暂停" valuePropName="checked">
                <Switch />
              </Form.Item>
              <Space>
                <Button
                  type="primary"
                  loading={planSaving}
                  disabled={!canPlan}
                  onClick={async () => {
                    const v = planForm.getFieldsValue();
                    setPlanSaving(true);
                    try {
                      await patchJson(`/api/outsource/jg/${detail.id}/plan`, {
                        pkgRequiredDate: v.pkgRequiredDate ? v.pkgRequiredDate.format("YYYY-MM-DD") : null,
                        pkgSupplierReplyDate: v.pkgSupplierReplyDate ? v.pkgSupplierReplyDate.format("YYYY-MM-DD") : null,
                        pkgReadyDate: v.pkgReadyDate ? v.pkgReadyDate.format("YYYY-MM-DD") : null,
                        pkgRefNos: v.pkgRefNos ?? [],
                        priority: v.priority ?? null,
                        urgentFlag: !!v.urgentFlag,
                        isPaused: !!v.isPaused,
                      });
                      message.success("计划属性已保存");
                      void loadDetail(detail.id);
                      void load();
                    } catch (e) {
                      message.error((e as Error).message);
                    } finally {
                      setPlanSaving(false);
                    }
                  }}
                >
                  保存计划属性
                </Button>
                <Button disabled={!canRevise} onClick={() => setReviseOpen(true)}>
                  交期修改
                </Button>
              </Space>
            </Form>
            {(detail.revisedDates?.length ?? 0) > 0 ? (
              <>
                <Typography.Text type="secondary">交期修改历史（{detail.revisedDates!.length} 次）</Typography.Text>
                <Timeline
                  style={{ marginTop: 8 }}
                  items={detail.revisedDates!.map((r) => ({
                    children: `${dayjs(r.at).format("MM-DD HH:mm")} ${r.by}：${r.from ?? "—"} → ${r.to}（${r.reason}）`,
                  }))}
                />
              </>
            ) : null}
            <Modal
              title="交期修改（留痕）"
              open={reviseOpen}
              onCancel={() => setReviseOpen(false)}
              onOk={async () => {
                const v = await reviseForm.validateFields();
                await postJson(`/api/outsource/jg/${detail.id}/revise-due`, {
                  newDate: v.newDate.format("YYYY-MM-DD"),
                  reason: v.reason,
                });
                message.success("交期已修改并留痕");
                setReviseOpen(false);
                reviseForm.resetFields();
                void loadDetail(detail.id);
                void load();
              }}
              okText="确认修改"
              cancelText="取消"
            >
              <Form form={reviseForm} layout="vertical">
                <Form.Item name="newDate" label="新交期" rules={[{ required: true, message: "必选日期" }]}>
                  <DatePicker style={{ width: "100%" }} />
                </Form.Item>
                <Form.Item name="reason" label="改期原因" rules={[{ required: true, message: "原因必填" }]}>
                  <Input.TextArea rows={2} maxLength={200} />
                </Form.Item>
              </Form>
            </Modal>
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
        title="驳回单据"
        open={rejectOpen}
        okText="确认驳回"
        okButtonProps={{ danger: true }}
        cancelText="取消"
        confirmLoading={actionLoading}
        onCancel={() => setRejectOpen(false)}
        onOk={() =>
          void post(
            "approve",
            {
              action: "reject",
              comment: rejectComment.trim() || undefined,
              version: detail?.version ?? 0,
            },
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

      <Modal
        title="加工厂确认（内部代录）"
        open={confirmOpen}
        okText="确认"
        cancelText="取消"
        confirmLoading={actionLoading}
        onCancel={() => setConfirmOpen(false)}
        onOk={() =>
          void post(
            "confirm",
            { version: detail?.version ?? 0, note: confirmNote.trim() || undefined },
            "已确认，单据进入执行中（生产中）",
          ).then((ok) => {
            if (ok) {
              setConfirmOpen(false);
              setConfirmNote("");
            }
          })
        }
      >
        <Input.TextArea
          rows={3}
          maxLength={200}
          placeholder="确认备注（可选）——确认后标记为生产中"
          value={confirmNote}
          onChange={(e) => setConfirmNote(e.target.value)}
        />
      </Modal>
    </div>
  );
}
