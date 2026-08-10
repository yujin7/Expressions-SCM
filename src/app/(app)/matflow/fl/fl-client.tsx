"use client";

import SearchInput from "@/components/SearchInput";

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

// ---------- 客户端十进制比较/加法（仅 UI 提示用；非负十进制字符串，禁 float） ----------

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

// ---------- 接口形状（对照 src/server/modules/matflow/fl.ts） ----------

interface FlRow {
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

interface FlLine {
  id: number;
  skuId: number;
  skuCode: string;
  skuName: string;
  baseUom: string;
  qty: string;
  batchId: number | null;
  batchNo: string | null;
  expiryDate: string | null;
}

interface FlRequirement {
  skuId: number;
  grossReq: string;
  issuedCum: string;
}

interface DocApproval {
  approverName: string | null;
  action: "approve" | "reject";
  comment: string | null;
  createdAt: string;
}

interface FlDetail {
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
  lines: FlLine[];
  requirements: FlRequirement[];
  approvals: DocApproval[];
}

interface JgOption {
  id: number;
  docNo: string;
  status: string;
  supplierName: string;
  productSkuCode: string;
  productSkuName: string;
}

interface WoMaterialLine {
  materialSkuId: number;
  skuCode: string;
  skuName: string;
  baseUom: string;
  grossReq: string;
}

interface CreateLine {
  skuId: number;
  skuCode: string;
  skuName: string;
  baseUom: string;
  grossReq: string;
  qty: string;
}

const STATUS_TABS = [
  { key: "", label: "全部" },
  { key: "draft", label: "草稿" },
  { key: "pending", label: "待审批" },
  { key: "completed", label: "已完成" },
];

export default function FlClient() {
  const { message } = App.useApp();
  const me = useMe();
  const canWrite = hasAnyRole(me, "warehouse");
  const canApprove =
    me != null && (me.roles.includes("admin") || (me.isApprover && me.roles.includes("warehouse")));

  const [rows, setRows] = useState<FlRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  // 列表页状态平台（E6-P1）：筛选/分页进 URL，密度与已保存视图存本地
  const listState = useListState({ key: "fl", defaults: { q: "", status: "" }, defaultPageSize: 20 });
  const { filters, page, pageSize } = listState;
  const q = filters.q;
  const status = filters.status;

  const [detailId, setDetailId] = useState<number | null>(null);
  const [detail, setDetail] = useState<FlDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  /** 超发被拒（403 含「超发/管理员」）警示 */
  const [overIssueAlert, setOverIssueAlert] = useState<string | null>(null);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectComment, setRejectComment] = useState("");

  // 创建
  const [createOpen, setCreateOpen] = useState(false);
  const [createLoading, setCreateLoading] = useState(false);
  const [jgOptions, setJgOptions] = useState<JgOption[]>([]);
  const [jgLoading, setJgLoading] = useState(false);
  const [jgId, setJgId] = useState<number | null>(null);
  const [fromWarehouseId, setFromWarehouseId] = useState<number | null>(null);
  const [remark, setRemark] = useState("");
  const [createLines, setCreateLines] = useState<CreateLine[]>([]);
  const [linesLoading, setLinesLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ q, page: String(page), pageSize: String(pageSize) });
      if (status) params.set("status", status);
      const res = await fetchJson<{ rows: FlRow[]; total: number }>(`/api/matflow/fl?${params.toString()}`);
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
        setDetail(await fetchJson<FlDetail>(`/api/matflow/fl/${id}`));
      } catch (e) {
        message.error((e as Error).message);
      } finally {
        setDetailLoading(false);
      }
    },
    [message],
  );

  useEffect(() => {
    setOverIssueAlert(null);
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
    setJgId(null);
    setFromWarehouseId(null);
    setRemark("");
    setCreateLines([]);
    setJgLoading(true);
    fetchJson<{ rows: JgOption[] }>("/api/outsource/jg?page=1&pageSize=999")
      .then((res) =>
        setJgOptions(res.rows.filter((r) => r.status === "approved" || r.status === "in_progress")),
      )
      .catch((e) => message.error((e as Error).message))
      .finally(() => setJgLoading(false));
  };

  /** 选 JG 后：JG 详情取 woId → WO 详情取物料行（毛需求）预填发料行 */
  const handleJgChange = async (id: number) => {
    setJgId(id);
    setCreateLines([]);
    setLinesLoading(true);
    try {
      const jg = await fetchJson<{ woId: number }>(`/api/outsource/jg/${id}`);
      const wo = await fetchJson<{ lines: WoMaterialLine[] }>(`/api/outsource/wo/${jg.woId}`);
      setCreateLines(
        wo.lines.map((l) => ({
          skuId: l.materialSkuId,
          skuCode: l.skuCode,
          skuName: l.skuName,
          baseUom: l.baseUom,
          grossReq: l.grossReq,
          qty: l.grossReq,
        })),
      );
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setLinesLoading(false);
    }
  };

  const handleCreate = async () => {
    if (jgId == null) return void message.warning("请选择加工通知单");
    if (fromWarehouseId == null) return void message.warning("请选择发料仓");
    const valid = createLines.filter((l) => DEC_RE.test(l.qty) && decCmp(l.qty, "0") > 0);
    if (valid.length === 0) return void message.warning("至少需要一行数量大于 0 的发料行");
    setCreateLoading(true);
    try {
      const created = await postJson<{ id: number }>("/api/matflow/fl", {
        jgId,
        fromWarehouseId,
        remark: remark.trim() || undefined,
        lines: valid.map((l) => ({ skuId: l.skuId, qty: l.qty })),
      });
      message.success("发料单已创建");
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
      await postJson(`/api/matflow/fl/${detail.id}/submit`, { version: detail.version });
      message.success("已提交审批");
      refresh();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setActionLoading(false);
    }
  };

  /** 审批：403 含「超发/管理员」→ 专项警示 Alert */
  const handleApprove = async (action: "approve" | "reject", comment?: string) => {
    if (!detail) return false;
    setActionLoading(true);
    setOverIssueAlert(null);
    try {
      await postJson(`/api/matflow/fl/${detail.id}/approve`, {
        action,
        comment: comment?.trim() || undefined,
        version: detail.version,
      });
      message.success(action === "approve" ? "审批通过，已过账发料" : "已驳回");
      refresh();
      return true;
    } catch (e) {
      const msg = (e as Error).message;
      if (msg.includes("超发") || msg.includes("管理员")) {
        setOverIssueAlert(msg);
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

  const columns: ColumnsType<FlRow> = [
    {
      title: "单据号",
      dataIndex: "docNo",
      width: 160,
      render: (v: string, r) => <Typography.Link onClick={() => setDetailId(r.id)}>{v}</Typography.Link>,
    },
    { title: "加工通知单", dataIndex: "jgDocNo", width: 160 },
    {
      title: "从仓 → 委外仓",
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

  const reqBySku = new Map((detail?.requirements ?? []).map((r) => [r.skuId, r]));
  const docActive =
    detail != null && ["approved", "in_progress", "completed"].includes(detail.status);

  const lineColumns: ColumnsType<FlLine> = [
    { title: "物料", key: "material", render: (_, r) => `${r.skuCode} ${r.skuName}` },
    { title: "单位", dataIndex: "baseUom", width: 70 },
    {
      title: "批次",
      dataIndex: "batchNo",
      width: 150,
      render: (v: string | null, r) => v ? `${v}${r.expiryDate ? ` · ${r.expiryDate}` : ""}` : "无批次",
    },
    {
      title: "毛需求",
      key: "grossReq",
      width: 110,
      align: "right",
      render: (_, r) => formatQty(reqBySku.get(r.skuId)?.grossReq),
    },
    {
      title: "累计已发",
      key: "issuedCum",
      width: 110,
      align: "right",
      render: (_, r) => formatQty(reqBySku.get(r.skuId)?.issuedCum),
    },
    {
      title: "本单数量",
      dataIndex: "qty",
      width: 110,
      align: "right",
      render: (v: string, r) => {
        const req = reqBySku.get(r.skuId);
        // 已生效单：累计口径已含本单 → 比累计；未生效：比 累计+本单
        const over =
          req != null &&
          decCmp(docActive ? req.issuedCum : decAdd(req.issuedCum, v), req.grossReq) > 0;
        return over ? (
          <Typography.Text type="danger">{formatQty(v)}（超发）</Typography.Text>
        ) : (
          formatQty(v)
        );
      },
    },
  ];

  const createLineColumns: ColumnsType<CreateLine> = [
    { title: "物料", key: "material", render: (_, r) => `${r.skuCode} ${r.skuName}` },
    { title: "单位", dataIndex: "baseUom", width: 70 },
    { title: "毛需求", dataIndex: "grossReq", width: 110, align: "right", render: (v: string) => formatQty(v) },
    {
      title: "本单发料数量",
      key: "qty",
      width: 160,
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
            title="确认审批通过？通过即过账发料（从仓 − / 委外仓 +）。"
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
        发料单（FL）
      </Typography.Title>
      <Typography.Paragraph type="secondary">
        按加工通知单从自有仓向委外仓发料；收料仓自动定位加工厂委外仓。超发需管理员审批。
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
                新建发料单
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
      <Table<FlRow>
        rowKey="id"
        size={listState.tableSize}
        columns={columns}
        dataSource={rows}
        loading={loading}
        scroll={{ x: "max-content" }}
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
            "发料单详情"
          )
        }
        open={detailId != null}
        onClose={() => setDetailId(null)}
        width={900}
        loading={detailLoading}
        extra={actions}
      >
        {detail ? (
          <div>
            <ChainStrip docType="fl" id={detail.id} />
            {overIssueAlert ? (
              <Alert
                type="warning"
                showIcon
                closable
                onClose={() => setOverIssueAlert(null)}
                style={{ marginBottom: 16 }}
                message="超发需管理员审批"
                description={`${overIssueAlert}——本单逐物料「累计已发 + 本单」超出工单毛需求，请转由管理员执行审批。`}
              />
            ) : null}
            <Descriptions column={2} size="small" bordered style={{ marginBottom: 16 }}>
              <Descriptions.Item label="加工通知单">{detail.jgDocNo}</Descriptions.Item>
              <Descriptions.Item label="发料路径">
                {detail.fromWarehouseName} → {detail.toWarehouseName}
              </Descriptions.Item>
              <Descriptions.Item label="制单人">{detail.createdByName ?? "—"}</Descriptions.Item>
              <Descriptions.Item label="制单时间">
                {dayjs(detail.createdAt).format("YYYY-MM-DD HH:mm")}
              </Descriptions.Item>
              <Descriptions.Item label="备注" span={2}>
                {detail.remark ?? "—"}
              </Descriptions.Item>
            </Descriptions>
            <Typography.Title level={5}>明细行（需求对照）</Typography.Title>
            <Table<FlLine>
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
        title="新建发料单"
        open={createOpen}
        width={760}
        okText="创建"
        cancelText="取消"
        confirmLoading={createLoading}
        onCancel={() => setCreateOpen(false)}
        onOk={() => void handleCreate()}
      >
        <Space direction="vertical" style={{ width: "100%" }} size="middle">
          <div>
            <div style={{ marginBottom: 4 }}>加工通知单（仅 已审批/执行中）</div>
            <Select
              showSearch
              optionFilterProp="label"
              loading={jgLoading}
              style={{ width: "100%" }}
              placeholder="选择加工通知单"
              value={jgId}
              options={jgOptions.map((j) => ({
                value: j.id,
                label: `${j.docNo}｜${j.supplierName}｜${j.productSkuCode} ${j.productSkuName}`,
              }))}
              onChange={(v: number) => void handleJgChange(v)}
            />
          </div>
          <div>
            <div style={{ marginBottom: 4 }}>发料仓（自有实时仓）</div>
            <RemoteSelect
              api="/api/master/warehouse"
              style={{ width: "100%" }}
              placeholder="选择发料源仓"
              value={fromWarehouseId}
              getLabel={(r) => `${String(r.code)} ${String(r.name)}`}
              filterRow={(r) =>
                r.active === true &&
                r.accountingMode === "realtime" &&
                r.kind !== "outsource" &&
                r.kind !== "snapshot"
              }
              onChange={(v: number) => setFromWarehouseId(v)}
            />
          </div>
          <div>
            <div style={{ marginBottom: 4 }}>发料行（按工单毛需求预填，可改；数量为 0 的行不提交）</div>
            <Table<CreateLine>
              rowKey="skuId"
              size="small"
              loading={linesLoading}
              columns={createLineColumns}
              dataSource={createLines}
              pagination={false}
              locale={{ emptyText: "请先选择加工通知单" }}
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
