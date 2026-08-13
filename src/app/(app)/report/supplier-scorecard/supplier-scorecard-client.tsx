"use client";

import SearchInput from "@/components/SearchInput";

/**
 * E5-06 + E5-07 供应商记分卡 / 质检透视 / 价格偏差（只读报表 + 人工采纳分级）。
 *
 * 两个页签回答两个问题：
 * - 记分卡：这家供应商到底几分？分从哪来？（展开行逐维度拆给你看——不可解释的评分没人敢用）
 * - 质检透视：质量问题在时间上怎么走？（按月堆叠，让步/报废是不是在变多）
 * - 价格偏差：同 SKU 的已生效采购价统一到基础单位未税后，哪些供应商值得复核？
 * 评分只是**数据建议**：采纳与否由采购判断，点「采纳」才写档案等级；样本不足者不评级而非给低分。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Alert, App, Button, Card, Col, Popconfirm, Progress, Row, Segmented, Select,
  Space, Statistic, Table, Tabs, Tag, Tooltip, Typography,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import { ReloadOutlined } from "@ant-design/icons";
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip as RTooltip, XAxis, YAxis } from "recharts";
import { fetchJson, postJson } from "@/components/fetchJson";
import DecisionVisual from "@/components/DecisionVisual";
import ListToolbar from "@/components/ListToolbar";
import { useListState } from "@/components/useListState";

/* ───────────────── 类型（与服务端 DTO 对齐） ───────────────── */

interface BreakdownItem {
  key: string;
  label: string;
  weight: number;
  value: number | null;
  points: number | null;
  note: string;
}

interface ScoreRow {
  supplierId: number;
  code: string;
  name: string;
  currentLevel: string | null;
  score: number | null;
  grade: string | null;
  confidence: "high" | "medium" | "low";
  onTimeRate: number | null;
  qcPassRate: number | null;
  concessionRate: number | null;
  scrapRate: number | null;
  priceChangeCount: number;
  sampleN: number;
  breakdown: BreakdownItem[];
  suggestLevelChange: boolean;
  reason: string;
}

interface ScoreData {
  rows: ScoreRow[];
  total: number;
  minSamples: number;
  summary: {
    suppliers: number;
    rated: number;
    suggestChanges: number;
    avgOnTimeRate: number | null;
    windowDays: number;
  };
}

interface QcRow {
  supplierId: number;
  code: string;
  name: string;
  month: string;
  batches: number;
  passQty: number;
  reworkQty: number;
  concessionQty: number;
  scrapQty: number;
  pendingQty: number;
  gradedQty: number;
  passRate: number | null;
  reworkRate: number | null;
  concessionRate: number | null;
  scrapRate: number | null;
  pendingRate: number | null;
}

interface QcData {
  rows: QcRow[];
  totals: Omit<QcRow, "supplierId" | "code" | "name" | "month">;
  months: string[];
}

interface PriceVarianceRow {
  key: string;
  supplierId: number;
  supplierCode: string;
  supplierName: string;
  skuId: number;
  skuCode: string;
  skuName: string;
  baseUom: string;
  currency: "CNY";
  lineCount: number;
  orderedBaseQty: string;
  averageBaseNetPrice: string;
  benchmarkBaseNetPrice: string;
  variancePct: string;
  isBenchmark: boolean;
}

interface PriceVarianceData {
  rows: PriceVarianceRow[];
  total: number;
  supplierSummary: Array<{
    supplierId: number;
    supplierCode: string;
    supplierName: string;
    comparableSkuCount: number;
    aboveBenchmarkSkuCount: number;
    medianVariancePct: string;
  }>;
  summary: {
    inputLineCount: number;
    validLineCount: number;
    comparableLineCount: number;
    excludedInvalidLineCount: number;
    singleSupplierLineCount: number;
    comparableSkuCount: number;
    comparableSupplierCount: number;
    coveragePct: string;
    windowDays: number;
    asOf: string;
  };
  readiness: {
    level: "observation";
    decisionReady: false;
    currencyState: "system_default_not_line_level";
    yonyouSupplierIdentityState: "uat_required";
    blockers: string[];
    permittedUse: string;
    prohibitedUse: string;
  };
}

/* ───────────────── 展示常量 ───────────────── */

const GRADE_COLORS: Record<string, string> = { S: "#52c41a", A: "#1677ff", B: "#faad14", C: "#fa8c16", D: "#cf1322" };
const CONFIDENCE_LABELS: Record<string, string> = { high: "高", medium: "中", low: "低" };
const QC_SERIES = [
  { key: "passQty", label: "正常（合格）", color: "#52c41a" },
  { key: "reworkQty", label: "返工", color: "#faad14" },
  { key: "concessionQty", label: "让步接收", color: "#1677ff" },
  { key: "scrapQty", label: "报废", color: "#cf1322" },
  { key: "pendingQty", label: "待判定", color: "#bfbfbf" },
] as const;

const pct = (v: number | null): string => (v == null ? "—" : `${(v * 100).toFixed(1)}%`);
const fmt = (v: number): string => (Number.isInteger(v) ? String(v) : v.toFixed(2));

/** 比率列：无数据显示「无数据」而不是 0%（0% 和「没测到」是两回事） */
function RateCell({ v, warnAbove, warnBelow }: { v: number | null; warnAbove?: number; warnBelow?: number }) {
  if (v == null) return <Typography.Text type="secondary">无数据</Typography.Text>;
  const bad = (warnAbove != null && v > warnAbove) || (warnBelow != null && v < warnBelow);
  return <Typography.Text style={{ color: bad ? "#cf1322" : undefined }}>{pct(v)}</Typography.Text>;
}

/* ───────────────── 页签一：记分卡 ───────────────── */

function ScorecardTab() {
  const { message } = App.useApp();
  const [data, setData] = useState<ScoreData | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [applying, setApplying] = useState<number | null>(null);
  // 列表页状态平台（E6-P1）：筛选/分页进 URL，密度与已保存视图存本地；
  // 本页两个页签各是独立列表，用 paramPrefix 分命名空间（sc_* / qc_*）互不清空
  const listState = useListState({ key: "supplier-scorecard", paramPrefix: "sc", defaults: { q: "", windowDays: "180" }, defaultPageSize: 20 });
  const { filters, page, pageSize } = listState;
  const q = filters.q;
  const windowDays = Number(filters.windowDays);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const params = new URLSearchParams({ q, page: String(page), pageSize: String(pageSize), windowDays: String(windowDays) });
      setData(await fetchJson<ScoreData>(`/api/report/supplier-scorecard?${params.toString()}`));
    } catch (e) {
      const text = e instanceof Error ? e.message : "供应商记分卡加载失败";
      setData(null);
      setLoadError(text);
      message.error(text);
    } finally {
      setLoading(false);
    }
  }, [q, page, pageSize, windowDays, message]);
  useEffect(() => { void load(); }, [load]);

  const apply = async (r: ScoreRow) => {
    if (!r.grade) return;
    setApplying(r.supplierId);
    try {
      await postJson("/api/report/supplier-scorecard", { supplierId: r.supplierId, level: r.grade });
      message.success(`已采纳：${r.name} 分级更新为 ${r.grade}`);
      await load();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setApplying(null);
    }
  };

  const columns: ColumnsType<ScoreRow> = [
    {
      title: "供应商", dataIndex: "name", width: 200, fixed: "left", ellipsis: true,
      render: (v: string, r) => (
        <Space direction="vertical" size={0}>
          <Typography.Text>{v}</Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>{r.code}</Typography.Text>
        </Space>
      ),
    },
    {
      title: "当前等级", dataIndex: "currentLevel", width: 90, align: "center",
      render: (v: string | null) => (v ? <Tag color={GRADE_COLORS[v]}>{v}</Tag> : <Typography.Text type="secondary">未分级</Typography.Text>),
    },
    {
      title: "建议等级", dataIndex: "grade", width: 190, align: "center",
      render: (v: string | null, r) => {
        if (v == null) return <Tooltip title={r.reason}><Typography.Text type="secondary">不予评级</Typography.Text></Tooltip>;
        if (!r.suggestLevelChange) {
          return (
            <Tooltip title={r.confidence === "low" ? "置信度低，不提议调整档案等级" : "与档案等级一致，无需调整"}>
              <Tag color={GRADE_COLORS[v]}>{v}</Tag>
            </Tooltip>
          );
        }
        return (
          <Space size={6}>
            <Tag color={GRADE_COLORS[v]} style={{ fontWeight: 600 }}>{v}</Tag>
            <Popconfirm
              title="采纳建议等级"
              description={`将「${r.name}」的档案分级由 ${r.currentLevel ?? "未分级"} 改为 ${v}`}
              okText="采纳"
              cancelText="取消"
              onConfirm={() => void apply(r)}
            >
              <Button size="small" type="primary" ghost loading={applying === r.supplierId}>采纳</Button>
            </Popconfirm>
          </Space>
        );
      },
    },
    {
      title: "综合分", dataIndex: "score", width: 150,
      render: (v: number | null, r) =>
        v == null ? (
          <Tooltip title={r.reason}><Typography.Text type="secondary">未评级</Typography.Text></Tooltip>
        ) : (
          <Tooltip title={r.reason}>
            <Progress
              percent={v}
              size="small"
              strokeColor={GRADE_COLORS[r.grade ?? "D"]}
              format={(p) => <span style={{ color: GRADE_COLORS[r.grade ?? "D"] }}>{p}</span>}
            />
          </Tooltip>
        ),
    },
    {
      title: "置信度", dataIndex: "confidence", width: 90, align: "center",
      render: (v: string, r) =>
        v === "low" ? (
          <Tooltip title={`样本不足（收货 ${r.sampleN} 单 < ${data?.minSamples ?? 3} 单），不予评级`}>
            <Tag>{CONFIDENCE_LABELS[v]}</Tag>
          </Tooltip>
        ) : (
          <Tag color={v === "high" ? "green" : "gold"}>{CONFIDENCE_LABELS[v]}</Tag>
        ),
    },
    { title: "准时率", dataIndex: "onTimeRate", width: 95, align: "right", render: (v: number | null) => <RateCell v={v} warnBelow={0.8} /> },
    { title: "合格率", dataIndex: "qcPassRate", width: 95, align: "right", render: (v: number | null) => <RateCell v={v} warnBelow={0.95} /> },
    { title: "让步率", dataIndex: "concessionRate", width: 95, align: "right", render: (v: number | null) => <RateCell v={v} warnAbove={0.05} /> },
    { title: "报废率", dataIndex: "scrapRate", width: 95, align: "right", render: (v: number | null) => <RateCell v={v} warnAbove={0.02} /> },
    {
      title: "价格变更", dataIndex: "priceChangeCount", width: 95, align: "right",
      render: (v: number) => (v > 0 ? <Typography.Text style={{ color: v >= 3 ? "#fa8c16" : undefined }}>{v} 次</Typography.Text> : <Typography.Text type="secondary">0</Typography.Text>),
    },
    { title: "样本数", dataIndex: "sampleN", width: 85, align: "right", render: (v: number) => `${v} 单` },
  ];

  /** 展开行：逐维度拆分——评分可解释性的关键 */
  const expanded = (r: ScoreRow) => (
    <div className="supplier-scorecard-breakdown">
      <Table<BreakdownItem>
        rowKey="key"
        size="small"
        pagination={false}
        tableLayout="fixed"
        dataSource={r.breakdown}
        columns={[
          { title: "维度", dataIndex: "label", width: 110 },
          { title: "权重", dataIndex: "weight", width: 70, align: "right", render: (v: number) => `${v} 分` },
          {
            title: "指标", dataIndex: "value", width: 100, align: "right",
            render: (v: number | null, d) =>
              v == null ? <Typography.Text type="secondary">无数据</Typography.Text> : d.key === "price" ? `${v} 次` : pct(v),
          },
          {
            title: "得分", dataIndex: "points", width: 90, align: "right",
            render: (v: number | null, d) =>
              v == null ? <Typography.Text type="secondary">不计分</Typography.Text> : <Typography.Text strong>{v} / {d.weight}</Typography.Text>,
          },
          { title: "说明", dataIndex: "note" },
        ]}
        footer={() => <Typography.Text type="secondary">{r.reason}</Typography.Text>}
      />
    </div>
  );

  const s = data?.summary;

  return (
    <div>
      <Alert
        className="supplier-scorecard-methodology"
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message="评分是数据建议，不是判决——采纳与否由采购判断，点「采纳」才会写入供应商档案等级，系统不会自动改主数据。"
        description={
          <div>
            <Typography.Text type="secondary">
              样本不足 {data?.minSamples ?? 3} 单时不评级；缺失维度不计分，按剩余权重归一。
            </Typography.Text>
            <details className="supplier-scorecard-methodology__details">
              <summary>查看完整评分口径与数据限制</summary>
              <Typography.Paragraph type="secondary">
                综合分 = 准时交付 40 分（复用交期学习的准时率：实际收货 ≤ 承诺到货）+ 质量 40 分（合格率 − 让步率×0.5 − 报废率×1.0）+ 价格稳定 20 分（窗口内生效调价次数，满 5 次归零）。
                某维度无数据时该维度不计分、按剩余权重归一（展开行有逐维度说明）；
                窗口内收货不足 {data?.minSamples ?? 3} 单的供应商<strong>不予评级</strong>，而不是给一个低分——单笔波动不足以定性。
                准时率目前只覆盖采购 PO（委外 JG 无「承诺 vs 收货」等价链路），纯加工厂该维度按归一处理。
              </Typography.Paragraph>
            </details>
          </div>
        }
      />

      {loadError ? (
        <Alert
          type="error"
          showIcon
          message="供应商记分卡加载失败"
          description={loadError}
          action={<Button size="small" icon={<ReloadOutlined />} onClick={() => void load()}>重试</Button>}
          style={{ marginBottom: 12 }}
        />
      ) : null}

      <div className="supplier-scorecard-kpis">
        <Card size="small"><Statistic title={`窗口内有往来的供应商（近 ${s?.windowDays ?? windowDays} 天）`} value={s ? s.suppliers : "—"} /></Card>
        <Card size="small"><Statistic title="已评级" value={s ? s.rated : "—"} suffix={s ? `/ ${s.suppliers}` : undefined} /></Card>
        <Card size="small">
          <Statistic title="建议调整等级" value={s ? s.suggestChanges : "—"} valueStyle={{ color: s && s.suggestChanges > 0 ? "#fa8c16" : undefined }} />
        </Card>
        <Card size="small">
          <Statistic
            title="平均准时率"
            value={s?.avgOnTimeRate == null ? "—" : s.avgOnTimeRate * 100}
            precision={s?.avgOnTimeRate == null ? undefined : 1}
            suffix={s?.avgOnTimeRate == null ? undefined : "%"}
            valueStyle={{ color: s?.avgOnTimeRate == null ? undefined : s.avgOnTimeRate < 0.8 ? "#cf1322" : "#52c41a" }}
          />
        </Card>
      </div>

      <ListToolbar
        state={listState}
        extra={
          <>
            <SearchInput
              key={q}
              allowClear
              size="small"
              defaultValue={q}
              placeholder="搜索供应商编码/名称"
              style={{ width: 240 }}
              onSearch={(v) => listState.setFilter({ q: v.trim() })}
            />
            <Segmented
              size="small"
              value={windowDays}
              onChange={(v) => listState.setFilter({ windowDays: String(v) })}
              options={[{ label: "近 90 天", value: 90 }, { label: "近 180 天", value: 180 }, { label: "近 365 天", value: 365 }]}
            />
          </>
        }
      />

      <Table<ScoreRow>
        className="supplier-scorecard-table"
        rowKey="supplierId"
        size={listState.tableSize}
        columns={columns}
        dataSource={data?.rows ?? []}
        loading={loading}
        scroll={{ x: "max-content" }}
        expandable={{ expandedRowRender: expanded, rowExpandable: (r) => r.breakdown.length > 0 }}
        rowClassName={(r) => (r.suggestLevelChange ? "ant-table-row-selected" : "")}
        pagination={listState.paginationProps({ total: data?.total ?? 0, showTotal: (t) => `共 ${t} 家` })}
        locale={{ emptyText: loadError ? "数据未加载" : "当前筛选下没有供应商记录" }}
      />
    </div>
  );
}

/* ───────────────── 页签二：质检透视 ───────────────── */

function QcSummaryTab() {
  const { message } = App.useApp();
  const [data, setData] = useState<QcData | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  // 本页签独立列表状态：URL 参数命名空间 qc_*（与「记分卡」页签的 sc_* 互不干扰）
  const listState = useListState({
    key: "supplier-scorecard-qc",
    paramPrefix: "qc",
    defaults: { months: "6", supplierId: "" },
    defaultPageSize: 20,
  });
  const months = Number(listState.filters.months);
  const supplierId = listState.filters.supplierId ? Number(listState.filters.supplierId) : null;

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      // 供应商筛选在前端做：一次取全量才能填出下拉选项（月份数有限、行量可控）
      setData(await fetchJson<QcData>(`/api/report/qc-summary?months=${months}`));
    } catch (e) {
      const text = e instanceof Error ? e.message : "质检透视加载失败";
      setData(null);
      setLoadError(text);
      message.error(text);
    } finally {
      setLoading(false);
    }
  }, [months, message]);
  useEffect(() => { void load(); }, [load]);

  const supplierOptions = useMemo(() => {
    const m = new Map<number, string>();
    for (const r of data?.rows ?? []) m.set(r.supplierId, `${r.name}（${r.code}）`);
    return [...m.entries()].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label));
  }, [data]);

  const rows = useMemo(
    () => (supplierId == null ? (data?.rows ?? []) : (data?.rows ?? []).filter((r) => r.supplierId === supplierId)),
    [data, supplierId],
  );

  /** 堆叠柱：X=月份，堆叠=五类判定量（选定供应商时即该供应商的月度走势） */
  const chartData = useMemo(() => {
    const byMonth = new Map<string, Record<string, number | string>>();
    for (const m of data?.months ?? []) {
      byMonth.set(m, { month: m, passQty: 0, reworkQty: 0, concessionQty: 0, scrapQty: 0, pendingQty: 0 });
    }
    for (const r of rows) {
      const acc = byMonth.get(r.month);
      if (!acc) continue;
      for (const s of QC_SERIES) acc[s.key] = (acc[s.key] as number) + r[s.key];
    }
    return [...byMonth.values()];
  }, [rows, data]);

  const hasData = chartData.some((d) => QC_SERIES.some((s) => (d[s.key] as number) > 0));

  const columns: ColumnsType<QcRow> = [
    { title: "月份", dataIndex: "month", width: 90, fixed: "left" },
    { title: "供应商", dataIndex: "name", width: 200, ellipsis: true, render: (v: string, r) => `${v}（${r.code}）` },
    { title: "收货批次", dataIndex: "batches", width: 90, align: "right" },
    { title: "判定总量", dataIndex: "gradedQty", width: 100, align: "right", render: fmt },
    { title: "正常", dataIndex: "passQty", width: 95, align: "right", render: fmt },
    { title: "合格率", dataIndex: "passRate", width: 95, align: "right", render: (v: number | null) => <RateCell v={v} warnBelow={0.95} /> },
    { title: "返工", dataIndex: "reworkQty", width: 95, align: "right", render: fmt },
    { title: "让步", dataIndex: "concessionQty", width: 95, align: "right", render: fmt },
    { title: "让步率", dataIndex: "concessionRate", width: 95, align: "right", render: (v: number | null) => <RateCell v={v} warnAbove={0.05} /> },
    { title: "报废", dataIndex: "scrapQty", width: 95, align: "right", render: fmt },
    { title: "报废率", dataIndex: "scrapRate", width: 95, align: "right", render: (v: number | null) => <RateCell v={v} warnAbove={0.02} /> },
    { title: "待判定", dataIndex: "pendingQty", width: 95, align: "right", render: fmt },
  ];

  const t = data?.totals;

  return (
    <div>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message="按（供应商 × 月）透视检验结果——让「只进不出」的质检数据形成反馈回路。"
        description={
          <Typography.Text type="secondary">
            归属月份取检验记录的录入月（Asia/Shanghai）；占比分母 = 判定总量（合格 + 不合格 + 让步），未检验的量不进分母；
            采购收货与委外收货都计入，供应商分别取自采购订单 / 委外通知单。
          </Typography.Text>
        }
      />

      {loadError ? (
        <Alert
          type="error"
          showIcon
          message="质检透视加载失败"
          description={loadError}
          action={<Button size="small" icon={<ReloadOutlined />} onClick={() => void load()}>重试</Button>}
          style={{ marginBottom: 12 }}
        />
      ) : null}

      <Row gutter={[10, 10]} className="compact-kpi-row">
        <Col><Card size="small"><Statistic title="收货批次" value={t ? t.batches : "—"} /></Card></Col>
        <Col><Card size="small"><Statistic title="合格率" value={t?.passRate == null ? "—" : t.passRate * 100} precision={t?.passRate == null ? undefined : 1} suffix={t?.passRate == null ? undefined : "%"} valueStyle={{ color: t?.passRate == null ? undefined : "#52c41a" }} /></Card></Col>
        <Col><Card size="small"><Statistic title="让步接收率" value={t?.concessionRate == null ? "—" : t.concessionRate * 100} precision={t?.concessionRate == null ? undefined : 1} suffix={t?.concessionRate == null ? undefined : "%"} valueStyle={{ color: t?.concessionRate == null ? undefined : "#1677ff" }} /></Card></Col>
        <Col><Card size="small"><Statistic title="报废率" value={t?.scrapRate == null ? "—" : t.scrapRate * 100} precision={t?.scrapRate == null ? undefined : 1} suffix={t?.scrapRate == null ? undefined : "%"} valueStyle={{ color: t?.scrapRate == null ? undefined : "#cf1322" }} /></Card></Col>
      </Row>

      <ListToolbar
        state={listState}
        extra={
          <>
            <Segmented
              value={months}
              onChange={(v) => listState.setFilter({ months: String(v) })}
              options={[{ label: "近 3 月", value: 3 }, { label: "近 6 月", value: 6 }, { label: "近 12 月", value: 12 }]}
            />
            <Select
              allowClear
              showSearch
              optionFilterProp="label"
              placeholder="全部供应商"
              style={{ width: 260 }}
              value={supplierId}
              onChange={(v) => listState.setFilter({ supplierId: v == null ? "" : String(v) })}
              options={supplierOptions}
            />
          </>
        }
      />

      <div style={{ marginBottom: 12 }}>
        <DecisionVisual
          title="月度检验结构"
          question="合格、返工、让步和报废的结构是否在恶化，集中在哪些月份？"
          metricId="qcPassRate"
          grain="月 × 检验判定"
          unit="检验数量"
          source={{
            tier: "derived",
            source: "收货检验台账按月聚合",
            asOf: data?.months.at(-1),
          }}
          coverage={{ covered: data?.months.length ?? 0, total: months, label: "目标窗口月份" }}
          activeFilters={[
            `近 ${months} 月`,
            supplierId == null ? "全部供应商" : supplierOptions.find((option) => option.value === supplierId)?.label ?? "指定供应商",
          ]}
          summary={t ? `收货批次 ${t.batches}，合格率 ${pct(t.passRate)}，让步率 ${pct(t.concessionRate)}，报废率 ${pct(t.scrapRate)}。` : "数据尚未成功加载。"}
          caveat="月份取检验录入月；占比分母只含已判定数量，未检验数量不进入分母。"
          state={loading && !data ? "loading" : loadError ? "error" : !hasData ? "empty" : "ready"}
          stateDetail={loadError ?? "当前窗口与供应商筛选下没有检验记录。"}
          height={320}
          dataView={
            <Table
              rowKey="month"
              size="small"
              pagination={false}
              dataSource={chartData}
              columns={[
                { title: "月份", dataIndex: "month" },
                ...QC_SERIES.map((series) => ({
                  title: series.label,
                  dataIndex: series.key,
                  align: "right" as const,
                  render: (value: number) => fmt(value),
                })),
              ]}
            />
          }
        >
          <ResponsiveContainer>
            <BarChart data={chartData} margin={{ top: 8, right: 16, bottom: 8, left: 8 }}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="month" tick={{ fontSize: 12 }} />
              <YAxis tickFormatter={(v: number) => (v >= 10000 ? `${Math.round(v / 1000)}k` : String(v))} />
              <RTooltip formatter={(v, n) => [fmt(Number(v)), String(n)]} />
              <Legend verticalAlign="top" height={24} />
              {QC_SERIES.map((s) => (
                <Bar key={s.key} dataKey={s.key} stackId="qc" name={s.label} fill={s.color} isAnimationActive={false} />
              ))}
            </BarChart>
          </ResponsiveContainer>
        </DecisionVisual>
      </div>

      <Table<QcRow>
        rowKey={(r) => `${r.month}-${r.supplierId}`}
        size={listState.tableSize}
        columns={columns}
        dataSource={rows}
        loading={loading}
        scroll={{ x: "max-content" }}
        pagination={{
          current: listState.page,
          pageSize: listState.pageSize,
          showSizeChanger: true,
          showTotal: (n) => `共 ${n} 条`,
          onChange: (p, ps) => listState.setPage(p, ps),
        }}
        locale={{ emptyText: loadError ? "数据未加载" : "当前窗口与供应商筛选下没有检验记录" }}
      />
    </div>
  );
}

/* ───────────────── 页签三：价格偏差观察 ───────────────── */

function PriceVarianceTab() {
  const { message } = App.useApp();
  const [data, setData] = useState<PriceVarianceData | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const listState = useListState({
    key: "supplier-price-variance",
    paramPrefix: "pv",
    defaults: { q: "", windowDays: "180" },
    defaultPageSize: 20,
  });
  const { filters, page, pageSize } = listState;
  const q = filters.q;
  const windowDays = Number(filters.windowDays);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const params = new URLSearchParams({ q, page: String(page), pageSize: String(pageSize), windowDays: String(windowDays) });
      setData(await fetchJson<PriceVarianceData>(`/api/report/supplier-price-variance?${params.toString()}`));
    } catch (error) {
      const text = error instanceof Error ? error.message : "供应商价格偏差加载失败";
      setData(null);
      setLoadError(text);
      message.error(text);
    } finally {
      setLoading(false);
    }
  }, [q, page, pageSize, windowDays, message]);
  useEffect(() => { void load(); }, [load]);

  const chartData = useMemo(
    () => (data?.supplierSummary ?? []).slice(0, 12).map((row) => ({
      name: row.supplierName,
      code: row.supplierCode,
      medianVariancePct: Number(row.medianVariancePct),
      comparableSkuCount: row.comparableSkuCount,
    })),
    [data],
  );

  const download = useCallback(async () => {
    try {
      const params = new URLSearchParams({ q, windowDays: String(windowDays), format: "csv" });
      const response = await fetch(`/api/report/supplier-price-variance?${params.toString()}`);
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? `导出失败（HTTP ${response.status}）`);
      }
      const url = URL.createObjectURL(await response.blob());
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `供应商价格偏差观察值-${data?.summary.asOf ?? "当前"}.csv`;
      anchor.style.display = "none";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      // Safari/部分 WebKit 在同一事件循环立即 revoke 会吞掉下载；延迟释放仍不泄漏对象 URL。
      window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
    } catch (error) {
      message.error(error instanceof Error ? error.message : "导出失败");
    }
  }, [q, windowDays, data?.summary.asOf, message]);

  const columns: ColumnsType<PriceVarianceRow> = [
    {
      title: "供应商",
      dataIndex: "supplierName",
      width: 220,
      fixed: "left",
      ellipsis: true,
      sorter: (a, b) => a.supplierName.localeCompare(b.supplierName),
      render: (value: string, row) => (
        <Space direction="vertical" size={0}>
          <Typography.Text>{value}</Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>{row.supplierCode}</Typography.Text>
        </Space>
      ),
    },
    {
      title: "SKU",
      dataIndex: "skuName",
      width: 280,
      ellipsis: true,
      sorter: (a, b) => a.skuCode.localeCompare(b.skuCode),
      render: (value: string, row) => (
        <Space direction="vertical" size={0}>
          <Typography.Text>{value}</Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>{row.skuCode}</Typography.Text>
        </Space>
      ),
    },
    {
      title: "数量加权未税价",
      dataIndex: "averageBaseNetPrice",
      width: 165,
      align: "right",
      sorter: (a, b) => Number(a.averageBaseNetPrice) - Number(b.averageBaseNetPrice),
      render: (value: string, row) => (
        <Tooltip title="已按采购单位换算系数和税率归一到基础单位未税价；CNY 为系统默认而非 PO 行级凭证币种">
          <span>{value} / {row.baseUom} <Typography.Text type="secondary">CNY*</Typography.Text></span>
        </Tooltip>
      ),
    },
    {
      title: "窗口最低可比价",
      dataIndex: "benchmarkBaseNetPrice",
      width: 150,
      align: "right",
      sorter: (a, b) => Number(a.benchmarkBaseNetPrice) - Number(b.benchmarkBaseNetPrice),
    },
    {
      title: "相对偏差",
      dataIndex: "variancePct",
      width: 120,
      align: "right",
      defaultSortOrder: "descend",
      sorter: (a, b) => Number(a.variancePct) - Number(b.variancePct),
      render: (value: string, row) => row.isBenchmark
        ? <Tag color="green">基准</Tag>
        : <Typography.Text style={{ color: Number(value) >= 5 ? "#cf1322" : "#fa8c16", fontWeight: 600 }}>+{value}%</Typography.Text>,
    },
    { title: "有效采购行", dataIndex: "lineCount", width: 110, align: "right", sorter: (a, b) => a.lineCount - b.lineCount },
    {
      title: "采购基础数量",
      dataIndex: "orderedBaseQty",
      width: 140,
      align: "right",
      sorter: (a, b) => Number(a.orderedBaseQty) - Number(b.orderedBaseQty),
      render: (value: string, row) => `${value} ${row.baseUom}`,
    },
  ];

  const summary = data?.summary;
  const readiness = data?.readiness;
  const coverage = Number(summary?.coveragePct ?? 0);

  return (
    <div>
      <Alert
        type="warning"
        showIcon
        style={{ marginBottom: 12 }}
        message="当前是采购价格观察值，尚未达到财务定价或自动供应商排名条件"
        description={
          <div>
            <Typography.Paragraph style={{ marginBottom: 6 }}>{readiness?.permittedUse ?? "用于发现值得采购复核的同口径价格信号。"}</Typography.Paragraph>
            <ul style={{ margin: 0, paddingInlineStart: 20 }}>
              {(readiness?.blockers ?? ["PO 行币种与用友供应商权威身份仍待验收。"] ).map((blocker) => <li key={blocker}>{blocker}</li>)}
            </ul>
            <Typography.Text type="secondary">{readiness?.prohibitedUse}</Typography.Text>
          </div>
        }
      />

      {loadError ? (
        <Alert
          type="error"
          showIcon
          message="供应商价格偏差加载失败"
          description={loadError}
          action={<Button size="small" icon={<ReloadOutlined />} onClick={() => void load()}>重试</Button>}
          style={{ marginBottom: 12 }}
        />
      ) : null}

      <div className="supplier-scorecard-kpis">
        <Card size="small"><Statistic title="可比 SKU" value={summary?.comparableSkuCount ?? "—"} /></Card>
        <Card size="small"><Statistic title="可比供应商" value={summary?.comparableSupplierCount ?? "—"} /></Card>
        <Card size="small"><Statistic title="可比采购行覆盖" value={summary ? coverage : "—"} precision={summary ? 1 : undefined} suffix={summary ? "%" : undefined} /></Card>
        <Card size="small"><Statistic title="被排除/单一供应商行" value={summary ? summary.excludedInvalidLineCount + summary.singleSupplierLineCount : "—"} /></Card>
      </div>

      <ListToolbar
        state={listState}
        extra={
          <>
            <SearchInput
              key={q}
              allowClear
              size="small"
              defaultValue={q}
              placeholder="搜索供应商或 SKU"
              style={{ width: 260 }}
              onSearch={(value) => listState.setFilter({ q: value.trim() })}
            />
            <Segmented
              size="small"
              value={windowDays}
              onChange={(value) => listState.setFilter({ windowDays: String(value) })}
              options={[{ label: "近 90 天", value: 90 }, { label: "近 180 天", value: 180 }, { label: "近 365 天", value: 365 }]}
            />
          </>
        }
      />

      <div style={{ marginBottom: 12 }}>
        <DecisionVisual
          title="供应商同 SKU 采购价偏差"
          question="哪些供应商在可比 SKU 上持续高于窗口内最低已生效采购价，值得进一步解释或议价？"
          metricId="supplierPriceVariance"
          grain="供应商 × SKU × 窗口"
          unit="偏差百分比"
          source={{
            tier: "derived",
            source: "SCM 已生效 PO 行（基础单位未税归一）",
            asOf: summary?.asOf,
            note: "CNY 为系统默认；用友供应商身份仍待 UAT",
          }}
          coverage={{ covered: summary?.comparableLineCount ?? 0, total: summary?.inputLineCount ?? 0, label: "有效 PO 行" }}
          activeFilters={[`近 ${windowDays} 天`, q ? `搜索：${q}` : "全部供应商与 SKU"]}
          summary={summary
            ? `完整窗口共 ${summary.comparableSkuCount} 个可比 SKU、${summary.comparableSupplierCount} 家供应商，采购行覆盖 ${summary.coveragePct}%。${q ? "图表与明细已按搜索条件收窄；" : ""}图中为供应商跨可比 SKU 的偏差中位数。`
            : "数据尚未成功加载。"}
          caveat="同 SKU 先按采购数量加权；跨 SKU 只取无量纲偏差百分比中位数，不跨物料轧差数量或金额。最低价不等于最优供应商，MOQ、账期、规格、质量和交期仍需人工复核。"
          state={loading && !data ? "loading" : loadError ? "error" : chartData.length === 0 ? "insufficient" : "ready"}
          stateDetail={loadError ?? "当前窗口缺少至少两家供应商采购同一 SKU 的可比样本。"}
          height={300}
          onExport={() => void download()}
          exportLabel="导出完整筛选结果（最多 5000 行）"
          dataView={
            <Table
              rowKey="supplierId"
              size="small"
              pagination={false}
              dataSource={data?.supplierSummary ?? []}
              columns={[
                { title: "供应商", dataIndex: "supplierName" },
                { title: "编码", dataIndex: "supplierCode" },
                { title: "可比 SKU", dataIndex: "comparableSkuCount", align: "right" },
                { title: "高于基准 SKU", dataIndex: "aboveBenchmarkSkuCount", align: "right" },
                { title: "偏差中位数", dataIndex: "medianVariancePct", align: "right", render: (value: string) => `${value}%` },
              ]}
            />
          }
        >
          <ResponsiveContainer>
            <BarChart data={chartData} layout="vertical" margin={{ top: 8, right: 24, bottom: 8, left: 12 }}>
              <CartesianGrid strokeDasharray="3 3" horizontal={false} />
              <XAxis type="number" unit="%" />
              <YAxis type="category" dataKey="name" width={110} tick={{ fontSize: 12 }} />
              <RTooltip
                formatter={(value) => [`${Number(value).toFixed(2)}%`, "偏差中位数"]}
                labelFormatter={(label, payload) => `${label}${payload?.[0]?.payload?.code ? `（${payload[0].payload.code}）` : ""}`}
              />
              <Bar dataKey="medianVariancePct" name="偏差中位数" fill="#fa8c16" radius={[0, 4, 4, 0]} isAnimationActive={false} />
            </BarChart>
          </ResponsiveContainer>
        </DecisionVisual>
      </div>

      <Table<PriceVarianceRow>
        rowKey="key"
        size={listState.tableSize}
        columns={columns}
        dataSource={data?.rows ?? []}
        loading={loading}
        scroll={{ x: "max-content" }}
        pagination={listState.paginationProps({ total: data?.total ?? 0, showTotal: (total) => `共 ${total} 条可比记录` })}
        locale={{ emptyText: loadError ? "数据未加载" : "当前窗口没有至少两家供应商采购同一 SKU 的可比记录" }}
      />
    </div>
  );
}

/* ───────────────── 页面外壳 ───────────────── */

export default function SupplierScorecardClient() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const requestedTab = searchParams.get("tab");
  const activeTab = requestedTab === "qc" || requestedTab === "price" ? requestedTab : "scorecard";
  return (
    <div>
      <Typography.Title level={4} style={{ marginTop: 0 }}>供应商记分卡</Typography.Title>
      <Tabs
        activeKey={activeTab}
        onChange={(tab) => {
          const next = new URLSearchParams(searchParams.toString());
          if (tab === "scorecard") next.delete("tab");
          else next.set("tab", tab);
          router.replace(`/report/supplier-scorecard${next.size > 0 ? `?${next.toString()}` : ""}`, { scroll: false });
        }}
        items={[
          { key: "scorecard", label: "记分卡", children: <ScorecardTab /> },
          { key: "qc", label: "质检透视", children: <QcSummaryTab /> },
          { key: "price", label: "价格偏差", children: <PriceVarianceTab /> },
        ]}
      />
    </div>
  );
}
