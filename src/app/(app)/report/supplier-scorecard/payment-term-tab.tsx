"use client";

/**
 * D64 供应商账期候选（记分卡页第四页签）：谁该谈账期、谈到了没有、账期类采购额占多少。
 * 只消费读模型 supplier-payment-term/v1；采购额由 API 按角色剥离；登记账期走 master/supplier.ts 专用写路径（审计）。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, App, Button, Card, Col, DatePicker, Form, Input, InputNumber, Modal, Row, Segmented, Select, Space, Statistic, Table, Tag, Tooltip, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { ReloadOutlined } from "@ant-design/icons";
import dayjs, { type Dayjs } from "dayjs";
import { exportCsv } from "@/components/exportCsv";
import { fetchJson, postJson, putJson } from "@/components/fetchJson";
import ListToolbar from "@/components/ListToolbar";
import { metricTooltip } from "@/components/metrics";
import SearchInput from "@/components/SearchInput";
import { useListState } from "@/components/useListState";
import { hasAnyRole, useMe } from "@/components/useMe";
import type {
  SupplierPaymentTermModel, SupplierPaymentTermRow, SupplierPool,
} from "@/server/modules/report/supplier-payment-term";

const POOL_LABELS: Record<SupplierPool, string> = { processor: "OA 加工厂", packaging: "包材厂", raw: "原料商" };
const TERM_LABELS: Record<string, string> = { prepay: "预付", on_delivery: "款到发货", monthly_credit: "月结" };
const ATTAIN_TAG: Record<string, { color: string; label: string }> = {
  attained: { color: "green", label: "达标" },
  below_target: { color: "orange", label: "未达标" },
  not_credit: { color: "default", label: "非账期" },
  unknown: { color: "default", label: "未登记" },
};
const TREND_LABEL: Record<string, string> = { up: "上升", down: "下降", flat: "持平", unknown: "无对比" };

const money = (v: string | null | undefined): string =>
  v == null ? "—" : Number(v).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = (v: number | null): string => (v == null ? "—" : `${(v * 100).toFixed(1)}%`);

interface TermFormValues {
  paymentTermType: string | null;
  creditDays?: number | null;
  paymentTermEffectiveFrom?: Dayjs | null;
  paymentTerm?: string;
  note?: string;
}

export default function PaymentTermTab() {
  const { message } = App.useApp();
  const me = useMe();
  const canWrite = hasAnyRole(me, "purchasing");
  const [data, setData] = useState<SupplierPaymentTermModel | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editing, setEditing] = useState<SupplierPaymentTermRow | null>(null);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm<TermFormValues>();
  // 本页签独立列表状态：URL 参数命名空间 pt_*（与 sc_* / qc_* / pv_* 互不干扰）
  const listState = useListState({
    key: "supplier-payment-term",
    paramPrefix: "pt",
    defaults: { q: "", pool: "", scope: "candidates" },
    defaultPageSize: 20,
  });
  const q = (listState.filters.q ?? "").trim().toLowerCase();
  const pool = listState.filters.pool ?? "";
  const scope = listState.filters.scope || "candidates";

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      setData(await fetchJson<SupplierPaymentTermModel>("/api/report/supplier-payment-term"));
    } catch (e) {
      const text = e instanceof Error ? e.message : "供应商账期加载失败";
      setData(null);
      setLoadError(text);
      message.error(text);
    } finally {
      setLoading(false);
    }
  }, [message]);
  useEffect(() => { void load(); }, [load]);

  const refresh = async () => {
    setRefreshing(true);
    try {
      await postJson("/api/report/supplier-payment-term", {});
      await load();
      message.success("读模型已重建");
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setRefreshing(false);
    }
  };

  const rows = useMemo(() => (data?.rows ?? []).filter((r) =>
    (!q || r.name.toLowerCase().includes(q) || r.code.toLowerCase().includes(q))
    && (!pool || r.pool === pool)
    && (scope === "all" || (scope === "candidates" ? r.candidate : r.spend[0].total != null))), [data, q, pool, scope]);

  const openEdit = (r: SupplierPaymentTermRow) => {
    setEditing(r);
    form.setFieldsValue({
      paymentTermType: r.paymentTermType,
      creditDays: r.creditDays,
      paymentTermEffectiveFrom: r.paymentTermEffectiveFrom ? dayjs(r.paymentTermEffectiveFrom) : null,
      paymentTerm: r.paymentTermText ?? undefined,
      note: undefined,
    });
  };

  const submitEdit = async () => {
    if (!editing) return;
    const v = await form.validateFields();
    setSaving(true);
    try {
      await putJson(`/api/master/supplier/${editing.supplierId}/payment-term`, {
        paymentTermType: v.paymentTermType ?? null,
        creditDays: v.paymentTermType === "monthly_credit" ? v.creditDays ?? null : null,
        paymentTermEffectiveFrom: v.paymentTermEffectiveFrom ? v.paymentTermEffectiveFrom.format("YYYY-MM-DD") : null,
        paymentTerm: v.paymentTerm || undefined,
        note: v.note || undefined,
      });
      message.success(`已登记 ${editing.name} 的账期`);
      setEditing(null);
      await postJson("/api/report/supplier-payment-term", {}).catch(() => undefined);
      await load();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const y = data?.year;
  const columns: ColumnsType<SupplierPaymentTermRow> = [
    {
      title: "供应商", dataIndex: "name", width: 220, fixed: "left", ellipsis: true,
      render: (v: string, r) => (
        <Space direction="vertical" size={0}>
          <Typography.Text>{v}</Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>{r.code}</Typography.Text>
        </Space>
      ),
    },
    { title: "池", dataIndex: "pool", width: 100, render: (v: SupplierPool) => <Tag>{POOL_LABELS[v]}</Tag> },
    {
      title: "合作起始", dataIndex: "cooperationSince", width: 130,
      render: (v: string | null) => (v ? <Tooltip title="按最早已批 PO/JG 建单日系统推算"><span>{v} <Typography.Text type="secondary">推算</Typography.Text></span></Tooltip> : <Typography.Text type="secondary">无往来</Typography.Text>),
    },
    { title: "合作年限", dataIndex: "cooperationYears", width: 90, align: "right", render: (v: number | null) => (v == null ? "—" : `${v} 年`) },
    {
      title: `${y ?? "当年"} 采购额`, key: "spend0", width: 150, align: "right",
      render: (_: unknown, r) => <span>{money(r.spend[0].total)} <Typography.Text type="secondary">{r.spend[0].rank ? `#${r.spend[0].rank}/${r.spend[0].rankOf}` : ""}</Typography.Text></span>,
    },
    {
      title: `${y ? y - 1 : "上年"} 采购额`, key: "spend1", width: 150, align: "right",
      render: (_: unknown, r) => <span>{money(r.spend[1].total)} <Typography.Text type="secondary">{r.spend[1].rank ? `#${r.spend[1].rank}/${r.spend[1].rankOf}` : ""}</Typography.Text></span>,
    },
    {
      title: "排名趋势", dataIndex: "rankTrend", width: 90, align: "center",
      render: (v: string) => <Tag color={v === "up" ? "green" : v === "down" ? "red" : "default"}>{TREND_LABEL[v] ?? v}</Tag>,
    },
    {
      title: "候选", dataIndex: "candidate", width: 90, align: "center",
      render: (v: boolean, r) => <Tooltip title={r.candidateReason}><Tag color={v ? "gold" : "default"}>{v ? "候选" : "—"}</Tag></Tooltip>,
    },
    {
      title: "当前账期", key: "term", width: 180,
      render: (_: unknown, r) => r.paymentTermType == null
        ? <Typography.Text type="secondary">{r.paymentTermText ? `未结构化：${r.paymentTermText}` : "未登记"}</Typography.Text>
        : <span>{TERM_LABELS[r.paymentTermType]}{r.paymentTermType === "monthly_credit" ? ` ${r.creditDays} 天` : ""}{r.paymentTermEffectiveFrom ? <Typography.Text type="secondary">（自 {r.paymentTermEffectiveFrom}）</Typography.Text> : null}</span>,
    },
    {
      title: <Tooltip title={metricTooltip("paymentTermAttainment")}>达标</Tooltip>, dataIndex: "attainment", width: 90, align: "center",
      render: (v: string) => <Tag color={ATTAIN_TAG[v]?.color}>{ATTAIN_TAG[v]?.label ?? v}</Tag>,
    },
    ...(canWrite ? [{
      title: "操作", key: "actions", width: 100, fixed: "right" as const,
      render: (_: unknown, r: SupplierPaymentTermRow) => <Button type="link" size="small" onClick={() => openEdit(r)}>登记账期</Button>,
    }] : []),
  ];

  const s = data?.summary;
  const mv = data?.moneyVisible ?? false;

  return (
    <div>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message={`候选 = 合作 ≥ ${data?.params.minYears ?? 2} 年且当年池内采购额排名较上年上升；目标账期 ${data?.params.targetMinDays ?? 45}–${data?.params.targetMaxDays ?? 60} 天；达成率 = 候选中已达标 ÷ 候选数（D64）。`}
        description={
          <Typography.Text type="secondary">
            年采购额 = 当年审批通过 PO 未税额 + 当年生效 JS 结算额（非应付）；合作起始日按最早已批 PO/JG 系统推算；账期类采购额占比为代理指标，不是应付余额占比。
            {data ? ` 读模型 ${data.builtAt.slice(0, 16).replace("T", " ")} 构建，截至 ${data.asOf}。` : ""}
            {data && !mv ? " 当前角色不可见金额。" : ""}
          </Typography.Text>
        }
      />

      {loadError ? (
        <Alert
          type="error"
          showIcon
          message="供应商账期加载失败"
          description={loadError}
          action={<Button size="small" icon={<ReloadOutlined />} onClick={() => void load()}>重试</Button>}
          style={{ marginBottom: 12 }}
        />
      ) : null}

      <Row gutter={[10, 10]} style={{ marginBottom: 12 }}>
        <Col xs={12} xl={4}><Card size="small"><Statistic title="账期候选" value={s ? s.candidates : "—"} suffix={s ? `/ ${s.withSpend} 家有往来` : undefined} /></Card></Col>
        <Col xs={12} xl={4}><Card size="small"><Statistic title="候选已达标" value={s ? s.candidatesAttained : "—"} /></Card></Col>
        <Col xs={12} xl={5}>
          <Card size="small">
            <Statistic
              title={<Tooltip title={metricTooltip("paymentTermAttainment")}>账期达成率</Tooltip>}
              value={s?.attainmentRate == null ? "—" : pct(s.attainmentRate)}
              valueStyle={{ color: s?.attainmentRate == null ? undefined : s.attainmentRate >= 1 ? "#52c41a" : "#fa8c16" }}
            />
          </Card>
        </Col>
        <Col xs={12} xl={5}>
          <Card size="small">
            <Statistic
              title={<Tooltip title={metricTooltip("creditTermSpendShare")}>账期类采购额占比</Tooltip>}
              value={s?.creditTermSpendSharePct == null ? "—" : `${s.creditTermSpendSharePct}%`}
            />
            <Typography.Text type="secondary">月结供应商 {s?.creditTermSuppliers ?? "—"} 家 · 采购额 {mv ? money(s?.creditTermSpend) : "—"} / {mv ? money(s?.totalSpend) : "—"}</Typography.Text>
          </Card>
        </Col>
        <Col xs={24} xl={6}>
          <Card size="small" title="分池">
            {(s?.byPool ?? []).map((p) => (
              <div key={p.pool}><Typography.Text>{p.label}</Typography.Text>：候选 {p.candidates} · 达标 {p.candidatesAttained} · 占比 {p.creditTermSpendSharePct == null ? "—" : `${p.creditTermSpendSharePct}%`}</div>
            ))}
          </Card>
        </Col>
      </Row>

      <ListToolbar
        state={listState}
        onExport={data ? () => exportCsv(
          `供应商账期候选-${data.year}`,
          ["供应商编码", "供应商", "池", "合作起始(推算)", "合作年限", `${data.year}采购额`, `${data.year}排名`, `${data.year - 1}采购额`, `${data.year - 1}排名`, "排名趋势", "候选", "候选依据", "账期类型", "账期天数", "生效日", "达标"],
          rows.map((r) => [
            r.code, r.name, POOL_LABELS[r.pool], r.cooperationSince, r.cooperationYears, r.spend[0].total, r.spend[0].rank, r.spend[1].total, r.spend[1].rank,
            TREND_LABEL[r.rankTrend], r.candidate ? "是" : "否", r.candidateReason, r.paymentTermType ? TERM_LABELS[r.paymentTermType] : null, r.creditDays, r.paymentTermEffectiveFrom, ATTAIN_TAG[r.attainment]?.label,
          ]),
        ) : undefined}
        primaryActions={hasAnyRole(me, "pmc", "purchasing") ? (
          <Button size="small" icon={<ReloadOutlined />} loading={refreshing} onClick={() => void refresh()}>重建读模型</Button>
        ) : undefined}
        extra={
          <>
            <Segmented
              size="small"
              value={scope}
              onChange={(v) => listState.setFilter({ scope: String(v) })}
              options={[{ label: "仅候选", value: "candidates" }, { label: "有往来", value: "active" }, { label: "全部", value: "all" }]}
            />
            <Select
              size="small"
              allowClear
              placeholder="全部池"
              style={{ width: 130 }}
              value={pool || undefined}
              onChange={(v) => listState.setFilter({ pool: v ?? "" })}
              options={(Object.keys(POOL_LABELS) as SupplierPool[]).map((k) => ({ value: k, label: POOL_LABELS[k] }))}
            />
            <SearchInput
              key={q}
              allowClear
              size="small"
              defaultValue={q}
              placeholder="搜索供应商编码/名称"
              style={{ width: 220 }}
              onSearch={(v) => listState.setFilter({ q: v.trim() })}
            />
          </>
        }
      />

      <Table<SupplierPaymentTermRow>
        rowKey="supplierId"
        size={listState.tableSize}
        columns={columns}
        dataSource={rows}
        loading={loading}
        scroll={{ x: "max-content" }}
        rowClassName={(r) => (r.candidate && r.attainment !== "attained" ? "ant-table-row-selected" : "")}
        pagination={listState.paginationProps({ total: rows.length, showTotal: (t) => `共 ${t} 家` })}
        locale={{ emptyText: loadError ? "数据未加载" : scope === "candidates" ? "当前没有账期谈判候选" : "当前筛选下没有供应商" }}
      />

      <Modal
        title={editing ? `登记账期 — ${editing.code} ${editing.name}` : "登记账期"}
        open={editing != null}
        onCancel={() => setEditing(null)}
        onOk={() => void submitEdit()}
        confirmLoading={saving}
        okText="保存"
        cancelText="取消"
        destroyOnHidden
      >
        <Form form={form} layout="vertical">
          <Form.Item name="paymentTermType" label="账期类型" rules={[{ required: true, message: "请选择账期类型" }]}>
            <Select options={Object.entries(TERM_LABELS).map(([value, label]) => ({ value, label }))} />
          </Form.Item>
          <Form.Item noStyle shouldUpdate={(a, b) => a.paymentTermType !== b.paymentTermType}>
            {({ getFieldValue }) => getFieldValue("paymentTermType") === "monthly_credit" ? (
              <Form.Item name="creditDays" label="账期天数" rules={[{ required: true, message: "月结必须填写天数" }]}>
                <InputNumber min={0} max={180} style={{ width: "100%" }} addonAfter="天" />
              </Form.Item>
            ) : null}
          </Form.Item>
          <Form.Item name="paymentTermEffectiveFrom" label="生效日" rules={[{ required: true, message: "请填写生效日" }]}>
            <DatePicker style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item name="paymentTerm" label="结算方式原文（可选）">
            <Input maxLength={60} placeholder="如 月结60" />
          </Form.Item>
          <Form.Item name="note" label="备注（写入审计）">
            <Input.TextArea maxLength={200} rows={2} placeholder="谈判结果 / 合同编号 / 生效说明" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
