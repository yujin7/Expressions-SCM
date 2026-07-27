"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import {
  App,
  Button,
  Descriptions,
  Drawer,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Radio,
  Select,
  Space,
  Table,
  Tabs,
  Tag,
  Typography,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import { PlusOutlined, ReloadOutlined } from "@ant-design/icons";
import dayjs from "dayjs";
import DocStatusTag from "@/components/DocStatusTag";
import { fetchJson, postJson } from "@/components/fetchJson";
import ListToolbar from "@/components/ListToolbar";
import { useListState } from "@/components/useListState";

interface PcRow {
  id: number;
  docNo: string;
  status: string;
  target: "po_line" | "jg_fee";
  poLineId: number | null;
  jgId: number | null;
  /** 敏感字段：非可见角色时后端已剥离（键不存在） */
  oldPrice?: string;
  newPrice?: string;
  deviationPct?: string;
  scope: string;
  version: number;
  createdByName: string | null;
  createdAt: string;
}

interface CreateFormValues {
  jgId: number;
  newPrice: number;
  scope: "unreceived_only" | "retroactive";
  remark?: string;
}

const STATUS_TABS = [
  { key: "", label: "全部" },
  { key: "pending", label: "待审批" },
  { key: "approved", label: "已审批" },
  { key: "draft", label: "已驳回（草稿）" },
];

const TARGET_LABELS: Record<string, string> = {
  po_line: "采购价（PO 行）",
  jg_fee: "加工费（JG）",
};

const SCOPE_LABELS: Record<string, string> = {
  unreceived_only: "仅未收货部分",
  retroactive: "含已收追溯",
};

function targetText(r: PcRow): string {
  if (r.target === "jg_fee") return `加工费 JG#${r.jgId ?? "—"}`;
  return `采购价 PO行#${r.poLineId ?? "—"}`;
}

/** 敏感价格展示：键被脱敏剥离时渲染 —，绝不出现 undefined */
function priceChangeText(r: PcRow): string {
  if (r.oldPrice == null && r.newPrice == null) return "—";
  return `${r.oldPrice ?? "—"} → ${r.newPrice ?? "—"}`;
}

function PcInner() {
  const { message } = App.useApp();
  const [form] = Form.useForm<CreateFormValues>();
  const [rows, setRows] = useState<PcRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  // 列表页状态平台（E6-P1）：筛选/分页进 URL，密度与已保存视图存本地
  const listState = useListState({ key: "pc", defaults: { status: "" }, defaultPageSize: 20 });
  const { page, pageSize } = listState;
  const status = listState.filters.status;

  const [createOpen, setCreateOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [jgOptions, setJgOptions] = useState<{ value: number; label: string }[]>([]);

  const [current, setCurrent] = useState<PcRow | null>(null);
  const [actionLoading, setActionLoading] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectComment, setRejectComment] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
      if (status) params.set("status", status);
      const res = await fetchJson<{ rows: PcRow[]; total: number }>(
        `/api/outsource/pc?${params.toString()}`,
      );
      setRows(res.rows);
      setTotal(res.total);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [status, page, pageSize, message]);

  useEffect(() => {
    void load();
  }, [load]);

  // 发起改价弹窗打开时拉取 JG 列表（委外链列表返回 {rows,total}）
  useEffect(() => {
    if (!createOpen) return;
    let cancelled = false;
    fetchJson<{ rows: { id: number; docNo: string; productSkuName: string }[]; total: number }>(
      "/api/outsource/jg?page=1&pageSize=999",
    )
      .then((res) => {
        if (!cancelled) {
          setJgOptions(res.rows.map((r) => ({ value: r.id, label: `${r.docNo} ${r.productSkuName}` })));
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
      await postJson<{ id: number }>("/api/outsource/pc", {
        jgId: values.jgId,
        newPrice: String(values.newPrice),
        scope: values.scope,
        remark: values.remark?.trim() || undefined,
      });
      message.success("加工费改价申请已提交审批");
      setCreateOpen(false);
      form.resetFields();
      void load();
    } catch (e) {
      if (e instanceof Error && e.message) message.error(e.message);
    } finally {
      setSaving(false);
    }
  };

  const approve = async (row: PcRow, action: "approve" | "reject", comment?: string) => {
    setActionLoading(true);
    try {
      await postJson(`/api/outsource/pc/${row.id}/approve`, {
        action,
        comment: comment?.trim() || undefined,
        version: row.version,
      });
      message.success(action === "approve" ? "审批已通过" : "已驳回");
      setCurrent(null);
      setRejectOpen(false);
      setRejectComment("");
      void load();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setActionLoading(false);
    }
  };

  const columns: ColumnsType<PcRow> = [
    {
      title: "单据号",
      dataIndex: "docNo",
      width: 160,
      render: (v: string, r) => <Typography.Link onClick={() => setCurrent(r)}>{v}</Typography.Link>,
    },
    {
      title: "对象",
      key: "target",
      width: 160,
      render: (_, r) => (
        <Tag color={r.target === "jg_fee" ? "purple" : "orange"}>{targetText(r)}</Tag>
      ),
    },
    { title: "原价 → 新价", key: "price", width: 160, render: (_, r) => priceChangeText(r) },
    {
      title: "偏差%",
      dataIndex: "deviationPct",
      width: 90,
      align: "right",
      render: (v: string | undefined) => (v != null ? `${v}%` : "—"),
    },
    {
      title: "生效范围",
      dataIndex: "scope",
      width: 120,
      render: (v: string) => SCOPE_LABELS[v] ?? v,
    },
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
        <Button type="link" size="small" onClick={() => setCurrent(r)}>
          查看
        </Button>
      ),
    },
  ];

  return (
    <div>
      <Typography.Title level={4} style={{ marginTop: 0 }}>
        价格变更（PC）
      </Typography.Title>
      <Typography.Paragraph type="secondary">
        采购价（PO 行）变更由 PO 提交比价（R1）自动生成；本页仅可手工发起加工费（JG）改价。
      </Typography.Paragraph>
      <Tabs
        activeKey={status}
        items={STATUS_TABS}
        onChange={(key) => listState.setFilter({ status: key })}
      />
      <ListToolbar
        state={listState}
        primaryActions={
          <>
            <Button size="small" icon={<ReloadOutlined />} onClick={() => void load()}>
              刷新
            </Button>
            <Button
              size="small"
              type="primary"
              icon={<PlusOutlined />}
              onClick={() => {
                form.resetFields();
                setCreateOpen(true);
              }}
            >
              发起加工费改价
            </Button>
          </>
        }
      />
      <Table<PcRow>
        rowKey="id"
        size={listState.tableSize}
        columns={columns}
        dataSource={rows}
        loading={loading}
        scroll={{ x: "max-content" }}
        pagination={listState.paginationProps({ total: total })}
      />

      <Modal
        title="发起加工费改价"
        open={createOpen}
        onOk={() => void handleCreate()}
        onCancel={() => setCreateOpen(false)}
        confirmLoading={saving}
        width={560}
        forceRender
        maskClosable={false}
        okText="提交审批"
        cancelText="取消"
      >
        <Form form={form} layout="vertical" initialValues={{ scope: "unreceived_only" }}>
          <Form.Item name="jgId" label="加工通知单" rules={[{ required: true, message: "必须选择 JG" }]}>
            <Select showSearch optionFilterProp="label" options={jgOptions} placeholder="选择加工通知单" />
          </Form.Item>
          <Form.Item
            name="newPrice"
            label="新加工费单价（元）"
            rules={[{ required: true, message: "新价必填" }]}
          >
            <InputNumber min={0.01} precision={2} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item name="scope" label="生效范围" rules={[{ required: true, message: "生效范围必填" }]}>
            <Radio.Group>
              <Radio value="unreceived_only">仅未收货部分</Radio>
              <Radio value="retroactive">含已收追溯</Radio>
            </Radio.Group>
          </Form.Item>
          <Form.Item name="remark" label="备注">
            <Input.TextArea rows={2} maxLength={500} />
          </Form.Item>
        </Form>
      </Modal>

      <Drawer
        title={
          current ? (
            <Space>
              <span>{current.docNo}</span>
              <DocStatusTag status={current.status} />
            </Space>
          ) : (
            "价格变更详情"
          )
        }
        open={current != null}
        onClose={() => setCurrent(null)}
        width={560}
        extra={
          current && current.status === "pending" ? (
            <Space>
              <Popconfirm
                title={
                  current.target === "jg_fee"
                    ? "确认审批通过？通过后立即更新 JG 加工费现价并新增费率分段。"
                    : "确认审批通过？通过后对应 PO 可重新提交。"
                }
                okText="通过"
                cancelText="取消"
                onConfirm={() => void approve(current, "approve")}
              >
                <Button type="primary" loading={actionLoading}>
                  审批通过
                </Button>
              </Popconfirm>
              <Button danger loading={actionLoading} onClick={() => setRejectOpen(true)}>
                驳回
              </Button>
            </Space>
          ) : null
        }
      >
        {current ? (
          <Descriptions column={1} size="small" bordered>
            <Descriptions.Item label="变更对象">{TARGET_LABELS[current.target]}</Descriptions.Item>
            <Descriptions.Item label="关联单据">{targetText(current)}</Descriptions.Item>
            <Descriptions.Item label="原价">{current.oldPrice ?? "—"}</Descriptions.Item>
            <Descriptions.Item label="新价">{current.newPrice ?? "—"}</Descriptions.Item>
            <Descriptions.Item label="偏差">
              {current.deviationPct != null ? `${current.deviationPct}%` : "—"}
            </Descriptions.Item>
            <Descriptions.Item label="生效范围">
              {SCOPE_LABELS[current.scope] ?? current.scope}
            </Descriptions.Item>
            <Descriptions.Item label="制单人">{current.createdByName ?? "—"}</Descriptions.Item>
            <Descriptions.Item label="创建时间">
              {dayjs(current.createdAt).format("YYYY-MM-DD HH:mm")}
            </Descriptions.Item>
          </Descriptions>
        ) : null}
      </Drawer>

      <Modal
        title="驳回价格变更"
        open={rejectOpen}
        okText="确认驳回"
        okButtonProps={{ danger: true }}
        cancelText="取消"
        confirmLoading={actionLoading}
        onCancel={() => setRejectOpen(false)}
        onOk={() => {
          if (current) void approve(current, "reject", rejectComment);
        }}
      >
        <Input.TextArea
          rows={3}
          maxLength={200}
          placeholder="驳回意见（可选）"
          value={rejectComment}
          onChange={(e) => setRejectComment(e.target.value)}
        />
      </Modal>
    </div>
  );
}

export default function PcClient() {
  // useListState 读 useSearchParams，需要 Suspense 边界
  return (
    <Suspense>
      <PcInner />
    </Suspense>
  );
}
