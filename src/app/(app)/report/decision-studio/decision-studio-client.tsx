"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import {
  Alert,
  App,
  Button,
  Card,
  Col,
  Progress,
  Radio,
  Row,
  Select,
  Space,
  Statistic,
  Table,
  Tabs,
  Tag,
  Typography,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import {
  Area,
  Bar,
  CartesianGrid,
  Cell,
  ComposedChart,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis,
} from "recharts";
import { CopyOutlined, DownloadOutlined, ReloadOutlined } from "@ant-design/icons";

import DecisionVisual from "@/components/DecisionVisual";
import { VISUAL_COLOR } from "@/components/decision-visuals";
import { fetchJson } from "@/components/fetchJson";
import { formatQty } from "@/components/format";
import { exportCsv } from "@/components/exportCsv";
import {
  buildExternalDemandDailyExport,
  buildExternalDemandFulfillmentExport,
  buildExternalDemandIdentityExport,
  buildExternalDemandRefundDriversExport,
  buildExternalDemandRollingBriefExport,
  externalDemandIdentityAction,
  externalRefundDriverAction,
} from "@/components/external-demand-export";
import {
  buildCommerceIdentityRepairExport,
  COMMERCE_IDENTITY_ISSUE_LABEL,
} from "@/components/commerce-identity-export";
import { useListState } from "@/components/useListState";
import RemoteSelect from "@/components/RemoteSelect";
import PlatformSkuGapCard from "./platform-sku-gap-card";
import type {
  DecisionStudioResult,
  StudioDimension,
} from "@/server/modules/report/decision-studio";

// 能力解锁面板只在 readiness 标签出现；不让它和整套数据产品治理 UI 阻塞常用首屏。
const DecisionReadinessPanel = dynamic(
  () => import("@/components/DecisionReadinessPanel"),
  { loading: () => <Card loading style={{ minHeight: 220 }} /> },
);

const DIMENSION_LABEL: Record<StudioDimension, string> = {
  brand: "品牌",
  channel: "渠道",
  sku: "SKU",
  month: "月份",
};

function pctLabel(value: number | null): string {
  if (value == null) return "数据不足";
  return `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`;
}

function ppLabel(value: number | null): string {
  if (value == null) return "无法计算";
  return `${value >= 0 ? "+" : ""}${value.toFixed(1)} 个百分点`;
}

function movementColor(
  movement: "up" | "down" | "flat" | "unknown",
  inverse = false,
): string | undefined {
  if (movement === "unknown" || movement === "flat") return undefined;
  const favorable = inverse ? movement === "down" : movement === "up";
  return favorable ? VISUAL_COLOR.positive : VISUAL_COLOR.critical;
}

function refundMovementLabel(movement: "up" | "down" | "flat" | "unknown"): string {
  if (movement === "up") return "退款增加驱动";
  if (movement === "down") return "退款减少驱动";
  if (movement === "flat") return "退款结构变动";
  return "退款驱动待判断";
}

function shortQty(value: number): string {
  if (Math.abs(value) >= 10_000) return `${(value / 10_000).toFixed(1)}万`;
  return formatQty(value);
}

function heatColor(value: number, max: number): string {
  if (value <= 0 || max <= 0) return "#f1f5f9";
  const ratio = Math.min(1, value / max);
  if (ratio > 0.75) return "#1d4ed8";
  if (ratio > 0.5) return "#3b82f6";
  if (ratio > 0.25) return "#93c5fd";
  return "#dbeafe";
}

export default function DecisionStudioClient() {
  const { message } = App.useApp();
  const [data, setData] = useState<DecisionStudioResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const activeRequest = useRef<AbortController | null>(null);
  const responseCache = useRef(new Map<string, { data: DecisionStudioResult; cachedAt: number }>());
  const view = useListState({
    key: "decision-studio",
    defaults: { dimension: "brand", key: "", tab: "focus", brand: "", channel: "", product: "" },
    paginated: false,
  });
  const dimension = (["brand", "channel", "sku", "month"].includes(view.filters.dimension)
    ? view.filters.dimension
    : "brand") as StudioDimension;
  const selectedKey = view.filters.key;
  // 跨维筛选：与分组维度正交，可同时收窄品牌与渠道（0727 会议的「NING × 天猫」）
  const scopeBrand = view.filters.brand;
  const scopeChannel = view.filters.channel;
  const activeTab = view.filters.tab || "focus";
  const focusProductId = view.filters.product;

  const load = useCallback(async (force = false) => {
    const query = new URLSearchParams({ dimension });
    query.set("tab", activeTab);
    if (selectedKey) query.set("key", selectedKey);
    if (scopeBrand) query.set("brand", scopeBrand);
    if (scopeChannel) query.set("channel", scopeChannel);
    const cacheKey = query.toString();
    const cached = responseCache.current.get(cacheKey);
    if (!force && cached && Date.now() - cached.cachedAt < 30_000) {
      activeRequest.current?.abort();
      activeRequest.current = null;
      setLoadError(null);
      setData(cached.data);
      setLoading(false);
      return;
    }
    activeRequest.current?.abort();
    const controller = new AbortController();
    activeRequest.current = controller;
    setLoading(true);
    setLoadError(null);
    setData(null);
    try {
      const nextData = await fetchJson<DecisionStudioResult>(
        `/api/report/decision-studio?${query.toString()}`,
        { signal: controller.signal },
      );
      responseCache.current.set(cacheKey, { data: nextData, cachedAt: Date.now() });
      if (responseCache.current.size > 12) {
        const oldestKey = responseCache.current.keys().next().value as string | undefined;
        if (oldestKey) responseCache.current.delete(oldestKey);
      }
      setData(nextData);
    } catch (error) {
      if ((error as Error).name === "AbortError") return;
      const detail = (error as Error).message;
      setLoadError(detail);
      message.error(detail);
    } finally {
      if (activeRequest.current === controller) {
        setLoading(false);
        activeRequest.current = null;
      }
    }
  }, [activeTab, dimension, selectedKey, scopeBrand, scopeChannel, message]);

  useEffect(() => {
    void load();
    return () => activeRequest.current?.abort();
  }, [load]);

  const groupOptions = useMemo(
    () => (data?.groups ?? []).map((item) => ({
      value: item.key,
      label: `${item.label} · ${shortQty(item.total)}`,
    })),
    [data],
  );
  const scope = data?.selectedLabel ?? "全部";
  const filters = [
    `维度：${DIMENSION_LABEL[dimension]}`,
    `范围：${scope}`,
    ...(scopeBrand ? [`品牌：${scopeBrand}`] : []),
    ...(scopeChannel ? [`渠道：${scopeChannel}`] : []),
  ];
  const paretoRows = (data?.pareto ?? []).slice(0, 30);
  const heatMax = Math.max(0, ...(data?.daily.dates ?? []).map((item) => item.qty));
  const external = data?.externalDemand;
  const externalReady = external?.state === "ready";
  const refundDrivers = external?.refundDrivers;
  const refundShopChartRows = (refundDrivers?.byShop ?? []).slice(0, 10);
  const identity = data?.commerceIdentity;

  const pivotColumns = useMemo<ColumnsType<DecisionStudioResult["pivot"][number]>>(
    () => [
      {
        title: DIMENSION_LABEL[dimension],
        dataIndex: "label",
        key: "label",
        fixed: "left",
        width: 220,
        render: (value: string, row) => (
          <Button
            type="link"
            size="small"
            style={{ padding: 0 }}
            onClick={() => view.setFilter({ key: row.key, tab: "focus" })}
          >
            {value}
          </Button>
        ),
      },
      ...(data?.months ?? []).map((month) => ({
        title: month,
        key: month,
        width: 120,
        align: "right" as const,
        render: (_: unknown, row: DecisionStudioResult["pivot"][number]) =>
          formatQty(row.byMonth[month] ?? 0),
      })),
      {
        title: "合计",
        dataIndex: "total",
        key: "total",
        width: 130,
        fixed: "right",
        align: "right",
        render: (value: number) => <Typography.Text strong>{formatQty(value)}</Typography.Text>,
      },
    ],
    [data?.months, dimension, view],
  );

  const copyReview = async () => {
    if (!data) return;
    try {
      await navigator.clipboard.writeText(data.review.markdown);
      message.success("月度经营回顾已复制");
    } catch {
      message.warning("浏览器未允许复制，请使用地址栏分享当前分析。");
    }
  };

  const exportExternalDaily = () => {
    if (!externalReady || !external || external.daily.length === 0) {
      message.warning("当前没有可导出的简道云日核对证据");
      return;
    }
    const payload = buildExternalDemandDailyExport(external);
    exportCsv(payload.filename, payload.headers, payload.rows);
    message.success("已导出简道云日控制总量 UAT 证据");
  };

  const exportExternalIdentityQueue = () => {
    if (!externalReady || !external || external.topUnmapped.length === 0) {
      message.warning("当前没有待导出的平台 SKU 身份修复项");
      return;
    }
    const payload = buildExternalDemandIdentityExport(external);
    exportCsv(payload.filename, payload.headers, payload.rows);
    message.success("已导出平台 SKU 身份修复队列");
  };

  const exportExternalRollingBrief = () => {
    if (!external || !external.decisionBrief.anchorDate) {
      message.warning("当前没有可导出的滚动需求窗口证据");
      return;
    }
    const payload = buildExternalDemandRollingBriefExport(external);
    exportCsv(payload.filename, payload.headers, payload.rows);
    message.success("已导出最近7天对前7天的需求决策证据");
  };

  const exportExternalRefundDrivers = () => {
    if (!external || external.refundDrivers.topContributors.length === 0) {
      message.warning("当前没有可导出的退款变化驱动项");
      return;
    }
    const payload = buildExternalDemandRefundDriversExport(external);
    exportCsv(payload.filename, payload.headers, payload.rows);
    message.success("已导出退款变化驱动行动证据");
  };

  const exportExternalFulfillment = () => {
    if (!external || external.fulfillment.state !== "ready" || external.fulfillment.topGaps.length === 0) {
      message.warning("当前没有可导出的简道云 × 聚水潭可比样本");
      return;
    }
    const payload = buildExternalDemandFulfillmentExport(external);
    exportCsv(payload.filename, payload.headers, payload.rows);
    message.success("已导出简道云 × 聚水潭需求履约核对证据");
  };

  const exportCommerceIdentityQueue = () => {
    if (!identity || identity.repairQueue.length === 0) {
      message.warning("当前没有可导出的三平台身份修复项");
      return;
    }
    const payload = buildCommerceIdentityRepairExport(identity);
    exportCsv(payload.filename, payload.headers, payload.rows);
    message.success("已导出三平台身份修复行动清单");
  };

  return (
    <div>
      <div className="decision-studio-heading">
        <Typography.Title level={3} style={{ margin: 0 }}>决策工作室</Typography.Title>
        <Typography.Text type="secondary">
          用一套筛选联动结构、趋势、透视、日级节奏和月度回顾；缺数据的能力保持留白。
        </Typography.Text>
      </div>
      <div className="decision-studio-filterbar">
        <div className="decision-studio-dimensions">
          <Radio.Group
            optionType="button"
            buttonStyle="solid"
            value={dimension}
            options={[
              { label: "品牌", value: "brand" },
              { label: "渠道", value: "channel" },
              { label: "SKU", value: "sku" },
              { label: "月份", value: "month" },
            ]}
            onChange={(event) => view.setFilter({
              dimension: event.target.value as StudioDimension,
              key: "",
            })}
          />
        </div>
        <div className="decision-studio-scope-filters">
          {/*
            跨维筛选：与上面的分组维度**正交**。旧实现只有一个 dimension + 一个 key，
            品牌与渠道互斥单选，做不到「NING × 天猫」——0727 会议要的正是这种组合。
            这里走主数据接口取候选，选中后进 SQL（EXISTS），不是前端裁剪。
          */}
          <RemoteSelect
            api="/api/master/brand"
            getLabel={(r) => String(r.nameCn ?? r.code)}
            getValue={(r) => String(r.code)}
            allowClear
            aria-label="筛选品牌"
            placeholder="全部品牌"
            style={{ width: "100%" }}
            value={scopeBrand || undefined}
            onChange={(v) => view.setFilter({ brand: v == null ? "" : String(v), key: "" })}
          />
          <RemoteSelect
            api="/api/master/channel"
            getLabel={(r) => String(r.name ?? r.code)}
            getValue={(r) => String(r.code)}
            allowClear
            aria-label="筛选渠道"
            placeholder="全部渠道"
            style={{ width: "100%" }}
            value={scopeChannel || undefined}
            onChange={(v) => view.setFilter({ channel: v == null ? "" : String(v), key: "" })}
          />
          <Select
            allowClear
            showSearch
            optionFilterProp="label"
            aria-label={`筛选${DIMENSION_LABEL[dimension]}`}
            style={{ width: "100%" }}
            placeholder={`筛选${DIMENSION_LABEL[dimension]}（全部）`}
            value={selectedKey || undefined}
            options={groupOptions}
            onChange={(key) => view.setFilter({ key: key ?? "" })}
          />
          <Button
            icon={<ReloadOutlined />}
            loading={loading}
            onClick={() => void load(true)}
          >
            刷新
          </Button>
        </div>
      </div>

      <Alert
        showIcon
        type="info"
        style={{ marginBottom: 12 }}
        message="联动筛选已进入 URL：刷新、分享、前进后退都保留现场。点击帕累托柱或透视表成员可继续下钻。"
        description={data?.limitations[0]}
      />

      {loadError ? (
        <Alert
          showIcon
          type="error"
          style={{ marginBottom: 12 }}
          message="决策数据加载失败"
          description={loadError}
          action={<Button size="small" onClick={() => void load(true)}>重新加载</Button>}
        />
      ) : null}

      <Row gutter={[10, 10]} className="compact-kpi-row">
        <Col xs={12} md={6}>
          <Card size="small" loading={loading && !data}>
            <Statistic
              title={`${data?.latestMonth ?? "最新月"}销量`}
              value={data?.comparison.current ?? "—"}
              formatter={(value) => Number.isFinite(Number(value)) ? formatQty(Number(value)) : "—"}
            />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card size="small" loading={loading && !data}>
            <Statistic
              title="环比"
              value={pctLabel(data?.comparison.momPct ?? null)}
              valueStyle={{
                color: data?.comparison.momPct == null
                  ? undefined
                  : data.comparison.momPct < 0
                    ? VISUAL_COLOR.critical
                    : VISUAL_COLOR.positive,
              }}
            />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card size="small" loading={loading && !data}>
            <Statistic title="同比" value={pctLabel(data?.comparison.yoyPct ?? null)} />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card size="small" loading={loading && !data}>
            <Statistic
              title={`贡献 80% 的${DIMENSION_LABEL[dimension]}数`}
              value={data ? data.pareto80Count : "—"}
              suffix={data ? `/ ${data.pareto.length}` : undefined}
            />
          </Card>
        </Col>
      </Row>

      <Tabs
        destroyOnHidden
        activeKey={activeTab}
        onChange={(tab) => view.setFilter({ tab })}
        items={[
          {
            key: "focus",
            label: "结构与基准",
            children: (
              <DecisionVisual
                title={`${DIMENSION_LABEL[dimension]}销量帕累托（TOP 30）`}
                question={`哪些${DIMENSION_LABEL[dimension]}贡献了约 80% 的最新月销量，谁显著高于同组中位数？`}
                metricId="salesQty"
                grain={`${data?.latestMonth ?? "最新月"} × ${DIMENSION_LABEL[dimension]}`}
                unit="基础单位数量 / 累计占比"
                source={{
                  tier: "snapshot",
                  source: "sales_monthly 销售月事实",
                  asOf: data?.latestMonth,
                }}
                coverage={{
                  covered: paretoRows.length,
                  total: data?.pareto.length ?? 0,
                  label: "图中成员",
                }}
                activeFilters={filters}
                summary={
                  data?.pareto[0]
                    ? `${data.pareto80Count} 个成员贡献约 80%；第一位 ${data.pareto[0].label} 占 ${data.pareto[0].sharePct.toFixed(1)}%。`
                    : "当前范围没有可排名的销量事实。"
                }
                caveat="柱形为销量，折线为累计占比；基准线是当前成员销量中位数，不是经营目标。图中仅画 TOP 30，数据表保留当前透视 TOP 20。"
                state={loading && !data ? "loading" : paretoRows.length ? "ready" : "empty"}
                height={430}
                dataView={
                  <Table
                    rowKey="key"
                    size="small"
                    pagination={false}
                    dataSource={data?.pareto ?? []}
                    columns={[
                      { title: DIMENSION_LABEL[dimension], dataIndex: "label" },
                      { title: "销量", dataIndex: "qty", align: "right", render: formatQty },
                      { title: "份额", dataIndex: "sharePct", align: "right", render: (v: number) => `${v.toFixed(1)}%` },
                      { title: "累计", dataIndex: "cumulativePct", align: "right", render: (v: number) => `${v.toFixed(1)}%` },
                    ]}
                  />
                }
              >
                <ResponsiveContainer minWidth={0} minHeight={1}>
                  <ComposedChart data={paretoRows} margin={{ top: 8, right: 22, left: 8, bottom: 86 }}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis
                      dataKey="label"
                      interval={0}
                      angle={-38}
                      textAnchor="end"
                      height={96}
                      tick={{ fontSize: 11 }}
                    />
                    <YAxis yAxisId="qty" tickFormatter={shortQty} />
                    <YAxis yAxisId="pct" orientation="right" domain={[0, 100]} unit="%" />
                    <RechartsTooltip
                      formatter={(value, name) => [
                        name === "累计占比" ? `${Number(value).toFixed(1)}%` : formatQty(Number(value)),
                        name,
                      ]}
                    />
                    {data?.medianQty != null ? (
                      <ReferenceLine
                        yAxisId="qty"
                        y={data.medianQty}
                        stroke={VISUAL_COLOR.warning}
                        strokeDasharray="5 4"
                        label="中位数"
                      />
                    ) : null}
                    <ReferenceLine
                      yAxisId="pct"
                      y={80}
                      stroke={VISUAL_COLOR.critical}
                      strokeDasharray="5 4"
                      label="80%"
                    />
                    <Bar
                      yAxisId="qty"
                      dataKey="qty"
                      name="销量"
                      fill={VISUAL_COLOR.primary}
                      onClick={(row) => {
                        const key = (row as unknown as { key?: string }).key;
                        if (key) view.setFilter({ key });
                      }}
                    >
                      {paretoRows.map((row) => (
                        <Cell
                          key={row.key}
                          fill={row.key === data?.selectedKey
                            ? VISUAL_COLOR.positive
                            : VISUAL_COLOR.primary}
                        />
                      ))}
                    </Bar>
                    <Line
                      yAxisId="pct"
                      type="monotone"
                      dataKey="cumulativePct"
                      name="累计占比"
                      stroke={VISUAL_COLOR.critical}
                      strokeWidth={2}
                      dot={false}
                    />
                  </ComposedChart>
                </ResponsiveContainer>
              </DecisionVisual>
            ),
          },
          {
            key: "trend",
            label: "趋势与异常",
            children: (
              <Space direction="vertical" size={12} style={{ width: "100%" }}>
                {data?.comparison.yoyGate ? (
                  <Alert showIcon type="warning" message="同比暂未解锁" description={data.comparison.yoyGate} />
                ) : null}
                {data && !data.spc.bands ? (
                  <Alert showIcon type="warning" message="统计控制带暂未解锁" description={data.spc.note} />
                ) : null}
                <DecisionVisual
                  title="月销量趋势、环比与统计控制带"
                  question="销量变化是普通波动、连续偏移，还是值得介入的统计异常？"
                  metricId="salesQty"
                  grain={`月 × ${scope}`}
                  unit="基础单位数量"
                  source={{
                    tier: "snapshot",
                    source: "sales_monthly 销售月事实",
                    asOf: data?.latestMonth,
                  }}
                  coverage={{
                    covered: data?.months.length ?? 0,
                    total: Math.max(12, data?.months.length ?? 0),
                    label: "可用月份（统计门槛 12）",
                  }}
                  activeFilters={filters}
                  summary={data
                    ? `${data.review.bullets[0]} ${data.review.bullets[3]}`
                    : "正在读取月销量趋势。"}
                  caveat="环比只比较相邻可用月份；同比必须有真实去年同期。控制带使用中位数/MAD，至少 12 个一致月份才显示。"
                  state={loading && !data ? "loading" : data?.monthly.length ? "ready" : "empty"}
                  height={390}
                  dataView={
                    <Table
                      rowKey="month"
                      size="small"
                      pagination={false}
                      dataSource={data?.monthly ?? []}
                      columns={[
                        { title: "月份", dataIndex: "month" },
                        { title: "销量", dataIndex: "qty", align: "right", render: formatQty },
                        { title: "上控制限", dataIndex: "upper3", align: "right", render: (v: number | null) => v == null ? "未解锁" : formatQty(v) },
                        { title: "下控制限", dataIndex: "lower3", align: "right", render: (v: number | null) => v == null ? "未解锁" : formatQty(v) },
                      ]}
                    />
                  }
                >
                  <ResponsiveContainer minWidth={0} minHeight={1}>
                    <LineChart data={data?.monthly ?? []} margin={{ top: 8, right: 18, left: 8, bottom: 20 }}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey="month" />
                      <YAxis tickFormatter={shortQty} />
                      <RechartsTooltip formatter={(value) => formatQty(Number(value))} />
                      {data?.spc.bands ? (
                        <>
                          <Area
                            dataKey="upper3"
                            stroke="none"
                            fill={VISUAL_COLOR.warning}
                            fillOpacity={0.08}
                            isAnimationActive={false}
                          />
                          <Line
                            dataKey="upper3"
                            name="+3σ"
                            dot={false}
                            stroke={VISUAL_COLOR.warning}
                            strokeDasharray="4 4"
                          />
                          <Line
                            dataKey="lower3"
                            name="-3σ"
                            dot={false}
                            stroke={VISUAL_COLOR.warning}
                            strokeDasharray="4 4"
                          />
                        </>
                      ) : null}
                      <Line
                        type="monotone"
                        dataKey="qty"
                        name="销量"
                        stroke={VISUAL_COLOR.primary}
                        strokeWidth={3}
                        activeDot={{ r: 6 }}
                      />
                    </LineChart>
                  </ResponsiveContainer>
                </DecisionVisual>
              </Space>
            ),
          },
          {
            key: "pivot",
            label: "自助透视",
            children: (
              <DecisionVisual
                title={`${DIMENSION_LABEL[dimension]} × 月份透视`}
                question={`哪些${DIMENSION_LABEL[dimension]}在什么月份贡献、增长或回落？`}
                metricId="salesQty"
                grain={`${DIMENSION_LABEL[dimension]} × 月`}
                unit="基础单位数量"
                source={{
                  tier: "snapshot",
                  source: "sales_monthly 销售月事实",
                  asOf: data?.latestMonth,
                }}
                coverage={{
                  covered: data?.pivot.length ?? 0,
                  total: data?.groups.length ?? 0,
                  label: "透视成员（按全期销量 TOP 20）",
                }}
                activeFilters={[`维度：${DIMENSION_LABEL[dimension]}`]}
                summary={`展示全期销量最高的 ${data?.pivot.length ?? 0} 个成员；点击成员可联动结构与趋势。`}
                caveat="为保持交互轻量，透视表展示全期销量 TOP 20；服务端先基于全量事实聚合，再排序，不使用当前表格页冒充全量。"
                state={loading && !data ? "loading" : data?.pivot.length ? "ready" : "empty"}
                height={380}
                dataView={null}
                contentIsTable
              >
                <Table
                  rowKey="key"
                  size="small"
                  pagination={false}
                  columns={pivotColumns}
                  dataSource={data?.pivot ?? []}
                  scroll={{ x: "max-content", y: 320 }}
                />
              </DecisionVisual>
            ),
          },
          {
            key: "daily",
            label: "日级节奏",
            children: (
              <DecisionVisual
                title="JST 日销量热力日历"
                question="日级销量集中在哪些日期，是否存在需要继续解释的峰谷？"
                metricId="salesQty"
                grain={selectedKey && dimension === "sku" ? `日 × SKU ${scope}` : "日 × 全部 JST 导入"}
                unit="出库数量"
                source={{
                  tier: "reference",
                  source: "JST 日销量受控 staging（每个日期取最新导入批次）",
                  asOf: data?.daily.latestDate,
                }}
                coverage={{
                  covered: data?.daily.coveredRows ?? 0,
                  total: data?.daily.totalRows ?? 0,
                  label: "已解析 SKU 行",
                }}
                activeFilters={selectedKey ? filters : ["范围：全部 JST 导入"]}
                summary={data?.daily.state === "ready"
                  ? `已覆盖 ${data.daily.dates.length} 个日期；颜色越深表示当日出库量越高。`
                  : data?.daily.gate ?? "等待 JST 日销量。"}
                caveat="该来源没有渠道、促销、退款和可售状态。热力只显示日级节奏，不能据此计算促销提升或断货损失。"
                state={loading && !data ? "loading" : data?.daily.state ?? "insufficient"}
                stateDetail={data?.daily.gate}
                height={360}
                dataView={
                  <Table
                    rowKey="date"
                    size="small"
                    pagination={false}
                    dataSource={data?.daily.dates ?? []}
                    columns={[
                      { title: "日期", dataIndex: "date" },
                      { title: "出库数量", dataIndex: "qty", align: "right", render: formatQty },
                    ]}
                  />
                }
              >
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fill, minmax(92px, 1fr))",
                    gap: 6,
                    alignContent: "start",
                    height: "100%",
                    overflow: "auto",
                  }}
                >
                  {(data?.daily.dates ?? []).map((item) => {
                    const background = heatColor(item.qty, heatMax);
                    const dark = background === "#1d4ed8" || background === "#3b82f6";
                    return (
                      <div
                        key={item.date}
                        title={`${item.date}：${formatQty(item.qty)}`}
                        style={{
                          padding: "10px 8px",
                          borderRadius: 6,
                          background,
                          color: dark ? "white" : "#0f172a",
                          minHeight: 56,
                        }}
                      >
                        <div style={{ fontSize: 11, opacity: 0.8 }}>{item.date.slice(5)}</div>
                        <div style={{ fontWeight: 700 }}>{shortQty(item.qty)}</div>
                      </div>
                    );
                  })}
                </div>
              </DecisionVisual>
            ),
          },
          {
            key: "external",
            label: "外部需求信号",
            children: (
              <Space direction="vertical" size={12} style={{ width: "100%" }}>
                <Alert
                  showIcon
                  type={external?.state === "ready" ? "warning" : "error"}
                  message="观察口径：可用于发现趋势与身份缺口，不可直接驱动正式销量、库存、财务或补货"
                  description={external?.gate}
                  action={(
                    <Button href="/import/exceptions?status=open&scope=JIANDAOYUN">
                      处理简道云身份认领
                    </Button>
                  )}
                />
                <Row gutter={[10, 10]} className="compact-kpi-row">
                  <Col xs={12} lg={6}>
                    <Card size="small">
                      <Statistic
                        title="支付件数"
                        value={externalReady ? external.totals.paidQty : "数据不足"}
                        formatter={externalReady ? (v) => formatQty(Number(v)) : undefined}
                      />
                    </Card>
                  </Col>
                  <Col xs={12} lg={6}>
                    <Card size="small">
                      <Statistic
                        title="成功退款件数 / 退款率"
                        value={externalReady ? external.totals.refundQty : "数据不足"}
                        formatter={externalReady ? (v) => formatQty(Number(v)) : undefined}
                        suffix={externalReady && external.totals.paidQty > 0
                          ? ` / ${(external.totals.refundQty / external.totals.paidQty * 100).toFixed(1)}%`
                          : undefined}
                      />
                    </Card>
                  </Col>
                  <Col xs={12} lg={6}>
                    <Card size="small">
                      <Statistic
                        title="净需求信号"
                        value={externalReady ? external.totals.netQty : "数据不足"}
                        formatter={externalReady ? (v) => formatQty(Number(v)) : undefined}
                      />
                    </Card>
                  </Col>
                  <Col xs={12} lg={6}>
                    <Card size="small">
                      <Statistic
                        title="平台 SKU 身份覆盖"
                        value={externalReady && external.coverage.identityPct != null
                          ? external.coverage.identityPct
                          : "数据不足"}
                        precision={externalReady ? 1 : undefined}
                        suffix={externalReady && external.coverage.identityPct != null ? "%" : undefined}
                        valueStyle={{ color: externalReady && (external.coverage.identityPct ?? 0) >= 80
                          ? VISUAL_COLOR.positive
                          : VISUAL_COLOR.warning }}
                      />
                    </Card>
                  </Col>
                </Row>
                <Card
                  size="small"
                  title="滚动需求决策简报"
                  extra={(
                    <Space size={8} wrap>
                      <Tag
                        style={external?.decisionBrief.state === "ready"
                          ? { color: "#166534", background: "#dcfce7", borderColor: "#86efac" }
                          : { color: "#854d0e", background: "#fef9c3", borderColor: "#fde047" }}
                      >
                        {external?.decisionBrief.state === "ready" ? "双窗口完整" : "窗口不完整"}
                      </Tag>
                      <Button
                        type="text"
                        size="small"
                        icon={<DownloadOutlined />}
                        disabled={!external?.decisionBrief.anchorDate}
                        onClick={exportExternalRollingBrief}
                      >
                        导出窗口证据
                      </Button>
                    </Space>
                  )}
                  styles={{ body: { padding: 12 } }}
                >
                  <Alert
                    showIcon
                    type={external?.decisionBrief.state === "ready" ? "info" : "warning"}
                    message={external?.decisionBrief.gate ?? "正在建立两个自然日窗口。"}
                    style={{ marginBottom: 10 }}
                  />
                  <Row gutter={[10, 10]} className="compact-kpi-row">
                    <Col xs={12} lg={6}>
                      <Card size="small">
                        <Statistic
                          title={`最近7天净需求 · ${external?.decisionBrief.current.observedDays ?? 0}/7天`}
                          value={external?.decisionBrief.state === "ready"
                            ? external.decisionBrief.current.netQty
                            : "数据不足"}
                          formatter={external?.decisionBrief.state === "ready"
                            ? (value) => formatQty(Number(value))
                            : undefined}
                        />
                        <Typography.Text type="secondary">
                          {external?.decisionBrief.current.startDate ?? "—"} 至 {external?.decisionBrief.current.endDate ?? "—"}
                        </Typography.Text>
                      </Card>
                    </Col>
                    <Col xs={12} lg={6}>
                      <Card size="small">
                        <Statistic
                          title="净需求较前7天"
                          value={external?.decisionBrief.state === "ready"
                            ? pctLabel(external.decisionBrief.change.netQtyPct)
                            : "数据不足"}
                          valueStyle={{
                            color: movementColor(external?.decisionBrief.movement.netDemand ?? "unknown"),
                          }}
                        />
                        <Typography.Text type="secondary">
                          前窗净需求 {external?.decisionBrief.state === "ready"
                            ? formatQty(external.decisionBrief.previous.netQty)
                            : "—"}
                        </Typography.Text>
                      </Card>
                    </Col>
                    <Col xs={12} lg={6}>
                      <Card size="small">
                        <Statistic
                          title="最近7天退款率"
                          value={external?.decisionBrief.state === "ready"
                            && external.decisionBrief.current.refundRatePct != null
                            ? external.decisionBrief.current.refundRatePct
                            : "数据不足"}
                          precision={1}
                          suffix={external?.decisionBrief.state === "ready"
                            && external.decisionBrief.current.refundRatePct != null ? "%" : undefined}
                          valueStyle={{
                            color: movementColor(
                              external?.decisionBrief.movement.refundRate ?? "unknown",
                              true,
                            ),
                          }}
                        />
                        <Typography.Text type="secondary">
                          较前窗 {ppLabel(external?.decisionBrief.change.refundRateDeltaPp ?? null)}
                        </Typography.Text>
                      </Card>
                    </Col>
                    <Col xs={12} lg={6}>
                      <Card size="small">
                        <Statistic
                          title="最近7天已映射支付覆盖"
                          value={external?.decisionBrief.state === "ready"
                            && external.decisionBrief.current.mappedPaidCoveragePct != null
                            ? external.decisionBrief.current.mappedPaidCoveragePct
                            : "数据不足"}
                          precision={1}
                          suffix={external?.decisionBrief.state === "ready"
                            && external.decisionBrief.current.mappedPaidCoveragePct != null ? "%" : undefined}
                          valueStyle={{
                            color: movementColor(
                              external?.decisionBrief.movement.mappedPaidCoverage ?? "unknown",
                            ),
                          }}
                        />
                        <Typography.Text type="secondary">
                          较前窗 {ppLabel(external?.decisionBrief.change.mappedPaidCoverageDeltaPp ?? null)}
                        </Typography.Text>
                      </Card>
                    </Col>
                  </Row>
                </Card>
                <DecisionVisual
                  title={`退款变化拆解 · ${refundMovementLabel(refundDrivers?.movement ?? "unknown")}`}
                  question="哪些店铺与平台 SKU 推动了最近 7 天的退款变化；它们是否已经具备可行动的系统身份？"
                  metricId="refundRate"
                  grain={refundDrivers?.grain ?? "店铺 × 天猫平台 SKU × 双自然日窗口"}
                  unit="件 / %"
                  source={{
                    tier: "reference",
                    source: "简道云天猫支付与成功退款（两个完整自然日窗口）",
                    asOf: external?.sourceAsOf,
                  }}
                  coverage={{
                    covered: refundDrivers?.identityCoverage.mappedDrivers ?? 0,
                    total: refundDrivers?.eligibleDrivers ?? 0,
                    label: "已有 SCM 身份的同向驱动",
                  }}
                  activeFilters={[
                    "粒度：店铺 + 平台 SKU",
                    "仅同方向变化池",
                    "正负不相互抵销",
                    "不自动归责",
                  ]}
                  summary={refundDrivers?.state === "ready"
                    ? `退款 ${formatQty(refundDrivers.totals.previousRefundQty)} → ${formatQty(refundDrivers.totals.currentRefundQty)}，变化 ${formatQty(refundDrivers.totals.deltaRefundQty ?? 0)}；同向池 ${formatQty(refundDrivers.totals.movementPoolQty ?? 0)}，共 ${refundDrivers.eligibleDrivers} 个驱动；其中 ${refundDrivers.identityCoverage.mappedMovementPoolPct?.toFixed(1) ?? "—"}% 已有 SCM 身份。${refundDrivers.byShop[0] ? ` 首要店铺：${refundDrivers.byShop[0].shopName}（${refundDrivers.byShop[0].movementPoolSharePct?.toFixed(1) ?? "—"}%）。` : ""}`
                    : refundDrivers?.gate ?? "正在建立退款驱动窗口。"}
                  caveat="贡献占比只在与总体变化同方向的 SKU 变化池内计算；退款发生日不一定等于原支付日，必须结合退款原因、退货入库和平台明细复核。"
                  state={loading && !data ? "loading" : refundDrivers?.state ?? "insufficient"}
                  stateDetail={refundDrivers?.gate}
                  height={360}
                  onExport={(refundDrivers?.topContributors.length ?? 0) > 0
                    ? exportExternalRefundDrivers
                    : undefined}
                  exportLabel="导出退款驱动行动证据"
                  dataView={(
                    <Table
                      rowKey={(row) => `${row.shopName}\u0000${row.platformSkuId}`}
                      size="small"
                      pagination={{ pageSize: 10, showSizeChanger: false }}
                      dataSource={refundDrivers?.topContributors ?? []}
                      scroll={{ x: 1320 }}
                      columns={[
                        { title: "店铺", dataIndex: "shopName", width: 160, fixed: "left", sorter: (a, b) => a.shopName.localeCompare(b.shopName, "zh-CN") },
                        { title: "平台 SKU", dataIndex: "platformSkuId", width: 170, sorter: (a, b) => a.platformSkuId.localeCompare(b.platformSkuId) },
                        { title: "商品 / 规格", key: "name", width: 220, ellipsis: true, render: (_, row) => row.skuName || row.productName || "（未提供）" },
                        { title: "本期退款", dataIndex: "currentRefundQty", width: 110, align: "right", sorter: (a, b) => a.currentRefundQty - b.currentRefundQty, render: formatQty },
                        { title: "前期退款", dataIndex: "previousRefundQty", width: 110, align: "right", sorter: (a, b) => a.previousRefundQty - b.previousRefundQty, render: formatQty },
                        {
                          title: "退款变化",
                          dataIndex: "deltaRefundQty",
                          width: 120,
                          align: "right",
                          sorter: (a, b) => a.deltaRefundQty - b.deltaRefundQty,
                          render: (value) => (
                            <Typography.Text type={Number(value) > 0 ? "danger" : undefined}>
                              {Number(value) > 0 ? "+" : ""}{formatQty(value)}
                            </Typography.Text>
                          ),
                        },
                        { title: "本期退款率", dataIndex: "currentRefundRatePct", width: 130, align: "right", sorter: (a, b) => (a.currentRefundRatePct ?? -1) - (b.currentRefundRatePct ?? -1), render: (value) => value == null ? "数据不足" : `${Number(value).toFixed(1)}%` },
                        { title: "退款率变化", dataIndex: "refundRateDeltaPp", width: 140, align: "right", sorter: (a, b) => (a.refundRateDeltaPp ?? -Infinity) - (b.refundRateDeltaPp ?? -Infinity), render: (value) => ppLabel(value == null ? null : Number(value)) },
                        { title: "同向池占比", dataIndex: "movementPoolSharePct", width: 130, align: "right", sorter: (a, b) => (a.movementPoolSharePct ?? -1) - (b.movementPoolSharePct ?? -1), render: (value) => value == null ? "数据不足" : `${Number(value).toFixed(1)}%` },
                        {
                          title: "下一步",
                          key: "action",
                          width: 175,
                          fixed: "right",
                          render: (_, row) => {
                            const action = externalRefundDriverAction(row);
                            if (row.skuId != null) return <Typography.Text>{action}</Typography.Text>;
                            if (row.exceptionStatus === "open" && row.barcode) {
                              const query = new URLSearchParams({
                                status: "open",
                                scope: "JIANDAOYUN",
                                aliasType: "sku_barcode",
                                rawValue: row.barcode,
                              });
                              return <Button type="link" size="small" href={`/import/exceptions?${query.toString()}`}>{action}</Button>;
                            }
                            return <Typography.Text type="warning">{action}</Typography.Text>;
                          },
                        },
                      ]}
                    />
                  )}
                >
                  <ResponsiveContainer minWidth={0} minHeight={1}>
                    <ComposedChart
                      data={refundShopChartRows}
                      layout="vertical"
                      margin={{ top: 8, right: 28, left: 42, bottom: 20 }}
                    >
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis type="number" tickFormatter={shortQty} />
                      <YAxis
                        type="category"
                        dataKey="shopName"
                        width={170}
                        tickFormatter={(value) => String(value).slice(0, 18)}
                      />
                      <RechartsTooltip
                        formatter={(value) => formatQty(Number(value))}
                        labelFormatter={(_, payload) => payload?.[0]?.payload?.shopName ?? ""}
                      />
                      <ReferenceLine x={0} stroke={VISUAL_COLOR.neutral} />
                      <Bar
                        dataKey="movementPoolQty"
                        name="同向退款变化池"
                        fill={refundDrivers?.movement === "down"
                          ? VISUAL_COLOR.positive
                          : refundDrivers?.movement === "up"
                            ? VISUAL_COLOR.critical
                            : VISUAL_COLOR.warning}
                        radius={[0, 4, 4, 0]}
                      />
                    </ComposedChart>
                  </ResponsiveContainer>
                </DecisionVisual>
                <DecisionVisual
                  title="简道云 · 天猫支付、退款与净需求趋势"
                  question="扣除成功退款后，外部需求信号如何变化；其中多少已经能安全归属系统 SKU？"
                  metricId="externalNetDemand"
                  grain="日 × 天猫平台 SKU"
                  unit="件"
                  source={{
                    tier: "reference",
                    source: "简道云天猫日销量 + 退款 + SKU 对照（各取最新成功批次）",
                    asOf: external?.sourceAsOf,
                  }}
                  coverage={{
                    covered: external?.coverage.mappedIdentities ?? 0,
                    total: external?.coverage.platformIdentities ?? 0,
                    label: "已映射平台 SKU 身份",
                  }}
                  activeFilters={["来源：简道云", "平台：天猫", "权限：只读观察", "当前经营筛选不作用于未映射平台身份"]}
                  summary={external?.state === "ready"
                    ? `观察净需求 ${formatQty(external.totals.netQty)}；已映射净需求 ${formatQty(external.totals.mappedNetQty)}；支付件数覆盖 ${external.coverage.paidQtyPct?.toFixed(1) ?? "—"}%。`
                    : external?.gate ?? "正在读取简道云外部需求证据。"}
                  caveat={external?.limitations.join(" ")}
                  state={loading && !data ? "loading" : external?.state ?? "insufficient"}
                  stateDetail={external?.gate}
                  height={390}
                  onExport={externalReady && (external?.daily.length ?? 0) > 0
                    ? exportExternalDaily
                    : undefined}
                  exportLabel="导出日控制总量 UAT 证据"
                  dataView={(
                    <Table
                      rowKey="date"
                      size="small"
                      pagination={false}
                      dataSource={external?.daily ?? []}
                      columns={[
                        { title: "日期", dataIndex: "date", sorter: (a, b) => a.date.localeCompare(b.date) },
                        { title: "支付件数", dataIndex: "paidQty", align: "right", sorter: (a, b) => a.paidQty - b.paidQty, render: formatQty },
                        { title: "成功退款", dataIndex: "refundQty", align: "right", sorter: (a, b) => a.refundQty - b.refundQty, render: formatQty },
                        { title: "净需求", dataIndex: "netQty", align: "right", sorter: (a, b) => a.netQty - b.netQty, render: formatQty },
                        { title: "已映射净需求", dataIndex: "mappedNetQty", align: "right", sorter: (a, b) => a.mappedNetQty - b.mappedNetQty, render: formatQty },
                      ]}
                    />
                  )}
                >
                  <ResponsiveContainer minWidth={0} minHeight={1}>
                    <LineChart data={external?.daily ?? []} margin={{ top: 8, right: 18, left: 8, bottom: 20 }}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey="date" minTickGap={28} />
                      <YAxis tickFormatter={shortQty} />
                      <RechartsTooltip formatter={(value) => formatQty(Number(value))} />
                      <Line type="monotone" dataKey="paidQty" name="支付件数" stroke={VISUAL_COLOR.primary} dot={false} />
                      <Line type="monotone" dataKey="refundQty" name="成功退款" stroke={VISUAL_COLOR.critical} dot={false} />
                      <Line type="monotone" dataKey="netQty" name="净需求信号" stroke={VISUAL_COLOR.positive} strokeWidth={3} dot={false} />
                      <Line type="monotone" dataKey="mappedNetQty" name="已映射净需求" stroke={VISUAL_COLOR.warning} strokeDasharray="5 4" dot={false} />
                    </LineChart>
                  </ResponsiveContainer>
                </DecisionVisual>
                <DecisionVisual
                  title="简道云净需求 × 聚水潭实际出库"
                  question="同一业务日、同一已映射 SCM SKU 下，支付扣退款后的需求与真实出库相差多少？"
                  metricId="externalNetDemand"
                  grain={external?.fulfillment.grain ?? "业务日 × SCM SKU"}
                  unit="件"
                  source={{
                    tier: "reference",
                    source: "简道云需求观察 + 聚水潭日出库观察（两边独立保留）",
                    asOf: external?.fulfillment.jstSourceAsOf,
                  }}
                  coverage={{
                    covered: external?.fulfillment.coverage.comparableSkuDays ?? 0,
                    total: external?.fulfillment.coverage.jdyMappedSkuDays ?? 0,
                    label: "简道云映射 SKU日中可与聚水潭同窗比较",
                  }}
                  activeFilters={["共同键：业务日 + SCM SKU", "跨店铺/仓汇总", "缺失不补零", "差异不自动定责"]}
                  summary={external?.fulfillment.state === "ready"
                    ? `可比 ${external.fulfillment.coverage.comparableSkuDays} 个 SKU日；简道云净需求 ${formatQty(external.fulfillment.totals.comparableDemandQty)}，聚水潭出库 ${formatQty(external.fulfillment.totals.comparableOutboundQty)}，差异 ${formatQty(external.fulfillment.totals.gapQty ?? 0)}。`
                    : external?.fulfillment.gate ?? "正在建立跨源可比窗口。"}
                  caveat="该差异可能来自店铺/仓映射、订单与出库时间差、取消、跨期退款或数据覆盖；不能直接判定漏单、超发或责任归属。"
                  state={loading && !data ? "loading" : external?.fulfillment.state ?? "insufficient"}
                  stateDetail={external?.fulfillment.gate}
                  height={340}
                  onExport={external?.fulfillment.state === "ready" && external.fulfillment.topGaps.length > 0
                    ? exportExternalFulfillment
                    : undefined}
                  exportLabel="导出跨源 UAT 明细"
                  dataView={(
                    <Table
                      rowKey={(row) => `${row.date}\u0000${row.skuId}`}
                      size="small"
                      pagination={{ pageSize: 10, showSizeChanger: false }}
                      dataSource={external?.fulfillment.topGaps ?? []}
                      scroll={{ x: 820 }}
                      columns={[
                        { title: "日期", dataIndex: "date", width: 120, sorter: (a, b) => a.date.localeCompare(b.date) },
                        { title: "SCM SKU", dataIndex: "skuCode", width: 150, render: (value, row) => value ?? `ID ${row.skuId}` },
                        { title: "简道云净需求", dataIndex: "mappedNetDemandQty", width: 150, align: "right", sorter: (a, b) => a.mappedNetDemandQty - b.mappedNetDemandQty, render: formatQty },
                        { title: "聚水潭出库", dataIndex: "jstOutboundQty", width: 140, align: "right", sorter: (a, b) => a.jstOutboundQty - b.jstOutboundQty, render: formatQty },
                        { title: "差异", dataIndex: "gapQty", width: 120, align: "right", defaultSortOrder: "descend", sorter: (a, b) => a.absoluteGapQty - b.absoluteGapQty, render: (value) => <Tag color={Number(value) === 0 ? "green" : "orange"}>{formatQty(value)}</Tag> },
                      ]}
                    />
                  )}
                >
                  <ResponsiveContainer minWidth={0} minHeight={1}>
                    <LineChart data={external?.fulfillment.daily ?? []} margin={{ top: 8, right: 18, left: 8, bottom: 20 }}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey="date" minTickGap={28} />
                      <YAxis tickFormatter={shortQty} />
                      <RechartsTooltip formatter={(value) => formatQty(Number(value))} />
                      <Line type="monotone" dataKey="comparableDemandQty" name="简道云可比净需求" stroke={VISUAL_COLOR.primary} strokeWidth={3} dot={false} />
                      <Line type="monotone" dataKey="comparableOutboundQty" name="聚水潭可比出库" stroke={VISUAL_COLOR.positive} strokeWidth={3} dot={false} />
                    </LineChart>
                  </ResponsiveContainer>
                </DecisionVisual>
                <Card
                  size="small"
                  title="优先处理：高销量未映射平台 SKU"
                  extra={(
                    <Space size={6} wrap>
                      <Tag color="gold">TOP {external?.topUnmapped.length ?? 0}</Tag>
                      <Button
                        type="text"
                        size="small"
                        icon={<DownloadOutlined />}
                        disabled={!externalReady || (external?.topUnmapped.length ?? 0) === 0}
                        onClick={exportExternalIdentityQueue}
                      >
                        导出修复队列
                      </Button>
                    </Space>
                  )}
                >
                  <Alert
                    type="info"
                    showIcon
                    style={{ marginBottom: 12 }}
                    message="先认领条码，再重新同步“天猫 SKU 对照”"
                    description="认领只建立简道云作用域身份；旧证据批次保持不可变，新同步批次才会取得系统 SKU 归属。"
                  />
                  <Table
                    rowKey={(row) => `${row.shopName}\u0000${row.platformSkuId}`}
                    size="small"
                    pagination={{ pageSize: 10, showSizeChanger: false }}
                    dataSource={external?.topUnmapped ?? []}
                    scroll={{ x: 1180 }}
                    columns={[
                      { title: "店铺", dataIndex: "shopName", width: 160, sorter: (a, b) => a.shopName.localeCompare(b.shopName, "zh-CN") },
                      { title: "平台 SKU", dataIndex: "platformSkuId", width: 180, sorter: (a, b) => a.platformSkuId.localeCompare(b.platformSkuId) },
                      { title: "条码", dataIndex: "barcode", width: 170, render: (value) => value || <Typography.Text type="secondary">未提供</Typography.Text> },
                      { title: "商品 / 规格", key: "name", ellipsis: true, render: (_, row) => row.skuName || row.productName || "（未提供）" },
                      { title: "支付件数", dataIndex: "paidQty", width: 130, align: "right", defaultSortOrder: "descend", sorter: (a, b) => a.paidQty - b.paidQty, render: formatQty },
                      { title: "退款", dataIndex: "refundQty", width: 110, align: "right", sorter: (a, b) => a.refundQty - b.refundQty, render: formatQty },
                      { title: "净需求", dataIndex: "netQty", width: 120, align: "right", sorter: (a, b) => a.netQty - b.netQty, render: formatQty },
                      {
                        title: "身份动作",
                        key: "identityAction",
                        width: 150,
                        fixed: "right",
                        render: (_, row) => {
                          const action = externalDemandIdentityAction(row);
                          if (!row.barcode) return <Tag color="error">{action}</Tag>;
                          if (row.exceptionStatus === "open") {
                            const query = new URLSearchParams({
                              status: "open",
                              scope: "JIANDAOYUN",
                              aliasType: "sku_barcode",
                              rawValue: row.barcode,
                            });
                            return <Button type="link" size="small" href={`/import/exceptions?${query.toString()}`}>{action}</Button>;
                          }
                          if (row.exceptionStatus === "resolved") return <Tag color="processing">{action}</Tag>;
                          if (row.exceptionStatus === "ignored") return <Tag>{action}</Tag>;
                          return <Tag color="warning">{action}</Tag>;
                        },
                      },
                    ]}
                  />
                </Card>
              </Space>
            ),
          },
          {
            key: "identity",
            label: "平台身份覆盖",
            children: (
              <Space direction="vertical" size={12} style={{ width: "100%" }}>
                <Alert
                  showIcon
                  type={identity?.state === "ready" ? "warning" : "error"}
                  message="三平台商品身份控制塔：只观察覆盖与质量，不提升任何外部表为系统主档"
                  description={identity?.gate}
                />
                <Space wrap style={{ width: "100%", justifyContent: "flex-end" }}>
                  <Button
                    icon={<DownloadOutlined />}
                    disabled={!identity?.repairQueue.length}
                    onClick={exportCommerceIdentityQueue}
                  >
                    导出修复队列
                  </Button>
                  <Button href="/import/exceptions?status=open&scope=JIANDAOYUN">
                    处理身份认领
                  </Button>
                </Space>
                <Row gutter={[10, 10]} className="compact-kpi-row">
                  <Col xs={12} lg={6}>
                    <Card size="small">
                      <Statistic
                        title="有可用批次的平台"
                        value={identity?.summary.availablePlatforms ?? 0}
                        suffix={`/ ${identity?.summary.totalPlatforms ?? 3}`}
                      />
                    </Card>
                  </Col>
                  <Col xs={12} lg={6}>
                    <Card size="small">
                      <Statistic
                        title="待修平台身份"
                        value={identity?.summary.repairBacklog ?? 0}
                        formatter={(value) => Number(value).toLocaleString("zh-CN")}
                        valueStyle={{ color: VISUAL_COLOR.warning }}
                      />
                    </Card>
                  </Col>
                  <Col xs={12} lg={6}>
                    <Card size="small">
                      <Statistic
                        title="平台唯一身份"
                        value={identity?.summary.uniqueIdentities ?? 0}
                        formatter={(value) => Number(value).toLocaleString("zh-CN")}
                      />
                    </Card>
                  </Col>
                  <Col xs={12} lg={6}>
                    <Card size="small">
                      <Statistic
                        title="跨平台加权身份覆盖"
                        value={identity?.summary.identityPct ?? "数据不足"}
                        precision={identity?.summary.identityPct == null ? undefined : 1}
                        suffix={identity?.summary.identityPct == null ? undefined : "%"}
                        valueStyle={{
                          color: (identity?.summary.identityPct ?? 0) >= 80
                            ? VISUAL_COLOR.positive
                            : VISUAL_COLOR.warning,
                        }}
                      />
                    </Card>
                  </Col>
                </Row>
                <PlatformSkuGapCard active={activeTab === "identity"} />
                <Card
                  size="small"
                  title="平台身份覆盖与放行门禁"
                  extra={<Tag color="warning">观察口径</Tag>}
                  styles={{ body: { padding: 0 } }}
                >
                  <Table
                    rowKey="key"
                    size="small"
                    pagination={false}
                    dataSource={identity?.platforms ?? []}
                    scroll={{ x: 1180 }}
                    columns={[
                      {
                        title: "平台",
                        dataIndex: "platform",
                        fixed: "left",
                        width: 100,
                        sorter: (a, b) => a.platform.localeCompare(b.platform, "zh-CN"),
                        render: (value, row) => (
                          <Space size={6}>
                            <Typography.Text strong>{value}</Typography.Text>
                            <Tag color={row.fresh === true ? "success" : row.fresh === false ? "error" : "default"}>
                              {row.fresh === true ? "新鲜" : row.fresh === false ? "陈旧" : "未知"}
                            </Tag>
                          </Space>
                        ),
                      },
                      {
                        title: "数据截至",
                        dataIndex: "sourceAsOf",
                        width: 130,
                        sorter: (a, b) => String(a.sourceAsOf ?? "").localeCompare(String(b.sourceAsOf ?? "")),
                        render: (value, row) => value
                          ? <span>{String(value).slice(0, 10)} · {row.ageDays}天</span>
                          : <Typography.Text type="secondary">无批次</Typography.Text>,
                      },
                      {
                        title: "原始行 / 唯一身份",
                        key: "volume",
                        width: 170,
                        align: "right",
                        sorter: (a, b) => a.sourceRows - b.sourceRows,
                        render: (_, row) => `${row.sourceRows.toLocaleString("zh-CN")} / ${row.uniqueIdentities.toLocaleString("zh-CN")}`,
                      },
                      {
                        title: "已映射 / 覆盖率",
                        key: "coverage",
                        width: 210,
                        sorter: (a, b) => (a.identityPct ?? -1) - (b.identityPct ?? -1),
                        defaultSortOrder: "ascend",
                        render: (_, row) => row.identityPct == null ? (
                          <Typography.Text type="secondary">数据不足</Typography.Text>
                        ) : (
                          <Space direction="vertical" size={0} style={{ width: "100%" }}>
                            <Typography.Text>{row.mappedIdentities.toLocaleString("zh-CN")} / {row.uniqueIdentities.toLocaleString("zh-CN")}</Typography.Text>
                            <Progress
                              percent={row.identityPct}
                              size="small"
                              status={row.identityPct >= 80 ? "success" : "exception"}
                              format={(value) => `${Number(value).toFixed(1)}%`}
                            />
                          </Space>
                        ),
                      },
                      {
                        title: "可用桥接字段",
                        key: "bridge",
                        width: 190,
                        sorter: (a, b) => (a.bridgePct ?? -1) - (b.bridgePct ?? -1),
                        render: (_, row) => (
                          <Space direction="vertical" size={0}>
                            <Typography.Text>{row.bridgeLabel}</Typography.Text>
                            <Typography.Text type="secondary">
                              {row.bridgePct == null ? "数据不足" : `${row.bridgeIdentities.toLocaleString("zh-CN")} · ${row.bridgePct.toFixed(1)}%`}
                            </Typography.Text>
                          </Space>
                        ),
                      },
                      {
                        title: "重复组 / 冲突",
                        key: "quality",
                        width: 150,
                        align: "right",
                        sorter: (a, b) => (a.duplicateGroups + a.conflictingMappings) - (b.duplicateGroups + b.conflictingMappings),
                        render: (_, row) => (
                          <Typography.Text type={row.duplicateGroups + row.conflictingMappings > 0 ? "danger" : "secondary"}>
                            {row.duplicateGroups.toLocaleString("zh-CN")} / {row.conflictingMappings.toLocaleString("zh-CN")}
                          </Typography.Text>
                        ),
                      },
                      {
                        title: "当前门禁",
                        dataIndex: "gate",
                        width: 320,
                        ellipsis: true,
                        render: (value, row) => (
                          <Space direction="vertical" size={0}>
                            <Tag color="error">禁止放行</Tag>
                            <Typography.Text type="secondary" title={value}>{value}</Typography.Text>
                            <Typography.Text type="secondary" title={row.bridgePolicy}>{row.bridgePolicy}</Typography.Text>
                          </Space>
                        ),
                      },
                    ]}
                  />
                </Card>
                <Card
                  size="small"
                  title="优先修复队列"
                  extra={(
                    <Typography.Text type="secondary">
                      每平台最多 20 条 · 共 {identity?.summary.repairBacklog.toLocaleString("zh-CN") ?? 0} 条待修
                    </Typography.Text>
                  )}
                  styles={{ body: { padding: 0 } }}
                >
                  <Table
                    rowKey={(row) => `${row.platformKey}:${row.shopName ?? ""}:${row.externalId}:${row.issue}`}
                    size="small"
                    dataSource={identity?.repairQueue ?? []}
                    pagination={{ pageSize: 10, showSizeChanger: false }}
                    scroll={{ x: 1040 }}
                    columns={[
                      {
                        title: "优先级",
                        dataIndex: "priority",
                        width: 90,
                        fixed: "left",
                        sorter: (a, b) => a.priority - b.priority,
                        defaultSortOrder: "ascend",
                        render: (value) => <Tag color={value === 1 ? "error" : value === 2 ? "warning" : "default"}>P{value}</Tag>,
                      },
                      {
                        title: "平台",
                        dataIndex: "platform",
                        width: 100,
                        sorter: (a, b) => a.platform.localeCompare(b.platform, "zh-CN"),
                      },
                      {
                        title: "店铺 / 平台身份",
                        key: "identity",
                        width: 260,
                        render: (_, row) => (
                          <Space direction="vertical" size={0}>
                            <Typography.Text>{row.externalId}</Typography.Text>
                            <Typography.Text type="secondary">{row.shopName || "不适用"}</Typography.Text>
                          </Space>
                        ),
                      },
                      {
                        title: "商品",
                        dataIndex: "productName",
                        width: 220,
                        ellipsis: true,
                        render: (value) => value || <Typography.Text type="secondary">未提供</Typography.Text>,
                      },
                      {
                        title: "问题",
                        dataIndex: "issue",
                        width: 150,
                        sorter: (a, b) => a.issue.localeCompare(b.issue),
                        render: (value: keyof typeof COMMERCE_IDENTITY_ISSUE_LABEL) => (
                          <Tag>{COMMERCE_IDENTITY_ISSUE_LABEL[value]}</Tag>
                        ),
                      },
                      {
                        title: "桥接证据",
                        key: "bridge",
                        width: 210,
                        render: (_, row) => (
                          <Space direction="vertical" size={0}>
                            <Typography.Text>{row.bridgeValue || "未提供"}</Typography.Text>
                            <Typography.Text type="secondary">{row.bridgeLabel} · {row.sourceRows} 行</Typography.Text>
                          </Space>
                        ),
                      },
                      {
                        title: "下一步",
                        dataIndex: "action",
                        width: 280,
                        fixed: "right",
                        render: (value, row) => {
                          if (!row.claimable || !row.bridgeValue) return value;
                          const query = new URLSearchParams({
                            status: "open",
                            scope: "JIANDAOYUN",
                            aliasType: "sku_barcode",
                            rawValue: row.bridgeValue,
                          });
                          return <Button type="link" size="small" href={`/import/exceptions?${query.toString()}`}>{value}</Button>;
                        },
                      },
                    ]}
                  />
                </Card>
                <Alert
                  showIcon
                  type="info"
                  message="如何利用：先修身份，再做总量对账，最后才让聚水潭履约与用友财务进入同一业务链"
                  description={identity?.limitations.join("")}
                />
              </Space>
            ),
          },
          {
            key: "review",
            label: "经营回顾",
            children: (
              <Row gutter={[12, 12]}>
                <Col xs={24} lg={14}>
                  <Card
                    title={data?.review.headline ?? "月度经营回顾"}
                    extra={
                      <Button icon={<CopyOutlined />} onClick={() => void copyReview()}>
                        复制成稿
                      </Button>
                    }
                  >
                    <Space direction="vertical" size={12} style={{ width: "100%" }}>
                      {(data?.review.bullets ?? []).map((bullet) => (
                        <Alert key={bullet} type="info" showIcon message={bullet} />
                      ))}
                      <Typography.Text type="secondary">
                        这是确定性事实成稿，不调用 LLM，不添加数据库中不存在的原因。负责人可在会议中补充判断。
                      </Typography.Text>
                    </Space>
                  </Card>
                </Col>
                <Col xs={24} lg={10}>
                  <Card title="未解锁分析" style={{ height: "100%" }}>
                    <Space direction="vertical" size={8}>
                      {data?.limitations.slice(1).map((item) => (
                        <Tag key={item} color="gold" style={{ whiteSpace: "normal", padding: "6px 8px" }}>
                          {item}
                        </Tag>
                      ))}
                    </Space>
                  </Card>
                </Col>
              </Row>
            ),
          },
          {
            key: "readiness",
            label: "能力解锁",
            children: (
              <DecisionReadinessPanel
                dataSources={data?.dataSources ?? []}
                dataProductReleases={data?.dataProductReleases ?? []}
                dataProductOutcomes={data?.dataProductOutcomes ?? []}
                supportingObservations={data?.supportingObservations ?? []}
                onReleaseChanged={load}
                focusProductId={focusProductId}
              />
            ),
          },
        ]}
      />
    </div>
  );
}
