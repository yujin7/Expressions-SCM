"use client";

import { useDocumentTarget } from "@/components/useDocumentTarget";
import { DOCUMENT_TRANSIENT_PARAMS } from "@/lib/document-links";
import { useDocumentRead } from "@/components/useDocumentRead";
import DocumentDrawer from "@/components/DocumentDrawer";
import DocumentTargetLink from "@/components/DocumentTargetLink";

import SearchInput from "@/components/SearchInput";

import { useEffect, useRef, useState } from "react";
import { App, Alert, Badge, Button, DatePicker, Descriptions, Input, InputNumber, Modal, Popconfirm, Radio, Select, Space, Table, Tabs, Tag, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { DeleteOutlined, PlusOutlined, ReloadOutlined } from "@ant-design/icons";
import dayjs from "dayjs";
import AttachmentPanel from "@/components/AttachmentPanel";
import ChainStrip from "@/components/ChainStrip";
import DocStatusTag from "@/components/DocStatusTag";
import DocWindowFilterTag from "@/components/DocWindowFilterTag";
import ListToolbar from "@/components/ListToolbar";
import LoadErrorAlert from "@/components/LoadErrorAlert";
import RemoteSelect from "@/components/RemoteSelect";
import { postJson } from "@/components/fetchJson";
import { formatQty, formatAsOf } from "@/components/format";
import { useListState } from "@/components/useListState";
import { hasAnyRole, useMe } from "@/components/useMe";
import ApprovalTimeline from "@/components/ApprovalTimeline";
import ScannerEntry from "@/components/ScannerEntry";
import { addScanQty, findUniqueScanMatch } from "@/components/scanner";
import QcOutcomePanel from "./qc-outcome-panel";

// ---------- 客户端十进制工具（仅 UI 过滤/汇总提示用；非负字符串，禁 float） ----------

const DEC_RE = /^\d+(\.\d+)?$/;

function decParts(s: string): [string, string] {
  const [i, f = ""] = s.split(".");
  return [i || "0", f];
}

function decCmp(a: string, b: string): number {
  const [ai, af] = decParts(a);
  const [bi, bf] = decParts(b);
  const scale = Math.max(af.length, bf.length);
  const av = BigInt(ai + af.padEnd(scale, "0"));
  const bv = BigInt(bi + bf.padEnd(scale, "0"));
  return av === bv ? 0 : av > bv ? 1 : -1;
}

function decAdd(a: string, b: string): string {
  const [ai, af] = decParts(a);
  const [bi, bf] = decParts(b);
  const scale = Math.max(af.length, bf.length);
  const sum = BigInt(ai + af.padEnd(scale, "0")) + BigInt(bi + bf.padEnd(scale, "0"));
  if (scale === 0) return sum.toString();
  const s = sum.toString().padStart(scale + 1, "0");
  return `${s.slice(0, -scale)}.${s.slice(-scale)}`.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
}

// ---------- 接口形状（对照 src/server/modules/matflow/sh.ts） ----------

const LINE_TYPE_LABELS: Record<string, string> = {
  normal: "正常",
  rework: "返工重交",
  spare: "备品",
};

const FAIL_HANDLING_LABELS: Record<string, string> = {
  pending: "待处理",
  rework: "返工",
  concession: "让步接收",
  scrap: "报废",
};

type ShLineType = "normal" | "rework" | "spare";
type FailHandling = "pending" | "rework" | "concession" | "scrap";

interface ShRow {
  id: number;
  docNo: string;
  status: string;
  sourceType: "jg" | "po";
  sourceId: number;
  warehouseName: string;
  lineCount: number;
  hasQc: boolean;
  inbound: boolean;
  createdByName: string | null;
  materialReviewPending?: boolean;
  createdAt: string;
}

interface ShLine {
  id: number;
  poLineId: number | null;
  skuId: number;
  skuCode: string;
  skuName: string;
  baseUom: string;
  lineType: string;
  expectedQty: string | null;
  actualQty: string;
  batchNo: string | null;
  prodDate: string | null;
}

interface QcLine {
  id: number;
  shLineId: number;
  passQty: string;
  failQty: string;
  concessionQty: string;
  failHandling: string;
}

interface DocApproval {
  approverName: string | null;
  action: "approve" | "reject";
  comment: string | null;
  createdAt: string;
}

interface ShDetail {
  id: number;
  docNo: string;
  status: string;
  remark: string | null;
  version: number;
  sourceType: "jg" | "po";
  sourceId: number;
  sourceDocNo: string | null;
  warehouseName: string;
  createdAt: string;
  createdByName: string | null;
  lines: ShLine[];
  qc: { id: number; conclusion: string | null; createdAt: string; lines: QcLine[] } | null;
  inbound: boolean;
  approvals: DocApproval[];
  materialReview: { checkedAt: string | null; reviewItemId: number | null; basisStatus: string | null } | null;
}

interface JgSource {
  id: number;
  status: string;
  productSkuId: number;
  productSkuCode: string;
  productSkuName: string;
  productSkuBarcode: string | null;
  qty: string;
}

interface PoSource {
  id: number;
  status: string;
  lines: PoDetailLine[];
}

interface PoDetailLine {
  id: number;
  skuId: number;
  skuCode: string;
  skuName: string;
  barcode: string | null;
  baseUom: string;
  purchaseUom: string;
  uomFactor: string;
  qty: string;
  receivedQty: string;
}

/** jg 源创建行（SKU 固定为加工成品） */
interface JgCreateLine {
  key: number;
  lineType: ShLineType;
  expectedQty: string;
  actualQty: string;
  batchNo: string;
  prodDate: string | null;
}

/** po 源创建行（按 PO 行预填） */
interface PoCreateLine {
  poLineId: number;
  skuId: number;
  skuCode: string;
  skuName: string;
  barcode: string | null;
  baseUom: string;
  orderedQty: string;
  purchaseUom: string;
  receivedQty: string;
  actualQty: string;
  batchNo: string;
  prodDate: string | null;
}

/** 检验区行编辑态 */
interface QcEditRow {
  shLineId: number;
  label: string;
  lineType: string;
  actualQty: string;
  passQty: string;
  failQty: string;
  concessionQty: string;
  failHandling: FailHandling;
}

const STATUS_TABS = [
  { key: "", label: "全部" },
  { key: "draft", label: "草稿" },
  { key: "pending", label: "待审批" },
  { key: "approved", label: "待检验/入库" },
  { key: "completed", label: "已入库" },
];

export default function ShClient() {
  const { message } = App.useApp();
  const me = useMe();
  const canWrite = hasAnyRole(me, "warehouse");
  const canApprove =
    me != null && (me.roles.includes("admin") || (me.isApprover && me.roles.includes("warehouse")));

  // 列表页状态平台（E6-P1）：筛选/分页进 URL，密度与已保存视图存本地
  // from/to = 制单时间窗（上海业务日，含首尾）：全链漏斗「到货」级点数字回链到本页时带过来
  const listState = useListState({ transientParams: DOCUMENT_TRANSIENT_PARAMS, key: "sh", defaults: { q: "", status: "", from: "", to: "", materialReviewPending: "" }, defaultPageSize: 20 });
  const { filters, page, pageSize } = listState;
  const q = filters.q;
  const status = filters.status;
  const from = filters.from;
  const to = filters.to;
  const listParams = new URLSearchParams({ q, page: String(page), pageSize: String(pageSize) });
  if (status) listParams.set("status", status);
  if (from) listParams.set("from", from);
  if (to) listParams.set("to", to);
  if (filters.materialReviewPending) listParams.set("materialReviewPending", filters.materialReviewPending);
  const listRead = useDocumentRead<{ rows: ShRow[]; total: number }>(`/api/matflow/sh?${listParams}`);
  const listValid = listRead.data != null && Array.isArray(listRead.data.rows) && Number.isSafeInteger(listRead.data.total)
    && listRead.data.total >= 0 && listRead.data.rows.every(r => r && Number.isSafeInteger(r.id) && r.id > 0 && typeof r.docNo === "string");
  const rows = listValid ? listRead.data!.rows : [];
  const total = listValid ? listRead.data!.total : 0;
  const loading = listRead.phase === "loading";
  const listError = listRead.error ?? (listRead.phase === "success" && !listValid ? "收货列表格式异常，请重新读取" : null);
  const load = listRead.retry;

  const documentSelection = useDocumentTarget();
  const { id: detailId, setId: setDetailId } = documentSelection;
  useEffect(() => { setRejectOpen(false); }, [detailId]);
  const detailRead = useDocumentRead<ShDetail>(detailId == null ? null : `/api/matflow/sh/${detailId}`);
  const detail = detailRead.data;
  const detailLoading = detailRead.phase === "loading";
  const loadDetail = detailRead.retry;
  const [actionLoading, setActionLoading] = useState(false);
  const [actionError, setActionError] = useState<{ id: number; message: string } | null>(null);
  const [overCapAlert, setOverCapAlert] = useState<string | null>(null);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectComment, setRejectComment] = useState("");

  // 检验区编辑态
  const [qcRows, setQcRows] = useState<QcEditRow[]>([]);
  const [qcConclusion, setQcConclusion] = useState("");
  const [qcLoading, setQcLoading] = useState(false);
  const [inboundLoading, setInboundLoading] = useState(false);
  const reviewBusy = useRef(false);
  const [reviewLoading, setReviewLoading] = useState(false);
  const [reviewError, setReviewError] = useState<{ id: number; message: string } | null>(null);

  // 创建
  const [createOpen, setCreateOpen] = useState(false);
  const [createLoading, setCreateLoading] = useState(false);
  const [sourceType, setSourceType] = useState<"jg" | "po">("jg");
  const [sourceId, setSourceId] = useState<number | null>(null);
  const [warehouseId, setWarehouseId] = useState<number | null>(null);
  const [remark, setRemark] = useState("");
  const [jgLines, setJgLines] = useState<JgCreateLine[]>([]);
  const [jgLineKey, setJgLineKey] = useState(1);
  const [poEdits, setPoEdits] = useState<Partial<Record<number, Pick<PoCreateLine, "actualQty" | "batchNo" | "prodDate">>>>({});
  const jgRead = useDocumentRead<JgSource>(createOpen && sourceType === "jg" && sourceId != null ? `/api/outsource/jg/${sourceId}` : null);
  const poRead = useDocumentRead<PoSource>(createOpen && sourceType === "po" && sourceId != null ? `/api/outsource/po/${sourceId}` : null);
  const sourceRead = sourceType === "jg" ? jgRead : poRead;
  const validStatus = (value: string) => value === "approved" || value === "in_progress";
  const jgValid = jgRead.data != null && jgRead.data.id === sourceId && validStatus(jgRead.data.status)
    && Number.isSafeInteger(jgRead.data.productSkuId) && jgRead.data.productSkuId > 0
    && typeof jgRead.data.productSkuCode === "string" && typeof jgRead.data.productSkuName === "string"
    && typeof jgRead.data.qty === "string" && DEC_RE.test(jgRead.data.qty);
  const poValid = poRead.data != null && poRead.data.id === sourceId && validStatus(poRead.data.status)
    && Array.isArray(poRead.data.lines) && poRead.data.lines.length > 0
    && poRead.data.lines.every(l => l && Number.isSafeInteger(l.id) && l.id > 0 && Number.isSafeInteger(l.skuId) && l.skuId > 0
      && typeof l.skuCode === "string" && typeof l.skuName === "string" && typeof l.baseUom === "string" && typeof l.purchaseUom === "string"
      && typeof l.qty === "string" && DEC_RE.test(l.qty) && typeof l.receivedQty === "string" && DEC_RE.test(l.receivedQty))
    && new Set(poRead.data.lines.map(l => l.id)).size === poRead.data.lines.length;
  const sourceReady = sourceType === "jg" ? jgValid : poValid;
  const sourceError = sourceRead.error ?? (sourceRead.phase === "success" && !sourceReady ? "来源单据身份、状态或收货行异常；仅已审批/执行中的单据可收货，请重新读取或改选来源" : null);
  const jg = jgValid ? jgRead.data : null;
  const jgProduct = jg ? { skuId: jg.productSkuId, skuCode: jg.productSkuCode, skuName: jg.productSkuName, barcode: jg.productSkuBarcode, qty: jg.qty } : null;
  const poLines: PoCreateLine[] = poValid ? poRead.data!.lines.map(l => ({
    poLineId: l.id, skuId: l.skuId, skuCode: l.skuCode, skuName: l.skuName, barcode: l.barcode,
    baseUom: l.baseUom, orderedQty: l.qty, purchaseUom: l.purchaseUom, receivedQty: l.receivedQty,
    actualQty: "0", batchNo: "", prodDate: null, ...poEdits[l.id],
  })) : [];
  const editPoLine = (id: number, edit: Partial<Pick<PoCreateLine, "actualQty" | "batchNo" | "prodDate">>) => {
    if (createLoading || !poValid) return;
    setPoEdits(prev => ({ ...prev, [id]: { actualQty: "0", batchNo: "", prodDate: null, ...prev[id], ...edit } }));
  };

  useEffect(() => { setOverCapAlert(null); }, [detailId]);

  /** 检验区编辑态初始化：已审批且未检验时，按收货行预填（合格=实收） */
  useEffect(() => {
    if (detail && detail.qc == null && detail.status === "approved") {
      setQcRows(
        detail.lines.map((l) => ({
          shLineId: l.id,
          label: `${l.skuCode} ${l.skuName}`,
          lineType: l.lineType,
          actualQty: l.actualQty,
          passQty: l.actualQty,
          failQty: "0",
          concessionQty: "0",
          failHandling: "pending" as const,
        })),
      );
      setQcConclusion("");
    } else {
      setQcRows([]);
    }
  }, [detail]);

  const refresh = () => {
    if (detail) void loadDetail();
    void load();
  };

  // ---------- 创建 ----------

  const resetCreateSource = () => {
    setSourceId(null);
    setJgLines([]);
    setPoEdits({});
  };

  const openCreate = () => {
    setCreateOpen(true);
    setSourceType("jg");
    resetCreateSource();
    setWarehouseId(null);
    setRemark("");
  };

  const handleSourceChange = (id: number) => {
    if (createLoading) return;
    setSourceId(id);
    setPoEdits({});
    setJgLines([{ key: 0, lineType: "normal", expectedQty: "", actualQty: "0", batchNo: "", prodDate: null }]);
    setJgLineKey(1);
  };

  const handleReceiveScan = (code: string, qty: string): boolean => {
    if (createLoading || !sourceReady) return false;
    if (sourceType === "jg") {
      if (!jgProduct) return false;
      const result = findUniqueScanMatch([jgProduct], code, (item) => [item.barcode, item.skuCode]);
      if (result.kind === "missing") {
        message.error(`扫描品不属于当前加工通知单：${code}`);
        return false;
      }
      const normalIndex = jgLines.findIndex((line) => line.lineType === "normal");
      if (normalIndex < 0) {
        message.error("当前没有正常收货行；请先添加正常行再扫码");
        return false;
      }
      setJgLines((prev) =>
        prev.map((line, index) =>
          index === normalIndex ? { ...line, actualQty: addScanQty(line.actualQty, qty) } : line,
        ),
      );
      message.success(`已计入 ${jgProduct.skuCode}：+${qty}`, 0.8);
      return true;
    }

    const result = findUniqueScanMatch(poLines, code, (line) => [line.barcode, line.skuCode]);
    if (result.kind === "missing") {
      message.error(`扫描品不属于当前采购订单：${code}`);
      return false;
    }
    if (result.kind === "ambiguous") {
      message.error(`条码/SKU 命中当前订单 ${result.count} 行，请手工选择行录入`);
      return false;
    }
    editPoLine(result.item.poLineId, { actualQty: addScanQty(result.item.actualQty, qty) });
    message.success(`已计入 ${result.item.skuCode}：+${qty}`, 0.8);
    return true;
  };

  const handleCreate = async () => {
    if (createLoading) return;
    if (sourceId == null) return void message.warning("请选择来源单据");
    if (!sourceReady) return void message.warning("请等待当前来源读取完成；读取失败时先重试，不能用旧数据创建");
    if (warehouseId == null) return void message.warning("请选择收货仓");
    let lines: Record<string, unknown>[];
    if (sourceType === "jg") {
      if (jgProduct == null) return void message.warning("请先选择加工通知单");
      const valid = jgLines.filter((l) => DEC_RE.test(l.actualQty) && decCmp(l.actualQty, "0") > 0);
      if (valid.length === 0) return void message.warning("至少需要一行实收数量大于 0 的收货行");
      lines = valid.map((l) => ({
        skuId: jgProduct.skuId, // jg 源行 SKU 必须是加工成品
        lineType: l.lineType,
        expectedQty: DEC_RE.test(l.expectedQty) && decCmp(l.expectedQty, "0") > 0 ? l.expectedQty : undefined,
        actualQty: l.actualQty,
        batchNo: l.batchNo.trim() || undefined,
        prodDate: l.prodDate ?? undefined,
      }));
    } else {
      const valid = poLines.filter((l) => DEC_RE.test(l.actualQty) && decCmp(l.actualQty, "0") > 0);
      if (valid.length === 0) return void message.warning("至少需要一行实收数量大于 0 的收货行");
      lines = valid.map((l) => ({
        skuId: l.skuId,
        poLineId: l.poLineId,
        lineType: "normal",
        actualQty: l.actualQty,
        batchNo: l.batchNo.trim() || undefined,
        prodDate: l.prodDate ?? undefined,
      }));
    }
    setCreateLoading(true);
    try {
      const created = await postJson<{ id: number }>("/api/matflow/sh", {
        sourceType,
        sourceId,
        warehouseId,
        remark: remark.trim() || undefined,
        lines,
      });
      message.success("收货单已创建");
      setCreateOpen(false);
      void load();
      setDetailId(created.id);
    } catch (e) {
      const msg = (e as Error).message;
      if (msg.includes("累计收货超限")) {
        Modal.warning({ title: "累计收货超限", content: msg });
      } else {
        message.error(msg);
      }
    } finally {
      setCreateLoading(false);
    }
  };

  // ---------- 动作 ----------

  const handleSubmit = async () => {
    if (!detail) return;
    setActionError(null);
    setActionLoading(true);
    try {
      await postJson(`/api/matflow/sh/${detail.id}/submit`, { version: detail.version });
      message.success("已提交审批");
      refresh();
    } catch (e) {
      setActionError({ id: detail.id, message: (e as Error).message });
    } finally {
      setActionLoading(false);
    }
  };

  const handleApprove = async (action: "approve" | "reject", comment?: string) => {
    if (!detail) return false;
    setActionError(null);
    setActionLoading(true);
    setOverCapAlert(null);
    try {
      await postJson(`/api/matflow/sh/${detail.id}/approve`, {
        action,
        comment: comment?.trim() || undefined,
        version: detail.version,
      });
      message.success(action === "approve" ? "审批通过，请录入检验后确认入库" : "已驳回");
      refresh();
      return true;
    } catch (e) {
      const msg = (e as Error).message;
      if (msg.includes("累计收货超限")) {
        setOverCapAlert(msg);
        void loadDetail();
      } else {
        setActionError({ id: detail.id, message: msg });
      }
      return false;
    } finally {
      setActionLoading(false);
    }
  };

  /** ② 检验区提交 */
  const handleQcSubmit = async () => {
    if (!detail) return;
    for (const r of qcRows) {
      for (const [label, v] of [
        ["合格", r.passQty],
        ["不合格", r.failQty],
        ["让步", r.concessionQty],
      ] as const) {
        if (!DEC_RE.test(v)) return void message.warning(`${r.label}：${label}数量格式不正确`);
      }
      const graded = decAdd(decAdd(r.passQty, r.failQty), r.concessionQty);
      if (decCmp(graded, r.actualQty) !== 0) {
        return void message.warning(`${r.label}：合格、不合格与让步数量必须完整覆盖实收 ${formatQty(r.actualQty)}（当前 ${graded}）`);
      }
    }
    setQcLoading(true);
    try {
      await postJson(`/api/matflow/sh/${detail.id}/qc`, {
        conclusion: qcConclusion.trim() || undefined,
        lines: qcRows.map((r) => ({
          shLineId: r.shLineId,
          passQty: r.passQty,
          failQty: r.failQty,
          concessionQty: r.concessionQty,
          failHandling: r.failHandling,
        })),
      });
      message.success("检验已提交，可执行入库确认");
      refresh();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setQcLoading(false);
    }
  };

  /** ③ 入库确认：结果 toast 展示入库数量（后端仅回状态，数量按检验结果汇总） */
  const handleInbound = async () => {
    if (!detail || !detail.qc) return;
    setInboundLoading(true);
    try {
      const result = await postJson<{ materialReview?: "checked" | "pending" }>(`/api/matflow/sh/${detail.id}/inbound`, {});
      let pass = "0";
      let concession = "0";
      for (const l of detail.qc.lines) {
        pass = decAdd(pass, l.passQty);
        concession = decAdd(concession, l.concessionQty);
      }
      let spare = "0";
      const qcByLine = new Map(detail.qc.lines.map((l) => [l.shLineId, l]));
      for (const l of detail.lines) {
        if (l.lineType === "spare") {
          const qc = qcByLine.get(l.id);
          spare = decAdd(spare, qc ? decAdd(qc.passQty, qc.concessionQty) : "0");
        }
      }
      const parts = [`合格 ${formatQty(pass)}`];
      if (decCmp(concession, "0") > 0) parts.push(`让步 ${formatQty(concession)}`);
      if (detail.sourceType === "jg" && decCmp(spare, "0") > 0) parts.push(`备品 ${formatQty(spare)}`);
      message.success(`入库完成：${parts.join("、")}`);
      if (result.materialReview === "pending") message.warning("库存已入账；物料核对提示尚未生成，请在入库区重试核对，不要再次入库。", 8);
      refresh();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setInboundLoading(false);
    }
  };

  const handleMaterialReview = async () => {
    if (!detail || !detail.inbound || detail.sourceType !== "jg" || !canWrite || reviewBusy.current) return;
    const target = { id: detail.id, docNo: detail.docNo };
    reviewBusy.current = true;
    setReviewLoading(true);
    setReviewError(null);
    try {
      await postJson(`/api/matflow/sh/${target.id}/material-review`, {});
      message.success(`${target.docNo}：核对提示已重新计算；未重复入库，也未自动完成复核。`);
      refresh();
    } catch (e) {
      setReviewError({ id: target.id, message: (e as Error).message });
    } finally {
      reviewBusy.current = false;
      setReviewLoading(false);
    }
  };

  // ---------- 列 ----------

  const columns: ColumnsType<ShRow> = [
    {
      title: "单据号",
      dataIndex: "docNo",
      width: 160,
      render: (v: string, r) => <DocumentTargetLink id={r.id} onOpen={setDetailId}>{v}</DocumentTargetLink>,
    },
    {
      title: "来源",
      key: "source",
      width: 150,
      render: (_, r) => (
        <Space size={4}>
          {r.sourceType === "jg" ? <Tag color="blue">委外</Tag> : <Tag color="green">采购</Tag>}
          <span>#{r.sourceId}</span>
        </Space>
      ),
    },
    { title: "仓库", dataIndex: "warehouseName", width: 140 },
    { title: "行数", dataIndex: "lineCount", width: 70, align: "right" },
    {
      title: "检验",
      dataIndex: "hasQc",
      width: 80,
      render: (v: boolean) => (v ? <Tag color="cyan">已检验</Tag> : <Tag>未检验</Tag>),
    },
    { title: "状态", dataIndex: "status", width: 100, render: (v: string) => <DocStatusTag status={v} /> },
    {
      title: "已入库",
      dataIndex: "inbound",
      width: 160,
      render: (v: boolean, row: ShRow) => <Space direction="vertical" size={2}>
        {v ? <Badge status="success" text="已入库" /> : <Badge status="default" text="未入库" />}
        {row.materialReviewPending ? <Button type="link" size="small" style={{ padding: 0 }} onClick={() => setDetailId(row.id)}>物料核对待计算</Button> : null}
      </Space>,
    },
    {
      title: "时间",
      dataIndex: "createdAt",
      width: 150,
      render: (v: string) => dayjs(v).format("YYYY-MM-DD HH:mm"),
    },
  ];

  const lineColumns: ColumnsType<ShLine> = [
    { title: "物料", key: "material", width: 160, render: (_, r) => <><div>{r.skuCode} {r.skuName}</div>{detail?.sourceType === "po" && <Typography.Text type="secondary">{r.poLineId != null ? `采购行 #${r.poLineId}` : "历史采购行未记录"}</Typography.Text>}</> },
    { title: "单位", dataIndex: "baseUom", width: 70 },
    {
      title: "行类型",
      dataIndex: "lineType",
      width: 90,
      render: (v: string) => LINE_TYPE_LABELS[v] ?? v,
    },
    {
      title: "应收",
      dataIndex: "expectedQty",
      width: 100,
      align: "right",
      render: (v: string | null) => formatQty(v),
    },
    { title: "实收", dataIndex: "actualQty", width: 100, align: "right", render: (v: string) => formatQty(v) },
    { title: "批号", dataIndex: "batchNo", width: 110, render: (v: string | null) => v ?? "—" },
    { title: "生产日期", dataIndex: "prodDate", width: 110, render: (v: string | null) => v ?? "—" },
  ];

  const shLineById = new Map((detail?.lines ?? []).map((l) => [l.id, l]));

  const qcResultColumns: ColumnsType<QcLine> = [
    {
      title: "物料",
      key: "material",
      width: 160,
      render: (_, r) => {
        const l = shLineById.get(r.shLineId);
        return l ? `${l.skuCode} ${l.skuName}` : `行#${r.shLineId}`;
      },
    },
    {
      title: "行类型",
      key: "lineType",
      width: 90,
      render: (_, r) => {
        const l = shLineById.get(r.shLineId);
        return l ? (LINE_TYPE_LABELS[l.lineType] ?? l.lineType) : "—";
      },
    },
    { title: "合格", dataIndex: "passQty", width: 90, align: "right", render: (v: string) => formatQty(v) },
    { title: "不合格", dataIndex: "failQty", width: 90, align: "right", render: (v: string) => formatQty(v) },
    {
      title: "让步",
      dataIndex: "concessionQty",
      width: 90,
      align: "right",
      render: (v: string) => formatQty(v),
    },
    {
      title: "不合格处理",
      dataIndex: "failHandling",
      width: 110,
      render: (v: string) => FAIL_HANDLING_LABELS[v] ?? v,
    },
  ];

  const qcEditColumns: ColumnsType<QcEditRow> = [
    { title: "物料", dataIndex: "label", width: 160 },
    {
      title: "行类型",
      dataIndex: "lineType",
      width: 90,
      render: (v: string) => LINE_TYPE_LABELS[v] ?? v,
    },
    { title: "实收", dataIndex: "actualQty", width: 90, align: "right", render: (v: string) => formatQty(v) },
    {
      title: "合格",
      key: "passQty",
      width: 110,
      render: (_, r, idx) => (
        <InputNumber<string>
          stringMode
          min="0"
          style={{ width: "100%" }}
          value={r.passQty}
          onChange={(v) =>
            setQcRows((prev) => prev.map((l, i) => (i === idx ? { ...l, passQty: v ?? "0" } : l)))
          }
        />
      ),
    },
    {
      title: "不合格",
      key: "failQty",
      width: 110,
      render: (_, r, idx) => (
        <InputNumber<string>
          stringMode
          min="0"
          style={{ width: "100%" }}
          value={r.failQty}
          onChange={(v) =>
            setQcRows((prev) => prev.map((l, i) => (i === idx ? { ...l, failQty: v ?? "0" } : l)))
          }
        />
      ),
    },
    {
      title: "让步",
      key: "concessionQty",
      width: 110,
      render: (_, r, idx) => (
        <InputNumber<string>
          stringMode
          min="0"
          style={{ width: "100%" }}
          value={r.concessionQty}
          onChange={(v) =>
            setQcRows((prev) => prev.map((l, i) => (i === idx ? { ...l, concessionQty: v ?? "0" } : l)))
          }
        />
      ),
    },
    {
      title: "不合格处理",
      key: "failHandling",
      width: 130,
      render: (_, r, idx) => (
        <Select<FailHandling>
          style={{ width: "100%" }}
          value={r.failHandling}
          options={Object.entries(FAIL_HANDLING_LABELS).map(([value, label]) => ({ value, label }))}
          onChange={(v) =>
            setQcRows((prev) => prev.map((l, i) => (i === idx ? { ...l, failHandling: v } : l)))
          }
        />
      ),
    },
  ];

  const jgCreateColumns: ColumnsType<JgCreateLine> = [
    {
      title: "行类型",
      key: "lineType",
      width: 130,
      render: (_, r, idx) => (
        <Select<ShLineType>
          disabled={createLoading}
          style={{ width: "100%" }}
          value={r.lineType}
          options={[
            { value: "normal", label: "正常" },
            { value: "rework", label: "返工重交" },
            { value: "spare", label: "备品" },
          ]}
          onChange={(v) =>
            setJgLines((prev) => prev.map((l, i) => (i === idx ? { ...l, lineType: v } : l)))
          }
        />
      ),
    },
    {
      title: "应收数量（可选）",
      key: "expectedQty",
      width: 140,
      render: (_, r, idx) => (
        <InputNumber<string>
          stringMode
          min="0"
          style={{ width: "100%" }}
          placeholder="可留空"
          disabled={createLoading}
          value={r.expectedQty || null}
          onChange={(v) =>
            setJgLines((prev) => prev.map((l, i) => (i === idx ? { ...l, expectedQty: v ?? "" } : l)))
          }
        />
      ),
    },
    {
      title: "实收数量",
      key: "actualQty",
      width: 130,
      render: (_, r, idx) => (
        <InputNumber<string>
          stringMode
          min="0"
          style={{ width: "100%" }}
          value={r.actualQty}
          disabled={createLoading}
          onChange={(v) =>
            setJgLines((prev) => prev.map((l, i) => (i === idx ? { ...l, actualQty: v ?? "0" } : l)))
          }
        />
      ),
    },
    {
      title: "批号",
      key: "batchNo",
      width: 130,
      render: (_, r, idx) => (
        <Input
          maxLength={50}
          value={r.batchNo}
          disabled={createLoading}
          onChange={(e) =>
            setJgLines((prev) => prev.map((l, i) => (i === idx ? { ...l, batchNo: e.target.value } : l)))
          }
        />
      ),
    },
    {
      title: "生产日期",
      key: "prodDate",
      width: 140,
      render: (_, r, idx) => (
        <DatePicker
          style={{ width: "100%" }}
          value={r.prodDate ? dayjs(r.prodDate) : null}
          disabled={createLoading}
          onChange={(d) =>
            setJgLines((prev) =>
              prev.map((l, i) => (i === idx ? { ...l, prodDate: d ? d.format("YYYY-MM-DD") : null } : l)),
            )
          }
        />
      ),
    },
    {
      title: "",
      key: "_del",
      width: 40,
      render: (_, __, idx) => (
        <Button
          type="text"
          size="small"
          icon={<DeleteOutlined />}
          disabled={createLoading}
          onClick={() => setJgLines((prev) => prev.filter((_, i) => i !== idx))}
        />
      ),
    },
  ];

  const poCreateColumns: ColumnsType<PoCreateLine> = [
    { title: "物料 / 单位", key: "material", width: 260, render: (_, r) => <><div>{r.skuCode} {r.skuName}（{r.baseUom}）</div><Typography.Text type="secondary">采购行 #{r.poLineId}</Typography.Text></> },
    {
      title: "订购",
      key: "ordered",
      width: 110,
      align: "right",
      render: (_, r) => `${formatQty(r.orderedQty)} ${r.purchaseUom}`,
    },
    {
      title: "已收（基础单位）",
      dataIndex: "receivedQty",
      width: 130,
      align: "right",
      render: (v: string) => formatQty(v),
    },
    {
      title: "本次实收（基础单位）",
      key: "actualQty",
      width: 150,
      render: (_, r) => (
        <InputNumber<string>
          stringMode
          min="0"
          style={{ width: "100%" }}
          value={r.actualQty}
          disabled={createLoading}
          onChange={(v) => editPoLine(r.poLineId, { actualQty: v ?? "0" })}
        />
      ),
    },
    {
      title: "批号",
      key: "batchNo",
      width: 120,
      render: (_, r) => (
        <Input
          maxLength={50}
          value={r.batchNo}
          disabled={createLoading}
          onChange={(e) => editPoLine(r.poLineId, { batchNo: e.target.value })}
        />
      ),
    },
    {
      title: "生产日期",
      key: "prodDate",
      width: 140,
      render: (_, r) => (
        <DatePicker
          style={{ width: "100%" }}
          value={r.prodDate ? dayjs(r.prodDate) : null}
          disabled={createLoading}
          onChange={(d) => editPoLine(r.poLineId, { prodDate: d ? d.format("YYYY-MM-DD") : null })}
        />
      ),
    },
  ];

  const actions = detail ? (
    <Space>
      {detail.status === "draft" && canWrite ? (
        <Popconfirm title="确认提交审批？" okText="提交" cancelText="取消" onConfirm={() => void handleSubmit()}>
          <Button type="primary" loading={actionLoading}>
            提交
          </Button>
        </Popconfirm>
      ) : null}
      {detail.status === "pending" && canApprove ? (
        <>
          <Popconfirm
            title="确认审批通过？通过后进入检验环节，检验前不入库。"
            okText="通过"
            cancelText="取消"
            onConfirm={() => void handleApprove("approve")}
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
    </Space>
  ) : null;

  return (
    <div>
      <Typography.Title level={4} style={{ marginTop: 0 }}>
        收货检验（SH）
      </Typography.Title>
      <Typography.Paragraph type="secondary">
        委外/采购收货一体屏：收货 → 审批 → 检验 → 入库确认。收货必检，检验前不入库。
      </Typography.Paragraph>
      <Tabs
        activeKey={status}
        items={STATUS_TABS}
        onChange={(key) => listState.setFilter({ status: key, materialReviewPending: "" })}
      />
      <ListToolbar
        state={listState}
        primaryActions={
          <>
            <Button icon={<ReloadOutlined />} onClick={() => void load()}>
              刷新
            </Button>
            <Button type={filters.materialReviewPending ? "primary" : "default"}
              onClick={() => listState.setFilter({ materialReviewPending: filters.materialReviewPending ? "" : "1", status: "" })}>
              {filters.materialReviewPending ? "显示全部收货" : "物料核对待计算"}
            </Button>
            {canWrite ? (
              <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
                新建收货单
              </Button>
            ) : null}
          </>
        }
        extra={
          <>
            <SearchInput
              key={q}
              allowClear
              defaultValue={q}
              placeholder="搜索单号 / SKU 编码 / 货品名称"
              style={{ width: 240 }}
              onSearch={(value) => listState.setFilter({ q: value.trim() })}
            />
            <DocWindowFilterTag from={from} to={to} onClear={() => listState.setFilter({ from: "", to: "" })} />
          </>
        }
      />
      <LoadErrorAlert error={listError} onRetry={load} subject="收货列表" retrying={loading} />
      <Table<ShRow>
        rowKey="id"
        size={listState.tableSize}
        columns={columns}
        dataSource={rows}
        loading={loading}
        scroll={{ x: "max-content" }}
        pagination={listValid ? listState.paginationProps({ total }) : false}
      />

      <DocumentDrawer
        key={detailId ?? "invalid-document"}
        title={
          detail ? (
            <Space>
              <span>{detail.docNo}</span>
              <DocStatusTag status={detail.status} />
              {detail.inbound ? <Tag color="success">已入库</Tag> : null}
            </Space>
          ) : (
            "收货单详情"
          )
        }
        open={documentSelection.present}
        readError={documentSelection.error ?? detailRead.error}
        onRetry={detailId != null ? detailRead.retry : undefined}
        closable={!actionLoading && !qcLoading && !inboundLoading}
        maskClosable={!actionLoading && !qcLoading && !inboundLoading}
        keyboard={!actionLoading && !qcLoading && !inboundLoading}
        onClose={() => { if (!actionLoading && !qcLoading && !inboundLoading) setDetailId(null); }}
        width={980}
        loading={detailLoading}
        extra={actions}
      >
        {detail ? (
          <div>
            <ChainStrip docType="sh" id={detail.id} />
            {actionError?.id === detail.id ? <Alert type="error" showIcon style={{ marginBottom: 12 }}
              message="操作未完成，请核对当前单据"
              description={actionError.message}
              action={<Button size="small" onClick={loadDetail}>重新读取单据</Button>} /> : null}
            {overCapAlert ? (
              <Alert
                type="warning"
                showIcon
                closable
                onClose={() => setOverCapAlert(null)}
                style={{ marginBottom: 16 }}
                message="累计收货超限，审批被阻塞"
                description={overCapAlert}
              />
            ) : null}
            <Descriptions column={{ xs: 1, sm: 2 }} size="small" bordered style={{ marginBottom: 16 }}>
              <Descriptions.Item label="来源">
                <Space size={4}>
                  {detail.sourceType === "jg" ? <Tag color="blue">委外</Tag> : <Tag color="green">采购</Tag>}
                  <span>{detail.sourceDocNo ?? `#${detail.sourceId}`}</span>
                </Space>
              </Descriptions.Item>
              <Descriptions.Item label="收货仓">{detail.warehouseName}</Descriptions.Item>
              <Descriptions.Item label="制单人">{detail.createdByName ?? "—"}</Descriptions.Item>
              <Descriptions.Item label="制单时间">
                {dayjs(detail.createdAt).format("YYYY-MM-DD HH:mm")}
              </Descriptions.Item>
              <Descriptions.Item label="备注" span={{ xs: 1, sm: 2 }}>
                {detail.remark ?? "—"}
              </Descriptions.Item>
            </Descriptions>

            <Typography.Title level={5}>① 收货行</Typography.Title>
            <Table<ShLine>
              rowKey="id"
              size="small"
              columns={lineColumns}
              tableLayout="fixed"
              scroll={{ x: 840 }}
              dataSource={detail.lines}
              pagination={false}
              style={{ marginBottom: 24 }}
            />

            <Typography.Title level={5}>② 检验区</Typography.Title>
            {detail.qc ? (
              <div style={{ marginBottom: 24 }}>
                <Table<QcLine>
                  rowKey="id"
                  size="small"
                  columns={qcResultColumns}
                  tableLayout="fixed"
                  scroll={{ x: 720 }}
                  dataSource={detail.qc.lines}
                  pagination={false}
                  style={{ marginBottom: 8 }}
                />
                <Typography.Text type="secondary">
                  检验时间：{dayjs(detail.qc.createdAt).format("YYYY-MM-DD HH:mm")}
                  {detail.qc.conclusion ? `｜结论：${detail.qc.conclusion}` : ""}
                </Typography.Text>
                {/* W2 审计 3：不合格量必须有去向（质量案件 / 退货草稿），否则它只是报表里的一个比率 */}
                <QcOutcomePanel shId={detail.id} canWrite={canWrite} onDone={() => void loadDetail()} />
              </div>
            ) : detail.status === "approved" && canWrite ? (
              <div style={{ marginBottom: 24 }}>
                <Table<QcEditRow>
                  rowKey="shLineId"
                  size="small"
                  columns={qcEditColumns}
                  tableLayout="fixed"
                  scroll={{ x: 890 }}
                  dataSource={qcRows}
                  pagination={false}
                  style={{ marginBottom: 8 }}
                />
                <Space direction="vertical" style={{ width: "100%" }}>
                  <Input.TextArea
                    rows={2}
                    maxLength={500}
                    placeholder="检验结论（可选）"
                    value={qcConclusion}
                    onChange={(e) => setQcConclusion(e.target.value)}
                  />
                  <Popconfirm
                    title="确认提交检验？一单一检，提交后不可修改。"
                    okText="提交"
                    cancelText="取消"
                    onConfirm={() => void handleQcSubmit()}
                  >
                    <Button type="primary" loading={qcLoading}>
                      提交检验
                    </Button>
                  </Popconfirm>
                </Space>
              </div>
            ) : (
              <Typography.Paragraph type="secondary" style={{ marginBottom: 24 }}>
                {detail.status === "approved"
                  ? "待仓管/管理员录入检验。"
                  : "收货单审批通过后方可录入检验。"}
              </Typography.Paragraph>
            )}

            {/* 检验照片证据链（扣款争议凭据）：已检挂 QC 记录；未检暂挂收货单（sh 兜底） */}
            {detail.qc ? (
              <>
                <AttachmentPanel entity="qc" entityId={detail.qc.id} canWrite={canWrite} title="检验照片" />
                <AttachmentPanel
                  entity="sh"
                  entityId={detail.id}
                  canWrite={false}
                  title="检验照片（检验前上传）"
                  hideWhenEmpty
                />
              </>
            ) : (
              <AttachmentPanel entity="sh" entityId={detail.id} canWrite={canWrite} title="检验照片" />
            )}

            <Typography.Title level={5}>③ 入库区</Typography.Title>
            <div style={{ marginBottom: 24 }}>
              {detail.inbound ? (
                <Space direction="vertical" size={12} style={{ width: "100%" }}>
                  <Alert type="success" showIcon message="已完成入库" />
                  {detail.sourceType === "jg" ? (
                    <Alert type={detail.materialReview?.checkedAt ? "info" : "warning"} showIcon
                      message={detail.materialReview?.checkedAt
                        ? `物料估算上次计算：${formatAsOf(detail.materialReview.checkedAt)}`
                        : "物料估算尚无成功计算记录（可能未运行或失败）"}
                      description={<Space direction="vertical" size={8} style={{ width: "100%" }}>
                        <Typography.Text>这是计算时的累计估算，不是当前实盘，也不代表负责人已复核；发退料变化后可重算。此操作不会重复入库。</Typography.Text>
                        {detail.materialReview?.basisStatus === "unknown" ? <Typography.Text type="warning">来源依据不完整，请进入复核项核对，不能按零差额处理。</Typography.Text> : null}
                        {detail.materialReview?.basisStatus === "no_difference" ? <Typography.Text>上次估算无差额，不等于账实相符。</Typography.Text> : null}
                        <Space wrap>
                          {canWrite ? <Button loading={reviewLoading} onClick={() => void handleMaterialReview()}>重算物料核对</Button>
                            : <Typography.Text type="secondary">请仓管/管理员重算核对。</Typography.Text>}
                          {detail.materialReview?.reviewItemId ? <a href={`/review/checklist?category=material_leftover&status=all&id=${detail.materialReview.reviewItemId}`}>查看核对事项</a> : null}
                        </Space>
                        {reviewError?.id === detail.id ? <Alert type="error" showIcon message={`核对计算未完成：${reviewError.message}`} description="入库结果不受影响；可重试上述核对，不要再次入库。" /> : null}
                      </Space>}
                    />
                  ) : null}
                </Space>
              ) : (
                <Space direction="vertical">
                  {detail.qc == null ? (
                    <Typography.Text type="secondary">收货必检：须先提交检验方可入库。</Typography.Text>
                  ) : null}
                  {canWrite ? (
                    <Popconfirm
                      title="确认入库？按检验结果过账（合格+让步入库）。"
                      okText="入库"
                      cancelText="取消"
                      onConfirm={() => void handleInbound()}
                    >
                      <Button
                        type="primary"
                        loading={inboundLoading}
                        disabled={detail.qc == null || detail.status !== "approved"}
                      >
                        确认入库
                      </Button>
                    </Popconfirm>
                  ) : (
                    <Typography.Text type="secondary">仅仓管/管理员可执行入库确认。</Typography.Text>
                  )}
                </Space>
              )}
            </div>

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
        title="新建收货单"
        open={createOpen}
        width={920}
        okText="创建"
        cancelText="取消"
        confirmLoading={createLoading}
        okButtonProps={{ disabled: !sourceReady || warehouseId == null }}
        cancelButtonProps={{ disabled: createLoading }}
        closable={!createLoading}
        maskClosable={!createLoading}
        keyboard={!createLoading}
        onCancel={() => { if (!createLoading) { setCreateOpen(false); resetCreateSource(); } }}
        onOk={() => void handleCreate()}
      >
        <Space direction="vertical" style={{ width: "100%" }} size="middle">
          <Radio.Group
            disabled={createLoading}
            value={sourceType}
            onChange={(e) => {
              setSourceType(e.target.value as "jg" | "po");
              resetCreateSource();
            }}
            options={[
              { value: "jg", label: "委外收货（加工通知单）" },
              { value: "po", label: "采购收货（采购订单）" },
            ]}
            optionType="button"
          />
          <div>
            <div style={{ marginBottom: 4 }}>
              {sourceType === "jg" ? "加工通知单（仅 已审批/执行中）" : "采购订单（仅 已审批/执行中）"}
            </div>
            <RemoteSelect
              key={sourceType}
              api={`/api/outsource/${sourceType}?receiptEligible=1`}
              disabled={createLoading}
              style={{ width: "100%" }}
              placeholder="选择来源单据"
              value={sourceId}
              getLabel={r => sourceType === "jg"
                ? `${r.docNo}｜${r.supplierName}｜${r.productSkuCode} ${r.productSkuName}｜数量 ${formatQty(String(r.qty))}`
                : `${r.docNo}｜${r.supplierName}`}
              onChange={(v: number) => void handleSourceChange(v)}
            />
          </div>
          <div>
            <div style={{ marginBottom: 4 }}>收货仓（自有实时仓）</div>
            <RemoteSelect
              api="/api/master/warehouse"
              disabled={createLoading}
              style={{ width: "100%" }}
              placeholder="选择收货仓"
              value={warehouseId}
              getLabel={(r) => `${String(r.code)} ${String(r.name)}`}
              filterRow={(r) =>
                r.active === true &&
                r.accountingMode === "realtime" &&
                r.kind !== "outsource" &&
                r.kind !== "snapshot"
              }
              onChange={(v: number) => setWarehouseId(v)}
            />
          </div>
          <LoadErrorAlert error={sourceError} onRetry={() => {
            setPoEdits({});
            setJgLines([{ key: 0, lineType: "normal", expectedQty: "", actualQty: "0", batchNo: "", prodDate: null }]);
            setJgLineKey(1);
            sourceRead.retry();
          }} subject="来源收货行" retrying={sourceRead.phase === "loading"} />
          {sourceRead.phase === "loading" ? <Typography.Text type="secondary">正在读取当前来源收货行，请稍候…</Typography.Text> : null}
          {!createLoading && (sourceType === "jg" ? jgProduct != null : poLines.length > 0) ? (
            <ScannerEntry
              help="扫码枪请保持光标在输入框；设备回车后系统按条码或 SKU 编码匹配当前来源单，并把数量累加到本次实收。委外扫码默认计入正常收货行。"
              onScan={handleReceiveScan}
            />
          ) : null}
          {sourceType === "jg" && jgProduct ? (
            <div>
              <div style={{ marginBottom: 4 }}>
                收货行——成品：{jgProduct.skuCode} {jgProduct.skuName}（JG 数量 {formatQty(jgProduct.qty)}）
              </div>
              <Table<JgCreateLine>
                rowKey="key"
                size="small"
                tableLayout="fixed"
                scroll={{ x: 810 }}
                columns={jgCreateColumns}
                dataSource={jgLines}
                pagination={false}
                footer={() => (
                  <Button
                    disabled={createLoading}
                    type="dashed"
                    size="small"
                    icon={<PlusOutlined />}
                    onClick={() => {
                      setJgLines((prev) => [
                        ...prev,
                        {
                          key: jgLineKey,
                          lineType: "normal",
                          expectedQty: "",
                          actualQty: "0",
                          batchNo: "",
                          prodDate: null,
                        },
                      ]);
                      setJgLineKey((k) => k + 1);
                    }}
                  >
                    添加收货行
                  </Button>
                )}
              />
            </div>
          ) : null}
          {sourceType === "po" && poLines.length > 0 ? (
            <div>
              <div style={{ marginBottom: 4 }}>收货行（按 PO 行预填；实收为 0 的行不提交）</div>
              <Table<PoCreateLine>
                rowKey="poLineId"
                size="small"
                tableLayout="fixed"
                scroll={{ x: 910 }}
                columns={poCreateColumns}
                dataSource={poLines}
                pagination={false}
              />
            </div>
          ) : null}
          <Input.TextArea
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
