"use client";

import { useCallback, useEffect, useState } from "react";
import { App, Alert, Button, Descriptions, Drawer, Input, InputNumber, Modal, Popconfirm, Select, Space, Table, Tabs, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { PlusOutlined, ReloadOutlined } from "@ant-design/icons";
import dayjs from "dayjs";
import ChainStrip from "@/components/ChainStrip";
import DocStatusTag from "@/components/DocStatusTag";
import ListToolbar from "@/components/ListToolbar";
import RemoteSelect from "@/components/RemoteSelect";
import { fetchJson, postJson } from "@/components/fetchJson";
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

interface PoOption {
  id: number;
  docNo: string;
  status: string;
  supplierName: string;
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

  const [rows, setRows] = useState<CtRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  // 列表页状态平台（E6-P1）：筛选/分页进 URL，密度与已保存视图存本地
  const listState = useListState({ key: "ct", defaults: { q: "", status: "" }, defaultPageSize: 20 });
  const { filters, page, pageSize } = listState;
  const q = filters.q;
  const status = filters.status;

  const [detailId, setDetailId] = useState<number | null>(null);
  const [detail, setDetail] = useState<CtDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  /** 审批 409「退货量超过已收数」专项警示 */
  const [overAlert, setOverAlert] = useState<string | null>(null);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectComment, setRejectComment] = useState("");

  // 创建
  const [createOpen, setCreateOpen] = useState(false);
  const [createLoading, setCreateLoading] = useState(false);
  const [poOptions, setPoOptions] = useState<PoOption[]>([]);
  const [poLoading, setPoLoading] = useState(false);
  const [poId, setPoId] = useState<number | null>(null);
  const [warehouseId, setWarehouseId] = useState<number | null>(null);
  const [remark, setRemark] = useState("");
  const [createLines, setCreateLines] = useState<CreateLine[]>([]);
  const [linesLoading, setLinesLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ q, page: String(page), pageSize: String(pageSize) });
      if (status) params.set("status", status);
      const res = await fetchJson<{ rows: CtRow[]; total: number }>(`/api/matflow/ct?${params.toString()}`);
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
        setDetail(await fetchJson<CtDetail>(`/api/matflow/ct/${id}`));
      } catch (e) {
        message.error((e as Error).message);
      } finally {
        setDetailLoading(false);
      }
    },
    [message],
  );

  useEffect(() => {
    setOverAlert(null);
    if (detailId != null) void loadDetail(detailId);
    else setDetail(null);
  }, [detailId, loadDetail]);

  const refresh = () => {
    if (detail) void loadDetail(detail.id);
    void load();
  };

  // ---------- 创建 ----------

  const openCreate = () => {
    setCreateOpen(true);
    setPoId(null);
    setWarehouseId(null);
    setRemark("");
    setCreateLines([]);
    setPoLoading(true);
    fetchJson<{ rows: PoOption[] }>("/api/outsource/po?page=1&pageSize=999")
      .then((res) =>
        setPoOptions(
          res.rows.filter(
            (r) => r.status === "approved" || r.status === "in_progress" || r.status === "completed",
          ),
        ),
      )
      .catch((e) => message.error((e as Error).message))
      .finally(() => setPoLoading(false));
  };

  /** 选 PO 后：取已收行（可退数量 = 当前已收数，基础单位） */
  const handlePoChange = async (id: number) => {
    setPoId(id);
    setCreateLines([]);
    setLinesLoading(true);
    try {
      const po = await fetchJson<{ lines: PoDetailLine[] }>(`/api/outsource/po/${id}`);
      const received = po.lines.filter((l) => DEC_RE.test(l.receivedQty) && decCmp(l.receivedQty, "0") > 0);
      if (received.length === 0) message.warning("该采购订单暂无已收数量，无可退行");
      setCreateLines(
        received.map((l) => ({
          poLineId: l.id,
          skuId: l.skuId,
          skuCode: l.skuCode,
          skuName: l.skuName,
          baseUom: l.baseUom,
          receivedQty: l.receivedQty,
          qty: "0",
          reason: "",
        })),
      );
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setLinesLoading(false);
    }
  };

  const handleCreate = async () => {
    if (poId == null) return void message.warning("请选择采购订单");
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
        void loadDetail(detail.id);
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
    { title: "物料", key: "material", render: (_, r) => `${r.skuCode} ${r.skuName}` },
    { title: "单位", dataIndex: "baseUom", width: 70 },
    { title: "PO 行", dataIndex: "poLineId", width: 80, render: (v: number) => `#${v}` },
    { title: "退货数量", dataIndex: "qty", width: 110, align: "right", render: (v: string) => formatQty(v) },
    { title: "退货原因", dataIndex: "reason", render: (v: string | null) => v ?? "—" },
  ];

  const createLineColumns: ColumnsType<CreateLine> = [
    { title: "物料", key: "material", render: (_, r) => `${r.skuCode} ${r.skuName}` },
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
      render: (_, r, idx) => (
        <InputNumber<string>
          stringMode
          min="0"
          style={{ width: "100%" }}
          value={r.qty}
          status={DEC_RE.test(r.qty) && decCmp(r.qty, r.receivedQty) > 0 ? "error" : undefined}
          onChange={(v) =>
            setCreateLines((prev) => prev.map((l, i) => (i === idx ? { ...l, qty: v ?? "0" } : l)))
          }
        />
      ),
    },
    {
      title: "退货原因（可选）",
      key: "reason",
      width: 180,
      render: (_, r, idx) => (
        <Input
          maxLength={200}
          value={r.reason}
          onChange={(e) =>
            setCreateLines((prev) => prev.map((l, i) => (i === idx ? { ...l, reason: e.target.value } : l)))
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
      <Space style={{ marginBottom: 8, width: "100%", display: "flex", justifyContent: "flex-end" }} wrap>
        {canWrite ? (
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
            新建退货单
          </Button>
        ) : null}
        <Button icon={<ReloadOutlined />} onClick={() => void load()}>
          刷新
        </Button>
      </Space>
      <ListToolbar
        state={listState}
        extra={
          <Input.Search
            key={q}
            allowClear
            defaultValue={q}
            placeholder="搜索单据号"
            style={{ width: 240 }}
            onSearch={(value) => listState.setFilter({ q: value.trim() })}
          />
        }
      />
      <Table<CtRow>
        rowKey="id"
        size={listState.tableSize}
        columns={columns}
        dataSource={rows}
        loading={loading}
        pagination={listState.paginationProps({ total: total })}
      />

      <Drawer
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
        open={detailId != null}
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
            <Descriptions column={2} size="small" bordered style={{ marginBottom: 16 }}>
              <Descriptions.Item label="采购订单">{detail.poDocNo}</Descriptions.Item>
              <Descriptions.Item label="退货出库仓">{detail.warehouseName}</Descriptions.Item>
              <Descriptions.Item label="制单人">{detail.createdByName ?? "—"}</Descriptions.Item>
              <Descriptions.Item label="制单时间">
                {dayjs(detail.createdAt).format("YYYY-MM-DD HH:mm")}
              </Descriptions.Item>
              <Descriptions.Item label="备注" span={2}>
                {detail.remark ?? "—"}
              </Descriptions.Item>
            </Descriptions>
            <Typography.Title level={5}>明细行</Typography.Title>
            <Table<CtLine>
              rowKey="id"
              size="small"
              columns={lineColumns}
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
      </Drawer>

      <Modal
        title="新建采购退货单"
        open={createOpen}
        width={860}
        okText="创建"
        cancelText="取消"
        confirmLoading={createLoading}
        onCancel={() => setCreateOpen(false)}
        onOk={() => void handleCreate()}
      >
        <Space direction="vertical" style={{ width: "100%" }} size="middle">
          <div>
            <div style={{ marginBottom: 4 }}>采购订单</div>
            <Select
              showSearch
              optionFilterProp="label"
              loading={poLoading}
              style={{ width: "100%" }}
              placeholder="选择采购订单"
              value={poId}
              options={poOptions.map((p) => ({
                value: p.id,
                label: `${p.docNo}｜${p.supplierName}`,
              }))}
              onChange={(v: number) => void handlePoChange(v)}
            />
          </div>
          <div>
            <div style={{ marginBottom: 4 }}>退货出库仓（自有实时仓）</div>
            <RemoteSelect
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
            <Table<CreateLine>
              rowKey="poLineId"
              size="small"
              loading={linesLoading}
              columns={createLineColumns}
              dataSource={createLines}
              pagination={false}
              locale={{ emptyText: "请先选择采购订单" }}
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
