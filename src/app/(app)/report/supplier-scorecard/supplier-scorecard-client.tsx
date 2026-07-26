"use client";

/**
 * E5-06 + E5-07 供应商记分卡 / 质检透视（只读报表 + 人工采纳分级）。
 *
 * 两个页签回答两个问题：
 * - 记分卡：这家供应商到底几分？分从哪来？（展开行逐维度拆给你看——不可解释的评分没人敢用）
 * - 质检透视：质量问题在时间上怎么走？（按月堆叠，让步/报废是不是在变多）
 * 评分只是**数据建议**：采纳与否由采购判断，点「采纳」才写档案等级；样本不足者不评级而非给低分。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Alert, App, Button, Card, Col, Empty, Input, Popconfirm, Progress, Row, Segmented, Select,
  Space, Statistic, Table, Tabs, Tag, Tooltip, Typography,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip as RTooltip, XAxis, YAxis } from "recharts";
import { fetchJson, postJson } from "@/components/fetchJson";
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
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState<number | null>(null);
  // 列表页状态平台（E6-P1）：筛选/分页进 URL，密度与已保存视图存本地；
  // 本页两个页签各是独立列表，用 paramPrefix 分命名空间（sc_* / qc_*）互不清空
  const listState = useListState({ key: "supplier-scorecard", paramPrefix: "sc", defaults: { q: "", windowDays: "180" }, defaultPageSize: 20 });
  const { filters, page, pageSize } = listState;
  const q = filters.q;
  const windowDays = Number(filters.windowDays);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ q, page: String(page), pageSize: String(pageSize), windowDays: String(windowDays) });
      setData(await fetchJson<ScoreData>(`/api/report/supplier-scorecard?${params.toString()}`));
    } catch (e) {
      message.error((e as Error).message);
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
    <Table<BreakdownItem>
      rowKey="key"
      size="small"
      pagination={false}
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
  );

  const s = data?.summary;

  return (
    <div>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message="评分是数据建议，不是判决——采纳与否由采购判断，点「采纳」才会写入供应商档案等级，系统不会自动改主数据。"
        description={
          <Typography.Text type="secondary">
            综合分 = 准时交付 40 分（复用交期学习的准时率：实际收货 ≤ 承诺到货）+ 质量 40 分（合格率 − 让步率×0.5 − 报废率×1.0）+ 价格稳定 20 分（窗口内生效调价次数，满 5 次归零）。
            某维度无数据时该维度不计分、按剩余权重归一（展开行有逐维度说明）；
            窗口内收货不足 {data?.minSamples ?? 3} 单的供应商<strong>不予评级</strong>，而不是给一个低分——单笔波动不足以定性。
            准时率目前只覆盖采购 PO（委外 JG 无「承诺 vs 收货」等价链路），纯加工厂该维度按归一处理。
          </Typography.Text>
        }
      />

      <Row gutter={12} style={{ marginBottom: 12 }}>
        <Col><Card size="small"><Statistic title={`窗口内有往来的供应商（近 ${s?.windowDays ?? 180} 天）`} value={s?.suppliers ?? 0} /></Card></Col>
        <Col><Card size="small"><Statistic title="已评级" value={s?.rated ?? 0} suffix={`/ ${s?.suppliers ?? 0}`} /></Card></Col>
        <Col>
          <Card size="small">
            <Statistic title="建议调整等级" value={s?.suggestChanges ?? 0} valueStyle={{ color: (s?.suggestChanges ?? 0) > 0 ? "#fa8c16" : undefined }} />
          </Card>
        </Col>
        <Col>
          <Card size="small">
            <Statistic
              title="平均准时率"
              value={s?.avgOnTimeRate == null ? 0 : s.avgOnTimeRate * 100}
              precision={1}
              suffix="%"
              valueStyle={{ color: s?.avgOnTimeRate != null && s.avgOnTimeRate < 0.8 ? "#cf1322" : "#52c41a" }}
            />
          </Card>
        </Col>
      </Row>

      <ListToolbar
        state={listState}
        extra={
          <>
            <Input.Search
              key={q}
              allowClear
              defaultValue={q}
              placeholder="搜索供应商编码/名称"
              style={{ width: 240 }}
              onSearch={(v) => listState.setFilter({ q: v.trim() })}
            />
            <Segmented
              value={windowDays}
              onChange={(v) => listState.setFilter({ windowDays: String(v) })}
              options={[{ label: "近 90 天", value: 90 }, { label: "近 180 天", value: 180 }, { label: "近 365 天", value: 365 }]}
            />
          </>
        }
      />

      <Table<ScoreRow>
        rowKey="supplierId"
        size={listState.tableSize}
        columns={columns}
        dataSource={data?.rows ?? []}
        loading={loading}
        scroll={{ x: "max-content" }}
        expandable={{ expandedRowRender: expanded, rowExpandable: (r) => r.breakdown.length > 0 }}
        rowClassName={(r) => (r.suggestLevelChange ? "ant-table-row-selected" : "")}
        pagination={listState.paginationProps({ total: data?.total ?? 0, showTotal: (t) => `共 ${t} 家` })}
      />
    </div>
  );
}

/* ───────────────── 页签二：质检透视 ───────────────── */

function QcSummaryTab() {
  const { message } = App.useApp();
  const [data, setData] = useState<QcData | null>(null);
  const [loading, setLoading] = useState(false);
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
    try {
      // 供应商筛选在前端做：一次取全量才能填出下拉选项（月份数有限、行量可控）
      setData(await fetchJson<QcData>(`/api/report/qc-summary?months=${months}`));
    } catch (e) {
      message.error((e as Error).message);
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

      <Row gutter={12} style={{ marginBottom: 12 }}>
        <Col><Card size="small"><Statistic title="收货批次" value={t?.batches ?? 0} /></Card></Col>
        <Col><Card size="small"><Statistic title="合格率" value={t?.passRate == null ? 0 : t.passRate * 100} precision={1} suffix="%" valueStyle={{ color: "#52c41a" }} /></Card></Col>
        <Col><Card size="small"><Statistic title="让步接收率" value={t?.concessionRate == null ? 0 : t.concessionRate * 100} precision={1} suffix="%" valueStyle={{ color: "#1677ff" }} /></Card></Col>
        <Col><Card size="small"><Statistic title="报废率" value={t?.scrapRate == null ? 0 : t.scrapRate * 100} precision={1} suffix="%" valueStyle={{ color: "#cf1322" }} /></Card></Col>
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

      <Card size="small" title="月度检验结构（堆叠 = 正常/返工/让步/报废/待判定 数量）" styles={{ body: { height: 320 } }} style={{ marginBottom: 12 }}>
        {!hasData ? (
          <Empty description="窗口内无检验记录" />
        ) : (
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
        )}
      </Card>

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
      />
    </div>
  );
}

/* ───────────────── 页面外壳 ───────────────── */

export default function SupplierScorecardClient() {
  return (
    <div>
      <Typography.Title level={4} style={{ marginTop: 0 }}>供应商记分卡</Typography.Title>
      <Tabs
        defaultActiveKey="scorecard"
        items={[
          { key: "scorecard", label: "记分卡", children: <ScorecardTab /> },
          { key: "qc", label: "质检透视", children: <QcSummaryTab /> },
        ]}
      />
    </div>
  );
}
