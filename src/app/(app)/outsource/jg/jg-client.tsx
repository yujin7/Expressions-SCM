"use client";

import { useLatestRead } from "@/components/useLatestRead";
import SupplierDeclaredCapacity from "@/components/SupplierDeclaredCapacity";
import type { DeclaredCapacityComparison } from "@/server/rules/declared-capacity";

import { useDocumentTarget } from "@/components/useDocumentTarget";
import { DOCUMENT_TRANSIENT_PARAMS } from "@/lib/document-links";
import { useDocumentRead } from "@/components/useDocumentRead";
import { formatQty } from "@/components/format";
import DocumentDrawer from "@/components/DocumentDrawer";

import SearchInput from "@/components/SearchInput";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import {
  App,
  Alert,
  Button,
  DatePicker,
  Descriptions,

  Form,
  Input,
  Modal,
  Popconfirm,
  Progress,
  Select,
  Space,
  Switch,
  Table,
  Tabs,
  Timeline,
  Typography,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import { ReloadOutlined } from "@ant-design/icons";
import dayjs from "dayjs";
import ChainStrip from "@/components/ChainStrip";
import JgExecutionStatus from "@/components/JgExecutionStatus";
import CaliberNote from "@/components/CaliberNote";
import { fetchJson, patchJson, postJson } from "@/components/fetchJson";
import ListToolbar from "@/components/ListToolbar";
import { useListState } from "@/components/useListState";
import type { jgTaskActions } from "@/server/modules/outsource/jg";
import { formatOrderType } from "@/components/labels";
import ApprovalTimeline from "@/components/ApprovalTimeline";

interface JgRow {
  id: number;
  docNo: string;
  status: string;
  woId: number;
  supplierName: string;
  productSkuCode: string;
  productSkuName: string;
  baseUom: string;
  qty: string;
  dueDate: string | null;
  inProduction: boolean;
  urgentFlag: boolean;
  isPaused: boolean;
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
  actions?: ReturnType<typeof jgTaskActions>;
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
  baseUom: string;
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
  capacity: {
    declared: DeclaredCapacityComparison;
    advisoryOnly: true;
    baseUom: string;
    dueMonth: string;
    stats: {
      sampleMonths: number;
      minMonths: number;
      reliable: boolean;
      p50: string | null;
      p90: string | null;
      months: { month: string; actualQty: string }[];
    };
    scheduledQty: string;
    projectedQty: string;
    utilizationPct: string | null;
    overP90: boolean;
    excessQty: string;
    explanation: string;
    limitations: string[];
  };
}

const STATUS_TABS = [
  { key: "", label: "全部" },
  { key: "draft", label: "草稿" },
  { key: "pending", label: "待审批" },
  { key: "approved", label: "已审批" },
  { key: "in_progress", label: "执行中" },
  { key: "completed", label: "已完成" },
  { key: "closed", label: "已关闭" },
  { key: "void", label: "已作废" },
];

function JgInner() {
  const { message } = App.useApp();
  const [rows, setRows] = useState<JgRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  // 列表页状态平台（E6-P1）：筛选/分页进 URL，密度与已保存视图存本地
  const listState = useListState({ transientParams: DOCUMENT_TRANSIENT_PARAMS, key: "jg", defaults: { q: "", status: "" }, defaultPageSize: 20 });
  const { filters, page, pageSize } = listState;
  const q = filters.q;
  const status = filters.status;

  const [planForm] = Form.useForm();
  const [planSaving, setPlanSaving] = useState(false);
  const [reviseOpen, setReviseOpen] = useState(false);
  const [reviseForm] = Form.useForm();
  const documentSelection = useDocumentTarget();
  const { id: detailId, setId: setDetailId } = documentSelection;
  useEffect(() => { setRejectOpen(false); setConfirmOpen(false); setReviseOpen(false); }, [detailId]);
  const detailRead = useDocumentRead<JgDetail>(detailId == null ? null : `/api/outsource/jg/${detailId}`);
  const detail = detailRead.data;
  const detailLoading = detailRead.phase === "loading";
  const loadDetail = detailRead.retry;
  const detailLoadError = detailRead.error;
  const [actionLoading, setActionLoading] = useState(false);
  const actionLock = useRef(false);
  const canPlan = detail?.actions?.plan === true && !actionLoading && !planSaving;
  const canRevise = detail?.actions?.revise === true && !actionLoading && !planSaving;

  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectComment, setRejectComment] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmNote, setConfirmNote] = useState("");

  const beginLoadRead = useLatestRead();
  const load = useCallback(async () => {
    const readRequest = beginLoadRead();
    setLoading(true);
    setLoadError(null);
    try {
      const params = new URLSearchParams({ q, page: String(page), pageSize: String(pageSize) });
      if (status) params.set("status", status);
      const res = await fetchJson<{ rows: JgRow[]; total: number }>(
        `/api/outsource/jg?${params.toString()}`, { signal: readRequest.signal });
      if (!readRequest.isCurrent()) return;
      setRows(res.rows);
      setTotal(res.total);
    } catch (e) {
      if (!readRequest.isCurrent()) return;
      const text = e instanceof Error ? e.message : "加工通知单加载失败";
      setRows([]);
      setTotal(0);
      setLoadError(text);
      message.error(text);
    } finally {
      if (readRequest.isCurrent()) { setLoading(false); }
    }
  }, [beginLoadRead, q, status, page, pageSize, message]);

  useEffect(() => {
    void load();
  }, [load]);



  const refresh = () => {
    if (detail) void loadDetail();
    void load();
  };

  const post = async (path: string, body: unknown, successText: string) => {
    const permission = path === "revise-due" ? "revise" : path === "approve" ? "approve"
      : path === "submit" ? "submit" : path === "withdraw" ? "withdraw" : path === "confirm" ? "confirm" : null;
    if (!detail || !permission || detail.actions?.[permission] !== true || actionLock.current) return false;
    actionLock.current = true;
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
      actionLock.current = false;
      setActionLoading(false);
    }
  };

  const columns: ColumnsType<JgRow> = [
    {
      title: "单据号",
      dataIndex: "docNo",
      width: 160,
      render: (v: string, r) => (
        <Typography.Link style={{ whiteSpace: "nowrap" }} onClick={() => setDetailId(r.id)}>{v}</Typography.Link>
      ),
    },
    {
      title: "成品",
      key: "product",
      width: 210,
      render: (_, r) => <div style={{ minWidth: 140, maxWidth: 210, overflowWrap: "anywhere" }}>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>{r.productSkuCode}</Typography.Text>
        <div>{r.productSkuName || "名称待补录"}</div>
      </div>,
    },
    { title: "数量", dataIndex: "qty", width: 100, align: "right", render: (value: string, row) => <span style={{ whiteSpace: "nowrap" }}>{formatQty(value)} {row.baseUom || "单位待核对"}</span> },
    { title: "加工厂", dataIndex: "supplierName", width: 120 },
    {
      title: "交期",
      dataIndex: "dueDate",
      width: 110,
      render: (v: string | null) => <span style={{ whiteSpace: "nowrap" }}>{v ?? "未填交期"}</span>,
    },
    {
      title: "状态与执行",
      key: "execution",
      width: 180,
      render: (_, row) => <JgExecutionStatus facts={row} docNo={row.docNo} />,
    },
    {
      title: "操作",
      key: "_actions",
      width: 64,
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
    <Space wrap>
      {detail.actions?.submit === true ? (
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
      {detail.actions?.approve === true ? (
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
      {detail.actions?.withdraw === true ? (
          <Popconfirm
            title="撤回本单？"
            description="撤回后回到草稿，可继续修改再提交。"
            okText="撤回"
            cancelText="取消"
            onConfirm={() => void post("withdraw", { version: detail.version }, "已撤回，单据回到草稿")}
          >
            <Button loading={actionLoading}>撤回</Button>
          </Popconfirm>
      ) : null}
      {detail.actions?.confirm === true ? (
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
        加工通知单由委外工单派生，来源及批次关系见单据链，本页不提供手工创建；加工费改价请前往「价格变更」发起。
      </Typography.Paragraph>
      <CaliberNote summary="加工确认不是实时生产进度；收货、质检与入库请沿单据链核对。"
        detail="已完成、已关闭、已作废的单据不再显示正在生产或未开始。历史加急/暂停保留用于追溯；当前计划标记也不等于自动逾期预警。" />
      <Tabs
        activeKey={status}
        items={STATUS_TABS}
        onChange={(key) => listState.setFilter({ status: key })}
      />
      <ListToolbar
        state={listState}
        primaryActions={
          <Button icon={<ReloadOutlined />} onClick={() => void load()}>
            刷新
          </Button>
        }
        extra={
          <SearchInput
            key={q}
            allowClear
            defaultValue={q}
            placeholder="搜索单号 / SKU 编码 / 货品名称"
            style={{ width: 240 }}
            onSearch={(value) => listState.setFilter({ q: value.trim() })}
          />
        }
      />
      {loadError ? (
        <Alert
          type="error"
          showIcon
          message="加工通知单加载失败"
          description={loadError}
          action={<Button size="small" icon={<ReloadOutlined />} onClick={() => void load()}>重试</Button>}
          style={{ marginBottom: 12 }}
        />
      ) : null}
      <Table<JgRow>
        rowKey="id"
        size={listState.tableSize}
        columns={columns}
        dataSource={rows}
        loading={loading}
        scroll={{ x: "max-content" }}
        pagination={listState.paginationProps({ total: total })}
        locale={{ emptyText: loadError ? "数据未加载" : "当前筛选下没有加工通知单" }}
      />

      <DocumentDrawer
        key={detailId ?? "invalid-document"}
        title={
          detail ? (
            <Space wrap align="start">
              <span>{detail.docNo}</span>
              <JgExecutionStatus facts={detail} docNo={detail.docNo} />
            </Space>
          ) : (
            "加工通知单详情"
          )
        }
        open={documentSelection.present}
        readError={documentSelection.error ?? detailRead.error}
        onRetry={detailId != null ? detailRead.retry : undefined}
        onClose={() => { if (!actionLock.current) setDetailId(null); }}
        keyboard={!actionLoading && !planSaving}
        maskClosable={!actionLoading && !planSaving}
        width={760}
        loading={detailLoading}
        extra={actions}
      >
        {detailLoadError ? (
          <Alert
            type="error"
            showIcon
            message="加工通知单详情加载失败"
            description={detailLoadError}
            action={detailId != null ? <Button size="small" onClick={() => void loadDetail()}>重试</Button> : undefined}
          />
        ) : detail ? (
          <div>
            <Alert type="info" showIcon style={{ marginBottom: 12 }}
              message={detail.actions?.reason ?? "尚未取得当前操作资格，请刷新单据；暂仅展示数据。"}
              action={<Button size="small" disabled={actionLoading || planSaving} onClick={loadDetail}>刷新权限</Button>} />
            <ChainStrip docType="jg" id={detail.id} />
            <Descriptions column={{ xs: 1, sm: 2 }} size="small" bordered style={{ marginBottom: 16 }}>
              <Descriptions.Item label="关联工单">{detail.woDocNo}</Descriptions.Item>
              <Descriptions.Item label="加工厂">{detail.supplierName}</Descriptions.Item>
              <Descriptions.Item label="成品">
                {detail.productSkuCode} {detail.productSkuName}
              </Descriptions.Item>
              <Descriptions.Item label="数量">{formatQty(detail.qty)} {detail.baseUom || "单位待核对"}</Descriptions.Item>
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
            <Typography.Title level={5}>供应商产能（独立证据 · 只提示）</Typography.Title>
            <SupplierDeclaredCapacity value={detail.capacity.declared} supplierName={detail.supplierName} />
            <Alert
              type={
                !detail.capacity.stats.reliable
                  ? "info"
                  : detail.capacity.overP90
                    ? "warning"
                    : "success"
              }
              showIcon
              message={
                !detail.capacity.stats.reliable
                  ? `样本不足（${detail.capacity.stats.sampleMonths}/${detail.capacity.stats.minMonths} 个活跃月）`
                  : detail.capacity.overP90
                    ? `${detail.capacity.dueMonth} 计划负荷超过历史活跃月 P90`
                    : `${detail.capacity.dueMonth} 计划负荷在历史活跃月 P90 内`
              }
              description={
                <Space direction="vertical" size={8} style={{ width: "100%" }}>
                  <Typography.Text>{detail.capacity.explanation}</Typography.Text>
                  {detail.capacity.stats.reliable && detail.capacity.utilizationPct != null ? (
                    <Progress
                      percent={Math.min(100, Number(detail.capacity.utilizationPct))}
                      status={detail.capacity.overP90 ? "exception" : "normal"}
                      format={() => `${detail.capacity.utilizationPct}%`}
                    />
                  ) : null}
                  <Typography.Text type="secondary">
                    {detail.capacity.dueMonth} 计划 {detail.capacity.projectedQty} {detail.capacity.baseUom}
                    {detail.capacity.stats.p90 != null
                      ? ` · P90 ${detail.capacity.stats.p90} ${detail.capacity.baseUom}`
                      : ""}
                    {" · "}仅提示，不阻断建单或审批
                  </Typography.Text>
                </Space>
              }
              style={{ marginBottom: 20 }}
            />
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
              key={detail.id}
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
                    if (!canPlan || actionLock.current) return;
                    actionLock.current = true;
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
                      void loadDetail();
                      void load();
                    } catch (e) {
                      message.error((e as Error).message);
                    } finally {
                      actionLock.current = false;
                      setPlanSaving(false);
                    }
                  }}
                >
                  保存计划属性
                </Button>
                <Button disabled={!canRevise} onClick={() => setReviseOpen(true)}>
                  交期修改
                </Button>
                <Button disabled={false} onClick={() => window.open(`/outsource/jg/${detail.id}/print`, "_blank")}>打印通知单</Button>
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
              open={reviseOpen && detail.actions?.revise === true}
              confirmLoading={actionLoading}
              onCancel={() => { if (!actionLock.current) setReviseOpen(false); }}
              onOk={async () => {
                const v = await reviseForm.validateFields();
                const ok = await post("revise-due", {
                  newDate: v.newDate.format("YYYY-MM-DD"),
                  reason: v.reason,
                }, "交期已修改并留痕");
                if (!ok) return;
                setReviseOpen(false);
                reviseForm.resetFields();
                void loadDetail();
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
                <ApprovalTimeline items={detail.approvals} />
              </>
            ) : null}
          </div>
        ) : null}
      </DocumentDrawer>

      <Modal
        title="驳回单据"
        open={rejectOpen && detail?.actions?.approve === true}
        okText="确认驳回"
        okButtonProps={{ danger: true }}
        cancelText="取消"
        confirmLoading={actionLoading}
        onCancel={() => { if (!actionLock.current) setRejectOpen(false); }}
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
        open={confirmOpen && detail?.actions?.confirm === true}
        okText="确认"
        cancelText="取消"
        confirmLoading={actionLoading}
        onCancel={() => { if (!actionLock.current) setConfirmOpen(false); }}
        onOk={() =>
          void post(
            "confirm",
            { version: detail?.version ?? 0, note: confirmNote.trim() || undefined },
            "已登记加工厂确认，单据进入执行中",
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
          placeholder="确认备注（可选）——登记工厂回复，不代表现场开工或完工"
          value={confirmNote}
          onChange={(e) => setConfirmNote(e.target.value)}
        />
      </Modal>
    </div>
  );
}

export default function JgClient() {
  // useListState 读 useSearchParams，需要 Suspense 边界
  return (
    <Suspense>
      <JgInner />
    </Suspense>
  );
}
