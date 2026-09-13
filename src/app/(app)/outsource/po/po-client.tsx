"use client";

import { useLatestRead } from "@/components/useLatestRead";

import { useDocumentTarget } from "@/components/useDocumentTarget";
import { DOCUMENT_TRANSIENT_PARAMS, purchaseLineTarget } from "@/lib/document-links";
import { useSearchParams } from "next/navigation";
import { useDocumentRead } from "@/components/useDocumentRead";

import SearchInput from "@/components/SearchInput";

import { Suspense, useCallback, useEffect, useState } from "react";
import { App, Alert, Button, Descriptions, Input, Modal, Popconfirm, Space, Table, Tabs, Tag, Tooltip, Typography } from "antd";
import DocumentDrawer from "@/components/DocumentDrawer";
import type { ColumnsType } from "antd/es/table";
import { ReloadOutlined } from "@ant-design/icons";
import dayjs from "dayjs";
import ChainStrip from "@/components/ChainStrip";
import DocStatusTag from "@/components/DocStatusTag";
import DocTransitionActions from "@/components/DocTransitionActions";
import { fetchJson, postJson } from "@/components/fetchJson";
import { formatQty } from "@/components/format";
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
  /** 表头承诺交期（供应商门户逐行回填后表头取最晚一行） */
  expectedDate: string | null;
  confirmedAt: string | null;
  /** 服务端派生（po.ts poListProgress）：已收占比 %、逾期天数 */
  receivedPct: number | null;
  overdueDays: number | null;
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
  /** 行级承诺交期：供应商门户 po-confirm 逐行回填的唯一落点；空 = 沿用表头 */
  expectedDate: string | null;
}

/** 交期承诺变更事实（po_promise_revisions，仅追加）：门户确认 / 采购改期 / 历史回填 / 外部观察 */
interface PromiseRevision {
  id: number;
  poLineId: number;
  skuCode: string;
  skuName: string;
  sequence: number;
  previousDate: string | null;
  promisedDate: string | null;
  source: string;
  actorType: string;
  recordedByName: string | null;
  reason: string | null;
  externalSource: string | null;
  externalRef: string | null;
  occurredAt: string;
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
  closedReason: string | null;
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
  promiseRevisions: PromiseRevision[];
}

/** po_promise_revisions.source / actor_type 的中文标签（枚举见 db/schema） */
const PROMISE_SOURCE_LABELS: Record<string, string> = {
  supplier_confirm: "供应商确认",
  buyer_revision: "采购改期",
  legacy_backfill: "历史回填",
  external_observation: "外部观察",
};
const PROMISE_ACTOR_LABELS: Record<string, string> = {
  supplier_token: "供应商（门户令牌）",
  internal_user: "内部用户",
  system_backfill: "系统回填",
  external_system: "外部系统",
};

const STATUS_TABS = [
  { key: "", label: "全部" },
  { key: "draft", label: "草稿" },
  { key: "pending", label: "待审批" },
  { key: "approved", label: "已审批" },
  { key: "in_progress", label: "执行中" },
  { key: "completed", label: "已完成" },
  // 手工短关后单据落到 closed，没有页签就等于「短关完就找不到了」
  { key: "closed", label: "已短关" },
];

const LINE_TYPE_LABELS: Record<string, string> = { raw: "原料", packaging: "包材" };

function PoInner() {
  const searchParams = useSearchParams();
  const hasRequestedLine = searchParams.has("poLineId");
  const requestedLineId = purchaseLineTarget(searchParams.toString());
  const { message } = App.useApp();
  const [rows, setRows] = useState<PoRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  // 列表页状态平台（E6-P1）：筛选/分页进 URL，密度与已保存视图存本地
  const listState = useListState({ transientParams: DOCUMENT_TRANSIENT_PARAMS, key: "po", defaults: { q: "", status: "" }, defaultPageSize: 20 });
  const { filters, page, pageSize } = listState;
  const q = filters.q;
  const status = filters.status;

  const documentSelection = useDocumentTarget();
  const { id: detailId, setId: setDetailId } = documentSelection;
  useEffect(() => { setRejectOpen(false); setConfirmOpen(false); }, [detailId]);
  const detailRead = useDocumentRead<PoDetail>(detailId == null ? null : `/api/outsource/po/${detailId}`);
  const detail = detailRead.data;
  const detailLoading = detailRead.phase === "loading";
  const loadDetail = detailRead.retry;
  const [actionLoading, setActionLoading] = useState(false);

  /** R1：提交遇价格异动时的警示（含 PC 单号） */
  const [priceAlert, setPriceAlert] = useState<{ text: string; pcNos: string[] } | null>(null);

  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectComment, setRejectComment] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmNote, setConfirmNote] = useState("");

  const beginLoadRead = useLatestRead();
  const load = useCallback(async () => {
    const readRequest = beginLoadRead();
    setLoading(true);
    try {
      const params = new URLSearchParams({ q, page: String(page), pageSize: String(pageSize) });
      if (status) params.set("status", status);
      const res = await fetchJson<{ rows: PoRow[]; total: number }>(
        `/api/outsource/po?${params.toString()}`, { signal: readRequest.signal });
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

  useEffect(() => { setPriceAlert(null); }, [detailId]);

  const refresh = () => {
    if (detail) void loadDetail();
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
        void loadDetail();
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
    // 交期承诺与履约进度：接口一直返回 expectedDate/confirmedAt，列表却整列丢掉——
    // 采购只能靠一张张点开抽屉才知道哪张单晚了。
    {
      title: "预计到货",
      dataIndex: "expectedDate",
      width: 110,
      render: (v: string | null) => v ?? <Typography.Text type="secondary">未承诺</Typography.Text>,
    },
    {
      title: "已确认",
      dataIndex: "confirmedAt",
      width: 130,
      render: (v: string | null) =>
        v ? <Tag color="green">{dayjs(v).format("YYYY-MM-DD")}</Tag> : <Tag>未确认</Tag>,
    },
    {
      title: "已收%",
      dataIndex: "receivedPct",
      width: 90,
      align: "right",
      render: (v: number | null) =>
        v == null ? <Typography.Text type="secondary">—</Typography.Text>
          : <Typography.Text style={{ color: v >= 100 ? "#52c41a" : v > 0 ? "#1677ff" : undefined }}>{formatQty(v)}%</Typography.Text>,
    },
    {
      title: "逾期",
      dataIndex: "overdueDays",
      width: 90,
      align: "right",
      render: (v: number | null) =>
        v == null ? <Typography.Text type="secondary">—</Typography.Text>
          : <Tag color="red">逾期 {v} 天</Tag>,
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
    { title: "采购行", dataIndex: "id", width: 100, render: (id: number) => <span>{`#${id}`}{id === requestedLineId ? <Tag color="blue">已定位</Tag> : null}</span> },
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
    // 行级承诺交期：供应商门户逐行回填的唯一落点。此前 getPo 根本没 select 这一列，
    // 供应商在门户上按行改了交期，内部页面一个字都看不到。
    {
      title: "行承诺交期",
      dataIndex: "expectedDate",
      width: 120,
      render: (v: string | null) =>
        v ?? (
          <Tooltip title="该行没有单独的承诺交期，按表头「预计到货」执行">
            <Typography.Text type="secondary">同表头</Typography.Text>
          </Tooltip>
        ),
    },
  ];

  const promiseColumns: ColumnsType<PromiseRevision> = [
    { title: "时间", dataIndex: "occurredAt", width: 140, render: (v: string) => dayjs(v).format("YYYY-MM-DD HH:mm") },
    { title: "物料", key: "sku", render: (_, r) => `${r.skuCode} ${r.skuName}` },
    { title: "第几次", dataIndex: "sequence", width: 80, align: "right" },
    {
      title: "承诺交期变化",
      key: "change",
      width: 190,
      render: (_, r) => (
        <span>
          {r.previousDate ?? "未承诺"} → <Typography.Text strong>{r.promisedDate ?? "撤销承诺"}</Typography.Text>
        </span>
      ),
    },
    { title: "来源", dataIndex: "source", width: 110, render: (v: string) => PROMISE_SOURCE_LABELS[v] ?? v },
    {
      title: "操作方",
      key: "actor",
      width: 150,
      render: (_, r) =>
        `${PROMISE_ACTOR_LABELS[r.actorType] ?? r.actorType}${r.recordedByName ? ` · ${r.recordedByName}` : ""}`,
    },
    {
      title: "说明",
      key: "reason",
      render: (_, r) =>
        r.reason ?? (r.externalSource ? `${r.externalSource}${r.externalRef ? ` #${r.externalRef}` : ""}` : "—"),
    },
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
          {/* 撤回：制单人收回自己的提交（服务端校验 createdBy，非制单人会被拒） */}
          <Popconfirm
            title="撤回本单？"
            description="撤回后回到草稿，可继续修改再提交。"
            okText="撤回"
            cancelText="取消"
            onConfirm={() => void post("withdraw", { version: detail.version }, "已撤回，单据回到草稿")}
          >
            <Button loading={actionLoading}>撤回</Button>
          </Popconfirm>
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
            placeholder="搜索单号 / SKU 编码 / 货品名称"
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

      <DocumentDrawer
        key={detailId ?? "invalid-document"}
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
            <ChainStrip docType="po" id={detail.id} />
            <DocTransitionActions docType="po" doc={detail} onChanged={refresh} labels={{
              completeHint: "请先核对实际履约。本操作只标记本采购单完成、移除其未结供给；不补记收货、不修改已收数量，也不自动关闭关联工单。",
              shortCloseHint: "供应商不再补齐余量时短关，并停止本采购单的后续到货预期。已收及库存事实保持不变；关联工单仍须另行核对处理。",
            }} />
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
            <Descriptions column={{ xs: 1, sm: 2 }} size="small" bordered styles={{ label: { width: 112, whiteSpace: "nowrap" } }} style={{ marginBottom: 16 }}>
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
              {detail.closedReason ? <Descriptions.Item label="短关原因" span={{ xs: 1, sm: 2 }}>{detail.closedReason}</Descriptions.Item> : null}
            </Descriptions>
            <Typography.Title level={5}>明细行</Typography.Title>
            {hasRequestedLine ? <Alert showIcon style={{ marginBottom: 8 }}
              type={detail.lines.some(line => line.id === requestedLineId) ? "info" : "warning"}
              message={detail.lines.some(line => line.id === requestedLineId)
                ? `来源报表指定采购行 #${requestedLineId}，下表已标记；数量与交期请以本单当前记录核对。`
                : requestedLineId == null ? "采购行链接格式无效，请向发送人索取正确链接。"
                  : `来源链接的采购行 #${requestedLineId} 不在本单内，请核对来源，不自动匹配同SKU其他行。`} /> : null}
            <Table<PoLine>
              rowKey="id"
              size="small"
              columns={lineColumns}
              dataSource={detail.lines}
              onRow={line => ({ style: line.id === requestedLineId ? { background: "#e6f4ff" } : undefined })}
              pagination={false}
              scroll={{ x: "max-content" }}
              style={{ marginBottom: 24 }}
            />
            {/* 交期承诺变更时间线：po_promise_revisions 是仅追加事实表，此前只被写不被读——
                供应商在门户上改了三次交期，内部页面看不到任何痕迹，只剩最后一个日期。 */}
            <Typography.Title level={5}>交期承诺变更</Typography.Title>
            <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
              仅追加事实：每次「有效承诺日」变化留一行，不覆盖历史。行交期优先，缺省继承表头。
            </Typography.Paragraph>
            <Table<PromiseRevision>
              rowKey="id"
              size="small"
              columns={promiseColumns}
              dataSource={detail.promiseRevisions}
              pagination={false}
              scroll={{ x: "max-content" }}
              style={{ marginBottom: 24 }}
              locale={{ emptyText: "尚无交期承诺变更记录（供应商确认或采购改期后会在此留痕）" }}
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
