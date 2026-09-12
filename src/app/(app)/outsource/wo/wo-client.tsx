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
import { App, Alert, Button, DatePicker, Descriptions, Divider, Form, Input, InputNumber, Modal, Popconfirm, Select, Space, Table, Tabs, Tag, Tooltip, Typography } from "antd";
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
import { ORDER_TYPE_LABELS, formatOrderType, toOptions } from "@/components/labels";
import ApprovalTimeline from "@/components/ApprovalTimeline";

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
  id: number;
  docNo: string;
  status: string;
  remark: string | null;
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

interface CreateFormValues {
  bhId?: number;
  productSkuId: number;
  qty: number;
  supplierId: number;
  feeRatePlan: number;
  dueDate?: Dayjs;
  orderType?: string;
  remark?: string;
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

function WoActions({
  doc,
  onChanged,
}: {
  doc: { id: number; status: string; version: number };
  onChanged: () => void;
}) {
  const { message } = App.useApp();
  const [loading, setLoading] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectComment, setRejectComment] = useState("");

  const post = async (path: string, body: unknown, successText: string) => {
    setLoading(true);
    try {
      await postJson(`/api/outsource/wo/${doc.id}/${path}`, body);
      message.success(successText);
      onChanged();
      return true;
    } catch (e) {
      message.error((e as Error).message);
      return false;
    } finally {
      setLoading(false);
    }
  };

  if (doc.status === "draft") {
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

  // 已审批之后没有任何「收口」动作时，工单永远停在半路（在办量只增不减）——补手工完成/短关
  if (doc.status === "approved" || doc.status === "in_progress") {
    return (
      <DocTransitionActions
        docType="wo"
        doc={doc}
        onChanged={onChanged}
        labels={{
          completeHint: "标记本工单已完工：加工通知单与收货已按实际收口，后续不再产生新的收货。",
          shortCloseHint: "短关＝加工厂不再继续做这张工单的剩余数量（少做/终止/换厂）。已发生的加工与收货保持不变，仅停止后续执行。",
        }}
      />
    );
  }

  if (doc.status === "pending") {
    return (
      <Space>
        <Popconfirm
          title="确认审批通过？通过后将按生效 BOM 生成需求快照。"
          okText="通过"
          cancelText="取消"
          onConfirm={() =>
            void post("approve", { action: "approve", version: doc.version }, "审批已通过")
          }
        >
          <Button type="primary" loading={loading}>
            审批通过
          </Button>
        </Popconfirm>
        <Button danger loading={loading} onClick={() => setRejectOpen(true)}>
          驳回
        </Button>
        {/* 撤回：制单人收回自己的提交（服务端校验 createdBy，非制单人会被拒） */}
        <Popconfirm
          title="撤回本单？"
          description="撤回后回到草稿，可继续修改再提交。"
          okText="撤回"
          cancelText="取消"
          onConfirm={() => void post("withdraw", { version: doc.version }, "已撤回，单据回到草稿")}
        >
          <Button loading={loading}>撤回</Button>
        </Popconfirm>
        <Modal
          title="驳回单据"
          open={rejectOpen}
          okText="确认驳回"
          okButtonProps={{ danger: true }}
          cancelText="取消"
          confirmLoading={loading}
          onCancel={() => setRejectOpen(false)}
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
  const canGenerate = hasAnyRole(useMe(), "pmc");
  const [form] = Form.useForm<CreateFormValues>();
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
  const [saving, setSaving] = useState(false);
  const [bhOptions, setBhOptions] = useState<{ value: number; label: string; orderType: string | null }[]>([]);

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



  // 创建弹窗打开时拉取已审批 BH 供关联（委外链列表返回 {rows,total}，RemoteSelect 不适用）
  useEffect(() => {
    if (!createOpen) return;
    let cancelled = false;
    fetchJson<{ rows: { id: number; docNo: string; orderType: string | null }[]; total: number }>(
      "/api/outsource/bh?status=approved&page=1&pageSize=999",
    )
      .then((res) => {
        if (!cancelled) {
          setBhOptions(
            res.rows.map((r) => ({
              value: r.id,
              orderType: r.orderType,
              label: `${r.docNo}${r.orderType ? `（${formatOrderType(r.orderType)}）` : ""}`,
            })),
          );
        }
      })
      .catch(() => {
        /* 下拉加载失败保持空 */
      });
    return () => {
      cancelled = true;
    };
  }, [createOpen]);

  const handleCreate = async () => {
    try {
      const values = await form.validateFields();
      setSaving(true);
      await postJson<{ id: number }>("/api/outsource/wo", {
        bhId: values.bhId ?? undefined,
        productSkuId: values.productSkuId,
        qty: String(values.qty),
        supplierId: values.supplierId,
        feeRatePlan: String(values.feeRatePlan),
        dueDate: values.dueDate ? values.dueDate.format("YYYY-MM-DD") : undefined,
        orderType: values.orderType || undefined,
        remark: values.remark?.trim() || undefined,
      });
      message.success("委外工单已创建（草稿）");
      setCreateOpen(false);
      form.resetFields();
      void load();
    } catch (e) {
      if (e instanceof Error && e.message) message.error(e.message);
    } finally {
      setSaving(false);
    }
  };

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
      modal.success({
        title: `${source.docNo}：草稿已生成，尚未提交审批`,
        content: (
          <div>
            {res.pos.map(p => <div key={p.id}>采购订单：<Link href={`/outsource/po?docId=${p.id}`}>{p.docNo}</Link></div>)}
            <div>加工通知单：<Link href={`/outsource/jg?docId=${res.jg.id}`}>{res.jg.docNo}</Link></div>
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
              onClick={() => {
                form.resetFields();
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
      <Table<WoRow>
        rowKey="id"
        size={listState.tableSize}
        columns={columns}
        dataSource={rows}
        loading={loading}
        scroll={{ x: "max-content" }}
        pagination={listState.paginationProps({ total: total })}
      />

      <Modal
        title="新建委外工单"
        open={createOpen}
        onOk={() => void handleCreate()}
        onCancel={() => setCreateOpen(false)}
        confirmLoading={saving}
        width={640}
        forceRender
        maskClosable={false}
        okText="保存草稿"
        cancelText="取消"
      >
        <Form form={form} layout="vertical">
          <Form.Item name="bhId" label="关联备货申请（可选，仅已审批）">
            <Select allowClear showSearch optionFilterProp="label" options={bhOptions} placeholder="选择备货申请"
              onChange={(id: number | undefined) => form.setFieldValue("orderType", bhOptions.find(b => b.value === id)?.orderType ?? undefined)} />
          </Form.Item>
          <Form.Item
            name="productSkuId"
            label="成品 SKU"
            rules={[{ required: true, message: "必须选择成品 SKU" }]}
          >
            <RemoteSelect
              api="/api/master/sku?type=finished"
              getLabel={(r) => `${String(r.code)} ${String(r.name)}`}
              placeholder="选择成品（须有生效 BOM）"
            />
          </Form.Item>
          <Form.Item name="qty" label="数量" rules={[{ required: true, message: "数量必填" }]}>
            <InputNumber min={0.0001} precision={4} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item
            name="supplierId"
            label="加工厂"
            rules={[{ required: true, message: "必须选择加工厂" }]}
          >
            <RemoteSelect
              api="/api/master/supplier"
              getLabel={(r) => `${String(r.code)} ${String(r.name)}`}
              filterRow={(r) => Array.isArray(r.kinds) && (r.kinds as string[]).includes("processor")}
              placeholder="选择加工厂"
            />
          </Form.Item>
          <Form.Item
            name="feeRatePlan"
            label="加工费计划单价（元）"
            rules={[{ required: true, message: "加工费计划单价必填" }]}
          >
            <InputNumber min={0.01} precision={2} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item name="dueDate" label="交期">
            <DatePicker style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item name="orderType" label="订单类型" extra="关联申请已有类型时必须继承；未分类或无来源时可人工明确。成品返单的10–20天是目标，不能用首批收货代表全量交付。">
            <Select allowClear options={toOptions(ORDER_TYPE_LABELS)} placeholder="选择类型；关联申请留空时继承来源" />
          </Form.Item>
          <Form.Item name="remark" label="备注">
            <Input.TextArea rows={2} maxLength={500} />
          </Form.Item>
        </Form>
      </Modal>

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
              {canGenerate && detail.status === "approved" && generatedKnown && existingJgNo == null ? (
                <Button type="primary" disabled={generating} icon={<ThunderboltOutlined />} onClick={openGenerate}>
                  生成单据
                </Button>
              ) : null}
              <WoActions
                doc={{ id: detail.id, status: detail.status, version: detail.version }}
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
            <Descriptions column={{ xs: 1, sm: 2 }} size="small" bordered style={{ marginBottom: 16 }}>
              <Descriptions.Item label="成品">
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
          skuOptions={(detail?.lines ?? []).map((l) => ({ value: l.materialSkuId, label: `${l.skuCode} ${l.skuName}` }))}
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
                    <Space align="baseline" style={{ display: "flex", justifyContent: "space-between" }}>
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
                          style={{ width: 280 }}
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
                                  style={{ width: 300 }}
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
