"use client";

import { useLatestRead } from "@/components/useLatestRead";

import { useDocumentTarget } from "@/components/useDocumentTarget";
import { DOCUMENT_TRANSIENT_PARAMS } from "@/lib/document-links";
import { useDocumentRead } from "@/components/useDocumentRead";
import { formatQty } from "@/components/format";
import DocumentDrawer from "@/components/DocumentDrawer";

import SearchInput from "@/components/SearchInput";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { hasAnyRole, useMe } from "@/components/useMe";
import { initialWoPurchaseGroups, isWoGenerationReceipt } from "@/lib/wo-generation";
import { App, Alert, Button, DatePicker, Descriptions, Divider, Form, Input, InputNumber, Modal, Popconfirm, Space, Table, Tabs, Tag, Tooltip, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import {
  DeleteOutlined,
  InfoCircleOutlined,
  PlusOutlined,
  ReloadOutlined,
  ThunderboltOutlined,
} from "@ant-design/icons";
import dayjs, { type Dayjs } from "dayjs";
import RemoteSelect from "@/components/RemoteSelect";
import SourcingAidPanel from "./sourcing-aid-panel";
import ChainStrip from "@/components/ChainStrip";
import DocStatusTag from "@/components/DocStatusTag";
import DocTransitionActions from "@/components/DocTransitionActions";
import DocWindowFilterTag from "@/components/DocWindowFilterTag";
import { fetchJson, postJson } from "@/components/fetchJson";
import ListToolbar from "@/components/ListToolbar";
import { useListState } from "@/components/useListState";
import { formatOrderType } from "@/components/labels";
import WoCreateDialog from "./wo-create-dialog";
import ApprovalTimeline from "@/components/ApprovalTimeline";
import type { WoTaskActions } from "@/server/modules/outsource/wo-task-actions";

interface WoRow {
  id: number;
  docNo: string;
  status: string;
  productSkuCode: string;
  productSkuName: string;
  qty: string;
  supplierName: string;
  orderType: string | null;
  dueDate: string | null;
  createdByName: string | null;
  createdAt: string;
}

interface WoLine {
  id: number;
  materialSkuId: number;
  skuCode: string;
  skuName: string;
  baseUom: string;
  qtyPer: string;
  planLossRatePct: string;
  grossReq: string;
  onHandAt: string;
  inTransitAt: string;
  suggestedQty: string;
}

interface DocApproval {
  approverName: string | null;
  action: "approve" | "reject";
  comment: string | null;
  createdAt: string;
}

interface WoDetail {
  taskActions: WoTaskActions | null;
  id: number;
  docNo: string;
  status: string;
  remark: string | null;
  closedReason: string | null;
  version: number;
  bhId: number | null;
  productSkuId: number;
  productSkuCode: string;
  productSkuName: string;
  qty: string;
  supplierId: number;
  supplierName: string;
  /** 敏感字段：非可见角色时后端已剥离（键不存在） */
  feeRatePlan?: string;
  orderType: string | null;
  dueDate: string | null;
  bomId: number;
  createdAt: string;
  createdByName: string | null;
  lines: WoLine[];
  approvals: DocApproval[];
}

interface GenerateFormValues {
  poGroups?: {
    supplierId: number;
    lines?: { materialSkuId: number; qty: string | number; price: string | number }[];
  }[];
  jgQty?: string | number;
  jgDueDate?: Dayjs;
}

const STATUS_TABS = [
  { key: "", label: "全部" },
  { key: "draft", label: "草稿" },
  { key: "pending", label: "待审批" },
  { key: "approved", label: "已审批" },
  // 手工收口后单据落到 completed/closed，没有页签就等于「短关完就找不到了」
  { key: "completed", label: "已完成" },
  { key: "closed", label: "已短关" },
];

export function WoActions({
  doc,
  onChanged,
  onError,
  blocked,
}: {
  doc: { id: number; status: string; version: number; taskActions: WoTaskActions | null };
  onChanged: () => void;
  onError: (message: string) => void;
  blocked: boolean;
}) {
  const { message } = App.useApp();
  const [loading, setLoading] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectComment, setRejectComment] = useState("");
  const pending = useRef(false), failed = useRef(false), alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const post = async (path: "submit" | "approve" | "withdraw", body: { version: number; action?: "approve" | "reject"; comment?: string }, successText: string) => {
    const permission = path === "approve" ? body.action === "reject" ? "reject" : "approve" : path;
    if (pending.current || failed.current || blocked || !doc.taskActions?.[permission]) return false;
    pending.current = true;
    setLoading(true);
    try {
      await postJson(`/api/outsource/wo/${doc.id}/${path}`, body);
      if (!alive.current) return false;
      message.success(successText);
      onChanged();
      return true;
    } catch (e) {
      failed.current = true;
      if (alive.current) onError(`${e instanceof Error ? e.message : "未取得处理结果"}。请先刷新核对当前单据状态与审批记录，勿重复提交。`);
      return false;
    } finally {
      pending.current = false;
      if (alive.current) setLoading(false);
    }
  };

  if (!doc.taskActions || blocked) return null;
  if (doc.status === "draft" && doc.taskActions.submit) {
    return (
      <Popconfirm
        title="确认提交审批？"
        okText="提交"
        cancelText="取消"
        onConfirm={() => void post("submit", { version: doc.version }, "已提交审批")}
      >
        <Button type="primary" loading={loading}>
          提交
        </Button>
      </Popconfirm>
    );
  }

  // Closure lives in the drawer body so terminal documents retain recovery feedback.
  if (doc.taskActions.manage) return null;

  if (doc.status === "pending") {
    return (
      <Space wrap>
        {doc.taskActions.approve ? <Popconfirm
          title="确认审批通过？通过后将按本工单BOM冻结需求快照。"
          okText="通过"
          cancelText="取消"
          onConfirm={() =>
            void post("approve", { action: "approve", version: doc.version }, "审批已通过")
          }
        >
          <Button type="primary" loading={loading}>
            审批通过
          </Button>
        </Popconfirm> : null}
        {doc.taskActions.reject ? <Button danger loading={loading} onClick={() => setRejectOpen(true)}>
          驳回
        </Button> : null}
        {/* 撤回：制单人收回自己的提交（服务端校验 createdBy，非制单人会被拒） */}
        {doc.taskActions.withdraw ? <Popconfirm
          title="撤回本单？"
          description="撤回后回到草稿，可继续修改再提交。"
          okText="撤回"
          cancelText="取消"
          onConfirm={() => void post("withdraw", { version: doc.version }, "已撤回，单据回到草稿")}
        >
          <Button loading={loading}>撤回</Button>
        </Popconfirm> : null}
        <Modal
          title="驳回单据"
          open={rejectOpen && doc.taskActions.reject}
          okText="确认驳回"
          okButtonProps={{ danger: true }}
          cancelText="取消"
          confirmLoading={loading}
          zIndex={1100}
          closable={!loading}
          maskClosable={false}
          cancelButtonProps={{ disabled: loading }}
          onCancel={() => { if (!pending.current) setRejectOpen(false); }}
          onOk={() =>
            void post(
              "approve",
              { action: "reject", comment: rejectComment.trim() || undefined, version: doc.version },
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
            disabled={loading}
            rows={3}
            maxLength={200}
            placeholder="驳回意见（可选）"
            value={rejectComment}
            onChange={(e) => setRejectComment(e.target.value)}
          />
        </Modal>
      </Space>
    );
  }

  return null;
}

function WoInner() {
  const { message, modal } = App.useApp();
  const me = useMe();
  const canGenerate = hasAnyRole(me, "pmc");
  const [genForm] = Form.useForm<GenerateFormValues>();
  const [rows, setRows] = useState<WoRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  // 列表页状态平台（E6-P1）：筛选/分页进 URL，密度与已保存视图存本地
  // from/to = 制单时间窗（上海业务日，含首尾）：全链漏斗「下单」级点数字回链到本页时带过来
  const listState = useListState({ transientParams: DOCUMENT_TRANSIENT_PARAMS, key: "wo", defaults: { q: "", status: "", from: "", to: "" }, defaultPageSize: 20 });
  const { filters, page, pageSize } = listState;
  const q = filters.q;
  const status = filters.status;
  const from = filters.from;
  const to = filters.to;

  const [createOpen, setCreateOpen] = useState(false);

  const documentSelection = useDocumentTarget();
  const { id: detailId, setId: setDetailId } = documentSelection;
  const targetId = useRef(detailId);
  targetId.current = detailId;
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { setGenOpen(false); }, [detailId]);
  const detailRead = useDocumentRead<WoDetail>(detailId == null ? null : `/api/outsource/wo/${detailId}`);
  const detail = detailRead.data;
  const detailLoading = detailRead.phase === "loading";
  const generatedJg = useDocumentRead<{ rows: { docNo: string }[] }>(
    detail?.status === "approved" ? `/api/outsource/jg?woId=${detail.id}&page=1&pageSize=1` : null,
  );
  const generatedKnown = generatedJg.phase === "success" && Array.isArray(generatedJg.data?.rows);
  const existingJgNo = generatedKnown ? generatedJg.data?.rows[0]?.docNo ?? null : null;
  const loadDetail = () => { detailRead.retry(); generatedJg.retry(); };

  const [genOpen, setGenOpen] = useState(false);
  const [generating, setGenerating] = useState(false);
  const generatingRef = useRef(false);
  const [generationError, setGenerationError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<{ id: number; message: string } | null>(null);

  const beginLoadRead = useLatestRead();
  const load = useCallback(async () => {
    const readRequest = beginLoadRead();
    setLoading(true);
    try {
      const params = new URLSearchParams({ q, page: String(page), pageSize: String(pageSize) });
      if (status) params.set("status", status);
      if (from) params.set("from", from);
      if (to) params.set("to", to);
      const res = await fetchJson<{ rows: WoRow[]; total: number }>(
        `/api/outsource/wo?${params.toString()}`, { signal: readRequest.signal });
      if (!readRequest.isCurrent()) return;
      setRows(res.rows);
      setTotal(res.total);
    } catch (e) {
      if (!readRequest.isCurrent()) return;
      message.error((e as Error).message);
    } finally {
      if (readRequest.isCurrent()) { setLoading(false); }
    }
  }, [beginLoadRead, q, status, from, to, page, pageSize, message]);

  useEffect(() => {
    void load();
  }, [load]);
  const openGenerate = () => {
    if (!detail || !canGenerate || generatingRef.current || !generatedKnown || existingJgNo) return;
    setGenerationError(null);
    genForm.resetFields();
    genForm.setFieldsValue({
      poGroups: initialWoPurchaseGroups(detail.supplierId, detail.lines),
      jgQty: detail.qty,
      jgDueDate: detail.dueDate ? dayjs(detail.dueDate) : undefined,
    });
    setGenOpen(true);
  };

  const handleGenerate = async () => {
    if (!detail || !canGenerate || generatingRef.current || generationError) return;
    const source = { id: detail.id, docNo: detail.docNo };
    generatingRef.current = true;
    setGenerating(true);
    let submitted = false;
    try {
      const values = await genForm.validateFields();
      if (!mounted.current || targetId.current !== source.id) return;
      if ((values.poGroups ?? []).some(g => !g?.supplierId || !g.lines?.length)) {
        message.error("每个 PO 分组必须选择供应商并至少添加一行；不采购时请删除该分组。");
        return;
      }
      const groups = (values.poGroups ?? [])
        .map((g) => ({
          supplierId: g.supplierId,
          lines: (g.lines ?? []).map((l) => ({
            materialSkuId: l.materialSkuId,
            qty: String(l.qty),
            price: String(l.price ?? 0),
          })),
        }));
      submitted = true;
      const res = await postJson<unknown>(
        `/api/outsource/wo/${source.id}/generate`,
        {
          poGroups: groups,
          jg: {
            qty: values.jgQty != null ? String(values.jgQty) : undefined,
            dueDate: values.jgDueDate ? values.jgDueDate.format("YYYY-MM-DD") : undefined,
          },
        },
      );
      if (!isWoGenerationReceipt(res)) throw new Error("生成回执不完整，请核对来源工单下的已有单据");
      if (!mounted.current) return;
      setGenOpen(false);
      const receipt = modal.success({
        title: `${source.docNo}：草稿已生成，尚未提交审批`,
        zIndex: 1200,
        content: (
          <div>
            {res.pos.map(p => <div key={p.id}>采购订单：<Link onClick={() => receipt.destroy()} href={`/outsource/po?docId=${p.id}`}>{p.docNo}</Link></div>)}
            <div>加工通知单：<Link onClick={() => receipt.destroy()} href={`/outsource/jg?docId=${res.jg.id}`}>{res.jg.docNo}</Link></div>
          </div>
        ),
      });
      if (targetId.current === source.id) loadDetail();
      void load();
    } catch (e) {
      if (!mounted.current) return;
      if (submitted && targetId.current === source.id) {
        setGenerationError(`${source.docNo}：${e instanceof Error ? e.message : "未取得生成结果"}。勿重复提交，请先刷新核对已有单据。`);
      } else if (e instanceof Error && e.message) message.error(e.message);
    } finally {
      generatingRef.current = false;
      if (mounted.current) setGenerating(false);
    }
  };

  const columns: ColumnsType<WoRow> = [
    {
      title: "单据号",
      dataIndex: "docNo",
      width: 160,
      render: (v: string, r) => (
        <Typography.Link onClick={() => setDetailId(r.id)}>{v}</Typography.Link>
      ),
    },
    {
      title: "成品",
      key: "product",
      render: (_, r) => `${r.productSkuCode} ${r.productSkuName}`,
    },
    { title: "数量", dataIndex: "qty", width: 100, align: "right" },
    { title: "加工厂", dataIndex: "supplierName", width: 140 },
    {
      title: "订单类型",
      dataIndex: "orderType",
      width: 110,
      render: (v: string | null) => (v ? <Tag color="blue">{formatOrderType(v)}</Tag> : "—"),
    },
    { title: "交期", dataIndex: "dueDate", width: 110, render: (v: string | null) => v ?? "—" },
    { title: "状态", dataIndex: "status", width: 100, render: (v: string) => <DocStatusTag status={v} /> },
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

  const lineColumns: ColumnsType<WoLine> = [
    { title: "物料", key: "material", render: (_, r) => `${r.skuCode} ${r.skuName}` },
    { title: "单位用量", dataIndex: "qtyPer", width: 90, align: "right" },
    { title: "损耗率%", dataIndex: "planLossRatePct", width: 85, align: "right" },
    { title: "毛需求", dataIndex: "grossReq", width: 100, align: "right" },
    {
      title: (
        <Tooltip title="自有实时仓口径，不含保税/云仓（D20）">
          在手 <InfoCircleOutlined />
        </Tooltip>
      ),
      dataIndex: "onHandAt",
      width: 100,
      align: "right",
    },
    { title: "在途", dataIndex: "inTransitAt", width: 100, align: "right" },
    { title: "建议量", dataIndex: "suggestedQty", width: 100, align: "right" },
  ];

  return (
    <div>
      <Typography.Title level={4} style={{ marginTop: 0 }}>
        委外工单（WO）
      </Typography.Title>
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
            <Button
              type="primary"
              icon={<PlusOutlined />}
              disabled={!canGenerate}
              onClick={() => {
                setCreateOpen(true);
              }}
            >
              新建委外工单
            </Button>
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
      <WoCreateDialog key={me?.id ?? "no-actor"} actorId={me?.id ?? null} allowed={canGenerate} open={createOpen}
        onClose={() => setCreateOpen(false)} onResume={() => setCreateOpen(true)} onCreated={() => { void load(); }} />
      <Table<WoRow>
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
            "委外工单详情"
          )
        }
        open={documentSelection.present}
        readError={documentSelection.error ?? detailRead.error}
        onRetry={detailId != null ? detailRead.retry : undefined}
        onClose={() => { if (!generatingRef.current) setDetailId(null); }}
        width={860}
        loading={detailLoading}
        extra={
          detail ? (
            <Space>
              {detail.taskActions?.generate && detail.status === "approved" && generatedKnown && existingJgNo == null ? (
                <Button type="primary" disabled={generating} icon={<ThunderboltOutlined />} onClick={openGenerate}>
                  生成单据
                </Button>
              ) : null}
              <WoActions
                key={`${detail.id}:${detail.version}`}
                doc={detail}
                blocked={actionError?.id === detail.id}
                onError={(message) => setActionError({ id: detail.id, message })}
                onChanged={() => {
                  void loadDetail();
                  void load();
                }}
              />
            </Space>
          ) : null
        }
      >
        {detail ? (
          <div>
            <ChainStrip docType="wo" id={detail.id} />
            <DocTransitionActions docType="wo" doc={detail} allowed={Boolean(detail.taskActions?.manage)}
              onChanged={() => { loadDetail(); void load(); }} labels={{
                completeHint: "请先核对实际完工。本操作只更新本工单状态，不自动关闭关联采购单、加工通知单或补记收货；关联单据须分别核对。",
                shortCloseHint: "少做、终止或换厂时记录本工单停止继续生产的决定。已发生的加工、收货及库存不变；关联采购单与加工通知单不会自动短关。",
              }} />
            <Alert type={actionError?.id === detail.id ? "error" : detail.taskActions ? "info" : "warning"} showIcon style={{ marginBottom: 12 }}
              message={actionError?.id === detail.id ? "处理结果需要核对" : "当前操作资格"}
              description={actionError?.id === detail.id ? actionError.message : detail.taskActions?.reason ?? "当前无法确认操作资格，请刷新后核对；暂不显示写入按钮。"}
              action={<Button onClick={() => { setActionError(null); loadDetail(); }}>刷新核对</Button>} />
            {detail.status === "approved" && !generatedKnown ? (
              <Alert type={generatedJg.phase === "loading" ? "info" : "warning"} showIcon
                message={generatedJg.phase === "loading" ? "正在核对已生成单据…" : "暂不能核实是否已生成加工通知单"}
                description={generatedJg.error ?? "核对成功后才可生成单据，避免重复操作。"}
                action={generatedJg.phase !== "loading" ? <Button onClick={generatedJg.retry}>重试核对</Button> : undefined} />
            ) : null}
            {detail.status === "approved" && existingJgNo != null ? (
              <Alert
                type="info"
                showIcon
                style={{ marginBottom: 16 }}
                message={`该工单已生成加工通知单 ${existingJgNo}，不可重复生成。`}
              />
            ) : null}
            <Descriptions column={{ xs: 1, sm: 2, md: 2, lg: 2, xl: 2, xxl: 2 }} size="small" bordered style={{ marginBottom: 16 }}>
              <Descriptions.Item label="成品" span={{ xs: 1, sm: 2, md: 2, lg: 2, xl: 2, xxl: 2 }}>
                {detail.productSkuCode} {detail.productSkuName}
              </Descriptions.Item>
              <Descriptions.Item label="数量">{formatQty(detail.qty)}</Descriptions.Item>
              <Descriptions.Item label="加工厂">{detail.supplierName}</Descriptions.Item>
              <Descriptions.Item label="加工费计划单价">
                {detail.feeRatePlan != null ? detail.feeRatePlan : "—"}
              </Descriptions.Item>
              <Descriptions.Item label="订单类型">{formatOrderType(detail.orderType)}</Descriptions.Item>
              <Descriptions.Item label="交期">{detail.dueDate ?? "—"}</Descriptions.Item>
              <Descriptions.Item label="关联备货申请">
                {detail.bhId != null ? `#${detail.bhId}` : "—"}
              </Descriptions.Item>
              <Descriptions.Item label="BOM">#{detail.bomId}</Descriptions.Item>
              <Descriptions.Item label="制单人">{detail.createdByName ?? "—"}</Descriptions.Item>
              <Descriptions.Item label="制单时间">
                {dayjs(detail.createdAt).format("YYYY-MM-DD HH:mm")}
              </Descriptions.Item>
              <Descriptions.Item label="备注" span={{ xs: 1, sm: 2 }}>
                {detail.remark ?? "—"}
              </Descriptions.Item>
              {detail.closedReason ? <Descriptions.Item label="短关原因" span={{ xs: 1, sm: 2 }}>{detail.closedReason}</Descriptions.Item> : null}
            </Descriptions>
            <Typography.Title level={5}>需求表（wo_line 快照）</Typography.Title>
            {detail.lines.length > 0 ? (
              <Table<WoLine>
                rowKey="id"
                size="small"
                columns={lineColumns}
                dataSource={detail.lines}
                pagination={false}
                style={{ marginBottom: 24 }}
              />
            ) : (
              <Typography.Paragraph type="secondary" style={{ marginBottom: 24 }}>
                审批通过后按生效 BOM 生成需求快照（毛需求/在手/在途/建议量）。
              </Typography.Paragraph>
            )}
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
        title={`生成采购订单 / 加工通知单${detail ? ` — ${detail.docNo}` : ""}`}
        zIndex={1100}
        open={genOpen}
        onOk={() => void handleGenerate()}
        onCancel={() => { if (!generatingRef.current) { setGenOpen(false); loadDetail(); } }}
        confirmLoading={generating}
        okButtonProps={{ disabled: !!generationError }}
        cancelButtonProps={{ disabled: generating }}
        closable={!generating}
        keyboard={!generating}
        width="min(860px, calc(100vw - 24px))"
        forceRender
        maskClosable={false}
        okText="生成"
        cancelText="取消"
      >
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          message="仅预填建议采购量大于零的物料；零建议不会替换为毛需求。可人工添加或调整 PO，同时生成 1 张 JG 草稿，仍须提交审批。快照不代表当前可用量，请先核对库存、在途与供应商。"
        />
        {generationError ? <Alert type="error" showIcon message="生成结果需核对" description={generationError}
          style={{ marginBottom: 16 }} action={<Button onClick={() => { setGenOpen(false); loadDetail(); }}>刷新核对</Button>} /> : null}
        {/* W2 审计 6：这里是全系统唯一一个真的在选供应商的地方，此前只有一个光秃秃的下拉框。
            面板只读——摆事实，不排名次、不自动改表单。 */}
        <SourcingAidPanel
          skuOptions={(genOpen ? detail?.lines ?? [] : []).map((l) => ({ value: l.materialSkuId, label: `${l.skuCode} ${l.skuName}` }))}
        />
        <Form form={genForm} layout="vertical" disabled={generating || !!generationError}>
          <Form.List name="poGroups">
            {(groups, { add: addGroup, remove: removeGroup }) => (
              <div>
                {groups.map((group) => (
                  <div
                    key={group.key}
                    style={{ border: "1px solid #f0f0f0", borderRadius: 8, padding: 12, marginBottom: 12 }}
                  >
                    <Space align="baseline" wrap style={{ display: "flex", justifyContent: "space-between" }}>
                      <Form.Item
                        name={[group.name, "supplierId"]}
                        label="供应商"
                        rules={[{ required: true, message: "必须选择供应商" }]}
                        style={{ marginBottom: 8 }}
                      >
                        <RemoteSelect
                          api="/api/master/supplier"
                          getLabel={(r) => `${String(r.code)} ${String(r.name)}`}
                          placeholder="选择供应商"
                          style={{ width: "min(280px, calc(100vw - 128px))" }}
                        />
                      </Form.Item>
                      <Button
                        type="text"
                        danger
                        icon={<DeleteOutlined />}
                        onClick={() => removeGroup(group.name)}
                      >
                        删除该 PO
                      </Button>
                    </Space>
                    <Form.List name={[group.name, "lines"]}>
                      {(lines, { add: addLine, remove: removeLine }) => (
                        <div>
                          {lines.map((line) => (
                            <Space key={line.key} align="baseline" style={{ display: "flex", marginBottom: 4 }} wrap>
                              <Form.Item
                                name={[line.name, "materialSkuId"]}
                                rules={[{ required: true, message: "必须选择物料" }]}
                                style={{ marginBottom: 8 }}
                              >
                                <RemoteSelect
                                  api="/api/master/sku?type=raw,packaging"
                                  getLabel={(r) => `${String(r.code)} ${String(r.name)}`}
                                  placeholder="选择物料（原料/包材）"
                                  style={{ width: "min(300px, calc(100vw - 128px))" }}
                                />
                              </Form.Item>
                              <Form.Item
                                name={[line.name, "qty"]}
                                rules={[{ required: true, message: "数量必填" }]}
                                style={{ marginBottom: 8 }}
                              >
                                <InputNumber stringMode min="0.0001" max="9999999999.9999" precision={4} placeholder="数量" style={{ width: 130 }} />
                              </Form.Item>
                              <Form.Item
                                name={[line.name, "price"]}
                                rules={[{ required: true, message: "单价必填" }]}
                                style={{ marginBottom: 8 }}
                              >
                                <InputNumber stringMode min="0" max="999999999999.99" precision={2} placeholder="单价" style={{ width: 120 }} />
                              </Form.Item>
                              <Button
                                type="text"
                                danger
                                icon={<DeleteOutlined />}
                                onClick={() => removeLine(line.name)}
                              />
                            </Space>
                          ))}
                          <Button type="dashed" block icon={<PlusOutlined />} onClick={() => addLine({ price: 0 })}>
                            添加物料行
                          </Button>
                        </div>
                      )}
                    </Form.List>
                  </div>
                ))}
                <Button
                  type="dashed"
                  block
                  icon={<PlusOutlined />}
                  onClick={() => addGroup({ lines: [] })}
                >
                  添加 PO 分组（按供应商）
                </Button>
              </div>
            )}
          </Form.List>
          <Divider />
          <Typography.Text strong>加工通知单（JG）</Typography.Text>
          <Space style={{ marginTop: 8 }} align="baseline" wrap>
            <Form.Item name="jgQty" label="加工数量" style={{ marginBottom: 8 }}>
              <InputNumber stringMode min="0.0001" max={detail?.qty} precision={4} style={{ width: 160 }} />
            </Form.Item>
            <Form.Item name="jgDueDate" label="交期" style={{ marginBottom: 8 }}>
              <DatePicker style={{ width: 160 }} />
            </Form.Item>
          </Space>
        </Form>
      </Modal>
    </div>
  );
}

export default function WoClient() {
  // useListState 读 useSearchParams，需要 Suspense 边界
  return (
    <Suspense>
      <WoInner />
    </Suspense>
  );
}
