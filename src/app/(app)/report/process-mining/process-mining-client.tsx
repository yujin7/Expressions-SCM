"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Alert,
  App,
  Card,
  Empty,
  Segmented,
  Select,
  Space,
  Statistic,
  Table,
  Tag,
  Timeline,
  Typography,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip as ChartTooltip,
  XAxis,
  YAxis,
} from "recharts";

import CaliberNote from "@/components/CaliberNote";
import DecisionVisual from "@/components/DecisionVisual";
import { fetchJson } from "@/components/fetchJson";
import { useListState } from "@/components/useListState";

interface StageMetric {
  key: string;
  entity: string;
  fromAction: string;
  fromLabel: string;
  toAction: string;
  toLabel: string;
  count: number;
  medianHours: number;
  p90Hours: number;
  avgHours: number;
  maxHours: number;
  reliable: boolean;
}

interface ProcessVariant {
  key: string;
  entity: string;
  path: string[];
  canonicalPath: string[];
  cases: number;
  share: number;
  medianHours: number | null;
}

interface CaseEvent {
  id: number;
  action: string;
  label: string;
  canonical: string;
  createdAt: string;
}

interface ProcessCase {
  key: string;
  entity: string;
  entityId: number;
  docNo: string;
  startedAt: string;
  lastAt: string;
  totalHours: number | null;
  eventCount: number;
  reachedTerminal: boolean;
  path: string[];
  events: CaseEvent[];
}

interface ProcessMiningData {
  generatedAt: string;
  windowDays: number;
  windowFrom: string;
  entity: string;
  entityOptions: { value: string; label: string }[];
  truncated: boolean;
  sourceEventCount: number;
  summary: {
    totalEvents: number;
    mappedEvents: number;
    versionedEvents: number;
    stateEvents: number;
    cases: number;
    analyzableCases: number;
    terminalCases: number;
    eventMappingRate: number;
    versionedRate: number;
    caseCoverageRate: number;
  };
  stages: StageMetric[];
  variants: ProcessVariant[];
  cases: ProcessCase[];
}

const ENTITY_LABELS: Record<string, string> = {
  bh: "备货申请",
  wo: "委外工单",
  po: "采购订单",
  jg: "加工通知单",
  fl: "发料单",
  tl: "退料单",
  sh: "收货单",
  ct: "采购退货单",
  stock_doc: "库存单据",
  pd_doc: "盘点单",
  js: "结算单",
};

const SH_TIME = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? SH_TIME.format(date) : value;
}

function duration(value: number | null): string {
  if (value == null) return "—";
  if (value < 1) return `${Math.round(value * 60)} 分钟`;
  if (value < 48) return `${value.toFixed(value < 10 ? 1 : 0)} 小时`;
  return `${(value / 24).toFixed(1)} 天`;
}

export default function ProcessMiningClient() {
  const { message } = App.useApp();
  const [data, setData] = useState<ProcessMiningData | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const listState = useListState({
    key: "process-mining",
    defaults: { windowDays: "90", entity: "all" },
  });
  const windowDays = Number(listState.filters.windowDays);
  const entity = listState.filters.entity;

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setLoadError(null);
    const params = new URLSearchParams({ windowDays: String(windowDays), entity });
    void fetchJson<ProcessMiningData>(`/api/report/process-mining?${params}`, { signal: controller.signal })
      .then((next) => setData(next))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        const text = error instanceof Error ? error.message : "流程数据加载失败";
        setLoadError(text);
        setData(null);
        message.error(text);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [entity, message, windowDays]);

  const chartRows = useMemo(
    () => (data?.stages ?? []).filter((stage) => stage.reliable).slice(0, 10).map((stage) => ({
      key: stage.key,
      name: `${ENTITY_LABELS[stage.entity] ?? stage.entity} · ${stage.fromLabel}→${stage.toLabel}`,
      median: stage.medianHours,
      p90: stage.p90Hours,
      samples: stage.count,
    })),
    [data],
  );

  const stageColumns: ColumnsType<StageMetric> = [
    {
      title: "流程",
      dataIndex: "entity",
      width: 120,
      render: (value: string) => ENTITY_LABELS[value] ?? value,
      sorter: (a, b) => (ENTITY_LABELS[a.entity] ?? a.entity).localeCompare(ENTITY_LABELS[b.entity] ?? b.entity),
    },
    {
      title: "环节",
      width: 220,
      render: (_, row) => `${row.fromLabel} → ${row.toLabel}`,
    },
    { title: "样本", dataIndex: "count", width: 80, align: "right", sorter: (a, b) => a.count - b.count },
    {
      title: "中位数",
      dataIndex: "medianHours",
      width: 110,
      align: "right",
      sorter: (a, b) => a.medianHours - b.medianHours,
      render: (value: number) => duration(value),
    },
    {
      title: "P90",
      dataIndex: "p90Hours",
      width: 110,
      align: "right",
      defaultSortOrder: "descend",
      sorter: (a, b) => a.p90Hours - b.p90Hours,
      render: (value: number, row) => row.reliable
        ? <Typography.Text style={{ color: value >= 72 ? "#cf1322" : undefined }}>{duration(value)}</Typography.Text>
        : <Typography.Text type="secondary">{duration(value)}</Typography.Text>,
    },
    {
      title: "可信度",
      dataIndex: "reliable",
      width: 100,
      render: (value: boolean, row) => value
        ? <Tag color="green">可比较</Tag>
        : <Tag>样本 {row.count}/3</Tag>,
    },
  ];

  const variantColumns: ColumnsType<ProcessVariant> = [
    { title: "流程", dataIndex: "entity", width: 110, render: (value: string) => ENTITY_LABELS[value] ?? value },
    {
      title: "路径变体",
      dataIndex: "path",
      render: (path: string[]) => (
        <Space size={[4, 4]} wrap split={<Typography.Text type="secondary">→</Typography.Text>}>
          {path.map((label, index) => <Tag key={`${index}-${label}`}>{label}</Tag>)}
        </Space>
      ),
    },
    { title: "案例数", dataIndex: "cases", width: 90, align: "right", sorter: (a, b) => a.cases - b.cases },
    { title: "占比", dataIndex: "share", width: 90, align: "right", render: (value: number) => `${value}%` },
    { title: "中位总时长", dataIndex: "medianHours", width: 120, align: "right", render: (value: number | null) => duration(value) },
  ];

  const caseColumns: ColumnsType<ProcessCase> = [
    {
      title: "单据",
      dataIndex: "docNo",
      width: 200,
      render: (value: string, row) => (
        <Space size={6}>
          <Tag>{ENTITY_LABELS[row.entity] ?? row.entity}</Tag>
          <Typography.Text code>{value}</Typography.Text>
        </Space>
      ),
    },
    { title: "首事件", dataIndex: "startedAt", width: 130, render: formatTime },
    { title: "末事件", dataIndex: "lastAt", width: 130, render: formatTime },
    { title: "事件数", dataIndex: "eventCount", width: 80, align: "right" },
    {
      title: "总时长",
      dataIndex: "totalHours",
      width: 110,
      align: "right",
      sorter: (a, b) => (a.totalHours ?? -1) - (b.totalHours ?? -1),
      render: (value: number | null) => duration(value),
    },
    {
      title: "终态证据",
      dataIndex: "reachedTerminal",
      width: 100,
      render: (value: boolean) => value ? <Tag color="green">已出现</Tag> : <Tag color="gold">未出现</Tag>,
    },
  ];

  const summary = data?.summary;
  const state = loading && data == null ? "loading" : loadError ? "error" : chartRows.length === 0 ? "insufficient" : "ready";

  return (
    <div className="process-mining-page">
      <div className="dashboard-header">
        <div className="dashboard-header__copy">
          <Typography.Title level={4} className="dashboard-header__title">流程效率与瓶颈</Typography.Title>
          <CaliberNote
            summary="从不可改写的审计事件计算环节周期与路径变体；只分析流程，不做员工排名。"
            detail="相邻状态事件构成一个环节；中位数描述常态，P90 用于暴露慢尾。连续重复动作按重试折叠。少于 3 个样本只展示、不参与瓶颈比较。历史事件按原 action 兼容分类，新事件写入 event-v1 规范身份。"
          />
        </div>
        <Space wrap className="dashboard-header__meta">
          <Select
            value={entity}
            style={{ width: 160 }}
            options={[{ value: "all", label: "全部流程" }, ...(data?.entityOptions ?? [])]}
            onChange={(value) => listState.setFilter({ entity: value })}
          />
          <Segmented
            value={windowDays}
            options={[
              { label: "30 天", value: 30 },
              { label: "90 天", value: 90 },
              { label: "180 天", value: 180 },
              { label: "365 天", value: 365 },
            ]}
            onChange={(value) => listState.setFilter({ windowDays: String(value) })}
          />
        </Space>
      </div>

      {loadError ? <Alert type="error" showIcon message="流程数据加载失败" description={loadError} style={{ marginBottom: 12 }} /> : null}
      {data?.truncated ? (
        <Alert
          type="warning"
          showIcon
          message={`窗口内有 ${data.sourceEventCount.toLocaleString()} 条事件，本视图仅分析最近 50,000 条。`}
          style={{ marginBottom: 12 }}
        />
      ) : null}
      {summary && summary.caseCoverageRate < 60 ? (
        <Alert
          type="warning"
          showIcon
          message={`可计算周期的案例覆盖率仅 ${summary.caseCoverageRate}%`}
          description="大量单据只有一个状态事件；当前结果可用于发现候选瓶颈，但不能代表全流程总体。"
          style={{ marginBottom: 12 }}
        />
      ) : null}

      <div className="process-mining-kpis">
        <Card size="small"><Statistic title="审计事件" value={summary?.totalEvents ?? 0} /></Card>
        <Card size="small"><Statistic title="状态事件" value={summary?.stateEvents ?? 0} /></Card>
        <Card size="small"><Statistic title="可计算周期案例" value={summary?.analyzableCases ?? 0} suffix={`/ ${summary?.cases ?? 0}`} /></Card>
        <Card size="small"><Statistic title="事件映射率" value={summary?.eventMappingRate ?? 0} precision={1} suffix="%" /></Card>
        <Card size="small"><Statistic title="event-v1 覆盖" value={summary?.versionedRate ?? 0} precision={1} suffix="%" /></Card>
      </div>

      <DecisionVisual
        title="环节慢尾（P90）"
        question="哪个真实流转环节最慢，常态与慢尾相差多大？"
        source={{
          tier: "derived",
          source: "audit_logs 追加式审计事件 × event-v1 分类",
          asOf: data?.generatedAt ? new Date(data.generatedAt).toLocaleDateString("zh-CN") : null,
          note: "只聚合环节，不输出个人绩效排名",
        }}
        coverage={summary ? {
          covered: summary.analyzableCases,
          total: summary.cases,
          label: "可计算周期案例",
        } : undefined}
        activeFilters={[
          entity === "all" ? "全部流程" : (ENTITY_LABELS[entity] ?? entity),
          `近 ${windowDays} 天`,
        ]}
        summary={chartRows.length > 0
          ? `当前有 ${chartRows.length} 个达到最小样本数的环节；按 P90 从慢到快展示。`
          : "当前筛选下没有达到 3 个样本的可比较环节。"}
        caveat="少于 3 个样本的环节不进入图表；审计缺失会降低覆盖率，不能把未记录误判为零耗时。"
        state={state}
        stateDetail={loadError ?? "当前筛选下没有达到 3 个样本的环节，请扩大时间窗口。"}
        height={340}
      >
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={chartRows} layout="vertical" margin={{ top: 8, right: 30, left: 12, bottom: 8 }}>
            <CartesianGrid strokeDasharray="3 3" horizontal={false} />
            <XAxis type="number" unit="h" />
            <YAxis type="category" dataKey="name" width={190} tick={{ fontSize: 11 }} />
            <ChartTooltip formatter={(value) => duration(Number(value))} />
            <Legend />
            <Bar dataKey="median" name="中位数" fill="#6f8cff" radius={[0, 4, 4, 0]} />
            <Bar dataKey="p90" name="P90 慢尾" fill="#d84a43" radius={[0, 4, 4, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </DecisionVisual>

      <Typography.Title level={5}>环节明细</Typography.Title>
      <Table<StageMetric>
        rowKey="key"
        size="small"
        columns={stageColumns}
        dataSource={data?.stages ?? []}
        loading={loading}
        pagination={{ pageSize: 10, showSizeChanger: false }}
        scroll={{ x: "max-content" }}
      />

      <Typography.Title level={5} style={{ marginTop: 20 }}>路径变体</Typography.Title>
      <Table<ProcessVariant>
        rowKey="key"
        size="small"
        columns={variantColumns}
        dataSource={data?.variants ?? []}
        loading={loading}
        pagination={false}
        locale={{ emptyText: <Empty description="当前窗口没有可识别的流程路径" /> }}
        scroll={{ x: "max-content" }}
      />

      <Typography.Title level={5} style={{ marginTop: 20 }}>慢案例与事件证据</Typography.Title>
      <Table<ProcessCase>
        rowKey="key"
        size="small"
        columns={caseColumns}
        dataSource={data?.cases ?? []}
        loading={loading}
        pagination={{ pageSize: 10, showSizeChanger: false }}
        scroll={{ x: "max-content" }}
        expandable={{
          rowExpandable: (row) => row.events.length > 0,
          expandedRowRender: (row) => (
            <Timeline
              style={{ margin: "8px 8px 0" }}
              items={row.events.map((event) => ({
                color: "blue",
                children: (
                  <Space wrap size={6}>
                    <Typography.Text>{formatTime(event.createdAt)}</Typography.Text>
                    <Tag>{event.label}</Tag>
                    <Typography.Text code>{event.canonical}</Typography.Text>
                  </Space>
                ),
              }))}
            />
          ),
        }}
      />
    </div>
  );
}
