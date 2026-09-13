"use client";

import { useDocumentTarget } from "@/components/useDocumentTarget";
import { DOCUMENT_TRANSIENT_PARAMS } from "@/lib/document-links";
import { useDocumentRead } from "@/components/useDocumentRead";
import DocumentDrawer from "@/components/DocumentDrawer";

import SearchInput from "@/components/SearchInput";

import { useEffect, useRef, useState } from "react";
import { App, Alert, Button, Descriptions, Input, InputNumber, Modal, Popconfirm, Space, Table, Tabs, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { PlusOutlined, ReloadOutlined } from "@ant-design/icons";
import dayjs from "dayjs";
import ChainStrip from "@/components/ChainStrip";
import DocStatusTag from "@/components/DocStatusTag";
import ListToolbar from "@/components/ListToolbar";
import RemoteSelect from "@/components/RemoteSelect";
import { postJson } from "@/components/fetchJson";
import LoadErrorAlert from "@/components/LoadErrorAlert";
import { formatQty } from "@/components/format";
import { useListState } from "@/components/useListState";
import { hasAnyRole, useMe, type Me } from "@/components/useMe";
import ApprovalTimeline from "@/components/ApprovalTimeline";
import CtDraftEditor from "./ct-draft-editor";
import CtDraftVoid from "./ct-draft-void";
import CtCreateRecovery, { useCtCreateRecovery } from "@/components/CtCreateRecovery";
import type { CtCreateRequest } from "@/components/ct-create-request";
import { viewportModalProps } from "@/components/viewport-modal";

// ---------- 客户端十进制比较（仅提交前过滤/预警用；非负字符串，禁 float） ----------

const DEC_RE = /^\d+(\.\d+)?$/;
const QTY_RE = /^\d{1,10}(\.\d{1,4})?$/;
const qtyUnits = (s: string) => { const [whole, fraction = ""] = s.split("."); return BigInt(whole) * 10000n + BigInt(fraction.padEnd(4, "0")); };

function decCmp(a: string, b: string): number {
  const [ai, af = ""] = a.split(".");
  const [bi, bf = ""] = b.split(".");
  const scale = Math.max(af.length, bf.length);
  const av = BigInt((ai || "0") + af.padEnd(scale, "0"));
  const bv = BigInt((bi || "0") + bf.padEnd(scale, "0"));
  return av === bv ? 0 : av > bv ? 1 : -1;
}

// ---------- 接口形状（对照 src/server/modules/matflow/ct.ts） ----------

interface CtRow {
  id: number;
  docNo: string;
  status: string;
  poId: number;
  poDocNo: string;
  warehouseName: string;
  lineCount: number;
  createdByName: string | null;
  createdAt: string;
}

interface CtLine {
  id: number;
  poLineId: number;
  skuId: number;
  skuCode: string;
  skuName: string;
  baseUom: string;
  qty: string;
  reason: string | null;
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

interface CtDetail {
  id: number;
  createdBy: number;
  docNo: string;
  status: string;
  remark: string | null;
  closedReason?: string | null;
  version: number;
  poId: number;
  poDocNo: string;
  warehouseName: string;
  createdAt: string;
  createdByName: string | null;
  lines: CtLine[];
  approvals: DocApproval[];
  actions?: { submit: boolean; approve: boolean; reject: boolean; edit: boolean; void?: boolean; reason: string };
}

interface PoDetailLine {
  id: number;
  skuId: number;
  skuCode: string;
  skuName: string;
  baseUom: string;
  receivedQty: string;
}

interface CreateLine {
  rowKey: string;
  index: number;
  batchId?: number | null;
  poLineId: number;
  skuId: number;
  skuCode: string;
  skuName: string;
  baseUom: string;
  receivedQty: string;
  qty: string;
  reason: string;
}
type LineEdit = Pick<CreateLine, "qty" | "reason" | "batchId">;
const emptyLine = (): LineEdit => ({ qty: "0", reason: "", batchId: undefined });

const STATUS_TABS = [
  { key: "", label: "全部" },
  { key: "draft", label: "草稿" },
  { key: "pending", label: "待审批" },
  { key: "completed", label: "已完成" },
  { key: "void", label: "已作废" },
];

export default function CtClient() {
  const me = useMe();
  return <CtWorkspace key={me ? `${me.id}:${me.roles.join(",")}:${me.isApprover}` : "anonymous"} me={me} />;
}

function CtWorkspace({ me }: { me: Me | null }) {
  const { message } = App.useApp();
  const canWrite = hasAnyRole(me, "warehouse");

  // 列表页状态平台（E6-P1）：筛选/分页进 URL，密度与已保存视图存本地
  const listState = useListState({ transientParams: DOCUMENT_TRANSIENT_PARAMS, key: "ct", defaults: { q: "", status: "" }, defaultPageSize: 20 });
  const { filters, page, pageSize } = listState;
  const q = filters.q;
  const status = filters.status;
  const listQuery = new URLSearchParams({ q, page: String(page), pageSize: String(pageSize) });
  if (status) listQuery.set("status", status);
  const listRead = useDocumentRead<{ rows: CtRow[]; total: number }>(`/api/matflow/ct?${listQuery}`);
  const listValid = listRead.data != null && Array.isArray(listRead.data.rows)
    && Number.isSafeInteger(listRead.data.total) && listRead.data.total >= 0
    && listRead.data.rows.every(r => r != null && Number.isSafeInteger(r.id) && r.id > 0
      && typeof r.docNo === "string" && typeof r.status === "string");
  const rows = listValid ? listRead.data!.rows : [];
  const listError = listRead.error ?? (listRead.data && !listValid ? "列表响应格式异常，请重新读取" : null);
  const load = listRead.retry;
  const recovery = useCtCreateRecovery(me?.id ?? null, canWrite, () => void load());

  const documentSelection = useDocumentTarget();
  const { id: detailId, setId: setDetailId } = documentSelection;
  useEffect(() => { setRejectOpen(false); setEditingDraft(null); setVoidingDraft(null); }, [detailId]);
  const [editingDraft, setEditingDraft] = useState<CtDetail | null>(null);
  const [voidingDraft, setVoidingDraft] = useState<CtDetail | null>(null);
  const detailRead = useDocumentRead<CtDetail>(detailId == null ? null : `/api/matflow/ct/${detailId}`);
  const detail = detailRead.data;
  const detailLoading = detailRead.phase === "loading";
  const loadDetail = detailRead.retry;
  const [actionLoading, setActionLoading] = useState(false);
  /** 审批 409「退货量超过已收数」专项警示 */
  const [overAlert, setOverAlert] = useState<string | null>(null);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectComment, setRejectComment] = useState("");

  // 创建
  const [createOpen, setCreateOpen] = useState(false);
  const [createLoading, setCreateLoading] = useState(false);
  const creating = useRef(false);
  const [poId, setPoId] = useState<number | null>(null);
  const [warehouseId, setWarehouseId] = useState<number | null>(null);
  const [remark, setRemark] = useState("");
  const [lineEdits, setLineEdits] = useState<Record<number, LineEdit[]>>({});
  const [editingRequestKey, setEditingRequestKey] = useState<string | null>(null);
  const [restoredSource, setRestoredSource] = useState<CtCreateRequest | null>(null);
  const poRead = useDocumentRead<{ id: number; lines: PoDetailLine[] }>(createOpen && poId != null ? `/api/outsource/po/${poId}` : null);
  const poValid = poRead.data != null && poRead.data.id === poId && Array.isArray(poRead.data.lines)
    && poRead.data.lines.every(l => l != null && Number.isSafeInteger(l.id) && l.id > 0 && Number.isSafeInteger(l.skuId) && l.skuId > 0
      && typeof l.skuCode === "string" && typeof l.skuName === "string" && typeof l.baseUom === "string"
      && typeof l.receivedQty === "string" && QTY_RE.test(l.receivedQty))
    && new Set(poRead.data.lines.map(l => l.id)).size === poRead.data.lines.length;
  const poError = poRead.error ?? (poRead.data && !poValid ? "采购订单身份或行数据不一致，请重新读取" : null);
  const sourceMismatch = poValid && restoredSource?.poId === poId && restoredSource.lines.some(original =>
    !poRead.data!.lines.some(current => current.id === original.poLineId && current.skuId === original.skuId));
  const createLines: CreateLine[] = poValid ? poRead.data!.lines.filter(l => decCmp(l.receivedQty, "0") > 0 || lineEdits[l.id] != null).flatMap(l => (lineEdits[l.id] ?? [emptyLine()]).map((edit, index) => ({
    rowKey: `${l.id}:${index}`, index, ...edit,
    poLineId: l.id, skuId: l.skuId, skuCode: l.skuCode, skuName: l.skuName, baseUom: l.baseUom,
    receivedQty: l.receivedQty,
  }))) : [];
  const editLine = (line: CreateLine, patch: Partial<LineEdit>) => setLineEdits(prev => ({
    ...prev, [line.poLineId]: (prev[line.poLineId] ?? [emptyLine()]).map((edit, index) => index === line.index ? { ...edit, ...patch } : edit),
  }));

  useEffect(() => { setOverAlert(null); }, [detailId]);

  const refresh = () => {
    if (detail) void loadDetail();
    void load();
  };

  // ---------- 创建 ----------

  const openCreate = () => {
    setCreateOpen(true);
    setPoId(null);
    setWarehouseId(null);
    setRemark("");
    setLineEdits({});
    setEditingRequestKey(null); setRestoredSource(null);
  };

  const editCreateRequest = (request: CtCreateRequest) => {
    // Reopening the same source inside an already-open modal must also withdraw stale balances.
    if (createOpen && poId === request.poId) poRead.retry();
    setCreateOpen(true); setEditingRequestKey(request.requestKey); setRestoredSource(request);
    setPoId(request.poId); setWarehouseId(request.warehouseId); setRemark(request.remark ?? "");
    const edits: Record<number, LineEdit[]> = {};
    for (const line of request.lines) (edits[line.poLineId] ??= []).push({ qty: line.qty, batchId: line.batchId, reason: line.reason ?? "" });
    setLineEdits(edits);
  };

  /** 选 PO 后：取已收行（可退数量 = 当前已收数，基础单位） */
  const handlePoChange = (id: number | undefined) => {
    if (creating.current) return;
    setPoId(id ?? null);
    setLineEdits({});
    setRestoredSource(null);
  };

  const handleCreate = async () => {
    if (creating.current) return;
    if (sourceMismatch) return void message.warning("原请求采购行缺失或物料身份变化，请明确重新选择采购来源并核对全部实物行；未发送请求");
    if (poId == null) return void message.warning("请选择采购订单");
    if (!poValid || poRead.phase !== "success") return void message.warning("请先成功读取当前采购订单的可退行");
    if (warehouseId == null) return void message.warning("请选择退货出库仓");
    if (createLines.some(l => !QTY_RE.test(l.qty))) return void message.warning("数量须为非负数，最多10位整数、4位小数；请核对全部退货行");
    const valid = createLines.filter((l) => decCmp(l.qty, "0") > 0);
    if (valid.length === 0) return void message.warning("至少需要一行数量大于 0 的退货行");
    if (valid.some(l => l.batchId === undefined)) return void message.warning("请逐行选择实际退货批次；历史无批次须显式选择");
    const totals = new Map<number, bigint>();
    for (const line of valid) totals.set(line.poLineId, (totals.get(line.poLineId) ?? 0n) + qtyUnits(line.qty));
    const over = valid.find((l) => totals.get(l.poLineId)! > qtyUnits(l.receivedQty));
    if (over) {
      return void message.warning(
        `${over.skuCode} PO行#${over.poLineId}：各批次退货合计超过该行已收余额 ${formatQty(over.receivedQty)}`,
      );
    }
    creating.current = true;
    setCreateLoading(true);
    try {
      const created = await recovery.submit({
        poId,
        warehouseId,
        remark: remark.trim() || undefined,
        lines: valid.map((l) => ({
          poLineId: l.poLineId,
          skuId: l.skuId,
          qty: l.qty,
          batchId: l.batchId!,
          reason: l.reason.trim() || undefined,
        })),
      }, editingRequestKey != null);
      if (!created?.document) return;
      message.success("采购退货单已创建");
      setCreateOpen(false);
      void load();
      setDetailId(created.document.id);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      creating.current = false;
      setCreateLoading(false);
    }
  };

  // ---------- 动作 ----------

  const handleSubmit = async () => {
    if (!detail) return;
    setActionLoading(true);
    try {
      await postJson(`/api/matflow/ct/${detail.id}/submit`, { version: detail.version });
      message.success("已提交审批");
      refresh();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setActionLoading(false);
    }
  };

  const handleApprove = async (action: "approve" | "reject", comment?: string) => {
    if (!detail) return false;
    setActionLoading(true);
    setOverAlert(null);
    try {
      await postJson(`/api/matflow/ct/${detail.id}/approve`, {
        action,
        comment: comment?.trim() || undefined,
        version: detail.version,
      });
      message.success(action === "approve" ? "审批通过，已过账退货并回冲 PO 已收数" : "已驳回");
      refresh();
      return true;
    } catch (e) {
      const msg = (e as Error).message;
      if (msg.includes("退货量超过已收数")) {
        setOverAlert(msg);
        void loadDetail();
      } else {
        message.error(msg);
      }
      return false;
    } finally {
      setActionLoading(false);
    }
  };

  // ---------- 列 ----------

  const columns: ColumnsType<CtRow> = [
    {
      title: "单据号",
      dataIndex: "docNo",
      width: 160,
      render: (v: string, r) => <Typography.Link onClick={() => setDetailId(r.id)}>{v}</Typography.Link>,
    },
    { title: "采购订单", dataIndex: "poDocNo", width: 160 },
    { title: "退货出库仓", dataIndex: "warehouseName" },
    { title: "行数", dataIndex: "lineCount", width: 70, align: "right" },
    { title: "状态", dataIndex: "status", width: 100, render: (v: string) => <DocStatusTag status={v} /> },
    { title: "制单人", dataIndex: "createdByName", width: 100, render: (v: string | null) => v ?? "—" },
    {
      title: "时间",
      dataIndex: "createdAt",
      width: 150,
      render: (v: string) => dayjs(v).format("YYYY-MM-DD HH:mm"),
    },
  ];

  const lineColumns: ColumnsType<CtLine> = [
    { title: "物料", key: "material", width: 220, render: (_, r) => `${r.skuCode} ${r.skuName}` },
    { title: "单位", dataIndex: "baseUom", width: 70 },
    { title: "PO 行", dataIndex: "poLineId", width: 80, render: (v: number) => `#${v}` },
    {
      title: "批次",
      dataIndex: "batchNo",
      width: 140,
      render: (v: string | null, r) => v ? `${v}${r.expiryDate ? ` · ${r.expiryDate}` : ""}` : "无批次",
    },
    { title: "退货数量", dataIndex: "qty", width: 110, align: "right", render: (v: string) => formatQty(v) },
    { title: "退货原因", dataIndex: "reason", render: (v: string | null) => v ?? "—" },
  ];

  const createLineColumns: ColumnsType<CreateLine> = [
    { title: "物料 / 采购行", key: "material", width: 220, render: (_, r) => `${r.skuCode} ${r.skuName} · PO行#${r.poLineId}` },
    { title: "单位", dataIndex: "baseUom", width: 70 },
    {
      title: "采购行已收余额",
      dataIndex: "receivedQty",
      width: 130,
      align: "right",
      render: (v: string) => formatQty(v),
    },
    { title: "实际退货批次", key: "batch", width: 280, render: (_, r) => <RemoteSelect
      key={`${poId}:${warehouseId}:${r.rowKey}`} allowClear aria-label={`${r.skuCode} 第${r.index + 1}行实际退货批次`}
      api={`/api/matflow/ct/return-lots?poId=${poId}&poLineId=${r.poLineId}&warehouseId=${warehouseId}`}
      disabled={createLoading || warehouseId == null || poId == null} style={{ width: "100%" }}
      placeholder="核对实物后选择批次" value={r.batchId === null ? "unbatched" : r.batchId}
      getValue={lot => lot.batchId == null ? "unbatched" : Number(lot.batchId)}
      getLabel={lot => `${lot.batchNo ?? "历史无批次（不可追溯）"} · 效期${lot.expiryDate ?? "未知"} · 未定位${formatQty(String(lot.availableQty))}`}
      onChange={(v: string | number | undefined) => editLine(r, { batchId: v === undefined ? undefined : v === "unbatched" ? null : Number(v) })}
    /> },
    {
      title: "退货数量",
      key: "qty",
      width: 140,
      render: (_, r) => (
        <InputNumber<string>
          aria-label={`${r.skuCode} 退货数量`}
          disabled={createLoading}
          stringMode
          min="0"
          style={{ width: "100%" }}
          value={r.qty}
          status={DEC_RE.test(r.qty) && decCmp(r.qty, r.receivedQty) > 0 ? "error" : undefined}
          onChange={(v) => editLine(r, { qty: v ?? "0" })}
        />
      ),
    },
    {
      title: "退货原因（可选）",
      key: "reason",
      width: 180,
      render: (_, r) => (
        <Input
          aria-label={`${r.skuCode} 退货原因`}
          disabled={createLoading}
          maxLength={200}
          value={r.reason}
          onChange={(e) => editLine(r, { reason: e.target.value })}
        />
      ),
    },
    { title: "混批", key: "split", width: 120, render: (_, r) => <Button disabled={createLoading} onClick={() =>
      setLineEdits(prev => ({ ...prev, [r.poLineId]: [...(prev[r.poLineId] ?? [emptyLine()]), emptyLine()] }))}>另一个批次</Button> },
  ];

  const actions = detail ? (
    <Space wrap>
      {detail.actions?.edit && <Button disabled={actionLoading} onClick={() => setEditingDraft(detail)}>修改原草稿</Button>}
      {detail.actions?.void && <Button danger disabled={actionLoading} onClick={() => setVoidingDraft(detail)}>作废错误草稿</Button>}
      {detail.status === "void" && canWrite && <Button onClick={() => { setDetailId(null); openCreate(); }}>新建正确退货单</Button>}
      {detail.actions?.submit ? (
        <Popconfirm title="确认提交审批？" okText="提交" cancelText="取消" onConfirm={() => void handleSubmit()}>
          <Button type="primary" loading={actionLoading}>
            提交
          </Button>
        </Popconfirm>
      ) : null}
      {detail.actions?.reject ? (
        <>
          <Popconfirm
            title="确认审批通过？通过即过账退货出库并回冲 PO 已收数。"
            okText="通过"
            cancelText="取消"
            onConfirm={() => void handleApprove("approve")}
          >
            <Button type="primary" loading={actionLoading} disabled={!detail.actions.approve}>
              审批通过
            </Button>
          </Popconfirm>
          <Button danger loading={actionLoading} onClick={() => setRejectOpen(true)}>
            驳回
          </Button>
        </>
      ) : null}
      {detail.status === "pending" && detail.createdBy === me?.id ? <span>已提交，等待其他审批人处理（不可自审）</span> : null}
    </Space>
  ) : null;

  return (
    <div>
      <Typography.Title level={4} style={{ marginTop: 0 }}>
        采购退货（CT）
      </Typography.Title>
      <Typography.Paragraph type="secondary">
        向供应商退回已收采购物料；逐行退货量不得超过该 PO 行当前已收数，审批过账后自动回冲已收数。
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
            <Button icon={<ReloadOutlined />} onClick={() => void load()}>
              刷新
            </Button>
            {canWrite ? (
              <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
                新建退货单
              </Button>
            ) : null}
          </>
        }
        extra={
          <SearchInput
            key={q}
            allowClear
            defaultValue={q}
            placeholder="搜索单号 / SKU 编码 / 货品名称"
            style={{ width: 240, maxWidth: "100%", minWidth: 0 }}
            onSearch={(value) => listState.setFilter({ q: value.trim() })}
          />
        }
      />
      <LoadErrorAlert error={listError} onRetry={load} subject="采购退货列表" />
      {!createOpen && <CtCreateRecovery recovery={recovery} onEdit={editCreateRequest} />}
      <Table<CtRow>
        rowKey="id"
        size={listState.tableSize}
        columns={columns}
        dataSource={rows}
        loading={listRead.phase === "loading"}
        scroll={{ x: "max-content" }}
        pagination={listValid ? listState.paginationProps({ total: listRead.data!.total }) : false}
        locale={{ emptyText: listError ? "读取失败，请重试" : listRead.phase === "loading" ? "正在读取采购退货…" : "当前筛选下暂无采购退货单" }}
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
            "采购退货单详情"
          )
        }
        open={documentSelection.present}
        readError={documentSelection.error ?? detailRead.error}
        onRetry={detailId != null ? detailRead.retry : undefined}
        onClose={() => setDetailId(null)}
        width={860}
        loading={detailLoading}
        extra={actions}
      >
        {detail ? (
          <div>
            <ChainStrip docType="ct" id={detail.id} />
            <Alert type="info" showIcon style={{ marginBottom: 12 }} message={detail.actions?.reason ?? "当前操作资格尚未确认，请重新读取原单；不凭旧页面提交或审批。"} />
            {detail.status === "void" && <Alert type="warning" showIcon style={{ marginBottom: 12 }} message={`作废原因：${detail.closedReason ?? "历史未登记"}`}
              description="原单保留只读，不代表退货已经发生。需继续退货时，请核对来源、仓库及实物批次后明确新建，不重复使用原单。" />}
            {overAlert ? (
              <Alert
                type="warning"
                showIcon
                closable
                onClose={() => setOverAlert(null)}
                style={{ marginBottom: 16 }}
                message="退货量超过已收数，审批被阻塞"
                description={overAlert}
              />
            ) : null}
            <Descriptions column={{ xs: 1, sm: 2 }} size="small" bordered style={{ marginBottom: 16 }}>
              <Descriptions.Item label="采购订单">{detail.poDocNo}</Descriptions.Item>
              <Descriptions.Item label="退货出库仓">{detail.warehouseName}</Descriptions.Item>
              <Descriptions.Item label="制单人">{detail.createdByName ?? "—"}</Descriptions.Item>
              <Descriptions.Item label="制单时间">
                {dayjs(detail.createdAt).format("YYYY-MM-DD HH:mm")}
              </Descriptions.Item>
              <Descriptions.Item label="备注" span={{ xs: 1, sm: 2 }}>
                {detail.remark ?? "—"}
              </Descriptions.Item>
            </Descriptions>
            <Typography.Title level={5}>明细行</Typography.Title>
            <Table<CtLine>
              rowKey="id"
              size="small"
              columns={lineColumns}
              tableLayout="fixed"
              scroll={{ x: 800 }}
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
      </DocumentDrawer>

      {editingDraft && <CtDraftEditor key={`${me?.id}:${me?.roles.join(",")}:${editingDraft.id}:${editingDraft.version}`} doc={editingDraft}
        onClose={() => setEditingDraft(null)} onReload={() => { setEditingDraft(null); refresh(); }}
        onSaved={() => { setEditingDraft(null); message.success("原退货草稿已更新，未提交或过账"); refresh(); }} />}

      {voidingDraft && <CtDraftVoid key={`${voidingDraft.id}:${voidingDraft.version}`} doc={voidingDraft}
        onClose={() => setVoidingDraft(null)} onReload={() => { setVoidingDraft(null); refresh(); }}
        onSaved={() => { setVoidingDraft(null); message.success("原草稿已作废，库存及采购已收数未改变"); refresh(); }} />}

      <Modal
        {...viewportModalProps}
        title="新建采购退货单"
        open={createOpen}
        width={1180}
        okText="创建"
        cancelText="取消"
        confirmLoading={createLoading}
        okButtonProps={{ disabled: !recovery.ready || recovery.busy || (!editingRequestKey && !!recovery.request) || !!sourceMismatch || !poValid || createLines.length === 0 || warehouseId == null }}
        cancelButtonProps={{ disabled: createLoading }}
        closable={!createLoading}
        maskClosable={!createLoading}
        keyboard={!createLoading}
        onCancel={() => { if (!createLoading) setCreateOpen(false); }}
        onOk={() => void handleCreate()}
      >
        <Space direction="vertical" style={{ width: "100%" }} size="middle">
          <CtCreateRecovery recovery={recovery} onEdit={editCreateRequest} />
          {sourceMismatch && <Alert type="error" showIcon message="原请求采购行缺失或物料身份已变，未丢弃原恢复记录。请明确重新选择采购来源并核对全部实物行，再修正同一请求。" />}
          <div>
            <div style={{ marginBottom: 4 }}>采购订单</div>
            <RemoteSelect
              api="/api/outsource/po?returnEligible=1"
              allowClear
              aria-label="采购订单"
              disabled={createLoading}
              style={{ width: "100%" }}
              placeholder="选择采购订单"
              value={poId}
              getLabel={p => `${String(p.docNo)}｜${String(p.supplierName)}`}
              onChange={(v: number) => void handlePoChange(v)}
            />
          </div>
          <div>
            <div style={{ marginBottom: 4 }}>退货出库仓（自有实时仓）</div>
            <RemoteSelect
              aria-label="退货出库仓"
              allowClear
              disabled={createLoading}
              api="/api/master/warehouse"
              style={{ width: "100%" }}
              placeholder="选择退货出库仓"
              value={warehouseId}
              getLabel={(r) => `${String(r.code)} ${String(r.name)}`}
              filterRow={(r) =>
                r.active === true &&
                r.accountingMode === "realtime" &&
                r.kind !== "outsource" &&
                r.kind !== "snapshot"
              }
              onChange={(v: number | undefined) => { if (!creating.current) { setWarehouseId(v ?? null); setLineEdits({}); } }}
            />
          </div>
          <div>
            <div style={{ marginBottom: 4 }}>退货行（仅列出已收数量大于 0 的 PO 行；数量为 0 的行不提交）</div>
            <Alert type="warning" showIcon style={{ marginBottom: 12 }} message="按实物选择，不自动配批；同一采购行各批次数量合计不能超过已收余额。"
              description="批次选项仅为所选仓库未定位库存，不证明它来自本采购订单；请核对原收货记录与供应商。已到期实物可受控退回，历史无批次不可追溯。切换出仓将清空已填批次和数量。" />
            <LoadErrorAlert error={poError} onRetry={poRead.retry} subject="采购订单可退行" />
            <Table<CreateLine>
              rowKey="rowKey"
              size="small"
              loading={poRead.phase === "loading"}
              columns={createLineColumns}
              tableLayout="fixed"
              scroll={{ x: 1140, y: 320 }}
              dataSource={createLines}
              pagination={false}
              locale={{ emptyText: poId == null ? "请先选择采购订单" : poError ? "读取失败，请重试" : poRead.phase === "loading" ? "正在读取可退行…" : "该采购订单暂无已收数量，无可退行" }}
            />
          </div>
          <Input.TextArea
            aria-label="退货备注"
            disabled={createLoading}
            rows={2}
            maxLength={500}
            placeholder="备注（可选）"
            value={remark}
            onChange={(e) => setRemark(e.target.value)}
          />
        </Space>
      </Modal>

      <Modal
        title="驳回单据"
        open={rejectOpen}
        okText="确认驳回"
        okButtonProps={{ danger: true }}
        cancelText="取消"
        confirmLoading={actionLoading}
        onCancel={() => setRejectOpen(false)}
        onOk={() =>
          void handleApprove("reject", rejectComment).then((ok) => {
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
    </div>
  );
}
