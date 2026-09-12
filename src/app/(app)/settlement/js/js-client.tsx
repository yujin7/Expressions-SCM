"use client";

import { useLatestRead } from "@/components/useLatestRead";

import { useDocumentTarget } from "@/components/useDocumentTarget";
import { DOCUMENT_TRANSIENT_PARAMS } from "@/lib/document-links";
import { useDocumentRead } from "@/components/useDocumentRead";
import DocumentDrawer from "@/components/DocumentDrawer";

import SearchInput from "@/components/SearchInput";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Alert, App, Button, Checkbox, Descriptions, Input, Modal, Popconfirm, Space, Spin, Table, Tabs, Tooltip, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { PlusOutlined, ReloadOutlined } from "@ant-design/icons";
import dayjs from "dayjs";
import ChainStrip from "@/components/ChainStrip";
import DocStatusTag from "@/components/DocStatusTag";
import ListToolbar from "@/components/ListToolbar";
import { fetchJson, JsonRequestError, postJson } from "@/components/fetchJson";
import { compareDecimalValues } from "@/lib/decimal-sort";
import { formatQty } from "@/components/format";
import { useListState } from "@/components/useListState";
import { hasAnyRole, useMe } from "@/components/useMe";
import ApprovalTimeline from "@/components/ApprovalTimeline";

/** 敏感金额（R9）：非可见角色时后端 maskSensitive 已剥离键 → undefined → 显示 "—" */
const fmtMoney = (v: string | null | undefined): string => (v == null ? "—" : v);

interface JsRow {
  id: number;
  docNo: string;
  status: string;
  jgId: number;
  jgDocNo: string;
  woDocNo: string;
  supplierName: string;
  goodQty: string;
  concessionQty: string;
  spareQty: string;
  feePayable?: string;
  deductionTotal?: string;
  settleAmount?: string;
  createdByName: string | null;
  createdAt: string;
}

interface JsLine {
  id?: number;
  materialSkuId: number;
  skuCode: string;
  skuName: string;
  qtyPer?: string;
  issuedQty: string;
  returnedQty: string;
  allowedLossRatePct?: string;
  stdQty: string;
  allowedLoss: string;
  actualLoss: string;
  excessLoss: string;
  deductPrice?: string;
  deductAmount?: string;
}

interface DocApproval {
  approverName: string | null;
  action: "approve" | "reject";
  comment: string | null;
  createdAt: string;
}

interface JsDetail {
  actions?: { submit: boolean; refreshFee: boolean; approve: boolean; reject: boolean; reason: string };
  id: number;
  docNo: string;
  status: string;
  remark: string | null;
  version: number;
  jgId: number;
  jgDocNo: string;
  woDocNo: string;
  supplierName: string;
  productSkuCode: string;
  productSkuName: string;
  goodQty: string;
  concessionQty: string;
  spareQty: string;
  feePayable?: string;
  concessionPrice?: string;
  deductionTotal?: string;
  manualAdj?: string;
  settleAmount?: string;
  createdBy: number | null;
  createdByName: string | null;
  createdAt: string;
  lines: JsLine[];
  approvals: DocApproval[];
  deductPriceSource: "price_list_proxy";
}

interface JsPreview {
  jgId: number;
  jgDocNo: string;
  jgStatus: string;
  goodQty: string;
  concessionQty: string;
  spareQty: string;
  effectiveQty: string;
  feeSegments: { qty: string; feeRate?: string }[];
  concessionPrice?: string;
  feePayable?: string;
  deductionTotal?: string;
  manualAdj?: string;
  settleAmount?: string;
  lines: JsLine[];
  surplusMaterials: { skuId: number; skuCode: string; surplus: string }[];
  warnings: string[];
  deductPriceSource: "price_list_proxy";
}

interface JsBasisReview {
  id: number; docNo: string; version: number; status: string; basisToken: string; changed: boolean;
  saved: { goodQty: string; concessionQty: string; spareQty: string; feePayable: string; concessionPrice: string; deductionTotal: string; manualAdj: string; settleAmount: string; lines: JsLine[] };
  current: JsPreview;
}

interface JgPickRow {
  id: number;
  docNo: string;
  status: string;
  supplierName: string;
  productSkuCode: string;
  productSkuName: string;
  qty: string;
  createdAt: string;
}

const STATUS_TABS = [
  { key: "", label: "全部" },
  { key: "draft", label: "草稿" },
  { key: "pending", label: "待审批" },
  { key: "completed", label: "已完成" },
];

/** JG 可开结算的候选状态：completed/closed 可直接开；in_progress 提供「关闭收货」入口 */
const JG_PICK_STATUSES = ["in_progress", "completed", "closed"] as const;

/** D23 候选偏差——扣款价代理口径提示（deductPriceSource=price_list_proxy） */
function DeductPriceSourceAlert() {
  return (
    <Alert
      type="warning"
      showIcon
      style={{ marginBottom: 12 }}
      message="扣款单价为价格表代理口径（P1 成本引擎前）——财务确认见 D23"
      description="《01》§5 R5 规定扣款价=当月加权平均价；1.0 阶段以 price_lists 最新生效价代理，成本台账（P1）上线后自动切换。"
    />
  );
}

/** js_line 逐物料表（预览与详情共用）：超额损耗>0 标红；用量负差标黄，不推断实物结余 */
function JsLinesTable({ lines, showPreviewCols }: { lines: JsLine[]; showPreviewCols: boolean }) {
  const columns: ColumnsType<JsLine> = [
    {
      title: "物料",
      key: "material",
      width: 180,
      render: (_, r) => `${r.skuCode} ${r.skuName}`,
    },
    {
      title: "累计发料",
      dataIndex: "issuedQty",
      width: 90,
      align: "right",
      render: (v: string) => formatQty(v),
    },
    {
      title: "累计退料",
      dataIndex: "returnedQty",
      width: 90,
      align: "right",
      render: (v: string) => formatQty(v),
    },
    {
      title: "净标准用量",
      dataIndex: "stdQty",
      width: 100,
      align: "right",
      render: (v: string) => formatQty(v),
    },
    {
      title: showPreviewCols ? "允许损耗（率）" : "允许损耗",
      dataIndex: "allowedLoss",
      width: 120,
      align: "right",
      render: (v: string, r) =>
        showPreviewCols && r.allowedLossRatePct != null
          ? `${formatQty(v)}（${formatQty(r.allowedLossRatePct)}%）`
          : formatQty(v),
    },
    {
      title: "实际损耗",
      dataIndex: "actualLoss",
      width: 100,
      align: "right",
      render: (v: string) =>
        compareDecimalValues(v, "0") < 0 ? (
          <Tooltip title="净发料（发料−退料）低于标准用量；可能是节约或记录/单位/BOM差异，不等于实物余料。请先核对，不能用继续退料消除负差。">
            <Typography.Text type="warning">{formatQty(v)}</Typography.Text>
          </Tooltip>
        ) : (
          formatQty(v)
        ),
    },
    {
      title: "超额损耗",
      dataIndex: "excessLoss",
      width: 100,
      align: "right",
      render: (v: string) =>
        compareDecimalValues(v, "0") > 0 ? <Typography.Text type="danger">{formatQty(v)}</Typography.Text> : formatQty(v),
    },
    {
      title: "扣款单价",
      dataIndex: "deductPrice",
      width: 100,
      align: "right",
      render: (v: string | undefined) => fmtMoney(v),
    },
    {
      title: "扣款额",
      dataIndex: "deductAmount",
      width: 100,
      align: "right",
      render: (v: string | undefined) => fmtMoney(v),
    },
  ];
  return (
    <>
      <style>{`
        .js-line-excess > td { background: #fff1f0 !important; }
        .js-line-surplus > td { background: #fffbe6 !important; }
      `}</style>
      <Table<JsLine>
        rowKey={(r) => r.id ?? r.materialSkuId}
        size="small"
        columns={columns}
        dataSource={lines}
        pagination={false}
        scroll={{ x: 900 }}
        rowClassName={(r) =>
          compareDecimalValues(r.excessLoss, "0") > 0 ? "js-line-excess" : compareDecimalValues(r.actualLoss, "0") < 0 ? "js-line-surplus" : ""
        }
      />
    </>
  );
}

export default function JsClient() {
  const { message } = App.useApp();
  const searchParams = useSearchParams();
  const me = useMe();
  const canCreate = hasAnyRole(me, "pmc");

  const [rows, setRows] = useState<JsRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  // 列表页状态平台（E6-P1）：筛选/分页进 URL，密度与已保存视图存本地
  const listState = useListState({ transientParams: DOCUMENT_TRANSIENT_PARAMS, key: "js", defaults: { q: "", status: "" }, defaultPageSize: 20 });
  const { filters, page, pageSize } = listState;
  const q = filters.q;
  const status = filters.status;

  // ---- 详情 Drawer ----
  const documentSelection = useDocumentTarget();
  const { id: detailId, setId: setDetailId } = documentSelection;
  useEffect(() => { setRejectOpen(false); setSurplusTarget(null); setSurplusAck(false); setSurplusNote(""); }, [detailId]);
  const detailRead = useDocumentRead<JsDetail>(detailId == null ? null : `/api/settlement/js/${detailId}`);
  const detail = detailRead.data;
  const detailLoading = detailRead.phase === "loading";
  const loadDetail = detailRead.retry;
  const [actionLoading, setActionLoading] = useState(false);
  const actionLock = useRef(false);
  const [basisOpen, setBasisOpen] = useState(false);
  const [basisNote, setBasisNote] = useState("");
  const basisRead = useDocumentRead<JsBasisReview>(basisOpen && detailId != null ? `/api/settlement/js/${detailId}/basis` : null);
  const basis = basisRead.data;
  useEffect(() => { setBasisOpen(false); setBasisNote(""); }, [detailId]);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectComment, setRejectComment] = useState("");
  // Historical API names retained; acknowledgement is bound to the challenged document/version.
  const [surplusTarget, setSurplusTarget] = useState<{ id: number; version: number } | null>(null);
  const [surplusMsg, setSurplusMsg] = useState("");
  const [surplusAck, setSurplusAck] = useState(false);
  const [surplusNote, setSurplusNote] = useState("");

  // ---- 发起结算 Modal ----
  const [createOpen, setCreateOpen] = useState(false);
  const [createStep, setCreateStep] = useState<1 | 2>(1);
  const [jgRows, setJgRows] = useState<JgPickRow[]>([]);
  const [jgLoading, setJgLoading] = useState(false);
  const [closingJgId, setClosingJgId] = useState<number | null>(null);
  const [preview, setPreview] = useState<JsPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [manualAdj, setManualAdj] = useState("0");
  const [manualAdjNote, setManualAdjNote] = useState("");
  const [createRemark, setCreateRemark] = useState("");
  const [creating, setCreating] = useState(false);
  const contextualOpenHandled = useRef(false);

  const beginLoadRead = useLatestRead();
  const load = useCallback(async () => {
    const readRequest = beginLoadRead();
    setLoading(true);
    try {
      const params = new URLSearchParams({ q, page: String(page), pageSize: String(pageSize) });
      if (status) params.set("status", status);
      const res = await fetchJson<{ rows: JsRow[]; total: number }>(`/api/settlement/js?${params.toString()}`, { signal: readRequest.signal });
      if (!readRequest.isCurrent()) return;
      setRows(res.rows);
      setTotal(res.total);
    } catch (e) {
      if (!readRequest.isCurrent()) return;
      message.error((e as Error).message);
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

  // ---- 发起结算：step1 JG 选择 ----
  const loadJgs = useCallback(async () => {
    setJgLoading(true);
    try {
      const lists = await Promise.all(
        JG_PICK_STATUSES.map((s) =>
          fetchJson<{ rows: JgPickRow[] }>(`/api/outsource/jg?status=${s}&pageSize=200`),
        ),
      );
      setJgRows(lists.flatMap((l) => l.rows));
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setJgLoading(false);
    }
  }, [message]);

  const openCreate = () => {
    setCreateOpen(true);
    setCreateStep(1);
    setPreview(null);
    setManualAdj("0");
    setManualAdjNote("");
    setCreateRemark("");
    void loadJgs();
  };

  /** in_progress JG → 关闭收货（版本号取详情，列表行无 version） */
  const closeJgReceiving = async (jgId: number) => {
    setClosingJgId(jgId);
    try {
      const jg = await fetchJson<{ version: number }>(`/api/outsource/jg/${jgId}`);
      await postJson("/api/settlement/jg-close", { jgId, version: jg.version });
      message.success("收货已关闭，可发起结算");
      void loadJgs();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setClosingJgId(null);
    }
  };

  const beginPickJgRead = useLatestRead();
  const pickJg = useCallback(async (jgId: number) => {
    const readRequest = beginPickJgRead();
    setCreateStep(2);
    setPreviewLoading(true);
    setPreview(null);
    try {
      const result = await fetchJson<JsPreview>(`/api/settlement/js/preview?jgId=${jgId}`, { signal: readRequest.signal });
      if (!readRequest.isCurrent()) return;
      setPreview(result);
    } catch (e) {
      if (!readRequest.isCurrent()) return;
      message.error((e as Error).message);
      setCreateStep(1);
    } finally {
      if (readRequest.isCurrent()) setPreviewLoading(false);
    }
  }, [beginPickJgRead, message]);

  useEffect(() => {
    const jgId = Number(searchParams.get("jgId"));
    if (!canCreate || contextualOpenHandled.current || !Number.isInteger(jgId) || jgId <= 0) return;
    contextualOpenHandled.current = true;
    setCreateOpen(true);
    setManualAdj("0");
    setManualAdjNote("");
    setCreateRemark("");
    void pickJg(jgId);
  }, [canCreate, pickJg, searchParams]);

  const submitCreate = async () => {
    if (!preview) return;
    const adj = manualAdj.trim() || "0";
    if (!/^-?\d+(\.\d+)?$/.test(adj)) {
      message.warning("手工调整必须是十进制数字");
      return;
    }
    if (Number(adj) !== 0 && !manualAdjNote.trim()) {
      message.warning("手工调整不为 0 时必须填写调整说明（留痕）");
      return;
    }
    setCreating(true);
    try {
      const doc = await postJson<{ id: number; docNo: string }>("/api/settlement/js", {
        jgId: preview.jgId,
        manualAdj: adj,
        manualAdjNote: manualAdjNote.trim() || undefined,
        remark: createRemark.trim() || undefined,
      });
      message.success(`结算单 ${doc.docNo} 已创建`);
      setCreateOpen(false);
      void load();
      setDetailId(doc.id);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setCreating(false);
    }
  };

  // ---- 提交 / 审批（仅明确的409机器码可触发负差确认） ----
  const post = async (path: string, body: unknown, successText: string) => {
    if (!detail || actionLock.current) return false;
    actionLock.current = true;
    setActionLoading(true);
    try {
      await postJson(`/api/settlement/js/${detail.id}/${path}`, body);
      message.success(successText);
      refresh();
      return true;
    } finally {
      actionLock.current = false;
      setActionLoading(false);
    }
  };

  const doApprove = async (extra?: { acknowledgeSurplus: boolean; surplusNote: string }) => {
    if (!detail) return;
    const target = { id: detail.id, version: detail.version };
    if (extra && (surplusTarget?.id !== target.id || surplusTarget.version !== target.version || !detail.actions?.approve)) {
      message.error("单据或处理资格已变化，请重新核对后审批。");
      return;
    }
    try {
      const approved = await post(
        "approve",
        { action: "approve", version: detail.version, ...(extra ?? {}) },
        "审批已通过，损耗已核销",
      );
      if (!approved) return;
      setSurplusTarget(null);
      setSurplusAck(false);
      setSurplusNote("");
    } catch (e) {
      const msg = (e as Error).message;
      // Do not interpret arbitrary error prose as permission to send an acknowledgement.
      if (e instanceof JsonRequestError && e.status === 409 && e.code === "SURPLUS_UNACKED") {
        setSurplusMsg(msg);
        setSurplusAck(false);
        setSurplusNote("");
        setSurplusTarget(target);
      } else {
        message.error(msg);
      }
    }
  };

  const surplusLines = detail?.lines.filter((l) => compareDecimalValues(l.actualLoss, "0") < 0) ?? [];
  const surplusCurrent = detail != null && detail.id === surplusTarget?.id && detail.version === surplusTarget.version && detail.actions?.approve === true;

  // ---- 列表列 ----
  const columns: ColumnsType<JsRow> = [
    {
      title: "单号",
      dataIndex: "docNo",
      width: 150,
      render: (v: string, r) => <Typography.Link onClick={() => setDetailId(r.id)}>{v}</Typography.Link>,
    },
    { title: "JG 单号", dataIndex: "jgDocNo", width: 150 },
    { title: "加工厂", dataIndex: "supplierName", width: 140 },
    { title: "合格数", dataIndex: "goodQty", width: 90, align: "right", render: (v: string) => formatQty(v) },
    { title: "让步", dataIndex: "concessionQty", width: 80, align: "right", render: (v: string) => formatQty(v) },
    { title: "备品", dataIndex: "spareQty", width: 80, align: "right", render: (v: string) => formatQty(v) },
    {
      title: "结算金额",
      dataIndex: "settleAmount",
      width: 110,
      align: "right",
      render: (v: string | undefined) => fmtMoney(v),
    },
    { title: "状态", dataIndex: "status", width: 100, render: (v: string) => <DocStatusTag status={v} /> },
    {
      title: "创建时间",
      dataIndex: "createdAt",
      width: 150,
      render: (v: string) => dayjs(v).format("YYYY-MM-DD HH:mm"),
    },
    {
      title: "操作",
      key: "_actions",
      width: 70,
      render: (_, r) => (
        <Button type="link" size="small" onClick={() => setDetailId(r.id)}>
          查看
        </Button>
      ),
    },
  ];

  const jgColumns: ColumnsType<JgPickRow> = [
    { title: "JG 单号", dataIndex: "docNo", width: 150 },
    { title: "成品", key: "product", render: (_, r) => `${r.productSkuCode} ${r.productSkuName}` },
    { title: "数量", dataIndex: "qty", width: 90, align: "right", render: (v: string) => formatQty(v) },
    { title: "加工厂", dataIndex: "supplierName", width: 130 },
    { title: "状态", dataIndex: "status", width: 100, render: (v: string) => <DocStatusTag status={v} /> },
    {
      title: "操作",
      key: "_actions",
      width: 140,
      render: (_, r) =>
        r.status === "in_progress" ? (
          <Popconfirm
            title="确认该 JG 收货已全部完成？"
            okText="关闭收货"
            cancelText="取消"
            onConfirm={() => void closeJgReceiving(r.id)}
          >
            <Button size="small" loading={closingJgId === r.id}>
              关闭收货
            </Button>
          </Popconfirm>
        ) : (
          <Button type="primary" size="small" onClick={() => void pickJg(r.id)}>
            发起结算
          </Button>
        ),
    },
  ];

  const feeSegColumns: ColumnsType<{ qty: string; feeRate?: string }> = [
    { title: "时段", key: "_seg", width: 80, render: (_, __, idx) => `第 ${idx + 1} 段` },
    { title: "数量", dataIndex: "qty", align: "right", render: (v: string) => formatQty(v) },
    { title: "单价", dataIndex: "feeRate", align: "right", render: (v: string | undefined) => fmtMoney(v) },
    {
      title: "小计",
      key: "_subtotal",
      align: "right",
      render: (_, r) => (r.feeRate == null ? "—" : (Number(r.qty) * Number(r.feeRate)).toFixed(2)),
    },
  ];

  // ---- 详情操作按钮 ----
  const drawerActions = detail ? (
    <Space wrap>
      {hasAnyRole(me, "purchasing", "pmc", "finance") ? (
        <Button disabled={actionLoading} onClick={() => { setBasisNote(""); setBasisOpen(true); }}>核对结算依据</Button>
      ) : null}
      {detail.actions?.refreshFee ? (
        <Popconfirm title="按当前已批准改价更新此草稿的加工费？"
          description="仅更新加工费与结算合计；收货数量必须一致，物料扣款和手工调整保持不变。"
          okText="更新加工费" cancelText="取消"
          onConfirm={() => void post("refresh-fee", { version: detail.version }, "加工费已更新，请核对金额后提交财务审批")
            .catch(e => message.error((e as Error).message))}>
          <Button disabled={actionLoading}>更新加工费</Button>
        </Popconfirm>
      ) : null}
      {detail.actions?.submit ? (
        <Popconfirm
          title="确认提交审批（财务）？"
          okText="提交"
          cancelText="取消"
          onConfirm={() =>
            void post("submit", { version: detail.version }, "已提交审批").catch((e) =>
              message.error((e as Error).message),
            )
          }
        >
          <Button type="primary" loading={actionLoading}>
            提交
          </Button>
        </Popconfirm>
      ) : null}
      {detail.actions?.approve ? (
          <Popconfirm
            title="确认审批通过？通过后立即核销委外仓损耗"
            okText="通过"
            cancelText="取消"
            onConfirm={() => void doApprove()}
          >
            <Button type="primary" loading={actionLoading}>
              审批通过
            </Button>
          </Popconfirm>
      ) : null}
      {detail.actions?.reject ? (
          <Button danger loading={actionLoading} onClick={() => setRejectOpen(true)}>
            驳回
          </Button>
      ) : null}
    </Space>
  ) : null;

  return (
    <div>
      <Typography.Title level={4} style={{ marginTop: 0 }}>
        委外结算单（JS）
      </Typography.Title>
      <Typography.Paragraph type="secondary">
        一 JG 一 JS；JG 收货关闭（或短关）后方可发起结算。审批（财务）通过即核销委外仓损耗。
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
            {canCreate ? (
              <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
                发起结算
              </Button>
            ) : null}
          </>
        }
        extra={
          <SearchInput
            key={q}
            allowClear
            defaultValue={q}
            placeholder="搜索单号"
            style={{ width: 240 }}
            onSearch={(value) => listState.setFilter({ q: value.trim() })}
          />
        }
      />
      <Table<JsRow>
        rowKey="id"
        size={listState.tableSize}
        columns={columns}
        dataSource={rows}
        loading={loading}
        scroll={{ x: 1100 }}
        pagination={listState.paginationProps({ total: total })}
      />

      {/* ---- 发起结算 Modal ---- */}
      <Modal
        title={createStep === 1 ? "发起结算 — 选择加工通知单（JG）" : `结算预览 — ${preview?.jgDocNo ?? ""}`}
        open={createOpen}
        width={createStep === 1 ? 760 : 980}
        onCancel={() => setCreateOpen(false)}
        footer={
          createStep === 1
            ? [
                <Button key="cancel" onClick={() => setCreateOpen(false)}>
                  取消
                </Button>,
              ]
            : [
                <Button key="back" onClick={() => setCreateStep(1)}>
                  上一步
                </Button>,
                <Button key="cancel" onClick={() => setCreateOpen(false)}>
                  取消
                </Button>,
                <Button key="ok" type="primary" loading={creating} disabled={!preview} onClick={() => void submitCreate()}>
                  创建结算单
                </Button>,
              ]
        }
      >
        {createStep === 1 ? (
          <>
            <Typography.Paragraph type="secondary" style={{ marginTop: 0 }}>
              仅收货关闭（已完成/已关闭）的 JG 可发起结算；执行中的 JG 请先确认收货闭环后「关闭收货」。
            </Typography.Paragraph>
            <Table<JgPickRow>
              rowKey="id"
              size="small"
              columns={jgColumns}
              dataSource={jgRows}
              loading={jgLoading}
              pagination={{ pageSize: 8, showTotal: (t) => `共 ${t} 条` }}
            />
          </>
        ) : previewLoading ? (
          <div style={{ textAlign: "center", padding: 48 }}>
            <Spin tip="正在计算结算预览…" />
          </div>
        ) : preview ? (
          <div>
            {/* 数量区 */}
            <Descriptions column={4} size="small" bordered style={{ marginBottom: 12 }}>
              <Descriptions.Item label="合格数">{formatQty(preview.goodQty)}</Descriptions.Item>
              <Descriptions.Item label="让步数">{formatQty(preview.concessionQty)}</Descriptions.Item>
              <Descriptions.Item label="备品数">{formatQty(preview.spareQty)}</Descriptions.Item>
              <Descriptions.Item label="有效结算数">{formatQty(preview.effectiveQty)}</Descriptions.Item>
            </Descriptions>

            {/* 加工费区 */}
            <Typography.Title level={5} style={{ marginTop: 0 }}>
              加工费（按收货时点分段计价）
            </Typography.Title>
            <Table
              rowKey={(_, idx) => idx ?? 0}
              size="small"
              columns={feeSegColumns}
              dataSource={preview.feeSegments}
              pagination={false}
              style={{ marginBottom: 8 }}
            />
            <Descriptions column={{ xs: 1, sm: 3 }} size="small" style={{ marginBottom: 16 }}>
              <Descriptions.Item label="让步单价">{fmtMoney(preview.concessionPrice)}</Descriptions.Item>
              <Descriptions.Item label="应付加工费">{fmtMoney(preview.feePayable)}</Descriptions.Item>
              <Descriptions.Item label="扣款合计">{fmtMoney(preview.deductionTotal)}</Descriptions.Item>
            </Descriptions>

            {/* 逐物料表 */}
            <Typography.Title level={5}>物料损耗与扣款（R5 逐物料，禁止跨物料轧差）</Typography.Title>
            <JsLinesTable lines={preview.lines} showPreviewCols />

            {/* 警告区 */}
            <div style={{ marginTop: 16 }}>
              <DeductPriceSourceAlert />
              {preview.surplusMaterials.length > 0 ? (
                <Alert
                  type="warning"
                  showIcon
                  style={{ marginBottom: 12 }}
                  message="净发料低于标准用量，需核对差异"
                  description={
                    <div>
                      {preview.surplusMaterials.map((s) => (
                        <div key={s.skuId}>
                          物料 {s.skuCode} 低于标准 {formatQty(s.surplus)}
                        </div>
                      ))}
                      <Typography.Text type="secondary">
                        先核对发料、退料、产出、单位和 BOM；负差不等于实物余料，继续退料会扩大差异。确认无误后由财务填写说明审批。
                      </Typography.Text>
                    </div>
                  }
                />
              ) : null}
              {preview.warnings.map((w, i) => (
                <Alert key={i} type="warning" showIcon style={{ marginBottom: 8 }} message={w} />
              ))}
            </div>

            {/* 手工调整 */}
            <Typography.Title level={5}>手工调整</Typography.Title>
            <Space direction="vertical" style={{ width: "100%" }}>
              <Space>
                <span>调整金额（可正可负）：</span>
                <Input
                  style={{ width: 160 }}
                  value={manualAdj}
                  onChange={(e) => setManualAdj(e.target.value)}
                  placeholder="0"
                />
                <Typography.Text type="secondary">
                  预计结算金额 = {fmtMoney(preview.settleAmount)}（未含本次调整）
                </Typography.Text>
              </Space>
              <Input.TextArea
                rows={2}
                maxLength={500}
                placeholder="调整说明（调整不为 0 时必填，审批留痕）"
                value={manualAdjNote}
                onChange={(e) => setManualAdjNote(e.target.value)}
              />
              <Input.TextArea
                rows={2}
                maxLength={500}
                placeholder="备注（可选）"
                value={createRemark}
                onChange={(e) => setCreateRemark(e.target.value)}
              />
            </Space>
          </div>
        ) : null}
      </Modal>

      {/* ---- 详情 Drawer ---- */}
      <DocumentDrawer
        key={detailId ?? "invalid-document"}
        title={
          detail ? (
            <Space>
              <span>{detail.docNo}</span>
              <DocStatusTag status={detail.status} />
            </Space>
          ) : (
            "结算单详情"
          )
        }
        open={documentSelection.present}
        readError={documentSelection.error ?? detailRead.error}
        onRetry={detailId != null ? detailRead.retry : undefined}
        onClose={() => { if (!actionLock.current) setDetailId(null); }}
        maskClosable={!actionLoading}
        keyboard={!actionLoading}
        width={960}
        loading={detailLoading}
        extra={drawerActions}
      >
        {detail ? (
          <div>
            <ChainStrip docType="js" id={detail.id} />
            <Alert type="info" showIcon style={{ marginBottom: 12 }}
              message={detail.actions?.reason ?? "操作资格未加载，请刷新详情后重试。"}
              description={detail.status === "draft" || detail.status === "pending"
                ? "此处为已保存金额，不随改价静默变化。待审批单须由有资格的审批人驳回，再由PMC更新加工费并重新提交。" : undefined} />
            <Descriptions column={{ xs: 1, sm: 3 }} size="small" bordered style={{ marginBottom: 16 }}>
              <Descriptions.Item label="JG 单号">{detail.jgDocNo}</Descriptions.Item>
              <Descriptions.Item label="关联工单">{detail.woDocNo}</Descriptions.Item>
              <Descriptions.Item label="加工厂">{detail.supplierName}</Descriptions.Item>
              <Descriptions.Item label="成品" span={{ xs: 1, sm: 3 }}>
                {detail.productSkuCode} {detail.productSkuName}
              </Descriptions.Item>
              <Descriptions.Item label="合格数">{formatQty(detail.goodQty)}</Descriptions.Item>
              <Descriptions.Item label="让步数">{formatQty(detail.concessionQty)}</Descriptions.Item>
              <Descriptions.Item label="备品数">{formatQty(detail.spareQty)}</Descriptions.Item>
              <Descriptions.Item label="应付加工费">{fmtMoney(detail.feePayable)}</Descriptions.Item>
              <Descriptions.Item label="让步单价">{fmtMoney(detail.concessionPrice)}</Descriptions.Item>
              <Descriptions.Item label="扣款合计">{fmtMoney(detail.deductionTotal)}</Descriptions.Item>
              <Descriptions.Item label="手工调整">{fmtMoney(detail.manualAdj)}</Descriptions.Item>
              <Descriptions.Item label="结算金额">
                <Typography.Text strong>{fmtMoney(detail.settleAmount)}</Typography.Text>
              </Descriptions.Item>
              <Descriptions.Item label="制单人">{detail.createdByName ?? "—"}</Descriptions.Item>
              <Descriptions.Item label="制单时间" span={{ xs: 1, sm: 2 }}>
                {dayjs(detail.createdAt).format("YYYY-MM-DD HH:mm")}
              </Descriptions.Item>
              <Descriptions.Item label="备注">{detail.remark ?? "—"}</Descriptions.Item>
            </Descriptions>

            <DeductPriceSourceAlert />
            {detail.status === "pending" && surplusLines.length > 0 ? (
              <Alert
                type="warning"
                showIcon
                style={{ marginBottom: 12 }}
                message="用量负差待核对：净发料低于标准用量，不等于可退余料"
                description={surplusLines
                  .map((l) => `物料 ${l.skuCode} 低于标准 ${formatQty(l.actualLoss.replace(/^-/, ""))}`)
                  .join("；")}
              />
            ) : null}

            <Typography.Title level={5}>物料损耗与扣款</Typography.Title>
            <JsLinesTable lines={detail.lines} showPreviewCols={false} />

            {detail.approvals.length > 0 ? (
              <>
                <Typography.Title level={5} style={{ marginTop: 24 }}>
                  审批记录
                </Typography.Title>
                <ApprovalTimeline items={detail.approvals} />
              </>
            ) : null}
          </div>
        ) : null}
      </DocumentDrawer>

      <Modal title={basis ? `核对结算依据 · ${basis.docNo}` : "核对结算依据"}
        open={basisOpen} width={1100} destroyOnHidden
        onCancel={() => { if (!actionLock.current) setBasisOpen(false); }}
        maskClosable={!actionLoading} keyboard={!actionLoading}
        footer={<Space wrap>
          <Button disabled={actionLoading} onClick={basisRead.retry}>重新读取</Button>
          <Button disabled={actionLoading} onClick={() => setBasisOpen(false)}>关闭</Button>
          {basis?.status === "draft" && hasAnyRole(me, "pmc") ? <Button type="primary" loading={actionLoading}
            disabled={!basis.changed || !basisNote.trim() || basisRead.phase !== "success"}
            onClick={() => {
              if (!basis || basis.id !== detailId) return;
              void post("basis", { version: basis.version, basisToken: basis.basisToken, note: basisNote.trim() }, "草稿依据已更新，请核对后重新提交审批")
                .then(ok => { if (ok) { setBasisOpen(false); setBasisNote(""); } })
                .catch(e => { message.error((e as Error).message); basisRead.retry(); });
            }}>按已核对依据更新草稿</Button> : null}
        </Space>}>
        {basisRead.phase === "loading" ? <div role="status"><Spin /> 正在读取当前依据…</div> : null}
        {basisRead.error ? <Alert type="error" showIcon message="结算依据读取失败" description={basisRead.error} /> : null}
        {basis ? <>
          <Alert style={{ marginBottom: 12 }} type={basis.changed ? "warning" : "info"} showIcon
            message={basis.changed ? "当前依据与已保存结算不同" : "当前计算与已保存结算一致"}
            description={basis.status === "draft"
              ? "核对逐物料、收货数量和金额后，由PMC填写说明更新草稿；手工调整保持原值，不直接过账。核对后来源再次变化会拒绝更新。"
              : basis.status === "pending" ? "待审批单须先由合格审批人驳回，再由PMC核对并更新草稿。不要按旧依据批准。"
                : "历史结算已冻结，仅供对照；退料只更新实物库存，金额差异请交财务处理，不自动重算已结算金额。"} />
          <Table size="small" pagination={false} rowKey="key" tableLayout="fixed" aria-label="结算依据汇总对照"
            columns={[{ title: "指标", dataIndex: "label", width: "40%" },
              { title: "已保存", dataIndex: "saved", width: "30%", align: "right", render: (value: string) => <span style={{ overflowWrap: "anywhere" }}>{value}</span> },
              { title: "当前依据", dataIndex: "current", width: "30%", align: "right", render: (value: string) => <span style={{ overflowWrap: "anywhere" }}>{value}</span> }]}
            dataSource={([
              ["goodQty", "合格数"], ["concessionQty", "让步数"], ["spareQty", "备品数"], ["feePayable", "应付加工费"], ["concessionPrice", "让步单价"],
              ["deductionTotal", "扣款合计"], ["manualAdj", "手工调整（保留）"], ["settleAmount", "结算金额"],
            ] as const).map(([key, label]) => ({ key, label,
              saved: key.endsWith("Qty") ? formatQty(basis.saved[key]) : basis.saved[key],
              current: key.endsWith("Qty") ? formatQty(basis.current[key]) : basis.current[key] ?? "—" }))} />
          <Typography.Title level={5}>已保存的逐物料依据</Typography.Title>
          <JsLinesTable lines={basis.saved.lines} showPreviewCols={false} />
          <Typography.Title level={5}>当前逐物料依据（尚未写入）</Typography.Title>
          <JsLinesTable lines={basis.current.lines} showPreviewCols />
          {basis.current.warnings.map((warning, i) => <Alert key={i} type="warning" showIcon style={{ marginTop: 8 }} message={warning} />)}
          {basis.status === "draft" && hasAnyRole(me, "pmc") ? <Input.TextArea aria-label="依据更新说明" rows={2} maxLength={500}
            style={{ marginTop: 12 }} placeholder="依据更新说明（必填，例如已核对退料单及损耗扣款变化）"
            disabled={actionLoading} value={basisNote} onChange={e => setBasisNote(e.target.value)} /> : null}
        </> : null}
      </Modal>

      {/* ---- 驳回 Modal ---- */}
      <Modal
        title="驳回结算单"
        open={rejectOpen}
        okText="确认驳回"
        okButtonProps={{ danger: true }}
        cancelText="取消"
        confirmLoading={actionLoading}
        onCancel={() => setRejectOpen(false)}
        onOk={() =>
          void post(
            "approve",
            { action: "reject", comment: rejectComment.trim() || undefined, version: detail?.version ?? 0 },
            "已驳回",
          )
            .then((ok) => {
              if (ok) {
                setRejectOpen(false);
                setRejectComment("");
              }
            })
            .catch((e) => message.error((e as Error).message))
        }
      >
        <Input.TextArea
          rows={3}
          maxLength={500}
          placeholder="驳回意见（可选）"
          value={rejectComment}
          onChange={(e) => setRejectComment(e.target.value)}
        />
      </Modal>

      {/* ---- 用量负差确认；历史acknowledgeSurplus字段保留，绑定当前单据版本 ---- */}
      <Modal
        title="用量负差核对确认"
        open={surplusCurrent}
        okText="确认并通过审批"
        okButtonProps={{ danger: true, disabled: !surplusCurrent || !surplusAck || !surplusNote.trim() }}
        cancelText="取消"
        confirmLoading={actionLoading}
        onCancel={() => {
          setSurplusTarget(null);
          setSurplusAck(false);
          setSurplusNote("");
        }}
        onOk={() => void doApprove({ acknowledgeSurplus: true, surplusNote: surplusNote.trim() })}
      >
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message="以下物料净发料低于标准用量，不能据此判定仓库实物结余"
          description={
            <div>
              {surplusLines.length > 0
                ? surplusLines.map((l) => (
                    <div key={l.materialSkuId}>
                      物料 {l.skuCode} {l.skuName} 低于标准 {formatQty(l.actualLoss.replace(/^-/, ""))}
                    </div>
                  ))
                : null}
              <Typography.Text type="secondary">{surplusMsg}</Typography.Text>
            </div>
          }
        />
        <Typography.Paragraph type="secondary">
          请核对发料、退料、产出、单位与 BOM，并记录差异原因（例如实际节约或漏记）。继续退料会扩大负差；有记录错误时先驳回纠正。确认只允许按已核对依据结算，不会补入库存或证明账实相符。
        </Typography.Paragraph>
        <Checkbox checked={surplusAck} onChange={(e) => setSurplusAck(e.target.checked)}>
          已核对差异原因及结算依据；知悉确认不会自动补库存或纠正原单
        </Checkbox>
        <Input.TextArea
          rows={3}
          maxLength={500}
          style={{ marginTop: 8 }}
          placeholder="差异原因及核对依据（必填，留痕）"
          value={surplusNote}
          onChange={(e) => setSurplusNote(e.target.value)}
        />
      </Modal>
    </div>
  );
}
