"use client";

import { useDocumentTarget } from "@/components/useDocumentTarget";
import { DOCUMENT_TRANSIENT_PARAMS } from "@/lib/document-links";
import { useDocumentRead } from "@/components/useDocumentRead";
import DocumentDrawer from "@/components/DocumentDrawer";

import SearchInput from "@/components/SearchInput";

import { useEffect, useState } from "react";
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
import { hasAnyRole, useMe } from "@/components/useMe";
import ApprovalTimeline from "@/components/ApprovalTimeline";

// ---------- 客户端十进制比较（仅提交前过滤/预警用；非负字符串，禁 float） ----------

const DEC_RE = /^\d+(\.\d+)?$/;

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
  docNo: string;
  status: string;
  remark: string | null;
  version: number;
  poId: number;
  poDocNo: string;
  warehouseName: string;
  createdAt: string;
  createdByName: string | null;
  lines: CtLine[];
  approvals: DocApproval[];
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
  poLineId: number;
  skuId: number;
  skuCode: string;
  skuName: string;
  baseUom: string;
  receivedQty: string;
  qty: string;
  reason: string;
}

const STATUS_TABS = [
  { key: "", label: "全部" },
  { key: "draft", label: "草稿" },
  { key: "pending", label: "待审批" },
  { key: "completed", label: "已完成" },
];

export default function CtClient() {
  const { message } = App.useApp();
  const me = useMe();
  const canWrite = hasAnyRole(me, "warehouse");
  const canApprove =
    me != null && (me.roles.includes("admin") || (me.isApprover && me.roles.includes("warehouse")));

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

  const documentSelection = useDocumentTarget();
  const { id: detailId, setId: setDetailId } = documentSelection;
  useEffect(() => { setRejectOpen(false); }, [detailId]);
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
  const [poId, setPoId] = useState<number | null>(null);
  const [warehouseId, setWarehouseId] = useState<number | null>(null);
  const [remark, setRemark] = useState("");
  const [lineEdits, setLineEdits] = useState<Record<number, { qty: string; reason: string }>>({});
  const poRead = useDocumentRead<{ id: number; lines: PoDetailLine[] }>(createOpen && poId != null ? `/api/outsource/po/${poId}` : null);
  const poValid = poRead.data != null && poRead.data.id === poId && Array.isArray(poRead.data.lines)
    && poRead.data.lines.every(l => l != null && Number.isSafeInteger(l.id) && l.id > 0 && Number.isSafeInteger(l.skuId) && l.skuId > 0
      && typeof l.skuCode === "string" && typeof l.skuName === "string" && typeof l.baseUom === "string"
      && typeof l.receivedQty === "string" && DEC_RE.test(l.receivedQty))
    && new Set(poRead.data.lines.map(l => l.id)).size === poRead.data.lines.length;
  const poError = poRead.error ?? (poRead.data && !poValid ? "采购订单身份或行数据不一致，请重新读取" : null);
  const createLines: CreateLine[] = poValid ? poRead.data!.lines.filter(l => decCmp(l.receivedQty, "0") > 0).map(l => ({
    poLineId: l.id, skuId: l.skuId, skuCode: l.skuCode, skuName: l.skuName, baseUom: l.baseUom,
    receivedQty: l.receivedQty, qty: lineEdits[l.id]?.qty ?? "0", reason: lineEdits[l.id]?.reason ?? "",
  })) : [];

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
  };

  /** 选 PO 后：取已收行（可退数量 = 当前已收数，基础单位） */
  const handlePoChange = (id: number) => {
    setPoId(id);
    setLineEdits({});
  };

  const handleCreate = async () => {
    if (poId == null) return void message.warning("请选择采购订单");
    if (!poValid || poRead.phase !== "success") return void message.warning("请先成功读取当前采购订单的可退行");
    if (warehouseId == null) return void message.warning("请选择退货出库仓");
    const valid = createLines.filter((l) => DEC_RE.test(l.qty) && decCmp(l.qty, "0") > 0);
    if (valid.length === 0) return void message.warning("至少需要一行数量大于 0 的退货行");
    const over = valid.find((l) => decCmp(l.qty, l.receivedQty) > 0);
    if (over) {
      return void message.warning(
        `${over.skuCode} ${over.skuName}：退货 ${formatQty(over.qty)} 超过可退数量 ${formatQty(over.receivedQty)}`,
      );
    }
    setCreateLoading(true);
    try {
      const created = await postJson<{ id: number }>("/api/matflow/ct", {
        poId,
        warehouseId,
        remark: remark.trim() || undefined,
        lines: valid.map((l) => ({
          poLineId: l.poLineId,
          skuId: l.skuId,
          qty: l.qty,
          reason: l.reason.trim() || undefined,
        })),
      });
      message.success("采购退货单已创建");
      setCreateOpen(false);
      void load();
      setDetailId(created.id);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
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
    { title: "物料", key: "material", width: 220, render: (_, r) => `${r.skuCode} ${r.skuName}` },
    { title: "单位", dataIndex: "baseUom", width: 70 },
    {
      title: "可退数量（已收）",
      dataIndex: "receivedQty",
      width: 130,
      align: "right",
      render: (v: string) => formatQty(v),
    },
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
          onChange={(v) =>
            setLineEdits(prev => ({ ...prev, [r.poLineId]: { qty: v ?? "0", reason: prev[r.poLineId]?.reason ?? "" } }))
          }
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
          onChange={(e) =>
            setLineEdits(prev => ({ ...prev, [r.poLineId]: { qty: prev[r.poLineId]?.qty ?? "0", reason: e.target.value } }))
          }
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
            title="确认审批通过？通过即过账退货出库并回冲 PO 已收数。"
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

      <Modal
        title="新建采购退货单"
        open={createOpen}
        width={860}
        okText="创建"
        cancelText="取消"
        confirmLoading={createLoading}
        okButtonProps={{ disabled: !poValid || createLines.length === 0 || warehouseId == null }}
        cancelButtonProps={{ disabled: createLoading }}
        closable={!createLoading}
        maskClosable={!createLoading}
        keyboard={!createLoading}
        onCancel={() => { if (!createLoading) setCreateOpen(false); }}
        onOk={() => void handleCreate()}
      >
        <Space direction="vertical" style={{ width: "100%" }} size="middle">
          <div>
            <div style={{ marginBottom: 4 }}>采购订单</div>
            <RemoteSelect
              api="/api/outsource/po?returnEligible=1"
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
              onChange={(v: number) => setWarehouseId(v)}
            />
          </div>
          <div>
            <div style={{ marginBottom: 4 }}>退货行（仅列出已收数量大于 0 的 PO 行；数量为 0 的行不提交）</div>
            <LoadErrorAlert error={poError} onRetry={poRead.retry} subject="采购订单可退行" />
            <Table<CreateLine>
              rowKey="poLineId"
              size="small"
              loading={poRead.phase === "loading"}
              columns={createLineColumns}
              tableLayout="fixed"
              scroll={{ x: 760 }}
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
