"use client";

import { useLatestRead } from "@/components/useLatestRead";

import { useDocumentTarget } from "@/components/useDocumentTarget";
import { useDocumentRead } from "@/components/useDocumentRead";
import { DOCUMENT_TRANSIENT_PARAMS } from "@/lib/document-links";
import DocumentDrawer from "@/components/DocumentDrawer";
import ApprovalTimeline from "@/components/ApprovalTimeline";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import {
  App,
  Alert,
  Button,
  Descriptions,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Radio,
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
import RemoteSelect from "@/components/RemoteSelect";
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

interface PcDetail extends PcRow {
  actions?: { approve: boolean; reject: boolean; reason: string };
  approvals: { approverName: string | null; action: "approve" | "reject"; comment: string | null; createdAt: string }[];
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
  const listState = useListState({ transientParams: DOCUMENT_TRANSIENT_PARAMS, key: "pc", defaults: { status: "" }, defaultPageSize: 20 });
  const { page, pageSize } = listState;
  const status = listState.filters.status;

  const [createOpen, setCreateOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const saveLock = useRef(false);
  const actionLock = useRef(false);
  const [canCreate, setCanCreate] = useState(false);

  const documentSelection = useDocumentTarget();
  const { id: detailId, setId: setDetailId } = documentSelection;
  useEffect(() => { setRejectOpen(false); }, [detailId]);
  const detailRead = useDocumentRead<PcDetail>(detailId == null ? null : `/api/outsource/pc/${detailId}`);
  const current = detailRead.data;
  const [actionLoading, setActionLoading] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectComment, setRejectComment] = useState("");

  const beginLoadRead = useLatestRead();
  const load = useCallback(async () => {
    const readRequest = beginLoadRead();
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
      if (status) params.set("status", status);
      const res = await fetchJson<{ rows: PcRow[]; total: number; actions?: { createFee: boolean } }>(
        `/api/outsource/pc?${params.toString()}`, { signal: readRequest.signal });
      if (!readRequest.isCurrent()) return;
      setRows(res.rows);
      setTotal(res.total);
      setCanCreate(res.actions?.createFee === true);
    } catch (e) {
      if (!readRequest.isCurrent()) return;
      setCanCreate(false);
      message.error((e as Error).message);
    } finally {
      if (readRequest.isCurrent()) { setLoading(false); }
    }
  }, [beginLoadRead, status, page, pageSize, message]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleCreate = async () => {
    if (saveLock.current || !canCreate) return;
    saveLock.current = true;
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
      saveLock.current = false;
      setSaving(false);
    }
  };

  const approve = async (row: PcRow, action: "approve" | "reject", comment?: string) => {
    if (actionLock.current || !current?.actions?.[action]) return;
    actionLock.current = true;
    setActionLoading(true);
    try {
      await postJson(`/api/outsource/pc/${row.id}/approve`, {
        action,
        comment: comment?.trim() || undefined,
        version: row.version,
      });
      message.success(action === "approve" ? "审批已通过" : "已驳回");
      setDetailId(null);
      setRejectOpen(false);
      setRejectComment("");
      void load();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      actionLock.current = false;
      setActionLoading(false);
    }
  };

  const columns: ColumnsType<PcRow> = [
    {
      title: "单据号",
      dataIndex: "docNo",
      width: 160,
      render: (v: string, r) => <Typography.Link onClick={() => setDetailId(r.id)}>{v}</Typography.Link>,
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
        <Button type="link" size="small" onClick={() => setDetailId(r.id)}>
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
            {canCreate && <Button
              size="small"
              type="primary"
              icon={<PlusOutlined />}
              onClick={() => {
                form.resetFields();
                setCreateOpen(true);
              }}
            >
              发起加工费改价
            </Button>}
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
        onCancel={() => { if (!saveLock.current) setCreateOpen(false); }}
        keyboard={!saving}
        confirmLoading={saving}
        width={560}
        forceRender
        maskClosable={false}
        okText="提交审批"
        cancelText="取消"
      >
        <Form form={form} layout="vertical" initialValues={{ scope: "unreceived_only" }}>
          <Form.Item name="jgId" label="加工通知单" rules={[{ required: true, message: "必须选择 JG" }]}>
            <RemoteSelect api="/api/outsource/jg" placeholder="搜索加工单号或产品编码/名称"
              disabled={saving}
              getLabel={(r) => `${String(r.docNo)}｜${String(r.supplierName)}｜${String(r.productSkuCode)} ${String(r.productSkuName)}`} />
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
          <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
            仅未收：合格收货按收货单创建时点分段取价。含已收追溯：已批准后，未结算的合格收货也用追溯价；之后的新时段价继续生效。
            让步价仍按现行比例计算。已有结算草稿须手动更新加工费，待审批单须驳回后更新；已审批结算冻结，不自动改历史金额。
          </Typography.Paragraph>
          <Form.Item name="remark" label="备注">
            <Input.TextArea rows={2} maxLength={500} />
          </Form.Item>
        </Form>
      </Modal>

      <DocumentDrawer
        key={detailId ?? "invalid-document"}
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
        open={documentSelection.present}
        loading={detailRead.phase === "loading"}
        readError={documentSelection.error ?? detailRead.error}
        onRetry={detailId != null ? detailRead.retry : undefined}
        onClose={() => { if (!actionLock.current) setDetailId(null); }}
        maskClosable={!actionLoading}
        keyboard={!actionLoading}
        width={560}
        extra={
          current && (current.actions?.approve || current.actions?.reject) ? (
            <Space>
              {current.actions.approve && <Popconfirm
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
              </Popconfirm>}
              {current.actions.reject && <Button danger loading={actionLoading} onClick={() => setRejectOpen(true)}>
                驳回
              </Button>}
            </Space>
          ) : null
        }
      >
        {current ? (
          <><Alert type="info" showIcon style={{ marginBottom: 12 }} message={current.actions?.reason ?? "操作资格未加载，请刷新详情后重试。"} />
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
          <ApprovalTimeline items={current.approvals} /></>
        ) : null}
      </DocumentDrawer>

      <Modal
        title="驳回价格变更"
        open={rejectOpen}
        okText="确认驳回"
        okButtonProps={{ danger: true }}
        cancelText="取消"
        confirmLoading={actionLoading}
        onCancel={() => { if (!actionLock.current) setRejectOpen(false); }}
        maskClosable={!actionLoading}
        keyboard={!actionLoading}
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
