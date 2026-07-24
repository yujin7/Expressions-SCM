"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Alert,
  App,
  Button,
  Checkbox,
  Descriptions,
  Drawer,
  Input,
  Modal,
  Popconfirm,
  Space,
  Spin,
  Table,
  Tabs,
  Timeline,
  Tooltip,
  Typography,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import { PlusOutlined, ReloadOutlined } from "@ant-design/icons";
import dayjs from "dayjs";
import ChainStrip from "@/components/ChainStrip";
import DocStatusTag from "@/components/DocStatusTag";
import { fetchJson, postJson } from "@/components/fetchJson";
import { formatQty } from "@/components/format";
import { hasAnyRole, useMe } from "@/components/useMe";

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

/** js_line 逐物料表（预览与详情共用）：超额损耗>0 标红；结余（负实际损耗）标黄 */
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
        Number(v) < 0 ? (
          <Tooltip title="负实际损耗=结余：该物料仍压在委外仓，审批前必须退料（TL）或财务短溢确认">
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
        Number(v) > 0 ? <Typography.Text type="danger">{formatQty(v)}</Typography.Text> : formatQty(v),
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
          Number(r.excessLoss) > 0 ? "js-line-excess" : Number(r.actualLoss) < 0 ? "js-line-surplus" : ""
        }
      />
    </>
  );
}

export default function JsClient() {
  const { message } = App.useApp();
  const me = useMe();
  const canCreate = hasAnyRole(me, "pmc");
  const canApprove = me != null && (me.roles.includes("admin") || (me.isApprover && me.roles.includes("finance")));

  const [rows, setRows] = useState<JsRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [status, setStatus] = useState("");
  const [q, setQ] = useState("");

  // ---- 详情 Drawer ----
  const [detailId, setDetailId] = useState<number | null>(null);
  const [detail, setDetail] = useState<JsDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectComment, setRejectComment] = useState("");
  // 结余（负实际损耗）409 → 短溢确认弹窗
  const [surplusOpen, setSurplusOpen] = useState(false);
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

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ q, page: String(page), pageSize: String(pageSize) });
      if (status) params.set("status", status);
      const res = await fetchJson<{ rows: JsRow[]; total: number }>(`/api/settlement/js?${params.toString()}`);
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
        setDetail(await fetchJson<JsDetail>(`/api/settlement/js/${id}`));
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

  const pickJg = async (jgId: number) => {
    setCreateStep(2);
    setPreviewLoading(true);
    setPreview(null);
    try {
      setPreview(await fetchJson<JsPreview>(`/api/settlement/js/preview?jgId=${jgId}`));
    } catch (e) {
      message.error((e as Error).message);
      setCreateStep(1);
    } finally {
      setPreviewLoading(false);
    }
  };

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

  // ---- 提交 / 审批（错误由调用方处理：approve 的 409 结余闸门需特殊分支） ----
  const post = async (path: string, body: unknown, successText: string) => {
    if (!detail) return false;
    setActionLoading(true);
    try {
      await postJson(`/api/settlement/js/${detail.id}/${path}`, body);
      message.success(successText);
      refresh();
      return true;
    } finally {
      setActionLoading(false);
    }
  };

  const doApprove = async (extra?: { acknowledgeSurplus: boolean; surplusNote: string }) => {
    if (!detail) return;
    try {
      await post(
        "approve",
        { action: "approve", version: detail.version, ...(extra ?? {}) },
        "审批已通过，损耗已核销",
      );
      setSurplusOpen(false);
      setSurplusAck(false);
      setSurplusNote("");
    } catch (e) {
      const msg = (e as Error).message;
      // 结余闸门 409：物料结余未退 → 弹出短溢确认
      if (msg.includes("acknowledgeSurplus") || msg.includes("结余")) {
        setSurplusMsg(msg);
        setSurplusOpen(true);
      } else {
        message.error(msg);
      }
    }
  };

  const surplusLines = detail?.lines.filter((l) => Number(l.actualLoss) < 0) ?? [];

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
  const canSubmitDetail =
    detail != null && (hasAnyRole(me, "pmc") || (me != null && detail.createdBy === me.id));
  const drawerActions = detail ? (
    <Space>
      {detail.status === "draft" && canSubmitDetail ? (
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
      {detail.status === "pending" && canApprove ? (
        <>
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
        委外结算单（JS）
      </Typography.Title>
      <Typography.Paragraph type="secondary">
        一 JG 一 JS；JG 收货关闭（或短关）后方可发起结算。审批（财务）通过即核销委外仓损耗。
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
          placeholder="搜索单号"
          style={{ width: 240 }}
          onSearch={(value) => {
            setQ(value.trim());
            setPage(1);
          }}
        />
        <Space>
          {canCreate ? (
            <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
              发起结算
            </Button>
          ) : null}
          <Button icon={<ReloadOutlined />} onClick={() => void load()}>
            刷新
          </Button>
        </Space>
      </Space>
      <Table<JsRow>
        rowKey="id"
        size="middle"
        columns={columns}
        dataSource={rows}
        loading={loading}
        scroll={{ x: 1100 }}
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
            <Descriptions column={3} size="small" style={{ marginBottom: 16 }}>
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
                  message="存在结余物料（负实际损耗）"
                  description={
                    <div>
                      {preview.surplusMaterials.map((s) => (
                        <div key={s.skuId}>
                          物料 {s.skuCode} 结余 {formatQty(s.surplus)}
                        </div>
                      ))}
                      <Typography.Text type="secondary">
                        审批前须先退料（TL）或由财务短溢确认，否则无法通过。
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
      <Drawer
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
        open={detailId != null}
        onClose={() => setDetailId(null)}
        width={960}
        loading={detailLoading}
        extra={drawerActions}
      >
        {detail ? (
          <div>
            <ChainStrip docType="js" id={detail.id} />
            <Descriptions column={3} size="small" bordered style={{ marginBottom: 16 }}>
              <Descriptions.Item label="JG 单号">{detail.jgDocNo}</Descriptions.Item>
              <Descriptions.Item label="关联工单">{detail.woDocNo}</Descriptions.Item>
              <Descriptions.Item label="加工厂">{detail.supplierName}</Descriptions.Item>
              <Descriptions.Item label="成品" span={3}>
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
              <Descriptions.Item label="制单时间" span={2}>
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
                message="存在结余物料（负实际损耗）——审批通过前须先退料（TL）或财务短溢确认"
                description={surplusLines
                  .map((l) => `物料 ${l.skuCode} 结余 ${formatQty(String(-Number(l.actualLoss)))}`)
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

      {/* ---- 结余短溢确认 Modal（approve 409 → acknowledgeSurplus 重试） ---- */}
      <Modal
        title="结余物料短溢确认"
        open={surplusOpen}
        okText="确认并通过审批"
        okButtonProps={{ danger: true, disabled: !surplusAck || !surplusNote.trim() }}
        cancelText="取消"
        confirmLoading={actionLoading}
        onCancel={() => {
          setSurplusOpen(false);
          setSurplusAck(false);
          setSurplusNote("");
        }}
        onOk={() => void doApprove({ acknowledgeSurplus: true, surplusNote: surplusNote.trim() })}
      >
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message="以下物料存在结余（负实际损耗），仍压在委外仓"
          description={
            <div>
              {surplusLines.length > 0
                ? surplusLines.map((l) => (
                    <div key={l.materialSkuId}>
                      物料 {l.skuCode} {l.skuName} 结余 {formatQty(String(-Number(l.actualLoss)))}
                    </div>
                  ))
                : null}
              <Typography.Text type="secondary">{surplusMsg}</Typography.Text>
            </div>
          }
        />
        <Typography.Paragraph type="secondary">
          建议优先退料（TL）使委外仓余额归零；确需短溢处理时，勾选确认并填写说明（审批留痕）。
        </Typography.Paragraph>
        <Checkbox checked={surplusAck} onChange={(e) => setSurplusAck(e.target.checked)}>
          确认短溢：知悉上述结余不退回，按短溢口径通过结算
        </Checkbox>
        <Input.TextArea
          rows={3}
          maxLength={500}
          style={{ marginTop: 8 }}
          placeholder="短溢说明（必填，留痕）"
          value={surplusNote}
          onChange={(e) => setSurplusNote(e.target.value)}
        />
      </Modal>
    </div>
  );
}
