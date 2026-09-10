"use client";

import { useDocumentTarget } from "@/components/useDocumentTarget";
import { DOCUMENT_TRANSIENT_PARAMS } from "@/lib/document-links";
import { useDocumentRead } from "@/components/useDocumentRead";
import DocumentDrawer from "@/components/DocumentDrawer";

import SearchInput from "@/components/SearchInput";

import { Suspense, useEffect, useRef, useState } from "react";
import { Alert, App, Button, Descriptions, Form, Input, InputNumber, Modal, Popconfirm, Radio, Select, Space, Table, Tabs, Tag, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { PlusOutlined, PrinterOutlined, ReloadOutlined, SaveOutlined } from "@ant-design/icons";
import dayjs from "dayjs";
import RemoteSelect from "@/components/RemoteSelect";
import DocStatusTag from "@/components/DocStatusTag";
import ListToolbar from "@/components/ListToolbar";
import { useListState } from "@/components/useListState";
import { fetchJson } from "@/components/fetchJson";
import LoadErrorAlert from "@/components/LoadErrorAlert";
import { formatQty } from "@/components/format";
import ApprovalTimeline from "@/components/ApprovalTimeline";
import ScannerEntry from "@/components/ScannerEntry";
import { addScanQty, findUniqueScanMatch } from "@/components/scanner";
import { COMMERCIAL_ROLE_LABELS } from "@/components/labels";
import ExportButton from "@/components/ExportButton";

/** 抽盘=循环抽点（原 PRD"永续盘点"）；full=定期全盘 */
const MODE_LABELS: Record<string, string> = { full: "定期全盘", partial: "抽盘" };
const MODE_COLORS: Record<string, string> = { full: "blue", partial: "purple" };

/** A stopped wait is not a cancelled business write; recovery must read before retrying. */
async function postCountAction(url: string, body: unknown) {
  const request = new AbortController();
  const timer = setTimeout(() => request.abort(), 30_000);
  try {
    return await fetchJson(url, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body), signal: request.signal });
  } catch (error) {
    if (request.signal.aborted) throw new Error("等待响应超过 30 秒，操作可能已完成。请先重新读取单据；新建任务请关闭弹窗并刷新列表核对，勿直接重复提交。");
    throw error;
  } finally { clearTimeout(timer); }
}

interface TaskRow {
  id: number;
  docNo: string;
  status: string;
  mode: string;
  warehouseName: string | null;
  bizDate: string | null;
  lineCount: number;
  diffCount: number;
  diffTotal: string;
  createdByName: string | null;
  createdAt: string;
}

interface TaskLine {
  id: number;
  skuId: number;
  skuCode: string;
  skuName: string;
  commercialRole: string;
  barcode: string | null;
  baseUom: string;
  batchId: number | null;
  bookQty: string;
  countedQty: string;
  diffQty: string;
  adjustDocId: number | null;
}

interface TaskApproval {
  approverName: string | null;
  action: "approve" | "reject";
  comment: string | null;
  createdAt: string;
}

interface TaskDetail {
  id: number;
  docNo: string;
  status: string;
  mode: string;
  remark: string | null;
  version: number;
  warehouseId: number;
  warehouseName: string | null;
  bizDate: string | null;
  lines: TaskLine[];
  roleSummary: { group: "sample" | "retail"; lineCount: number; bookQty: string; countedQty: string; diffQty: string }[];
  adjustDocs: { id: number; docNo: string }[];
  approvals: TaskApproval[];
  createdByName: string | null;
  createdAt: string;
}

interface CreateFormValues {
  warehouseId: number;
  mode: "full" | "partial";
  bizDate?: string;
  q?: string;
  skuIds?: number[];
  remark?: string;
}

const STATUS_TABS = [
  { key: "", label: "全部" },
  { key: "draft", label: "草稿" },
  { key: "pending", label: "待审批" },
  { key: "completed", label: "已完成" },
];

/** 精确十进制减法（显示用；禁 float——与 PO 打印页同一约定），scale=4 */
function subDec(a: string, b: string): string {
  const toU = (s: string): bigint => {
    const t = s.trim();
    const neg = t.startsWith("-");
    const [i, f = ""] = (neg ? t.slice(1) : t).split(".");
    const v = BigInt((i || "0") + (f + "0000").slice(0, 4));
    return neg ? -v : v;
  };
  const v = toU(a) - toU(b);
  const neg = v < 0n;
  const s = (neg ? -v : v).toString().padStart(5, "0");
  const int = s.slice(0, -4);
  const frac = s.slice(-4).replace(/0+$/, "");
  return `${neg ? "-" : ""}${int}${frac ? "." + frac : ""}`;
}

/** 差异展示：盈=绿 亏=红 平=灰 */
function DiffText({ value }: { value: string }) {
  const trimmed = (value ?? "").trim();
  const isZero = !trimmed || /^-?0(\.0*)?$/.test(trimmed);
  if (isZero) return <Typography.Text type="secondary">0</Typography.Text>;
  const neg = trimmed.startsWith("-");
  return (
    <Typography.Text style={{ color: neg ? "#cf1322" : "#389e0d", fontWeight: 600 }}>
      {neg ? trimmed : `+${trimmed}`}
    </Typography.Text>
  );
}

export default function CountClient() {
  // useSearchParams（列表页状态平台 E6-P1）需要 Suspense 边界
  return (
    <Suspense>
      <CountInner />
    </Suspense>
  );
}

function CountInner() {
  const { message } = App.useApp();
  const [form] = Form.useForm<CreateFormValues>();
  // 列表页状态平台（E6-P1）：筛选/分页进 URL，密度与已保存视图存本地
  const listState = useListState({ transientParams: DOCUMENT_TRANSIENT_PARAMS,
    key: "count",
    defaults: { q: "", status: "", mode: "", period: "" },
    defaultPageSize: 20,
  });
  const { filters, page, pageSize } = listState;
  const q = filters.q;
  const status = filters.status;
  const mode = filters.mode || undefined;
  const period = filters.period || undefined;

  const [createOpen, setCreateOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const createLock = useRef(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const createMode = Form.useWatch("mode", form);

  const documentSelection = useDocumentTarget();
  const { id: detailId, setId: setDetailId } = documentSelection;
  useEffect(() => { setRejectOpen(false); }, [detailId]);
  const detailRead = useDocumentRead<TaskDetail>(detailId == null ? null : `/api/inventory/count/${detailId}`);
  const rawDetail = detailRead.data;
  const validDetail = rawDetail != null && rawDetail.id === detailId && Number.isInteger(rawDetail.version)
    && rawDetail.version > 0 && Array.isArray(rawDetail.lines) && Array.isArray(rawDetail.roleSummary)
    && Array.isArray(rawDetail.approvals) && Array.isArray(rawDetail.adjustDocs)
    && new Set(rawDetail.lines.map(line => line.id)).size === rawDetail.lines.length
    && rawDetail.lines.every(line => Number.isInteger(line.id) && line.id > 0
      && typeof line.bookQty === "string" && /^-?\d+(\.\d+)?$/.test(line.bookQty)
      && typeof line.countedQty === "string" && /^\d+(\.\d+)?$/.test(line.countedQty)
      && typeof line.diffQty === "string" && /^-?\d+(\.\d+)?$/.test(line.diffQty));
  const detail = validDetail ? rawDetail : null;
  const detailError = detailRead.error ?? (rawDetail && !validDetail ? "盘点单身份或数量结构异常，请重新读取" : null);
  const detailLoading = detailRead.phase === "loading";
  const loadDetail = detailRead.retry;
  const detailKey = detail ? `${detail.id}:${detail.version}` : "";
  const currentDetailKey = useRef(detailKey);
  currentDetailKey.current = detailKey;
  const [actionLoading, setActionLoading] = useState(false);
  const actionLock = useRef(false);
  const [actionError, setActionError] = useState<{ key: string; message: string } | null>(null);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectComment, setRejectComment] = useState("");
  /** 草稿态本地编辑的实盘数（lineId → 输入值） */
  const [editState, setEditState] = useState<{ key: string; values: Record<number, string> }>({ key: "", values: {} });
  const edited = editState.key === detailKey ? editState.values : {};
  const setEdited = (update: (previous: Record<number, string>) => Record<number, string>) => {
    if (actionLock.current || !detailKey) return;
    setEditState(previous => ({ key: detailKey, values: update(previous.key === detailKey ? previous.values : {}) }));
  };
  const params = new URLSearchParams({ q, page: String(page), pageSize: String(pageSize) });
  if (status) params.set("status", status);
  if (mode) params.set("mode", mode);
  if (period) params.set("period", period);
  const listRead = useDocumentRead<{ rows: TaskRow[]; total: number }>(`/api/inventory/count?${params.toString()}`);
  const listData = listRead.data;
  const validList = listData != null && Array.isArray(listData.rows) && Number.isInteger(listData.total)
    && listData.total >= 0 && listData.rows.every(row => Number.isInteger(row.id) && row.id > 0 && typeof row.docNo === "string");
  const rows = validList ? listData.rows : [];
  const total = validList ? listData.total : 0;
  const loading = listRead.phase === "loading";
  const listError = listRead.error ?? (listData && !validList ? "盘点列表响应异常，请重试" : null);
  const load = listRead.retry;

  const handleCreate = async () => {
    if (createLock.current) return;
    createLock.current = true;
    setSaving(true);
    setCreateError(null);
    try {
      const values = await form.validateFields();
      const filters =
        values.mode === "partial"
          ? {
              q: values.q?.trim() || undefined,
              skuIds: values.skuIds && values.skuIds.length > 0 ? values.skuIds : undefined,
            }
          : undefined;
      await postCountAction("/api/inventory/count", {
        warehouseId: values.warehouseId,
        mode: values.mode,
        filters,
        remark: values.remark?.trim() || undefined,
      });
      message.success("盘点任务已创建（草稿）——账面数已快照");
      setCreateOpen(false);
      form.resetFields();
      void load();
    } catch (e) {
      if (e instanceof Error && e.message) setCreateError(e.message);
    } finally {
      createLock.current = false;
      setSaving(false);
    }
  };

  const doAction = async (path: string, body: unknown, successText: string): Promise<boolean> => {
    if (!detail || actionLock.current || (path === "submit" && Object.keys(edited).length > 0)) return false;
    actionLock.current = true;
    const key = detailKey;
    setActionLoading(true);
    setActionError(null);
    try {
      await postCountAction(`/api/inventory/count/${detail.id}/${path}`, body);
      if (currentDetailKey.current === key) {
        message.success(successText);
        loadDetail();
      }
      void load();
      return currentDetailKey.current === key;
    } catch (e) {
      setActionError({ key, message: e instanceof Error ? e.message : "操作失败，请核对单据后再试" });
      return false;
    } finally {
      actionLock.current = false;
      setActionLoading(false);
    }
  };

  const dirtyCount = Object.keys(edited).length;
  const editable = detail?.status === "draft";

  const handleScan = (code: string, qty: string): boolean => {
    if (!detail || !editable || actionLock.current) return false;
    const result = findUniqueScanMatch(detail.lines, code, (line) => [line.barcode, line.skuCode]);
    if (result.kind === "missing") {
      message.error(`未在本盘点任务中找到条码/SKU：${code}`);
      return false;
    }
    if (result.kind === "ambiguous") {
      message.error(`条码/SKU 命中 ${result.count} 个批次行，请在表格中按批次手工录入`);
      return false;
    }
    const line = result.item;
    setEdited((prev) => ({
      ...prev,
      [line.id]: prev[line.id] == null ? qty : addScanQty(prev[line.id], qty),
    }));
    message.success(`已计入 ${line.skuCode}：+${qty}`, 0.8);
    return true;
  };

  const saveCounts = async () => {
    if (!detail || dirtyCount === 0) return;
    await doAction(
      "lines",
      {
        version: detail.version,
        lines: Object.entries(edited).map(([lineId, countedQty]) => ({ lineId: Number(lineId), countedQty })),
      },
      "实盘数已保存",
    );
  };

  const columns: ColumnsType<TaskRow> = [
    {
      title: "单据号",
      dataIndex: "docNo",
      width: 160,
      render: (v: string, r) => <Typography.Link onClick={() => setDetailId(r.id)}>{v}</Typography.Link>,
    },
    {
      // 盘点期＝业务日期，不是录入时间。补录/次月才录的盘点按这个归期。
      title: "盘点期",
      dataIndex: "bizDate",
      width: 110,
      render: (v: string | null) => v ?? "—",
    },
    {
      title: "模式",
      dataIndex: "mode",
      width: 100,
      render: (v: string) => <Tag color={MODE_COLORS[v] ?? "default"}>{MODE_LABELS[v] ?? v}</Tag>,
    },
    { title: "仓库", dataIndex: "warehouseName" },
    { title: "行数", dataIndex: "lineCount", width: 70, align: "right" },
    {
      title: "差异行数",
      dataIndex: "diffCount",
      width: 90,
      align: "right",
      render: (v: number) => (v > 0 ? <Typography.Text type="warning">{v}</Typography.Text> : v),
    },
    {
      title: "盈亏合计",
      dataIndex: "diffTotal",
      width: 110,
      align: "right",
      render: (v: string) => <DiffText value={v} />,
    },
    { title: "制单人", dataIndex: "createdByName", width: 100 },
    {
      title: "时间",
      dataIndex: "createdAt",
      width: 150,
      render: (v: string) => dayjs(v).format("YYYY-MM-DD HH:mm"),
    },
    { title: "状态", dataIndex: "status", width: 100, render: (v: string) => <DocStatusTag status={v} /> },
  ];

  const lineColumns: ColumnsType<TaskLine> = [
    { title: "SKU 编码", dataIndex: "skuCode", width: 110 },
    { title: "名称", dataIndex: "skuName", width: 220 },
    { title: "批次 ID", dataIndex: "batchId", width: 90, render: (v: number | null) => v ?? "—" },
    {
      // 0727 行动项：「单独标注小样分类」——导出的清单要能一眼区分库存类别
      title: "业务用途",
      dataIndex: "commercialRole",
      width: 96,
      render: (v: string) => (
        <Tag color={v === "sample" ? "purple" : v === "unclassified" ? "warning" : undefined}>
          {COMMERCIAL_ROLE_LABELS[v] ?? v}
        </Tag>
      ),
    },
    { title: "单位", dataIndex: "baseUom", width: 70 },
    { title: "账面数", dataIndex: "bookQty", width: 100, align: "right", render: formatQty },
    {
      title: "实盘数",
      dataIndex: "countedQty",
      width: 130,
      align: "right",
      render: (v: string, r) =>
        editable ? (
          <InputNumber<string>
            stringMode
            min="0"
            precision={4}
            size="small"
            style={{ width: 120 }}
            disabled={actionLoading}
            aria-label={`实盘数 ${r.skuCode} 批次 ${r.batchId ?? "无"}`}
            value={edited[r.id] ?? v}
            onChange={(val) => {
              if (val == null) return;
              setEdited((prev) => ({ ...prev, [r.id]: String(val) }));
            }}
          />
        ) : (
          formatQty(v)
        ),
    },
    {
      title: "差异",
      key: "diff",
      width: 100,
      align: "right",
      render: (_, r) => {
        // 草稿态按本地编辑值即时计算展示（提交后以服务端为准）；十进制字符串运算，禁 float
        const shown = edited[r.id] != null ? subDec(edited[r.id], r.bookQty) : r.diffQty;
        return <DiffText value={shown} />;
      },
    },
  ];

  return (
    <div>
      <Typography.Title level={4} style={{ marginTop: 0 }}>
        盘点任务
      </Typography.Title>
      <Typography.Paragraph type="secondary" style={{ marginTop: -8 }}>
        抽盘=循环抽点（原&ldquo;永续盘点&rdquo;）：不停业、按计划抽部分货品；全盘=定期全仓清点。审批（财务）通过后自动生成盘盈亏调整单（CA）过账。
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
            {/* 0727 行动项 #1 的交付物：按盘点期导出带小样标注的明细，直接给业务 */}
            <ExportButton
              href={`/api/export/count-lines?${new URLSearchParams({
                ...(period ? { period } : {}),
              }).toString()}`}
              label="导出盘点明细"
            />
            <Button
              type="primary"
              icon={<PlusOutlined />}
              onClick={() => {
                form.resetFields();
                form.setFieldsValue({ mode: "partial" });
                setCreateError(null);
                setCreateOpen(true);
              }}
            >
              新建盘点任务
            </Button>
          </>
        }
        extra={
          <>
            <Input
              key={period ?? ""}
              allowClear
              placeholder="盘点期 YYYY-MM"
              style={{ width: 150 }}
              defaultValue={period}
              onChange={(e) => { if (!e.target.value) listState.setFilter({ period: "" }); }}
              onBlur={(e) => listState.setFilter({ period: e.target.value.trim() })}
              onPressEnter={(e) => listState.setFilter({ period: (e.target as HTMLInputElement).value.trim() })}
            />
            <SearchInput
              key={q}
              allowClear
              defaultValue={q}
              placeholder="搜索单据号"
              style={{ width: 220 }}
              onSearch={(value) => listState.setFilter({ q: value.trim() })}
            />
            <Select
              allowClear
              placeholder="全部模式"
              style={{ width: 140 }}
              options={Object.entries(MODE_LABELS).map(([value, label]) => ({ value, label }))}
              value={mode}
              onChange={(v) => listState.setFilter({ mode: v ?? "" })}
            />
          </>
        }
      />
      <LoadErrorAlert error={listError} subject="盘点列表" onRetry={load} />
      <Table<TaskRow>
        rowKey="id"
        size={listState.tableSize}
        columns={columns}
        dataSource={rows}
        scroll={{ x: "max-content" }}
        loading={loading}
        pagination={validList ? listState.paginationProps({ total }) : false}
      />

      <Modal
        title="新建盘点任务"
        open={createOpen}
        onOk={() => void handleCreate()}
        onCancel={() => { if (!createLock.current) setCreateOpen(false); }}
        closable={!saving}
        keyboard={!saving}
        cancelButtonProps={{ disabled: saving }}
        confirmLoading={saving}
        width="min(640px, 100vw)"
        forceRender
        maskClosable={false}
        okText="创建（快照账面数）"
        cancelText="取消"
      >
        {createError && <Alert type="error" showIcon message="创建未确认成功" description={createError} style={{ marginBottom: 12 }} />}
        <Form form={form} layout="vertical" disabled={saving}>
          <Form.Item name="warehouseId" label="仓库（仅实时记账仓）" rules={[{ required: true, message: "必须选择仓库" }]}>
            <RemoteSelect
              api="/api/master/warehouse"
              getLabel={(r) => `${String(r.code)} ${String(r.name)}`}
              filterRow={(r) => r.accountingMode === "realtime" && r.active !== false}
              placeholder="选择仓库"
            />
          </Form.Item>
          <Form.Item name="mode" label="盘点模式" rules={[{ required: true }]}>
            <Radio.Group>
              <Radio.Button value="partial">抽盘（循环抽点）</Radio.Button>
              <Radio.Button value="full">定期全盘</Radio.Button>
            </Radio.Group>
          </Form.Item>
          {createMode === "partial" ? (
            <>
              <Form.Item name="skuIds" label="指定 SKU（可多选；留空则按关键词/全部非零行）">
                <RemoteSelect
                  api="/api/master/sku"
                  mode="multiple"
                  getLabel={(r) => `${String(r.code)} ${String(r.name)}`}
                  placeholder="选择要抽盘的 SKU"
                />
              </Form.Item>
              <Form.Item name="q" label="关键词筛选（SKU 编码/名称/产品名）">
                <Input allowClear placeholder="如：包材 / RA000 / 精华液" maxLength={100} />
              </Form.Item>
            </>
          ) : null}
          <Form.Item name="remark" label="备注">
            <Input.TextArea rows={2} maxLength={200} placeholder="如：7 月循环抽点第 3 批" />
          </Form.Item>
        </Form>
        <Typography.Text type="secondary">
          创建时将快照当前账面数为盘前基准；实盘数默认预填=账面数，请逐行改为实际清点数。
        </Typography.Text>
      </Modal>

      <DocumentDrawer
        key={detailId ?? "invalid-document"}
        title={
          detail ? (
            <Space>
              <span>{detail.docNo}</span>
              <Tag color={MODE_COLORS[detail.mode] ?? "default"}>{MODE_LABELS[detail.mode] ?? detail.mode}</Tag>
              <DocStatusTag status={detail.status} />
            </Space>
          ) : (
            "盘点单详情"
          )
        }
        open={documentSelection.present}
        readError={documentSelection.error ?? detailError}
        onRetry={detailId != null ? detailRead.retry : undefined}
        onClose={() => { if (!actionLock.current) setDetailId(null); }}
        closable={!actionLoading}
        maskClosable={!actionLoading}
        keyboard={!actionLoading}
        width="min(860px, 100vw)"
        loading={detailLoading}
        extra={
          detail ? (
            <Space>
              <Button
                icon={<PrinterOutlined />}
                onClick={() => window.open(`/inventory/count/${detail.id}/print`, "_blank")}
              >
                打印盘点表
              </Button>
              {editable ? (
                <Button
                  icon={<SaveOutlined />}
                  disabled={dirtyCount === 0 || actionLoading}
                  loading={actionLoading}
                  onClick={() => void saveCounts()}
                >
                  保存实盘数{dirtyCount > 0 ? `（${dirtyCount}）` : ""}
                </Button>
              ) : null}
              {detail.status === "draft" ? (
                <Popconfirm
                  title="确认提交财务审批？"
                  disabled={dirtyCount > 0 || actionLoading}
                  okText="提交"
                  cancelText="取消"
                  onConfirm={() => void doAction("submit", { version: detail.version }, "已提交审批（盘点=财务审批域）")}
                >
                  <Button type="primary" loading={actionLoading} disabled={dirtyCount > 0 || actionLoading}>
                    提交
                  </Button>
                </Popconfirm>
              ) : null}
              {detail.status === "pending" ? (
                <>
                  <Popconfirm
                    disabled={actionLoading}
                    title="审批通过将立即生成盘盈亏调整单并过账，确认？"
                    okText="通过"
                    cancelText="取消"
                    onConfirm={() =>
                      void doAction("approve", { action: "approve", version: detail.version }, "审批通过，差异已过账")
                    }
                  >
                    <Button type="primary" loading={actionLoading}>
                      审批通过
                    </Button>
                  </Popconfirm>
                  <Button danger loading={actionLoading} onClick={() => { setRejectComment(""); setRejectOpen(true); }}>
                    驳回
                  </Button>
                </>
              ) : null}
            </Space>
          ) : null
        }
      >
        {detail ? (
          <div>
            {actionError?.key === detailKey && <Alert type="error" showIcon message="操作未确认成功" description={actionError.message}
              action={<Button disabled={actionLoading} onClick={loadDetail}>重新读取单据</Button>} style={{ marginBottom: 12 }} />}
            <Descriptions column={{ xs: 1, sm: 2 }} size="small" bordered style={{ marginBottom: 16 }}>
              <Descriptions.Item label="仓库">{detail.warehouseName ?? "—"}</Descriptions.Item>
              <Descriptions.Item label="盘点期">{detail.bizDate ?? "—"}</Descriptions.Item>
              <Descriptions.Item label="模式">{MODE_LABELS[detail.mode] ?? detail.mode}</Descriptions.Item>
              <Descriptions.Item label="制单人">{detail.createdByName ?? "—"}</Descriptions.Item>
              <Descriptions.Item label="制单时间">{dayjs(detail.createdAt).format("YYYY-MM-DD HH:mm")}</Descriptions.Item>
              <Descriptions.Item label="备注">{detail.remark ?? "—"}</Descriptions.Item>
              <Descriptions.Item label="调整单">
                {detail.adjustDocs.length > 0
                  ? detail.adjustDocs.map((a) => (
                      <Typography.Link key={a.id} href={`/inventory/docs?q=${encodeURIComponent(a.docNo)}`}>
                        {a.docNo}
                      </Typography.Link>
                    ))
                  : detail.status === "completed"
                    ? "无差异，未生成"
                    : "—"}
              </Descriptions.Item>
            </Descriptions>
            {/*
              小样/非小样分组小计（0727 行动项：便于孙明「清晰区分库存类别」）。
              「未分类」按参与正常销售归入非小样——与全站口径一致，
              所以存量没打标之前这两行会显得小样为 0，这不是算错。
            */}
            <Table
              size="small"
              bordered
              pagination={false}
              style={{ marginBottom: 16 }}
              rowKey="group"
              tableLayout="fixed"
              scroll={{ x: 650 }}
              dataSource={detail.roleSummary}
              columns={[
                {
                  title: "库存类别",
                  dataIndex: "group",
                  width: 210,
                  render: (v: string) => (
                    <Tag color={v === "sample" ? "purple" : "blue"}>
                      {v === "sample" ? "小样/赠品/试用/内用" : "正常销售（含未分类）"}
                    </Tag>
                  ),
                },
                { title: "行数", dataIndex: "lineCount", width: 80, align: "right" },
                { title: "账面合计", dataIndex: "bookQty", width: 120, align: "right", render: formatQty },
                { title: "实盘合计", dataIndex: "countedQty", width: 120, align: "right", render: formatQty },
                {
                  title: "差异",
                  dataIndex: "diffQty",
                  width: 120,
                  align: "right",
                  render: (v: string) => (
                    <DiffText value={formatQty(v)} />
                  ),
                },
              ]}
            />
            {editable ? (
              <>
                <ScannerEntry
                  disabled={actionLoading}
                  help="扫码枪请保持光标在输入框；首次扫描该 SKU 从扫码数量开始计数，后续扫描累加。若同一 SKU 有多个批次行，系统会阻止歧义写入。"
                  onScan={handleScan}
                />
                <Typography.Paragraph type="secondary" style={{ margin: "8px 0" }}>
                  实盘数已预填账面数；手工修改按表格值保存，首次扫码则从扫码数量开始累计。
                  {dirtyCount > 0 && "有未保存修改，请先保存实盘数，再提交审批。"}
                </Typography.Paragraph>
              </>
            ) : null}
            <Table<TaskLine>
              rowKey="id"
              tableLayout="fixed"
              scroll={{ x: 1016 }}
              size="small"
              columns={lineColumns}
              dataSource={detail.lines}
              pagination={detail.lines.length > 100 ? { pageSize: 100, showSizeChanger: false } : false}
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

      <Modal
        title="驳回盘点单"
        open={rejectOpen}
        okText="确认驳回"
        okButtonProps={{ danger: true }}
        cancelText="取消"
        confirmLoading={actionLoading}
        closable={!actionLoading}
        maskClosable={!actionLoading}
        keyboard={!actionLoading}
        cancelButtonProps={{ disabled: actionLoading }}
        onCancel={() => { if (!actionLock.current) setRejectOpen(false); }}
        onOk={() =>
          void doAction(
            "approve",
            { action: "reject", comment: rejectComment.trim() || undefined, version: detail?.version },
            "已驳回，退回草稿",
          ).then((ok) => {
            if (ok) {
              setRejectOpen(false);
              setRejectComment("");
            }
          })
        }
      >
        <Input.TextArea
          disabled={actionLoading}
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
