"use client";

import SearchInput from "@/components/SearchInput";

import { Suspense, useCallback, useEffect, useState } from "react";
import { App, Alert, Button, Descriptions, Drawer, Input, Modal, Popconfirm, Space, Table, Tabs, Tag, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { ReloadOutlined } from "@ant-design/icons";
import dayjs from "dayjs";
import ChainStrip from "@/components/ChainStrip";
import DocStatusTag from "@/components/DocStatusTag";
import { fetchJson, postJson } from "@/components/fetchJson";
import ListToolbar from "@/components/ListToolbar";
import { useListState } from "@/components/useListState";
import ApprovalTimeline from "@/components/ApprovalTimeline";

interface PoRow {
  id: number;
  docNo: string;
  status: string;
  woId: number | null;
  supplierName: string;
  lineCount: number;
  createdByName: string | null;
  createdAt: string;
}

interface PoLine {
  id: number;
  skuId: number;
  skuCode: string;
  skuName: string;
  baseUom: string;
  lineType: string;
  purchaseUom: string;
  uomFactor: string;
  qty: string;
  /** 敏感字段：非可见角色时后端已剥离（键不存在） */
  price?: string;
  taxIncluded: boolean;
  taxRatePct: string;
  receivedQty: string;
}

interface DocApproval {
  approverName: string | null;
  action: "approve" | "reject";
  comment: string | null;
  createdAt: string;
}

interface PoDetail {
  id: number;
  docNo: string;
  status: string;
  remark: string | null;
  version: number;
  woId: number | null;
  supplierId: number;
  supplierName: string;
  expectedDate: string | null;
  confirmedAt: string | null;
  confirmNote: string | null;
  createdAt: string;
  createdByName: string | null;
  lines: PoLine[];
  approvals: DocApproval[];
}

const STATUS_TABS = [
  { key: "", label: "全部" },
  { key: "draft", label: "草稿" },
  { key: "pending", label: "待审批" },
  { key: "approved", label: "已审批" },
  { key: "in_progress", label: "执行中" },
  { key: "completed", label: "已完成" },
];

const LINE_TYPE_LABELS: Record<string, string> = { raw: "原料", packaging: "包材" };

function PoInner() {
  const { message } = App.useApp();
  const [rows, setRows] = useState<PoRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  // 列表页状态平台（E6-P1）：筛选/分页进 URL，密度与已保存视图存本地
  const listState = useListState({ key: "po", defaults: { q: "", status: "" }, defaultPageSize: 20 });
  const { filters, page, pageSize } = listState;
  const q = filters.q;
  const status = filters.status;

  const [detailId, setDetailId] = useState<number | null>(null);
  const [detail, setDetail] = useState<PoDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);

  /** R1：提交遇价格异动时的警示（含 PC 单号） */
  const [priceAlert, setPriceAlert] = useState<{ text: string; pcNos: string[] } | null>(null);

  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectComment, setRejectComment] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmNote, setConfirmNote] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ q, page: String(page), pageSize: String(pageSize) });
      if (status) params.set("status", status);
      const res = await fetchJson<{ rows: PoRow[]; total: number }>(
        `/api/outsource/po?${params.toString()}`,
      );
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
        const res = await fetchJson<PoDetail>(`/api/outsource/po/${id}`);
        setDetail(res);
      } catch (e) {
        message.error((e as Error).message);
      } finally {
        setDetailLoading(false);
      }
    },
    [message],
  );

  useEffect(() => {
    setPriceAlert(null);
    if (detailId != null) void loadDetail(detailId);
    else setDetail(null);
  }, [detailId, loadDetail]);

  const refresh = () => {
    if (detail) void loadDetail(detail.id);
    void load();
  };

  const post = async (path: string, body: unknown, successText: string) => {
    if (!detail) return false;
    setActionLoading(true);
    try {
      await postJson(`/api/outsource/po/${detail.id}/${path}`, body);
      message.success(successText);
      refresh();
      return true;
    } catch (e) {
      message.error((e as Error).message);
      return false;
    } finally {
      setActionLoading(false);
    }
  };

  /** R1-aware 提交：409「价格异动」→ 警示 Alert（含 PC 单号），不弹通用错误 */
  const handleSubmit = async () => {
    if (!detail) return;
    setActionLoading(true);
    setPriceAlert(null);
    try {
      await postJson(`/api/outsource/po/${detail.id}/submit`, { version: detail.version });
      message.success("已提交审批");
      refresh();
    } catch (e) {
      const msg = (e as Error).message;
      if (msg.includes("价格异动")) {
        const pcNos = msg.match(/PC[0-9A-Za-z-]+/g) ?? [];
        setPriceAlert({ text: msg, pcNos });
        void loadDetail(detail.id);
      } else {
        message.error(msg);
      }
    } finally {
      setActionLoading(false);
    }
  };

  const columns: ColumnsType<PoRow> = [
    {
      title: "单据号",
      dataIndex: "docNo",
      width: 160,
      render: (v: string, r) => (
        <Typography.Link onClick={() => setDetailId(r.id)}>{v}</Typography.Link>
      ),
    },
    { title: "供应商", dataIndex: "supplierName" },
    { title: "行数", dataIndex: "lineCount", width: 70, align: "right" },
    {
      title: "确认状态",
      key: "confirm",
      width: 100,
      render: (_, r) =>
        r.status === "in_progress" || r.status === "completed" ? (
          <Tag color="green">已确认</Tag>
        ) : (
          <Tag>未确认</Tag>
        ),
    },
    { title: "状态", dataIndex: "status", width: 100, render: (v: string) => <DocStatusTag status={v} /> },
    { title: "制单人", dataIndex: "createdByName", width: 100, render: (v: string | null) => v ?? "—" },
    {
      title: "时间",
      dataIndex: "createdAt",
      width: 160,
      render: (v: string) => dayjs(v).format("YYYY-MM-DD HH:mm"),
    },
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

  const lineColumns: ColumnsType<PoLine> = [
    { title: "物料", key: "material", render: (_, r) => `${r.skuCode} ${r.skuName}` },
    {
      title: "类型",
      dataIndex: "lineType",
      width: 70,
      render: (v: string) => LINE_TYPE_LABELS[v] ?? v,
    },
    { title: "采购单位", dataIndex: "purchaseUom", width: 90 },
    { title: "换算率", dataIndex: "uomFactor", width: 80, align: "right" },
    { title: "数量", dataIndex: "qty", width: 100, align: "right" },
    {
      title: "单价",
      dataIndex: "price",
      width: 90,
      align: "right",
      render: (v: string | undefined) => (v != null ? v : "—"),
    },
    {
      title: "含税",
      dataIndex: "taxIncluded",
      width: 70,
      render: (v: boolean) => (v ? "含税" : "未税"),
    },
    { title: "税率%", dataIndex: "taxRatePct", width: 70, align: "right" },
    { title: "已收量", dataIndex: "receivedQty", width: 100, align: "right" },
  ];

  /* 生成/复制供应商确认链接。链接为 UUID token + 30 天有效期 + 单次使用，
     公开页只读且脱敏（不含内部价），供应商提交后回填逐行交期并推进状态机。
     外发渠道是人工/IT，所以这里只负责生成并把链接交到买手手上。 */
  const [tokenLoading, setTokenLoading] = useState(false);
  const genConfirmLink = useCallback(
    async (poId: number) => {
      setTokenLoading(true);
      try {
        const r = await fetchJson<{ token: string; path: string }>(`/api/outsource/po/${poId}/confirm-token`, {
          method: "POST",
        });
        const url = `${window.location.origin}${r.path}`;
        try {
          await navigator.clipboard.writeText(url);
          message.success("确认链接已生成并复制到剪贴板（30 天有效，仅可使用一次）");
        } catch {
          // 非安全上下文或剪贴板权限被拒时退化为可复制弹窗，绝不静默失败
          message.info("确认链接已生成（30 天有效，仅可使用一次）");
          window.prompt("复制以下链接发给供应商：", url);
        }
      } catch (e) {
        message.error((e as Error).message);
      } finally {
        setTokenLoading(false);
      }
    },
    [message],
  );

  const actions = detail ? (
    <Space>
      {detail.status === "draft" ? (
        <Popconfirm
          title="确认提交审批？提交时按 R1 比价，价格异动将生成价格变更申请。"
          okText="提交"
          cancelText="取消"
          onConfirm={() => void handleSubmit()}
        >
          <Button type="primary" loading={actionLoading}>
            提交
          </Button>
        </Popconfirm>
      ) : null}
      {detail.status === "pending" ? (
        <>
          <Popconfirm
            title="确认审批通过？"
            okText="通过"
            cancelText="取消"
            onConfirm={() =>
              void post("approve", { action: "approve", version: detail.version }, "审批已通过")
            }
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
      {detail.status === "approved" ? (
        <Button type="primary" loading={actionLoading} onClick={() => setConfirmOpen(true)}>
          确认（代录）
        </Button>
      ) : null}
      {/* 供应商确认链接：token 门户是 po_lines.expected_date 的**唯一**写入路径
          （内部「确认（代录）」只写表头 note/version，不写行级交期）。
          首版只加了回调没加这个按钮，回调成了编译进包却不可达的死代码。 */}
      {["approved", "in_progress"].includes(detail.status) ? (
        <Button loading={tokenLoading} onClick={() => void genConfirmLink(detail.id)}>
          生成供应商确认链接
        </Button>
      ) : null}
      {detail.status !== "draft" ? (
        <Button onClick={() => window.open(`/outsource/po/${detail.id}/print`, "_blank")}>打印采购单</Button>
      ) : null}
    </Space>
  ) : null;

  return (
    <div>
      <Typography.Title level={4} style={{ marginTop: 0 }}>
        采购订单（PO）
      </Typography.Title>
      <Typography.Paragraph type="secondary">
        采购订单由委外工单「生成单据」派生，本页不提供手工创建。
      </Typography.Paragraph>
      <Tabs
        activeKey={status}
        items={STATUS_TABS}
        onChange={(key) => listState.setFilter({ status: key })}
      />
      <ListToolbar
        state={listState}
        primaryActions={
          <Button icon={<ReloadOutlined />} onClick={() => void load()}>
            刷新
          </Button>
        }
        extra={
          <SearchInput
            key={q}
            allowClear
            defaultValue={q}
            placeholder="搜索单据号"
            style={{ width: 240 }}
            onSearch={(value) => listState.setFilter({ q: value.trim() })}
          />
        }
      />
      <Table<PoRow>
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
            "采购订单详情"
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
            <ChainStrip docType="po" id={detail.id} />
            {priceAlert ? (
              <Alert
                type="warning"
                showIcon
                closable
                onClose={() => setPriceAlert(null)}
                style={{ marginBottom: 16 }}
                message="存在价格异动，提交被阻塞"
                description={
                  <div>
                    <div>{priceAlert.text}</div>
                    {priceAlert.pcNos.length > 0 ? (
                      <div style={{ marginTop: 4 }}>
                        价格变更申请：{priceAlert.pcNos.join("、")}——请前往
                        <Typography.Link href="/outsource/pc">「价格变更」</Typography.Link>
                        页面审批通过后重新提交本单。
                      </div>
                    ) : null}
                  </div>
                }
              />
            ) : null}
            <Descriptions column={2} size="small" bordered style={{ marginBottom: 16 }}>
              <Descriptions.Item label="供应商">{detail.supplierName}</Descriptions.Item>
              <Descriptions.Item label="关联工单">
                {detail.woId != null ? `#${detail.woId}` : "—"}
              </Descriptions.Item>
              <Descriptions.Item label="预计到货">{detail.expectedDate ?? "—"}</Descriptions.Item>
              <Descriptions.Item label="确认时间">
                {detail.confirmedAt ? dayjs(detail.confirmedAt).format("YYYY-MM-DD HH:mm") : "未确认"}
              </Descriptions.Item>
              <Descriptions.Item label="确认备注">{detail.confirmNote ?? "—"}</Descriptions.Item>
              <Descriptions.Item label="制单人">{detail.createdByName ?? "—"}</Descriptions.Item>
              <Descriptions.Item label="制单时间">
                {dayjs(detail.createdAt).format("YYYY-MM-DD HH:mm")}
              </Descriptions.Item>
              <Descriptions.Item label="备注">{detail.remark ?? "—"}</Descriptions.Item>
            </Descriptions>
            <Typography.Title level={5}>明细行</Typography.Title>
            <Table<PoLine>
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
        title="驳回单据"
        open={rejectOpen}
        okText="确认驳回"
        okButtonProps={{ danger: true }}
        cancelText="取消"
        confirmLoading={actionLoading}
        onCancel={() => setRejectOpen(false)}
        onOk={() =>
          void post(
            "approve",
            {
              action: "reject",
              comment: rejectComment.trim() || undefined,
              version: detail?.version ?? 0,
            },
            "已驳回",
          ).then((ok) => {
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

      <Modal
        title="供应商确认（内部代录）"
        open={confirmOpen}
        okText="确认"
        cancelText="取消"
        confirmLoading={actionLoading}
        onCancel={() => setConfirmOpen(false)}
        onOk={() =>
          void post(
            "confirm",
            { version: detail?.version ?? 0, note: confirmNote.trim() || undefined },
            "已确认，单据进入执行中",
          ).then((ok) => {
            if (ok) {
              setConfirmOpen(false);
              setConfirmNote("");
            }
          })
        }
      >
        <Input.TextArea
          rows={3}
          maxLength={200}
          placeholder="确认备注（可选，如供应商回传信息）"
          value={confirmNote}
          onChange={(e) => setConfirmNote(e.target.value)}
        />
      </Modal>
    </div>
  );
}

export default function PoClient() {
  // useListState 读 useSearchParams，需要 Suspense 边界
  return (
    <Suspense>
      <PoInner />
    </Suspense>
  );
}
