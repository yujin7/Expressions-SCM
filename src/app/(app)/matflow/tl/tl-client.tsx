"use client";

import { useLatestRead } from "@/components/useLatestRead";

import { useDocumentTarget } from "@/components/useDocumentTarget";
import { DOCUMENT_TRANSIENT_PARAMS } from "@/lib/document-links";
import { useDocumentRead } from "@/components/useDocumentRead";
import DocumentDrawer from "@/components/DocumentDrawer";

import SearchInput from "@/components/SearchInput";

import { useCallback, useEffect, useRef, useState } from "react";
import { App, Alert, Button, Descriptions, Input, InputNumber, Modal, Popconfirm, Select, Space, Table, Tabs, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { PlusOutlined, ReloadOutlined } from "@ant-design/icons";
import dayjs from "dayjs";
import ChainStrip from "@/components/ChainStrip";
import DocStatusTag from "@/components/DocStatusTag";
import ListToolbar from "@/components/ListToolbar";
import RemoteSelect from "@/components/RemoteSelect";
import { useJgMaterialLines } from "@/components/useJgMaterialLines";
import { fetchJson, postJson } from "@/components/fetchJson";
import { formatQty } from "@/components/format";
import { useListState } from "@/components/useListState";
import ApprovalTimeline from "@/components/ApprovalTimeline";

// ---------- 客户端十进制比较（仅提交前过滤 0 行；非负字符串，禁 float） ----------

const DEC_RE = /^\d+(\.\d+)?$/;

function decCmp(a: string, b: string): number {
  const [ai, af = ""] = a.split(".");
  const [bi, bf = ""] = b.split(".");
  const scale = Math.max(af.length, bf.length);
  const av = BigInt((ai || "0") + af.padEnd(scale, "0"));
  const bv = BigInt((bi || "0") + bf.padEnd(scale, "0"));
  return av === bv ? 0 : av > bv ? 1 : -1;
}

// ---------- 接口形状（对照 src/server/modules/matflow/tl.ts） ----------

const REASON_LABELS: Record<string, string> = {
  surplus_return: "剩料退回",
  defect_exchange: "不合格料退换",
};

type TlReason = "surplus_return" | "defect_exchange";

interface TlRow {
  id: number;
  docNo: string;
  status: string;
  jgId: number;
  jgDocNo: string;
  fromWarehouseName: string;
  toWarehouseName: string;
  lineCount: number;
  createdByName: string | null;
  createdAt: string;
}

interface TlLine {
  id: number;
  skuId: number;
  skuCode: string;
  skuName: string;
  baseUom: string;
  qty: string;
  reason: string;
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

interface TlDetail {
  id: number;
  docNo: string;
  status: string;
  remark: string | null;
  version: number;
  jgId: number;
  jgDocNo: string;
  fromWarehouseName: string;
  toWarehouseName: string;
  createdAt: string;
  createdByName: string | null;
  lines: TlLine[];
  approvals: DocApproval[];
  actions?: { submit: boolean; approve: boolean; reject: boolean; reason: string };
}

interface CreateLine {
  skuId: number;
  skuCode: string;
  skuName: string;
  baseUom: string;
  qty: string;
  reason: TlReason;
}

const STATUS_TABS = [
  { key: "", label: "全部" },
  { key: "draft", label: "草稿" },
  { key: "pending", label: "待审批" },
  { key: "completed", label: "已完成" },
];

export default function TlClient() {
  const { message } = App.useApp();
  const [canWrite, setCanWrite] = useState(false);

  const [rows, setRows] = useState<TlRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  // 列表页状态平台（E6-P1）：筛选/分页进 URL，密度与已保存视图存本地
  const listState = useListState({ transientParams: DOCUMENT_TRANSIENT_PARAMS, key: "tl", defaults: { q: "", status: "" }, defaultPageSize: 20 });
  const { filters, page, pageSize } = listState;
  const q = filters.q;
  const status = filters.status;

  const documentSelection = useDocumentTarget();
  const { id: detailId, setId: setDetailId } = documentSelection;
  useEffect(() => { setRejectOpen(false); }, [detailId]);
  const detailRead = useDocumentRead<TlDetail>(detailId == null ? null : `/api/matflow/tl/${detailId}`);
  const detail = detailRead.data;
  const detailLoading = detailRead.phase === "loading";
  const loadDetail = detailRead.retry;
  const [actionLoading, setActionLoading] = useState(false);
  /** 审批 409「退料超过累计发料」专项警示 */
  const [overReturnAlert, setOverReturnAlert] = useState<string | null>(null);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectComment, setRejectComment] = useState("");

  // 创建
  const [createOpen, setCreateOpen] = useState(false);
  const [createLoading, setCreateLoading] = useState(false);
  const createLock = useRef(false);
  const [jgId, setJgId] = useState<number | null>(null);
  const [toWarehouseId, setToWarehouseId] = useState<number | null>(null);
  const [remark, setRemark] = useState("");
  const [createLines, setCreateLines] = useState<CreateLine[]>([]);
  const materialRead = useJgMaterialLines((lines) => setCreateLines(lines.map((l) => ({
    skuId: l.materialSkuId, skuCode: l.skuCode, skuName: l.skuName, baseUom: l.baseUom,
    qty: "0", reason: "surplus_return",
  }))));

  const beginLoadRead = useLatestRead();
  const load = useCallback(async () => {
    const readRequest = beginLoadRead();
    setLoading(true);
    setCanWrite(false);
    try {
      const params = new URLSearchParams({ q, page: String(page), pageSize: String(pageSize) });
      if (status) params.set("status", status);
      const res = await fetchJson<{ rows: TlRow[]; total: number; actions?: { create: boolean } }>(`/api/matflow/tl?${params.toString()}`, { signal: readRequest.signal });
      if (!readRequest.isCurrent()) return;
      setRows(res.rows);
      setTotal(res.total);
      setCanWrite(res.actions?.create === true);
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

  useEffect(() => { setOverReturnAlert(null); }, [detailId]);

  const refresh = () => {
    if (detail) void loadDetail();
    void load();
  };

  // ---------- 创建 ----------

  const openCreate = () => {
    if (createLock.current) return;
    materialRead.cancel();
    setCreateOpen(true);
    setJgId(null);
    setToWarehouseId(null);
    setRemark("");
    setCreateLines([]);
  };

  /** 选 JG 后：取 WO 物料行作为可退物料清单（数量默认 0，由仓管填写） */
  const handleJgChange = async (id: number) => {
    if (createLock.current) return;
    setJgId(id);
    await materialRead.load(id);
  };

  const handleCreate = async () => {
    if (createLock.current || materialRead.loading || materialRead.error) return;
    if (jgId == null) return void message.warning("请选择加工通知单");
    if (toWarehouseId == null) return void message.warning("请选择退回仓");
    const valid = createLines.filter((l) => DEC_RE.test(l.qty) && decCmp(l.qty, "0") > 0);
    if (valid.length === 0) return void message.warning("至少需要一行数量大于 0 的退料行");
    createLock.current = true;
    setCreateLoading(true);
    try {
      const created = await postJson<{ id: number }>("/api/matflow/tl", {
        jgId,
        toWarehouseId,
        remark: remark.trim() || undefined,
        lines: valid.map((l) => ({ skuId: l.skuId, qty: l.qty, reason: l.reason })),
      });
      message.success("退料单已创建");
      setCreateOpen(false);
      void load();
      setDetailId(created.id);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      createLock.current = false;
      setCreateLoading(false);
    }
  };

  // ---------- 动作 ----------

  const handleSubmit = async () => {
    if (!detail) return;
    setActionLoading(true);
    try {
      await postJson(`/api/matflow/tl/${detail.id}/submit`, { version: detail.version });
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
    setOverReturnAlert(null);
    try {
      await postJson(`/api/matflow/tl/${detail.id}/approve`, {
        action,
        comment: comment?.trim() || undefined,
        version: detail.version,
      });
      message.success(action === "approve" ? "审批通过，已过账退料" : "已驳回");
      refresh();
      return true;
    } catch (e) {
      const msg = (e as Error).message;
      if (msg.includes("退料超过累计发料")) {
        setOverReturnAlert(msg);
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

  const columns: ColumnsType<TlRow> = [
    {
      title: "单据号",
      dataIndex: "docNo",
      width: 160,
      render: (v: string, r) => <Typography.Link onClick={() => setDetailId(r.id)}>{v}</Typography.Link>,
    },
    { title: "加工通知单", dataIndex: "jgDocNo", width: 160 },
    {
      title: "委外仓 → 退回仓",
      key: "route",
      render: (_, r) => `${r.fromWarehouseName} → ${r.toWarehouseName}`,
    },
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

  const lineColumns: ColumnsType<TlLine> = [
    { title: "物料", key: "material", width: 200, render: (_, r) => `${r.skuCode} ${r.skuName}` },
    { title: "单位", dataIndex: "baseUom", width: 70 },
    { title: "数量", dataIndex: "qty", width: 110, align: "right", render: (v: string) => formatQty(v) },
    {
      title: "批次",
      dataIndex: "batchNo",
      width: 150,
      render: (v: string | null, r) => v ? `${v}${r.expiryDate ? ` · ${r.expiryDate}` : ""}` : "无批次",
    },
    {
      title: "退料原因",
      dataIndex: "reason",
      width: 130,
      render: (v: string) => REASON_LABELS[v] ?? v,
    },
  ];

  const createLineColumns: ColumnsType<CreateLine> = [
    { title: "物料", key: "material", width: 200, render: (_, r) => `${r.skuCode} ${r.skuName}` },
    { title: "单位", dataIndex: "baseUom", width: 70 },
    {
      title: "退料数量",
      key: "qty",
      width: 150,
      render: (_, r, idx) => (
        <InputNumber<string>
          stringMode
          min="0"
          style={{ width: "100%" }}
          value={r.qty}
          onChange={(v) =>
            setCreateLines((prev) => prev.map((l, i) => (i === idx ? { ...l, qty: v ?? "0" } : l)))
          }
        />
      ),
    },
    {
      title: "退料原因",
      key: "reason",
      width: 160,
      render: (_, r, idx) => (
        <Select<TlReason>
          style={{ width: "100%" }}
          value={r.reason}
          options={[
            { value: "surplus_return", label: "剩料退回" },
            { value: "defect_exchange", label: "不合格料退换" },
          ]}
          onChange={(v) =>
            setCreateLines((prev) => prev.map((l, i) => (i === idx ? { ...l, reason: v } : l)))
          }
        />
      ),
    },
  ];

  const actions = detail ? (
    <Space>
      {detail.actions?.submit ? (
        <Popconfirm title="确认提交审批？" okText="提交" cancelText="取消" onConfirm={() => void handleSubmit()}>
          <Button type="primary" loading={actionLoading}>
            提交
          </Button>
        </Popconfirm>
      ) : null}
      {detail.actions?.approve ? (
        <>
          <Popconfirm
            title="确认审批通过？通过即过账退料（委外仓 − / 退回仓 +）。"
            okText="通过"
            cancelText="取消"
            onConfirm={() => void handleApprove("approve")}
          >
            <Button type="primary" loading={actionLoading}>
              审批通过
            </Button>
          </Popconfirm>
        </>
      ) : null}
      {detail.actions?.reject ? (
        <Button danger loading={actionLoading} onClick={() => setRejectOpen(true)}>驳回</Button>
      ) : null}
    </Space>
  ) : null;

  return (
    <div>
      <Typography.Title level={4} style={{ marginTop: 0 }}>
        退料单（TL）
      </Typography.Title>
      <Typography.Paragraph type="secondary">
        委外仓向自有仓退回物料；出仓自动定位该加工厂委外仓。逐物料累计退料不得超过累计发料。
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
                新建退料单
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
            style={{ width: 240 }}
            onSearch={(value) => listState.setFilter({ q: value.trim() })}
          />
        }
      />
      <Table<TlRow>
        rowKey="id"
        size={listState.tableSize}
        columns={columns}
        dataSource={rows}
        loading={loading}
        scroll={{ x: "max-content" }}
        pagination={listState.paginationProps({ total: total })}
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
            "退料单详情"
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
            <ChainStrip docType="tl" id={detail.id} />
            <Alert type="info" showIcon style={{ marginBottom: 12 }}
              message={detail.actions?.reason ?? "操作资格未加载，请刷新详情后重试。"} />
            {overReturnAlert ? (
              <Alert
                type="warning"
                showIcon
                closable
                onClose={() => setOverReturnAlert(null)}
                style={{ marginBottom: 16 }}
                message="退料超过累计发料，审批被阻塞"
                description={overReturnAlert}
              />
            ) : null}
            <Descriptions column={{ xs: 1, sm: 2 }} size="small" bordered style={{ marginBottom: 16 }}
              styles={{ label: { width: 104, whiteSpace: "nowrap" }, content: { overflowWrap: "anywhere" } }}>
              <Descriptions.Item label="加工通知单">{detail.jgDocNo}</Descriptions.Item>
              <Descriptions.Item label="退料路径">
                {detail.fromWarehouseName} → {detail.toWarehouseName}
              </Descriptions.Item>
              <Descriptions.Item label="制单人">{detail.createdByName ?? "—"}</Descriptions.Item>
              <Descriptions.Item label="制单时间">
                {dayjs(detail.createdAt).format("YYYY-MM-DD HH:mm")}
              </Descriptions.Item>
              <Descriptions.Item label="备注" span={{ xs: 1, sm: 2 }}>
                {detail.remark ?? "—"}
              </Descriptions.Item>
            </Descriptions>
            <Typography.Title level={5}>明细行</Typography.Title>
            <Table<TlLine>
              rowKey="id"
              size="small"
              columns={lineColumns}
              dataSource={detail.lines}
              pagination={false}
              scroll={{ x: 660 }}
              tableLayout="fixed"
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
        title="新建退料单"
        open={createOpen}
        width={820}
        okText="创建"
        cancelText="取消"
        confirmLoading={createLoading}
        onCancel={() => { if (!createLock.current) { materialRead.cancel(); setCreateOpen(false); } }}
        maskClosable={!createLoading}
        keyboard={!createLoading}
        okButtonProps={{ disabled: !canWrite || materialRead.loading || Boolean(materialRead.error) }}
        onOk={() => void handleCreate()}
      >
        <Space direction="vertical" style={{ width: "100%" }} size="middle">
          <Alert type="info" showIcon message="收货关闭后、结算冻结前可退回实物余料。"
            description="退料不会自动更新结算，请通知PMC核对草稿或待审批依据。结算已冻结的工单禁止继续退料，请联系财务和仓管核对库存及差额纠错，不改写历史金额。" />
          <div>
            <div style={{ marginBottom: 4 }}>加工通知单（已审批、执行中、收货关闭或短关）</div>
            <RemoteSelect
              api="/api/outsource/jg?returnEligible=1"
              disabled={createLoading}
              style={{ width: "100%" }}
              placeholder="选择加工通知单"
              value={jgId}
              getLabel={(j) => `${String(j.docNo)}｜${String(j.supplierName)}｜${String(j.productSkuCode)} ${String(j.productSkuName)}`}
              onChange={(v: number) => void handleJgChange(v)}
            />
          </div>
          <div>
            <div style={{ marginBottom: 4 }}>退回仓（自有实时仓）</div>
            <RemoteSelect
              api="/api/master/warehouse"
              style={{ width: "100%" }}
              placeholder="选择退回仓"
              value={toWarehouseId}
              getLabel={(r) => `${String(r.code)} ${String(r.name)}`}
              filterRow={(r) =>
                r.active === true &&
                r.accountingMode === "realtime" &&
                r.kind !== "outsource" &&
                r.kind !== "snapshot"
              }
              onChange={(v: number) => setToWarehouseId(v)}
            />
          </div>
          <div>
            <div style={{ marginBottom: 4 }}>退料行（工单物料清单；数量为 0 的行不提交）</div>
            {materialRead.error && <Alert type="error" showIcon message={materialRead.error}
              action={<Button size="small" disabled={jgId == null || createLoading} onClick={() => { if (jgId != null) void handleJgChange(jgId); }}>重试物料</Button>} />}
            <Table<CreateLine>
              rowKey="skuId"
              size="small"
              loading={materialRead.loading}
              columns={createLineColumns}
              dataSource={createLines}
              pagination={false}
              scroll={{ x: 580 }}
              tableLayout="fixed"
              locale={{ emptyText: materialRead.error ? "物料读取失败" : jgId == null ? "请先选择加工通知单" : "当前工单没有物料行" }}
            />
          </div>
          <Input.TextArea
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
        okButtonProps={{ danger: true, disabled: !detail?.actions?.reject }}
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
