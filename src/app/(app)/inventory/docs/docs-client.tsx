"use client";

import { useLatestRead } from "@/components/useLatestRead";

import { useDocumentTarget } from "@/components/useDocumentTarget";
import { DOCUMENT_TRANSIENT_PARAMS } from "@/lib/document-links";
import { useDocumentRead } from "@/components/useDocumentRead";
import DocumentDrawer from "@/components/DocumentDrawer";

import SearchInput from "@/components/SearchInput";
import { TRANSFER_TYPE_LABELS, TRANSFER_TYPES } from "@/lib/transfer-types";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { Alert, App, Button, Descriptions, Form, Input, InputNumber, Modal, Select, Space, Table, Tabs, Tag, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { DeleteOutlined, ExperimentOutlined, PlusOutlined, ReloadOutlined } from "@ant-design/icons";
import { formatAsOf } from "@/components/format";
import ExportButton from "@/components/ExportButton";
import RemoteSelect from "@/components/RemoteSelect";
import DocStatusTag from "@/components/DocStatusTag";
import DocActions from "@/components/DocActions";
import ListToolbar from "@/components/ListToolbar";
import { useListState } from "@/components/useListState";
import { fetchJson } from "@/components/fetchJson";
import { useMe, hasAnyRole, type Me } from "@/components/useMe";
import StockCreateRecovery, { useStockCreateRecovery } from "@/components/StockCreateRecovery";
import type { StockCreatePayload } from "@/components/stock-create-request";
import { STOCK_SUBTYPE_LABELS, toOptions } from "@/components/labels";
import ApprovalTimeline from "@/components/ApprovalTimeline";
import { useSearchParams } from "next/navigation";
import { FefoPreviewModal } from "./FefoPreviewModal";
import { currentFefoPreviewKey, fefoPreviewKey, useFefoPreview } from "@/components/useFefoPreview";
import { compareDecimalValues } from "@/lib/decimal-sort";
import LoadErrorAlert from "@/components/LoadErrorAlert";
import type { StockDocActionHints } from "@/lib/stock-doc-actions";
import { expiryReferenceKey, useExpiryReference } from "@/components/useExpiryReference";
import ExpiryReferenceNotice from "@/components/ExpiryReferenceNotice";

interface DocRow {
  id: number;
  docNo: string;
  subtype: string;
  status: string;
  transferType?: string | null;
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
  batchId: number | null;
  batchNo: string | null;
  expiryDate: string | null;
}

interface DocApproval {
  approverName: string | null;
  action: "approve" | "reject";
  comment: string | null;
  createdAt: string;
}

interface DocDetail {
  actions?: StockDocActionHints;
  id: number;
  docNo: string;
  subtype: string;
  status: string;
  version: number;
  remark: string | null;
  closedReason: string | null;
  warehouseId: number;
  warehouseName: string;
  toWarehouseId: number | null;
  toWarehouseName: string | null;
  reversalOfId: number | null;
  lines: DocLine[];
  approvals: DocApproval[];
  approvalBasis?: { label: string; href: string | null; sourceDocNo: string | null; verified: boolean; note: string | null };
  createdByName: string;
  createdAt: string;
}

interface CreateFormValues {
  subtype: StockCreatePayload["subtype"];
  warehouseId: number;
  toWarehouseId?: number;
  reason?: string; // R16：调拨业务原因
  transferType?: StockCreatePayload["transferType"]; // D60：固定清单
  remark?: string;
  riskDisposalId?: number;
  lines?: { skuId: number; qty: number | string; price?: number | string | null; batchId?: number | null }[];
}

const BATCH_OUTBOUND_SUBTYPES = new Set(["issue_out", "sales_out", "transfer"]);

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
  // W2-3：短关（已审批/执行中 → 已关闭）与作废（草稿 → 已作废）落地后，这两个页签才有数据来源
  { key: "closed", label: "已关闭" },
  { key: "void", label: "已作废" },
];

function SubtypeTag({ subtype }: { subtype: string }) {
  return <Tag color={SUBTYPE_COLORS[subtype] ?? "default"}>{STOCK_SUBTYPE_LABELS[subtype] ?? subtype}</Tag>;
}

export default function DocsClient() {
  const me = useMe();
  // useSearchParams（列表页状态平台 E6-P1）需要 Suspense 边界
  return (
    <Suspense>
      <DocsInner key={`${me?.id}:${me?.roles.join(",")}`} me={me} />
    </Suspense>
  );
}

function DocsInner({ me }: { me: Me | null }) {
  const { message } = App.useApp();
  const searchParams = useSearchParams();
  const [form] = Form.useForm<CreateFormValues>();
  const [rows, setRows] = useState<DocRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  // 列表页状态平台（E6-P1）：筛选/分页进 URL（?status=pending 工作台直达），密度与已保存视图存本地
  const listState = useListState({ transientParams: DOCUMENT_TRANSIENT_PARAMS,
    key: "inv-docs",
    defaults: { q: "", status: "", subtype: "" },
    defaultPageSize: 20,
  });
  const { filters, page, pageSize } = listState;
  const q = filters.q;
  const status = filters.status;
  const subtype = filters.subtype || undefined;

  const [createOpen, setCreateOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [editingRequest, setEditingRequest] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const recovery = useStockCreateRecovery(me?.id ?? null, hasAnyRole(me, "warehouse"), () => void load());
  const createSubtype = Form.useWatch("subtype", form);
  const createWarehouseId = Form.useWatch("warehouseId", form);
  const createLines = Form.useWatch("lines", form);
  const createRiskDisposalId = Form.useWatch("riskDisposalId", form);
  const handledScrapLink = useRef<string | null>(null);
  const batchStatus = useDocumentRead<{ enabled: boolean }>(createOpen ? "/api/inventory/batch-posting/status" : null);
  const batchStatusKnown = batchStatus.phase === "success" && typeof batchStatus.data?.enabled === "boolean";
  const batchPostingEnabled = batchStatusKnown && batchStatus.data?.enabled === true;
  const batchStatusError = batchStatus.error ?? (batchStatus.phase === "success" && !batchStatusKnown ? "批次规则响应不完整" : null);
  const [fefoPreviewOpen, setFefoPreviewOpen] = useState(false);
  const [fefoTarget, setFefoTarget] = useState<string | null>(null);
  const currentFefoKey = currentFefoPreviewKey({ subtype: createSubtype, warehouseId: createWarehouseId, lines: createLines, riskDisposalId: createRiskDisposalId });
  const fefo = useFefoPreview(createOpen && fefoPreviewOpen ? fefoTarget : null, currentFefoKey);
  const [confirmedFefoFingerprint, setConfirmedFefoFingerprint] = useState<string | null>(null);
  const fefoConfirmed = currentFefoKey != null && confirmedFefoFingerprint === currentFefoKey;

  useEffect(() => {
    if (searchParams.get("create") !== "scrap" || !recovery.ready || recovery.request || !hasAnyRole(me, "warehouse")) return;
    const skuId = Number(searchParams.get("skuId"));
    const riskDisposalId = Number(searchParams.get("disposalId"));
    const linkKey = `${skuId}:${riskDisposalId}`;
    if (
      handledScrapLink.current === linkKey
      || !Number.isInteger(skuId)
      || skuId <= 0
      || !Number.isInteger(riskDisposalId)
      || riskDisposalId <= 0
    ) return;
    handledScrapLink.current = linkKey;
    form.setFieldsValue({
      subtype: "issue_out",
      riskDisposalId,
      remark: "风险库存报废处置",
      lines: [{ skuId, qty: 1 }],
    });
    setCreateOpen(true);
  }, [form, searchParams, recovery.ready, recovery.request, me]);

  useEffect(() => {
    setConfirmedFefoFingerprint(null);
    if (!createOpen) { setFefoPreviewOpen(false); setFefoTarget(null); }
  }, [createOpen, currentFefoKey]);

  // R15 只读盘点参考；失败保持未知，不改变现行审批/过账规则。
  const expiryRead = useExpiryReference(expiryReferenceKey(
    createOpen && (createSubtype === "sales_out" || createSubtype === "transfer"), createWarehouseId, createLines,
  ));

  const documentSelection = useDocumentTarget();
  const { id: detailId, setId: setDetailId } = documentSelection;
  const detailRead = useDocumentRead<DocDetail>(detailId == null ? null : `/api/inventory/stock-doc/${detailId}`);
  const detail = detailRead.data;
  const detailLoading = detailRead.phase === "loading";
  const loadDetail = detailRead.retry;

  const loadFefoPreview = async (): Promise<boolean> => {
    try {
      const values = await form.validateFields(["subtype", "warehouseId", "lines", "riskDisposalId"]);
      if (!BATCH_OUTBOUND_SUBTYPES.has(values.subtype)) return true;
      setConfirmedFefoFingerprint(null);
      setFefoTarget(fefoPreviewKey(values));
      setFefoPreviewOpen(true);
      fefo.retry();
      return true;
    } catch (error) {
      if (error instanceof Error && error.message) message.error(error.message);
      return false;
    }
  };

  const beginLoadRead = useLatestRead();
  const load = useCallback(async () => {
    const readRequest = beginLoadRead();
    setLoading(true);
    try {
      const params = new URLSearchParams({ q, page: String(page), pageSize: String(pageSize) });
      if (status) params.set("status", status);
      if (subtype) params.set("subtype", subtype);
      const res = await fetchJson<{ rows: DocRow[]; total: number }>(
        `/api/inventory/stock-doc?${params.toString()}`, { signal: readRequest.signal });
      if (!readRequest.isCurrent()) return;
      setRows(res.rows);
      setTotal(res.total);
    } catch (e) {
      if (!readRequest.isCurrent()) return;
      message.error((e as Error).message);
    } finally {
      if (readRequest.isCurrent()) { setLoading(false); }
    }
  }, [beginLoadRead, q, status, subtype, page, pageSize, message]);

  useEffect(() => {
    void load();
  }, [load]);



  const handleCreate = async () => {
    if (savingRef.current || recovery.busy) return;
    savingRef.current = true;
    setSaveError(null);
    try {
      const values = await form.validateFields();
      const lines = (values.lines ?? []).filter((l) => l && l.skuId != null);
      if (lines.length === 0) {
        message.warning("至少添加一行明细");
        return;
      }
      if (BATCH_OUTBOUND_SUBTYPES.has(values.subtype) && !batchStatusKnown) {
        throw Error("尚未取得批次规则，请先重试读取；未发送建单请求");
      }
      if (batchPostingEnabled && BATCH_OUTBOUND_SUBTYPES.has(values.subtype)) {
        const fingerprint = fefoPreviewKey(values);
        if (confirmedFefoFingerprint !== fingerprint) {
          const opened = await loadFefoPreview();
          if (opened) message.info("请核对并确认 FEFO 批次预分配后再保存");
          return;
        }
      }
      setSaving(true);
      const body = {
        subtype: values.subtype,
        warehouseId: values.warehouseId,
        toWarehouseId: values.subtype === "transfer" ? values.toWarehouseId : undefined,
        reason: values.subtype === "transfer" ? values.reason || undefined : undefined,
        transferType: values.subtype === "transfer" ? values.transferType : undefined,
        remark: values.remark?.trim() || undefined,
        riskDisposalId: values.riskDisposalId,
        lines: lines.map((l) => ({
          skuId: l.skuId,
          qty: l.qty,
          batchId: l.batchId,
          price: values.subtype === "opening" ? l.price : undefined,
        })),
      };
      const result = await recovery.submit(body, editingRequest);
      if (!result?.document) return;
      message.success("已确认原库存单，请核对当前状态");
      setCreateOpen(false);
      setEditingRequest(false);
      form.resetFields();
      void load();
    } catch (e) {
      if (e instanceof Error && e.message) setSaveError(e.message);
    } finally {
      savingRef.current = false;
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
    {
      title: "类型",
      dataIndex: "subtype",
      width: 150,
      render: (v: string, r) => (
        <span>
          <SubtypeTag subtype={v} />
          {v === "transfer" ? (
            <Tag style={{ marginInlineStart: 4 }}>{r.transferType ? (TRANSFER_TYPE_LABELS[r.transferType as keyof typeof TRANSFER_TYPE_LABELS] ?? r.transferType) : "未分类"}</Tag>
          ) : null}
        </span>
      ),
    },
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
      render: (v: string) => formatAsOf(v),
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
    { title: "名称", dataIndex: "skuName", width: 180 },
    { title: "数量", dataIndex: "qty", width: 110, align: "right" },
    {
      title: "批次",
      dataIndex: "batchNo",
      width: 150,
      render: (value: string | null, row) =>
        value ? (
          <Space size={4} wrap>
            <Tag color="blue" style={{ whiteSpace: "normal", overflowWrap: "anywhere" }}>{value}</Tag>
            {row.expiryDate ? <Typography.Text type="secondary">{row.expiryDate}</Typography.Text> : null}
          </Space>
        ) : (
          <Typography.Text type="secondary">无批次</Typography.Text>
        ),
    },
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
        onChange={(key) => listState.setFilter({ status: key })}
      />
      {!createOpen && <StockCreateRecovery recovery={recovery} onEdit={request => {
        form.resetFields();
        form.setFieldsValue({ ...request, toWarehouseId: request.toWarehouseId ?? undefined });
        setEditingRequest(true); setSaveError(null); setCreateOpen(true);
      }} />}
      <ListToolbar
        state={listState}
        primaryActions={
          <>
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
              disabled={!hasAnyRole(me, "warehouse") || !recovery.ready || recovery.busy || !!recovery.request}
              onClick={() => {
                form.resetFields();
                setSaveError(null);
                setEditingRequest(false);
                setCreateOpen(true);
              }}
            >
              新建单据
            </Button>
          </>
        }
        extra={
          <>
            <SearchInput
              key={q}
              allowClear
              defaultValue={q}
              placeholder="搜索单据号"
              style={{ width: 240 }}
              onSearch={(value) => listState.setFilter({ q: value.trim() })}
            />
            <Select
              allowClear
              placeholder="全部类型"
              style={{ width: 160 }}
              options={toOptions(STOCK_SUBTYPE_LABELS)}
              value={subtype}
              onChange={(v) => listState.setFilter({ subtype: v ?? "" })}
            />
          </>
        }
      />
      <Table<DocRow>
        rowKey="id"
        size={listState.tableSize}
        columns={columns}
        dataSource={rows}
        scroll={{ x: "max-content" }}
        loading={loading}
        pagination={listState.paginationProps({ total: total })}
      />

      <Modal
        title="新建库存单据"
        open={createOpen}
        onOk={() => void handleCreate()}
        onCancel={() => setCreateOpen(false)}
        confirmLoading={saving || recovery.busy}
        okButtonProps={{ disabled: !recovery.ready || !!recovery.result?.document || !!recovery.result?.cancelled || (!!recovery.request && !editingRequest) || (BATCH_OUTBOUND_SUBTYPES.has(createSubtype) && !batchStatusKnown) }}
        width="min(720px, 100vw)"
        forceRender
        maskClosable={false}
        okText="保存草稿"
        cancelText="取消"
      >
        <StockCreateRecovery recovery={recovery} onAcknowledged={() => {
          form.resetFields(); setEditingRequest(false); setSaveError(null); setConfirmedFefoFingerprint(null); setFefoPreviewOpen(false); setFefoTarget(null);
        }} onEdit={request => {
          form.setFieldsValue({ ...request, toWarehouseId: request.toWarehouseId ?? undefined });
          setEditingRequest(true); setSaveError(null);
        }} />
        {saveError && <Alert type="error" showIcon message="尚未保存" description={saveError} style={{ marginBottom: 12 }} />}
        <LoadErrorAlert error={batchStatusError} onRetry={batchStatus.retry} subject="批次规则" retrying={batchStatus.phase === "loading"} />
        {BATCH_OUTBOUND_SUBTYPES.has(createSubtype) && !batchStatusKnown && !batchStatusError && <Alert type="info" showIcon message="正在核对批次规则，暂不可保存出库草稿" style={{ marginBottom: 12 }} />}
        <Form form={form} layout="vertical">
          <Form.Item name="riskDisposalId" hidden>
            <Input />
          </Form.Item>
          <Form.Item name="subtype" label="类型" rules={[{ required: true, message: "必须选择单据类型" }]}>
            <Select
              options={toOptions(MANUAL_SUBTYPE_LABELS)}
              placeholder="期初/领料出/销售出/调拨（红字冲销不可手工创建）"
            />
          </Form.Item>
          <Form.Item name="warehouseId" label="仓库（仅实时记账仓）" rules={[{ required: true, message: "必须选择仓库" }]}>
            <RemoteSelect
              api="/api/master/warehouse"
              getLabel={(r) => `${String(r.code)} ${String(r.name)}`}
              // 与盘点页同一过滤：四类手工单的源仓必须是实时记账仓，快照仓选了也只会在提交时被拒（createStockDoc）
              filterRow={(r) => r.accountingMode === "realtime" && r.active !== false}
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
                // 转入仓不能是快照仓（服务端「快照仓 1.1 启用」拒绝），选项里就不给
                filterRow={(r) => r.active !== false && r.accountingMode !== "snapshot" && r.kind !== "snapshot"}
                placeholder="选择目标仓库"
              />
            </Form.Item>
          ) : null}
          {createRiskDisposalId ? (
            <Alert
              type="warning"
              showIcon
              style={{ marginBottom: 12 }}
              message="已绑定风险库存报废登记"
              description="请核对仓库、批次与实际报废数量。审批过账后处置登记会自动完成；若后续红字冲销，登记会自动重开。"
            />
          ) : null}
          {createSubtype === "transfer" ? (
            <Form.Item
              name="transferType"
              label="调拨类型（D60 固定清单；线路成本基线按类型分列）"
              rules={[{ required: true, message: "调拨必须选择调拨类型" }]}
            >
              <Select
                placeholder="工厂发仓 / 保税转运 / 仓间调拨 / 借调 / 退回工厂 / 其他"
                options={TRANSFER_TYPES.map((t) => ({ value: t, label: TRANSFER_TYPE_LABELS[t] }))}
              />
            </Form.Item>
          ) : null}
          {createSubtype === "transfer" ? (
            <Form.Item name="reason" label="业务原因（R16：借调将进入月末部门间借调对账）">
              <Select
                allowClear
                placeholder="正常调拨可不填"
                options={[
                  { value: "借调", label: "借调（部门间借货，月末自动对账）" },
                  { value: "补货", label: "补货" },
                  { value: "退仓", label: "退仓" },
                  { value: "调仓优化", label: "调仓优化" },
                ]}
              />
            </Form.Item>
          ) : null}
          <Form.Item name="remark" label="备注">
            <Input.TextArea rows={2} maxLength={200} />
          </Form.Item>
          <ExpiryReferenceNotice read={expiryRead} />
          <Space style={{ width: "100%", justifyContent: "space-between", marginBottom: 8 }} wrap>
            <Typography.Text strong>明细行</Typography.Text>
            {batchPostingEnabled && BATCH_OUTBOUND_SUBTYPES.has(createSubtype) ? (
              <Button
                icon={<ExperimentOutlined />}
                onClick={() => void loadFefoPreview()}
                loading={fefo.loading}
              >
                预览 FEFO 批次
              </Button>
            ) : null}
          </Space>
          {batchPostingEnabled && BATCH_OUTBOUND_SUBTYPES.has(createSubtype) ? (
            <Alert
              type={fefoConfirmed ? "success" : "info"}
              showIcon
              style={{ marginBottom: 12 }}
              message={fefoConfirmed ? "已确认当前 FEFO 预分配" : "保存前需核对 FEFO 批次"}
              description="修改仓库、SKU 或数量后需要重新确认；系统保存时会再次校验，以防并发出库造成批次余额变化。"
            />
          ) : null}
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
                      <InputNumber stringMode min="0.0001" max="9999999999.9999" precision={4} placeholder="数量" aria-label={`第${name + 1}行数量`} style={{ width: 130 }} />
                    </Form.Item>
                    {createSubtype === "opening" ? (
                      <Form.Item {...restField} name={[name, "price"]} style={{ marginBottom: 8 }}>
                        <InputNumber stringMode min="0" max="999999999999.99" precision={2} placeholder="单价（可选）" style={{ width: 130 }} />
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

      <FefoPreviewModal
        open={createOpen && fefoPreviewOpen}
        loading={fefo.loading}
        groups={fefo.groups}
        error={fefo.error}
        onRetry={() => void loadFefoPreview()}
        onCancel={() => setFefoPreviewOpen(false)}
        onConfirm={() => {
          const values = form.getFieldsValue(["subtype", "warehouseId", "lines", "riskDisposalId"]);
          const key = currentFefoPreviewKey(values);
          if (key == null || key !== fefoTarget || fefo.loading || fefo.error || !fefo.groups?.length
            || fefo.groups.some(group => compareDecimalValues(group.shortBy, "0") > 0)) {
            message.warning("当前批次预览尚未确认，请重新读取"); return;
          }
          setConfirmedFefoFingerprint(key);
          setFefoPreviewOpen(false);
          message.success("已确认 FEFO 批次规则；保存时将重新校验并写入草稿行");
        }}
      />

      <DocumentDrawer
        key={detailId ?? "invalid-document"}
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
        open={documentSelection.present}
        readError={documentSelection.error ?? detailRead.error}
        onRetry={detailId != null ? detailRead.retry : undefined}
        onClose={() => setDetailId(null)}
        width="min(720px, 100vw)"
        loading={detailLoading}
        extra={
          detail && (detail.subtype !== "count_adjust" || detail.status === "completed") ? (
            <DocActions
              key={`${detail.id}:${detail.version}`}
              docType="stock-doc"
              apiBase="/api/inventory/stock-doc"
              doc={{
                id: detail.id,
                docNo: detail.docNo,
                status: detail.status,
                version: detail.version,
                subtype: detail.subtype,
                reversalOfId: detail.reversalOfId,
                actions: detail.actions,
              }}
              onChanged={() => {
                void loadDetail();
                void load();
              }}
            />
          ) : null
        }
      >
        {detail ? (
          <div>
            {detail.actions?.reason ? <Alert type="info" showIcon message={detail.actions.reason} style={{ marginBottom: 12 }} /> : null}
            {["void", "closed"].includes(detail.status) && <Alert type="info" showIcon style={{ marginBottom: 12 }}
              message={detail.status === "void" ? "作废原因" : "短关原因"}
              description={detail.closedReason?.trim() || "历史单据未记录原因，请核对审计记录；不能据此判断库存已被冲销。"} />}
            <Descriptions column={{ xs: 1, sm: 2 }} size="small" bordered
              styles={{ label: { whiteSpace: "nowrap" }, content: { overflowWrap: "anywhere" } }} style={{ marginBottom: 16 }}>
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
                {formatAsOf(detail.createdAt)}（上海时间）
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
              scroll={{ x: 740 }}
              style={{ marginBottom: 24 }}
            />
            {detail.approvalBasis?.note ? <Alert
              type={detail.approvalBasis.verified ? "info" : "warning"}
              showIcon
              message={detail.approvalBasis.label}
              description={<>
                {detail.approvalBasis.note}
                {detail.approvalBasis.href ? <div style={{ marginTop: 8 }}><a href={detail.approvalBasis.href} style={{ display: "inline-block" }}>查看来源盘点：{detail.approvalBasis.sourceDocNo}</a></div> : null}
              </>}
              style={{ marginBottom: 16 }}
            /> : null}
            {detail.approvals.length > 0 ? (
              <>
                <Typography.Title level={5}>{detail.approvalBasis?.label ?? "审批记录"}</Typography.Title>
                <ApprovalTimeline items={detail.approvals} />
              </>
            ) : null}
          </div>
        ) : null}
      </DocumentDrawer>
    </div>
  );
}
